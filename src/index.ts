import path from "node:path";
import fs from "node:fs";
import Fastify, { FastifyInstance, FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import sensible from "fastify-sensible";
import { z } from "zod";
import { config } from "./config";
import { logger } from "./logger";
import { runMigrations } from "./migrate";
import {
  deleteJob,
  enqueueJob,
  getJob,
  listNotes,
  listRecentJobs,
  listSteps,
  updateJobStatus,
} from "./repositories/jobRepository";
import { Worker } from "./services/worker";
import { JobStatus } from "./types/job";
import { metricsRegistry } from "./metrics";
import { extractKeyFromUrl, getObjectStream } from "./services/minioClient";
import { ReportAssets } from "./types/job";

type ClarificationPrompt = { key: string; prompt: string };

const metadataSchema = z
  .object({
    source: z.string().optional(),
    user_id: z.string().optional(),
    request_id: z.string().optional(),
    time_horizon: z.string().optional(),
    region_focus: z.string().optional(),
    data_modalities: z.union([z.string(), z.array(z.string())]).optional(),
    integration_targets: z.union([z.string(), z.array(z.string())]).optional(),
    quality_constraints: z.string().optional(),
  })
  .passthrough();

const REQUIRED_METADATA_FIELDS: ClarificationPrompt[] = [
  {
    key: "time_horizon",
    prompt: "What time horizon should this research focus on (e.g., current state, 12-18 months, 3-5 year outlook)?",
  },
  {
    key: "region_focus",
    prompt: "Which geographic regions or regulatory domains are in scope (e.g., US, EU/GDPR, APAC)?",
  },
  {
    key: "data_modalities",
    prompt: "List the data modalities that must be analyzed (blogs, PDFs, scraped HTML, structured CSV/JSON, etc.).",
  },
  {
    key: "integration_targets",
    prompt: "Which enterprise systems must consume this report (knowledge graph, SharePoint, MDM, ticketing, etc.)?",
  },
  {
    key: "quality_constraints",
    prompt: "Specify any tone, compliance, or quality constraints (red lines, citation expectations, reviewer needs).",
  },
];

function hasMetadataValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasMetadataValue(entry));
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

function collectClarificationPrompts(metadata?: Record<string, unknown> | null): ClarificationPrompt[] {
  const bag = metadata ?? {};
  return REQUIRED_METADATA_FIELDS.filter((field) => !hasMetadataValue(bag[field.key]))
    .map((field) => ({ key: field.key, prompt: field.prompt }));
}

