import { ResearchJob } from "../types/job";
import { config } from "../config";
import { logger } from "../logger";
import {
  attachSource,
  claimNextQueuedJob,
  insertNote,
  insertStep,
  listNotes,
  updateJobStatus,
  updateStep,
} from "../repositories/jobRepository";
import { chatCompletion } from "./llmClient";
import { prompts } from "../prompts";
import { n8nFetchUrl, n8nWebSearch } from "./n8nClient";
import { putObject } from "./minioClient";
import { embedText } from "./embeddingClient";
import { ensureCollection, upsertNoteVector } from "./qdrantClient";
import { fetch } from "undici";

interface PlannedStep {
  title: string;
  tool_hint?: string;
  objective?: string;
}

interface SummarizerOutput {
  page_notes?: { label?: string; summary: string; importance?: number }[];
  step_summary?: string;
  step_importance?: number;
}

export class Worker {
  private running = 0;
  private timer: NodeJS.Timeout | null = null;

  start() {
    if (this.timer) {
      return;
    }
    ensureCollection().catch((err) => {
      logger.error(err, "failed to ensure qdrant collection");
    });
    this.timer = setInterval(() => {
      void this.tick();
    }, 2000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick() {
    if (this.running >= config.worker.maxConcurrent) {
      return;
    }
    const job = await claimNextQueuedJob();
    if (!job) {
      return;
    }
    this.running += 1;
    logger.info({ jobId: job.id }, "Starting job execution");
    this.processJob(job)
      .catch((error) => {
        logger.error({ error, jobId: job.id }, "Job failed");
        return updateJobStatus(job.id, "error", { error: String(error) });
      })
      .finally(() => {
        this.running -= 1;
      });
  }

  private async processJob(job: ResearchJob) {
    const stepsPlan = await this.planSteps(job);
    if (!stepsPlan.length) {
      throw new Error("No steps planned");
    }

    const steps = [];
    for (let i = 0; i < stepsPlan.length; i += 1) {
      const plan = stepsPlan[i];
      const inserted = await insertStep(job.id, plan.title, i + 1, plan.tool_hint);
      steps.push({ plan, record: inserted });
    }

    for (const step of steps) {
      await this.executeStep(job, step.plan, step.record.id, step.record.step_order);
    }

    const finalReport = await this.buildFinalReport(job);
    await updateJobStatus(job.id, "completed", {
      final_report: finalReport,
      completed_at: new Date().toISOString(),
    });
    logger.info({ jobId: job.id }, "Job completed");
  }

  private async planSteps(job: ResearchJob): Promise<PlannedStep[]> {
    const priorNotes = await listNotes(job.id);
    const priorContext = priorNotes
      .filter((n) => n.role === "cross_job_summary" || n.role === "step_summary")
      .map((n, idx) => `Note ${idx + 1}: ${n.content}`)
      .join("\n");

    const plannerPrompt = prompts.planner.replace(
      "{{MAX_STEPS}}",
      String(config.worker.maxSteps),
    );

    const response = await chatCompletion([
      { role: "system", content: plannerPrompt },
      {
        role: "user",
        content: `Question: ${job.question}\nContext:\n${priorContext || "(none)"}`,
      },
    ]);

    try {
      const parsed = JSON.parse(response);
      if (Array.isArray(parsed)) {
        return parsed.slice(0, config.worker.maxSteps);
      }
    } catch (error) {
      logger.warn({ error }, "Failed to parse planner output, falling back");
    }

    return [
      {
        title: "Perform initial web research",
        tool_hint: "searxng",
        objective: "Find authoritative overviews and primary sources",
      },
    ];
  }

  private async executeStep(
    job: ResearchJob,
    plan: PlannedStep,
    stepId: string,
    stepOrder: number,
  ) {
    await updateStep(stepId, "running");
    const query = `${job.question} :: ${plan.objective ?? "research"}`;
    const results = await this.runSearch(plan.tool_hint, query);
    if (!results.length) {
      await updateStep(stepId, "partial", { error: "No search results" });
      return;
    }

    const sources = [] as {
      title?: string;
      url: string;
      snippet?: string;
      content?: string;
      raw_storage_url?: string;
    }[];

    for (let i = 0; i < Math.min(results.length, 3); i += 1) {
      const result = results[i];
      try {
        const fetched = await n8nFetchUrl(result.url);
        const key = `raw/${job.id}/${stepOrder}-${i + 1}.json`;
        const rawUrl = await putObject(key, JSON.stringify(fetched));
        sources.push({
          title: fetched.title ?? result.title,
          url: fetched.url ?? result.url,
          snippet: result.snippet,
          content: fetched.content,
          raw_storage_url: rawUrl,
        });
      } catch (error) {
        logger.warn({ error, url: result.url }, "Failed to fetch source");
      }
    }

    const summary: SummarizerOutput = await this.summarizeStep(job, plan, sources);
    const pageNotes = summary.page_notes ?? [];
    for (let i = 0; i < pageNotes.length; i += 1) {
      const note = pageNotes[i];
      const record = await insertNote({
        jobId: job.id,
        stepId,
        role: "page_summary",
        importance: note.importance ?? 3,
        tokenCount: estimateTokens(note.summary),
        content: note.summary,
        sourceUrl: sources[i]?.url,
      });
      if (sources[i]) {
        await attachSource(record.id, {
          url: sources[i].url,
          title: sources[i].title,
          snippet: sources[i].snippet,
          raw_storage_url: sources[i].raw_storage_url,
        });
      }
      await this.indexNote(record.id, note.summary, {
        job_id: job.id,
        step_id: stepId,
        role: "page_summary",
        importance: note.importance ?? 3,
        url: sources[i]?.url,
        title: sources[i]?.title,
      });
    }

    if (summary.step_summary) {
      const record = await insertNote({
        jobId: job.id,
        stepId,
        role: "step_summary",
        importance: summary.step_importance ?? 3,
        tokenCount: estimateTokens(summary.step_summary),
        content: summary.step_summary,
      });
      await this.indexNote(record.id, summary.step_summary, {
        job_id: job.id,
        step_id: stepId,
        role: "step_summary",
        importance: summary.step_importance ?? 3,
      });
    }

    await updateStep(stepId, "completed", { sources: sources.length });
  }

  private async runSearch(toolHint = "searxng", query: string) {
    const ordering = this.buildToolPriority(toolHint);
    for (const tool of ordering) {
      try {
        if (tool === "searxng" && config.search.searxBaseUrl) {
          const results = await this.searchSearx(query);
          if (results.length) return results;
        } else if (tool === "n8n") {
          const results = await n8nWebSearch(query, 6);
          if (results.length) return results;
        }
      } catch (error) {
        logger.warn({ error, tool }, "search tool failed");
      }
    }
    return [];
  }

  private buildToolPriority(initial?: string) {
    const base = [initial, "searxng", "ddg_mcp", "n8n"].filter(Boolean) as string[];
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const tool of base) {
      if (!seen.has(tool)) {
        seen.add(tool);
        ordered.push(tool);
      }
    }
    return ordered;
  }

  private async searchSearx(query: string) {
    const endpoint = `${config.search.searxBaseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`SearXNG returned ${response.status}`);
    }
    const data = (await response.json()) as { results?: { title: string; url: string; content?: string }[] };
    return (
      data.results?.map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.content,
      })) ?? []
    );
  }

  private async summarizeStep(
    job: ResearchJob,
    plan: PlannedStep,
    sources: { title?: string; url: string; content?: string }[],
  ): Promise<SummarizerOutput> {
    const sourcesText = sources
      .map((source, idx) => {
        const preview = (source.content ?? "").slice(0, 2000);
        return `Source ${idx + 1}: ${source.title ?? source.url}\nURL: ${source.url}\nContent:\n${preview}`;
      })
      .join("\n---\n");

    const prompt = `${prompts.summarizer}\nQuestion: ${job.question}\nStep Objective: ${plan.objective ?? plan.title}\nSources:\n${sourcesText}`;
    const response = await chatCompletion([
      { role: "system", content: "Respond with strict JSON." },
      { role: "user", content: prompt },
    ]);

    try {
      return JSON.parse(response);
    } catch (error) {
      logger.warn({ error, response }, "Failed to parse summarizer output");
      return {
        page_notes: sources.map((source, idx) => ({
          label: `Source ${idx + 1}`,
          summary: (source.content ?? "").slice(0, 500),
          importance: 2,
        })),
        step_summary: sources.map((s) => s.content?.slice(0, 200)).join("\n"),
        step_importance: 2,
      };
    }
  }

  private async buildFinalReport(job: ResearchJob) {
    const notes = await listNotes(job.id);
    const selected: typeof notes = [];
    let budget = config.llm.maxContext - 2000 - config.llm.maxTokens;
    for (const note of notes) {
      if (selected.length >= config.worker.maxNotesForSynth) {
        break;
      }
      if (budget - note.token_count <= 0) {
        continue;
      }
      selected.push(note);
      budget -= note.token_count;
    }

    const notesText = selected
      .map((note, idx) => `Note ${idx + 1} (${note.role}, importance ${note.importance}): ${note.content}`)
      .join("\n\n");

    const draft = await chatCompletion([
      { role: "system", content: prompts.synthesizer },
      {
        role: "user",
        content: `Question: ${job.question}\nEvidence:\n${notesText}`,
      },
    ]);

    const criticInput = `Draft report:\n${draft}\n\nNotes:\n${notesText}`;
    const criticRaw = await chatCompletion([
      { role: "system", content: prompts.critic },
      { role: "user", content: criticInput },
    ]);

    let critic;
    try {
      critic = JSON.parse(criticRaw);
    } catch (error) {
      logger.warn({ error }, "Critic output parse failed");
    }

    if (critic?.limitations) {
      return `${draft}\n\nLimitations & Critic Notes:\n${critic.limitations}\nIssues: ${(critic.issues || []).join(", ")}`;
    }
    return draft;
  }

  private async indexNote(
    noteId: string,
    text: string,
    payload: Record<string, unknown>,
  ) {
    try {
      const vector = await embedText(text);
      if (vector.length === 0) {
        return;
      }
      await upsertNoteVector(noteId, vector, payload);
    } catch (error) {
      logger.error({ error }, "Embedding/Qdrant failed for note");
    }
  }
}

function estimateTokens(text: string) {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}
