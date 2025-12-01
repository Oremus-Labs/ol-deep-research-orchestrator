import Fastify from "fastify";
import sensible from "fastify-sensible";
import { z } from "zod";
import { config } from "./config";
import { logger } from "./logger";
import { runMigrations } from "./migrate";
import { enqueueJob, getJob, listNotes, listSteps, updateJobStatus } from "./repositories/jobRepository";
import { Worker } from "./services/worker";

const worker = new Worker();

async function buildServer() {
  await runMigrations();
  const app = Fastify({ logger });
  await app.register(sensible);

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/healthz")) {
      return;
    }
    const header = request.headers["x-api-key"];
    if (header !== config.apiKey) {
      reply.code(401);
      throw new Error("Unauthorized");
    }
  });

  app.get("/healthz", async () => ({ status: "ok" }));

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

  app.post("/research", async (request, reply) => {
    const body = createSchema.parse(request.body ?? {});
    const job = await enqueueJob({
      question: body.question,
      options: body.options ?? {},
      metadata: body.metadata ?? {},
      depth: body.options?.depth,
      maxSteps: body.options?.max_steps ?? config.worker.maxSteps,
      maxDurationSeconds:
        body.options?.max_duration_seconds ?? config.worker.maxJobSeconds,
    });
    reply.code(201);
    return { job_id: job.id, status: job.status };
  });

  app.get("/research/:id", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const job = await getJob(params.id);
    if (!job) {
      throw app.httpErrors.notFound("job not found");
    }
    const steps = await listSteps(job.id);
    const completed = steps.filter((step) => step.status === "completed").length;
    const notes = await listNotes(job.id);
    return {
      job_id: job.id,
      status: job.status,
      question: job.question,
      created_at: job.created_at,
      updated_at: job.updated_at,
      final_report: job.final_report,
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
    };
  });

  app.post("/research/:id/cancel", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
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

  worker.start();
  return app;
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