const worker = new Worker();
const createSchema = z.object({
  question: z.string().min(4),
  options: z
    .object({
      depth: z.enum(["quick", "normal", "deep"]).optional(),
      max_steps: z.number().optional(),
      max_duration_seconds: z.number().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
  metadata: metadataSchema.optional(),
});
const idParamSchema = z.object({ id: z.string().uuid() });
type ReportFormat = "markdown" | "pdf" | "docx";
type ReportAssetField = "markdown_url" | "pdf_url" | "docx_url";

const reportDownloadParamSchema = idParamSchema.extend({
  format: z.enum(["markdown", "pdf", "docx"] as const),
});

const clarificationSchema = z.object({
  responses: metadataSchema.default({}),
});

const REPORT_ASSET_CONFIG: Record<ReportFormat, { field: ReportAssetField; contentType: string; filename: string }> = {
  markdown: {
    field: "markdown_url",
    contentType: "text/markdown; charset=utf-8",
    filename: "report.md",
  },
  pdf: {
    field: "pdf_url",
    contentType: "application/pdf",
    filename: "report.pdf",
  },
  docx: {
    field: "docx_url",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    filename: "report.docx",
  },
};

async function buildServer() {
  await runMigrations();
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });
  await app.register(sensible);

  const uiDistPath = path.join(__dirname, "..", "ui-dist");
  if (fs.existsSync(uiDistPath)) {
    await app.register(fastifyStatic, {
      root: uiDistPath,
      prefix: "/ui/",
      list: false,
    });
    app.get("/", async (_request, reply) => reply.redirect("/ui/"));
    app.get("/ui", async (_request, reply) => reply.sendFile("index.html"));
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/ui/") || request.url === "/ui") {
        return reply.sendFile("index.html");
      }
      reply.status(404).send({ error: "Not Found" });
    });
  } else {
    app.log.warn({ uiDistPath }, "UI build directory not found. Skipping static assets.");
  }

  app.addHook("onRequest", async (request, reply) => {
    if (
      request.url.startsWith("/healthz") ||
      request.url.startsWith("/metrics") ||
      request.url.startsWith("/ui") ||
      request.url.startsWith("/ui-api")
    ) {
      return;
    }
    const header = request.headers["x-api-key"];
    if (header !== config.apiKey) {
      reply.code(401);
      throw new Error("Unauthorized");
    }
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/metrics", async (_, reply) => {
    reply.header("content-type", metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });

  app.post("/research", async (request, reply) => {
    const body = createSchema.parse(request.body ?? {});
    const job = await createJobFromPayload(body);
    reply.code(201);
    return { job_id: job.id, status: job.status };
  });

  app.get("/research", async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().min(1).max(100).optional(),
      })
      .parse(request.query ?? {});
    const jobs = await listRecentJobs(query.limit ?? 20);
    return {
      jobs: jobs.map((job) => ({
        job_id: job.id,
        question: job.question,
        status: job.status,
        created_at: job.created_at,
        updated_at: job.updated_at,
        has_report: Boolean(job.final_report),
      })),
    };
  });

  app.get("/research/:id", async (request) => {
    const params = idParamSchema.parse(request.params);
    return buildJobResponse(app, params.id);
  });

  app.post("/research/:id/cancel", async (request) => {
    const params = idParamSchema.parse(request.params);
    return cancelJobById(app, params.id);
  });

  app.post("/research/:id/pause", async (request) => {
    const params = idParamSchema.parse(request.params);
    return pauseJobById(app, params.id);
  });

  app.post("/research/:id/start", async (request) => {
    const params = idParamSchema.parse(request.params);
    return startJobById(app, params.id);
  });

  app.post("/research/:id/clarify", async (request) => {
    const params = idParamSchema.parse(request.params);
    const body = clarificationSchema.parse(request.body ?? {});
    return submitClarification(app, params.id, body.responses);
  });

  app.delete("/research/:id", async (request) => {
    const params = idParamSchema.parse(request.params);
    return deleteJobById(app, params.id);
  });

  app.post("/ui-api/research", async (request, reply) => {
    const body = createSchema.parse(request.body ?? {});
    const job = await createJobFromPayload(body, { source: "deep-research-ui" });
    reply.code(201);
    return { job_id: job.id, status: job.status };
  });

  app.get("/ui-api/research", async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().min(1).max(100).optional(),
      })
      .parse(request.query ?? {});
    const jobs = await listRecentJobs(query.limit ?? 20);
    return {
      jobs: jobs.map((job) => ({
        job_id: job.id,
        question: job.question,
        status: job.status,
        created_at: job.created_at,
        updated_at: job.updated_at,
        has_report: Boolean(job.final_report),
      })),
    };
  });

  app.get("/ui-api/research/:id", async (request) => {
    const params = idParamSchema.parse(request.params);
    return buildJobResponse(app, params.id);
  });

  app.post("/ui-api/research/:id/clarify", async (request) => {
    const params = idParamSchema.parse(request.params);
    const body = clarificationSchema.parse(request.body ?? {});
    return submitClarification(app, params.id, body.responses);
  });

  app.get("/research/:id/report/:format", async (request, reply) => {
    const params = reportDownloadParamSchema.parse(request.params);
    return streamReportAsset(app, params.id, params.format, reply);
  });

  app.get("/ui-api/research/:id/report/:format", async (request, reply) => {
    const params = reportDownloadParamSchema.parse(request.params);
    return streamReportAsset(app, params.id, params.format, reply);
  });

  app.post("/ui-api/research/:id/cancel", async (request) => {
    const params = idParamSchema.parse(request.params);
    return cancelJobById(app, params.id);
  });

  app.post("/ui-api/research/:id/pause", async (request) => {
    const params = idParamSchema.parse(request.params);
    return pauseJobById(app, params.id);
  });

  app.post("/ui-api/research/:id/start", async (request) => {
    const params = idParamSchema.parse(request.params);
    return startJobById(app, params.id);
  });

  app.delete("/ui-api/research/:id", async (request) => {
    const params = idParamSchema.parse(request.params);
    return deleteJobById(app, params.id);
  });

  worker.start();
  return app;
}

type CreatePayload = z.infer<typeof createSchema>;

async function createJobFromPayload(
  body: CreatePayload,
  metadataDefaults?: Record<string, unknown>,
) {
  const metadata = { ...(body.metadata ?? {}) };
  if (metadataDefaults) {
    for (const [key, value] of Object.entries(metadataDefaults)) {
      if (metadata[key] === undefined) {
        metadata[key] = value;
      }
    }
  }
  const outstandingPrompts = collectClarificationPrompts(metadata);
  const initialStatus: JobStatus = outstandingPrompts.length ? "clarification_required" : "queued";
  return enqueueJob({
    question: body.question,
    options: body.options ?? {},
    metadata,
    depth: body.options?.depth,
    maxSteps: body.options?.max_steps ?? config.worker.maxSteps,
    maxDurationSeconds: body.options?.max_duration_seconds ?? config.worker.maxJobSeconds,
    status: initialStatus,
  });
}

async function buildJobResponse(app: FastifyInstance, jobId: string) {
  const job = await getJob(jobId);
  if (!job) {
    throw app.httpErrors.notFound("job not found");
  }
  const steps = await listSteps(job.id);
  const notes = await listNotes(job.id);
  const completed = steps.filter((step) => step.status === "completed").length;
  const clarificationPrompts = collectClarificationPrompts(job.metadata ?? {});
  return {
    job_id: job.id,
    status: job.status,
    question: job.question,
    created_at: job.created_at,
    updated_at: job.updated_at,
    final_report: job.final_report,
    assets: job.report_assets ?? null,
    metadata: job.metadata ?? {},
    clarification_prompts: clarificationPrompts,
    steps: steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      order: step.step_order,
      tool_hint: step.tool_hint,
      theme: step.theme,
      iteration: step.iteration ?? 0,
    })),
    progress: {
      total_steps: steps.length,
      completed_steps: completed,
    },
    notes: notes.map((note) => ({
      id: note.id,
      role: note.role,
      importance: note.importance,
      token_count: note.token_count,
    })),
    error: job.error ?? null,
  };
}

