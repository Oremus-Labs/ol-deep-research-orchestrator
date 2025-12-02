import { createHash } from "node:crypto";
import {
  CitationLedgerRecord,
  NoteRecord,
  ResearchJob,
  ResearchStep,
  SourceRecord,
} from "../types/job";
import { config } from "../config";
import { logger } from "../logger";
import {
  attachSource,
  claimNextQueuedJob,
  createSectionDraft,
  findCitationByHash,
  getJob,
  getNextCitationNumber,
  getSectionDraft,
  insertCitationLedgerEntry,
  insertNote,
  insertStep,
  listCitationLedger,
  listSteps,
  rescueStaleJobs,
  touchJobHeartbeat,
  listNotes,
  listSourcesByJob,
  updateJobStatus,
  updateSectionDraft,
  updateStep,
} from "../repositories/jobRepository";
import { chatCompletion } from "./llmClient";
import { prompts } from "../prompts";
import { n8nFetchUrl, n8nWebSearch } from "./n8nClient";
import { putObject } from "./minioClient";
import { embedText } from "./embeddingClient";
import { ensureCollection, querySimilarNotes, upsertNoteVector } from "./qdrantClient";
import { fetch } from "undici";
import { clampForEmbedding, estimateTokens } from "../utils/text";
import {
  jobDurationHistogram,
  jobRescueCounter,
  jobStatusCounter,
  recordToolError,
  startToolTimer,
} from "../metrics";
import { buildReportArtifacts } from "./reportBuilder";

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

interface WarmNote {
  id: string | number;
  content: string;
  role?: string;
  importance: number;
  jobId?: string;
}

interface CriticFeedback {
  issues?: string[];
  follow_up?: string[];
  limitations?: string;
}

interface SectionSpec {
  key: string;
  title: string;
  noteRoles: string[];
  maxNotes: number;
}

class JobControlError extends Error {
  readonly status: "paused" | "cancelled" | "clarification_required";

  constructor(status: "paused" | "cancelled" | "clarification_required") {
    super(`Job ${status}`);
    this.status = status;
    this.name = "JobControlError";
  }
}

