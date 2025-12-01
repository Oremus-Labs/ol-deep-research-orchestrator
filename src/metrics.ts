import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const jobStatusCounter = new Counter({
  name: "deep_research_jobs_total",
  help: "Total deep research jobs processed, by status",
  labelNames: ["status"],
  registers: [metricsRegistry],
});

export const jobDurationHistogram = new Histogram({
  name: "deep_research_job_duration_seconds",
  help: "End-to-end job duration in seconds",
  buckets: [30, 60, 120, 300, 600, 1200, 2400],
  labelNames: ["status"],
  registers: [metricsRegistry],
});

export const toolLatencyHistogram = new Histogram({
  name: "deep_research_tool_latency_seconds",
  help: "Latency for external tool calls",
  buckets: [0.5, 1, 2, 5, 10, 20, 30],
  labelNames: ["tool"],
  registers: [metricsRegistry],
});

export const toolErrorsCounter = new Counter({
  name: "deep_research_tool_errors_total",
  help: "External tool failures by tool and stage",
  labelNames: ["tool", "stage"],
  registers: [metricsRegistry],
});

export const minioUploadsCounter = new Counter({
  name: "deep_research_minio_uploads_total",
  help: "Completed MinIO uploads by status",
  labelNames: ["status"],
  registers: [metricsRegistry],
});

export const jobRescueCounter = new Counter({
  name: "deep_research_job_rescues_total",
  help: "Jobs automatically requeued due to staleness",
  labelNames: ["reason"],
  registers: [metricsRegistry],
});

export function startToolTimer(tool: string) {
  return toolLatencyHistogram.startTimer({ tool });
}

export function recordToolError(tool: string, stage: string) {
  toolErrorsCounter.labels(tool, stage).inc();
}

export function recordMinioUpload(status: "success" | "error") {
  minioUploadsCounter.labels(status).inc();
}