async function submitClarification(
  app: FastifyInstance,
  jobId: string,
  responses: Record<string, unknown>,
) {
  const job = await fetchJobOrThrow(app, jobId);
  if (job.status !== "clarification_required") {
    throw app.httpErrors.badRequest("Job does not require clarification");
  }
  const mergedMetadata = { ...(job.metadata ?? {}), ...responses };
  const remaining = collectClarificationPrompts(mergedMetadata);
  const nextStatus: JobStatus = remaining.length ? "clarification_required" : "queued";
  await updateJobStatus(job.id, nextStatus, {
    metadata: mergedMetadata,
    error: null,
  });
  return buildJobResponse(app, job.id);
}

type JobMutationResult = { job_id: string; status: JobStatus };
type JobDeleteResult = { job_id: string; deleted: true };

async function fetchJobOrThrow(app: FastifyInstance, jobId: string) {
  const job = await getJob(jobId);
  if (!job) {
    throw app.httpErrors.notFound("job not found");
  }
  return job;
}

async function cancelJobById(app: FastifyInstance, jobId: string): Promise<JobMutationResult> {
  const job = await fetchJobOrThrow(app, jobId);
  if (job.status === "cancelled") {
    return { job_id: job.id, status: "cancelled" };
  }
  if (job.status === "completed") {
    throw app.httpErrors.badRequest("Job already completed");
  }
  await updateJobStatus(job.id, "cancelled");
  return { job_id: job.id, status: "cancelled" };
}

async function pauseJobById(app: FastifyInstance, jobId: string): Promise<JobMutationResult> {
  const job = await fetchJobOrThrow(app, jobId);
  if (job.status === "paused") {
    return { job_id: job.id, status: "paused" };
  }
  if (job.status === "running" || job.status === "queued") {
    await updateJobStatus(job.id, "paused");
    return { job_id: job.id, status: "paused" };
  }
  throw app.httpErrors.badRequest(`Cannot pause job in status ${job.status}`);
}

async function startJobById(app: FastifyInstance, jobId: string): Promise<JobMutationResult> {
  const job = await fetchJobOrThrow(app, jobId);
  if (job.status !== "paused") {
    throw app.httpErrors.badRequest(`Cannot start job in status ${job.status}`);
  }
  await updateJobStatus(job.id, "queued", {
    error: null,
    final_report: null,
    report_assets: null,
    completed_at: null,
  });
  return { job_id: job.id, status: "queued" };
}

async function deleteJobById(app: FastifyInstance, jobId: string): Promise<JobDeleteResult> {
  const job = await fetchJobOrThrow(app, jobId);
  if (job.status === "running") {
    throw app.httpErrors.badRequest("Pause or cancel the job before deleting it");
  }
  await deleteJob(job.id);
  return { job_id: job.id, deleted: true };
}

async function streamReportAsset(
  app: FastifyInstance,
  jobId: string,
  format: ReportFormat,
  reply: FastifyReply,
) {
  const job = await fetchJobOrThrow(app, jobId);
  if (!job.report_assets) {
    throw app.httpErrors.notFound("Report assets not available");
  }
  const descriptor = REPORT_ASSET_CONFIG[format];
  const assetUrl = job.report_assets[descriptor.field];
  if (!assetUrl) {
    throw app.httpErrors.notFound("Requested asset not available");
  }
  const key = extractKeyFromUrl(assetUrl);
  if (!key) {
    throw app.httpErrors.internalServerError("Invalid asset key");
  }
  try {
    const object = await getObjectStream(key);
    reply.header("Content-Type", object.contentType ?? descriptor.contentType);
    if (object.contentLength !== undefined) {
      reply.header("Content-Length", String(object.contentLength));
    }
    reply.header("Content-Disposition", `attachment; filename=${descriptor.filename}`);
    if (object.etag) {
      reply.header("ETag", object.etag);
    }
    if (object.lastModified) {
      reply.header("Last-Modified", object.lastModified.toUTCString());
    }
    if (object.checksumSHA256) {
      reply.header("x-amz-checksum-sha256", object.checksumSHA256);
    }
    return reply.send(object.stream);
  } catch (error) {
    app.log.error({ error, jobId, format }, "Failed to stream report asset");
    throw app.httpErrors.internalServerError("Unable to download report asset");
  }
}

buildServer()
  .then((app) => {
    app.listen({ port: config.port, host: "0.0.0.0" }, (err, address) => {
      if (err) {
        app.log.error(err);
        process.exit(1);
      }
      app.log.info(`Server listening on ${address}`);
    });
  })
  .catch((err) => {
    logger.error({ err }, "Failed to start server");
    process.exit(1);
  });