const DEFAULT_SECTION_PLAN: SectionSpec[] = [
  { key: "executive_summary", title: "Executive Summary", noteRoles: ["step_summary"], maxNotes: 6 },
  { key: "background", title: "Background & Context", noteRoles: ["page_summary"], maxNotes: 8 },
  { key: "analysis", title: "Analysis", noteRoles: ["step_summary"], maxNotes: 6 },
  { key: "recommendations", title: "Recommendations", noteRoles: ["critic_note", "step_summary"], maxNotes: 4 },
];

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
    try {
      const rescues = await rescueStaleJobs({
        startThresholdMs: config.worker.rescue.startSeconds * 1000,
        heartbeatThresholdMs: config.worker.rescue.heartbeatSeconds * 1000,
        graceMs: config.worker.rescue.graceSeconds * 1000,
      });
      if (rescues.length) {
        rescues.forEach((rescue) => jobRescueCounter.labels(rescue.reason).inc());
        logger.warn({ rescues }, "Rescued stale jobs");
      }
    } catch (error) {
      logger.error({ error }, "Failed to evaluate stale jobs");
    }
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
    const stopJobTimer = jobDurationHistogram.startTimer();
    jobStatusCounter.labels("started").inc();
    const existingSteps = await listSteps(job.id);
    logger.info({ jobId: job.id, existingSteps: existingSteps.length }, "Loaded existing steps for job");
    let steps: { plan: PlannedStep; record: ResearchStep }[] = [];

    await this.ensureJobActive(job.id);

    if (!existingSteps.length) {
      const stepsPlan = await this.planSteps(job);
      if (!stepsPlan.length) {
        jobStatusCounter.labels("error").inc();
        stopJobTimer({ status: "error" });
        throw new Error("No steps planned");
      }
      for (let i = 0; i < stepsPlan.length; i += 1) {
        const plan = stepsPlan[i];
        const inserted = await insertStep(job.id, plan.title, i + 1, plan.tool_hint);
        steps.push({ plan, record: inserted });
      }
    } else {
      logger.info({ jobId: job.id }, "Resuming job with existing steps");
      steps = existingSteps.map((record) => ({
        plan: { title: record.title, tool_hint: record.tool_hint ?? undefined },
        record,
      }));
    }
    await touchJobHeartbeat(job.id);

    for (const step of steps) {
      await this.ensureJobActive(job.id);
      if (this.isStepComplete(step.record.status)) {
        continue;
      }
      await this.executeStep(job, step.plan, step.record.id, step.record.step_order);
      await touchJobHeartbeat(job.id);
      await this.ensureJobActive(job.id);
    }

    try {
      if (config.features.longformEnabled) {
        logger.info({ jobId: job.id }, "Longform pipeline enabled");
      }
      await this.ensureJobActive(job.id);
      const { report: baseReport, critic } = config.features.longformEnabled
        ? await this.buildLongformReport(job)
        : await this.buildFinalReport(job);
      const notes = await listNotes(job.id);
      const sources = await listSourcesByJob(job.id);
      const citationLedger = await listCitationLedger(job.id);
      const reportWithLinks = linkifyCitations(baseReport, citationLedger);
      const finalReport = appendReferencesToReport(reportWithLinks, citationLedger);
      await touchJobHeartbeat(job.id);
      if (critic) {
        await this.recordCriticFeedback(job, critic);
      }
      const assets = await buildReportArtifacts({
        job,
        finalReport,
        notes,
        sources,
        citationLedger,
      });
      await touchJobHeartbeat(job.id);
      await updateJobStatus(job.id, "completed", {
        final_report: finalReport,
        report_assets: assets,
        completed_at: new Date().toISOString(),
      });
      await this.recordCrossSummary(job, baseReport);
      jobStatusCounter.labels("completed").inc();
      stopJobTimer({ status: "completed" });
      logger.info({ jobId: job.id }, "Job completed");
      return;
    } catch (error) {
      if (error instanceof JobControlError) {
        jobStatusCounter.labels(error.status).inc();
        stopJobTimer({ status: error.status });
        logger.info({ jobId: job.id, status: error.status }, "Job halted by user action");
        return;
      }
      jobStatusCounter.labels("error").inc();
      stopJobTimer({ status: "error" });
      throw error;
    }
  }

  private isStepComplete(status?: string | null) {
    return status === "completed" || status === "partial";
  }

  private async planSteps(job: ResearchJob): Promise<PlannedStep[]> {
    const priorNotes = await listNotes(job.id);
    const priorContext = priorNotes
      .filter((n) => n.role === "cross_job_summary" || n.role === "step_summary")
      .map((n, idx) => `Note ${idx + 1}: ${n.content}`)
      .join("\n");
    const warmNotes = await this.fetchWarmNotes(job);
    const warmContext = warmNotes
      .map(
        (note, idx) =>
          `Archive Note ${idx + 1} (importance ${note.importance}): ${note.content}`,
      )
      .join("\n");
    const contextSections = [];
    if (priorContext) {
      contextSections.push("Job Notes:\n" + priorContext);
    }
    if (warmContext) {
      contextSections.push("Relevant Archive Notes:\n" + warmContext);
    }
    const combinedContext = contextSections.join("\n\n") || "(none)";

    const maxSteps = job.max_steps ?? config.worker.maxSteps;
    const plannerPrompt = prompts.planner.replace("{{MAX_STEPS}}", String(maxSteps));

    const response = await chatCompletion([
      { role: "system", content: plannerPrompt },
      {
        role: "user",
        content: `Question: ${job.question}\nContext:\n${combinedContext}`,
      },
    ]);

    try {
      const parsed = JSON.parse(response);
      if (Array.isArray(parsed)) {
        return parsed.slice(0, maxSteps);
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
    await this.ensureJobActive(job.id);
    await updateStep(stepId, "running");
    await touchJobHeartbeat(job.id);
    const query = `${job.question} :: ${plan.objective ?? "research"}`;
    const results = await this.runSearch(plan.tool_hint, query);
    if (!results.length) {
      await updateStep(stepId, "partial", { error: "No search results" });
      await touchJobHeartbeat(job.id);
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
        const fetched = await this.fetchSourceWithFallback(result.url);
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
      const importance = clampImportance(note.importance);
      const record = await insertNote({
        jobId: job.id,
        stepId,
        role: "page_summary",
        importance,
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
      const embedContent = clampForEmbedding(note.summary);
      await this.indexNote(record.id, embedContent, {
        job_id: job.id,
        step_id: stepId,
        role: "page_summary",
        importance,
        url: sources[i]?.url,
        title: sources[i]?.title,
      });
    }

    if (summary.step_summary) {
      const stepImportance = clampImportance(summary.step_importance);
      const record = await insertNote({
        jobId: job.id,
        stepId,
        role: "step_summary",
        importance: stepImportance,
        tokenCount: estimateTokens(summary.step_summary),
        content: summary.step_summary,
      });
      const embedContent = clampForEmbedding(summary.step_summary);
      await this.indexNote(record.id, embedContent, {
        job_id: job.id,
        step_id: stepId,
        role: "step_summary",
        importance: stepImportance,
      });
    }

    await updateStep(stepId, "completed", { sources: sources.length });
    await touchJobHeartbeat(job.id);
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
        recordToolError(tool ?? "unknown", "search");
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
    const stopTimer = startToolTimer("searxng");
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        recordToolError("searxng", "http");
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
    } finally {
      stopTimer();
    }
  }

  private async fetchSourceWithFallback(url: string) {
    try {
      return await n8nFetchUrl(url);
    } catch (error) {
      recordToolError("n8n_fetch", "workflow");
      logger.warn({ error, url }, "n8n fetch failed, falling back to direct fetch");
      return this.directFetchUrl(url);
    }
  }

  private async directFetchUrl(url: string) {
    const stopTimer = startToolTimer("http_fetch");
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: {
          "user-agent": "DeepResearchBot/1.0 (+https://oremuslabs.com)",
        },
      });
      if (!response.ok) {
        recordToolError("http_fetch", "http");
        throw new Error(`Direct fetch failed (${response.status})`);
      }
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType || contentType.includes("pdf") || contentType.includes("octet-stream")) {
        throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
      }
      const body = await response.text();
      const cleanBody = body
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : url;
      return {
        url,
        title,
        content: cleanBody,
        statusCode: response.status,
      };
    } finally {
      stopTimer();
    }
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

  private async fetchWarmNotes(job: ResearchJob): Promise<WarmNote[]> {
    try {
      const vector = await embedText(job.question);
      if (!vector.length) {
        return [];
      }
      const hits = await querySimilarNotes({
        vector,
        limit: config.worker.warmNotesLimit,
        minImportance: config.worker.warmImportanceMin,
        excludeJobId: job.id,
      });
      return hits.map((hit) => ({
        id: hit.id,
        content: String(hit.payload?.content ?? ""),
        importance: clampImportance(hit.payload?.importance as number),
        role: (hit.payload?.role as string) ?? undefined,
        jobId: (hit.payload?.job_id as string) ?? undefined,
      }));
    } catch (error) {
      logger.warn({ error, jobId: job.id }, "warm note retrieval failed");
      return [];
    }
  }

  private getSectionPlan(_job: ResearchJob): SectionSpec[] {
    return DEFAULT_SECTION_PLAN;
  }

  private async buildLongformReport(job: ResearchJob): Promise<{
    report: string;
    critic?: CriticFeedback;
  }> {
    await this.ensureJobActive(job.id);
    const sections = this.getSectionPlan(job);
    const notes = await listNotes(job.id);
    const sources = await listSourcesByJob(job.id);
    const sourcesByNote = this.groupSourcesByNote(sources);
    const renderedSections: { spec: SectionSpec; content: string }[] = [];

    for (const section of sections) {
      await this.ensureJobActive(job.id);
      const content = await this.generateSectionDraft(job, section, notes, sourcesByNote);
      if (content) {
        renderedSections.push({ spec: section, content });
      }
      await touchJobHeartbeat(job.id);
    }

    const bridged = renderedSections.map((entry, idx) => {
      if (idx === 0) {
        return entry.content;
      }
      const bridge = this.buildSectionBridge(renderedSections[idx - 1].spec, entry.spec);
      return `${bridge}\n\n${entry.content}`;
    });

    const combined = bridged.join("\n\n").trim();
    const notesText = this.buildNotesEvidence(notes);
    const sectionGuide = renderedSections
      .map((entry, idx) => `${idx + 1}. ${entry.spec.title} (key: ${entry.spec.key})`)
      .join("\n");
    const critic = await this.runCriticEvaluation(combined, notesText, sectionGuide);
    const report = this.mergeCriticIntoDraft(combined, critic);
    return { report, critic };
  }

  private buildSectionBridge(prev: SectionSpec, next: SectionSpec) {
    const focus = next.noteRoles.length ? next.noteRoles.join(", ") : "new findings";
    return `> _Transition:_ ${next.title} builds on ${prev.title}, focusing on ${focus}.`;
  }

  private async generateSectionDraft(
    job: ResearchJob,
    spec: SectionSpec,
    notes: NoteRecord[],
    sourcesByNote: Map<string, SourceRecord[]>,
  ): Promise<string | null> {
    const sorted = notes
      .filter((note) => spec.noteRoles.includes(note.role))
      .sort((a, b) => {
        if (b.importance !== a.importance) return b.importance - a.importance;
        return b.token_count - a.token_count;
      })
      .slice(0, spec.maxNotes);

    if (!sorted.length) {
      return null;
    }

    let draftRecord = await getSectionDraft(job.id, spec.key);
    if (!draftRecord) {
      draftRecord = await createSectionDraft({
        jobId: job.id,
        sectionKey: spec.key,
      });
    }

    const paragraphs: string[] = [];
    const citationMap: { noteId: string; citations: number[] }[] = [];
    for (const note of sorted) {
      const sources = sourcesByNote.get(note.id) ?? [];
      const rendered = await this.renderNoteWithCitations(job.id, note, sources);
      paragraphs.push(rendered.text);
      if (rendered.citations.length) {
        citationMap.push({ noteId: note.id, citations: rendered.citations });
      }
    }

    const content = [`## ${spec.title}`, "", ...paragraphs].join("\n");

    await updateSectionDraft(draftRecord.id, {
      status: "completed",
      tokens: estimateTokens(content),
      content,
      citationMap: { citations: citationMap },
    });
    await touchJobHeartbeat(job.id);

    logger.info({ jobId: job.id, section: spec.key }, "Section draft completed");
    return content;
  }

  private async renderNoteWithCitations(
    jobId: string,
    note: NoteRecord,
    sources: SourceRecord[],
  ): Promise<{ text: string; citations: number[] }> {
    const citations: number[] = [];
    for (const source of sources) {
      if (!source.url && !source.raw_storage_url) {
        continue;
      }
      const number = await this.ensureCitationNumber(jobId, source);
      citations.push(number);
    }
    const suffix = citations.length ? ` ${citations.map((n) => `[${n}](#ref-${n})`).join("")}` : "";
    return { text: `${note.content}${suffix}`, citations };
  }

  private async ensureCitationNumber(jobId: string, source: SourceRecord): Promise<number> {
    const hash = this.hashSource(source);
    let entry = await findCitationByHash(jobId, hash);
    if (!entry) {
      const next = await getNextCitationNumber(jobId);
      entry = await insertCitationLedgerEntry({
        jobId,
        sourceHash: hash,
        sourceId: source.id,
        citationNumber: next,
        title: source.title ?? source.url ?? undefined,
        url: source.url ?? undefined,
        accessedAt: new Date().toISOString(),
      });
    }
    return entry.citation_number;
  }

  private hashSource(source: SourceRecord) {
    const input = `${source.url ?? ""}|${source.title ?? ""}|${source.raw_storage_url ?? ""}`;
    return createHash("sha1").update(input).digest("hex");
  }

  private groupSourcesByNote(sources: SourceRecord[]) {
    const map = new Map<string, SourceRecord[]>();
    for (const source of sources) {
      if (!source.note_id) continue;
      const list = map.get(source.note_id) ?? [];
      list.push(source);
      map.set(source.note_id, list);
    }
    return map;
  }

  private buildNotesEvidence(notes: NoteRecord[]) {
    const selected = this.selectNotesForSynthesis(notes);
    return selected
      .slice(0, config.worker.maxNotesForSynth)
      .map((note, idx) => `Note ${idx + 1} (${note.role}, importance ${note.importance}): ${note.content}`)
      .join("\n\n");
  }
  private async buildFinalReport(job: ResearchJob): Promise<{
    report: string;
    critic?: CriticFeedback;
  }> {
    const notes = await listNotes(job.id);
    const selected = this.selectNotesForSynthesis(notes);
    let budget = config.llm.maxContext - 2000 - config.llm.maxTokens;
    const packed: typeof notes = [];
    for (const note of selected) {
      if (packed.length >= config.worker.maxNotesForSynth) {
        break;
      }
      if (budget - note.token_count <= 0) {
        continue;
      }
      packed.push(note);
      budget -= note.token_count;
    }

    const notesText = packed
      .map((note, idx) => `Note ${idx + 1} (${note.role}, importance ${note.importance}): ${note.content}`)
      .join("\n\n");

    const draft = await chatCompletion([
      { role: "system", content: prompts.synthesizer },
      {
        role: "user",
        content: `Question: ${job.question}\nEvidence:\n${notesText}`,
      },
    ]);
    await touchJobHeartbeat(job.id);

    const critic = await this.runCriticEvaluation(draft, notesText);
    await touchJobHeartbeat(job.id);
    return { report: this.mergeCriticIntoDraft(draft, critic), critic };
  }

  private selectNotesForSynthesis(notes: NoteRecord[]) {
    return [...notes].sort((a, b) => {
      if (b.importance !== a.importance) {
        return b.importance - a.importance;
      }
      return b.token_count - a.token_count;
    });
  }

  private async recordCriticFeedback(job: ResearchJob, critic: CriticFeedback) {
    const parts: string[] = [];
    if (critic.limitations) {
      parts.push(`Limitations: ${critic.limitations}`);
    }
    if (critic.issues?.length) {
      parts.push(`Issues: ${critic.issues.join("; ")}`);
    }
    if (critic.follow_up?.length) {
      parts.push(`Follow-up ideas: ${critic.follow_up.join("; ")}`);
    }
    const text = parts.join("\n").trim();
    if (!text) {
      return;
    }
    const note = await insertNote({
      jobId: job.id,
      role: "critic_note",
      importance: 3,
      tokenCount: estimateTokens(text),
      content: text,
    });
    const embedTextContent = clampForEmbedding(text);
    await this.indexNote(note.id, embedTextContent, {
      job_id: job.id,
      role: "critic_note",
      importance: 3,
    });
    await touchJobHeartbeat(job.id);
  }

  private async recordCrossSummary(job: ResearchJob, report: string) {
    const text = `Question: ${job.question}\nSummary:\n${report}`;
    const note = await insertNote({
      jobId: job.id,
      role: "cross_job_summary",
      importance: 4,
      tokenCount: estimateTokens(text),
      content: text,
    });
    const embedTextContent = clampForEmbedding(text);
    await this.indexNote(note.id, embedTextContent, {
      job_id: job.id,
      role: "cross_job_summary",
      importance: 4,
    });
    await touchJobHeartbeat(job.id);
  }

  private async runCriticEvaluation(draft: string, notesText: string, sectionGuide?: string) {
    const criticInput = `Draft report:\n${draft}\n\nSections:\n${sectionGuide ?? "(not provided)"}\n\nNotes:\n${notesText}`;
    const criticRaw = await chatCompletion([
      { role: "system", content: prompts.critic },
      { role: "user", content: criticInput },
    ]);

    try {
      return JSON.parse(criticRaw) as CriticFeedback;
    } catch (error) {
      logger.warn({ error }, "Critic output parse failed");
      return undefined;
    }
  }

  private mergeCriticIntoDraft(draft: string, critic?: CriticFeedback) {
    if (!critic || !critic.limitations) {
      return draft;
    }
    const issues = critic.issues?.length ? `\nIssues: ${critic.issues.join(", ")}` : "";
    return `${draft}\n\nLimitations & Critic Notes:\n${critic.limitations}${issues}`;
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
      await upsertNoteVector(noteId, vector, {
        ...payload,
        content: text,
      });
    } catch (error) {
      logger.error({ error }, "Embedding/Qdrant failed for note");
    }
  }

  private async ensureJobActive(jobId: string) {
    const snapshot = await getJob(jobId);
    if (!snapshot) {
      throw new Error("Job record missing during execution");
    }
    if (snapshot.status === "paused") {
      throw new JobControlError("paused");
    }
    if (snapshot.status === "cancelled") {
      throw new JobControlError("cancelled");
    }
    if (snapshot.status === "clarification_required") {
      throw new JobControlError("clarification_required");
    }
  }
}

function clampImportance(value?: number) {
  const num = Number.isFinite(value) ? Number(value) : 3;
  return Math.min(5, Math.max(1, Math.round(num)));
}

function appendReferencesToReport(report: string, ledger: CitationLedgerRecord[]) {
  if (!ledger.length) {
    return report;
  }
  const lines = ledger
    .map((entry) => {
      const title = entry.title ?? entry.url ?? "Untitled Source";
      const anchor = `ref-${entry.citation_number}`;
      const renderedLink = entry.url ? `[${title}](${entry.url})` : title;
      return `<a id="${anchor}"></a>[${entry.citation_number}] ${renderedLink}`;
    })
    .join("\n");
  const separator = report.trim().endsWith("\n") ? "" : "\n";
  return `${report.trim()}${separator}\n\n## References\n${lines}`;
}

function linkifyCitations(report: string, ledger: CitationLedgerRecord[]) {
  if (!ledger.length) {
    return report;
  }
  const validNumbers = new Set(ledger.map((entry) => entry.citation_number));
  return report.replace(/\[(\d+)\](?!\()/g, (match, group) => {
    const num = Number(group);
    if (!validNumbers.has(num)) {
      return match;
    }
    return `[${num}](#ref-${num})`;
  });
}
