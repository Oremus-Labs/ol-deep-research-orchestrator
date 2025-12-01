import path from "node:path";
import fs from "node:fs";
import Fastify, { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import sensible from "fastify-sensible";
import { z } from "zod";
import { config } from "./config";
import { logger } from "./logger";
import { runMigrations } from "./migrate";
import { enqueueJob, getJob, listNotes, listSteps, updateJobStatus } from "./repositories/jobRepository";
import { Worker } from "./services/worker";
import { metricsRegistry } from "./metrics";

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
  metadata: z
    .object({
      source: z.string().optional(),
      user_id: z.string().optional(),
      request_id: z.string().optional(),
    })
    .passthrough()
    .optional(),
});
const idParamSchema = z.object({ id: z.string().uuid() });

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
    app.get("/ui", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/ui/*", async (_request, reply) => reply.sendFile("index.html"));
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

  app.get("/research/:id", async (request) => {
    const params = idParamSchema.parse(request.params);
    return buildJobResponse(app, params.id);
  });

  app.post("/research/:id/cancel", async (request) => {
    const params = idParamSchema.parse(request.params);
    const job = await getJob(params.id);
    if (!job) {
      throw app.httpErrors.notFound("job not found");
    }
    if (job.status === "completed" || job.status === "cancelled") {
      return { job_id: job.id, status: job.status };
    }
    await updateJobStatus(job.id, "cancelled");
    return { job_id: job.id, status: "cancelled" };
  });

  app.post("/ui-api/research", async (request, reply) => {
    const body = createSchema.parse(request.body ?? {});
    const job = await createJobFromPayload(body, { source: "deep-research-ui" });
    reply.code(201);
    return { job_id: job.id, status: job.status };
  });

  app.get("/ui-api/research/:id", async (request) => {
    const params = idParamSchema.parse(request.params);
    return buildJobResponse(app, params.id);
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
  return enqueueJob({
    question: body.question,
    options: body.options ?? {},
    metadata,
    depth: body.options?.depth,
    maxSteps: body.options?.max_steps ?? config.worker.maxSteps,
    maxDurationSeconds: body.options?.max_duration_seconds ?? config.worker.maxJobSeconds,
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
  return {
    job_id: job.id,
    status: job.status,
    question: job.question,
    created_at: job.created_at,
    updated_at: job.updated_at,
    final_report: job.final_report,
    assets: job.report_assets ?? null,
    steps: steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      order: step.step_order,
      tool_hint: step.tool_hint,
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
