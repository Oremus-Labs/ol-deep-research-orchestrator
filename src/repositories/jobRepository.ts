import { PoolClient, QueryResult } from "pg";
import { pool } from "../db";
import { JobStatus, ResearchJob, SourceRecord } from "../types/job";

interface EnqueueInput {
  question: string;
  options: Record<string, unknown>;
  metadata: Record<string, unknown>;
  depth?: string;
  maxSteps?: number;
  maxDurationSeconds?: number;
}

export async function enqueueJob(input: EnqueueInput): Promise<ResearchJob> {
  const result = await pool.query<ResearchJob>(
    `INSERT INTO research_jobs (question, options, metadata, status, depth, max_steps, max_duration_seconds)
     VALUES ($1, $2, $3, 'queued', $4, $5, $6)
     RETURNING *`,
    [
      input.question,
      input.options ?? {},
      input.metadata ?? {},
      input.depth ?? null,
      input.maxSteps ?? null,
      input.maxDurationSeconds ?? null,
    ],
  );
  return result.rows[0];
}

export async function getJob(jobId: string): Promise<ResearchJob | null> {
  const { rows } = await pool.query<ResearchJob>(
    "SELECT * FROM research_jobs WHERE id = $1",
    [jobId],
  );
  return rows[0] ?? null;
}

export async function listSteps(jobId: string) {
  const { rows } = await pool.query(
    "SELECT * FROM research_steps WHERE job_id = $1 ORDER BY step_order",
    [jobId],
  );
  return rows;
}

export async function claimNextQueuedJob(client?: PoolClient) {
  const runner = client ?? (await pool.connect());
  let job: QueryResult<ResearchJob> | null = null;
  try {
    await runner.query("BEGIN");
    job = await runner.query<ResearchJob>(
      `SELECT * FROM research_jobs
       WHERE status = 'queued'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    if (!job.rows.length) {
      await runner.query("COMMIT");
      return null;
    }
    const current = job.rows[0];
    await runner.query(
      `UPDATE research_jobs SET status='running', started_at = now(), updated_at = now()
       WHERE id = $1`,
      [current.id],
    );
    await runner.query("COMMIT");
    return current;
  } catch (error) {
    await runner.query("ROLLBACK");
    throw error;
  } finally {
    if (!client) {
      runner.release();
    }
  }
}

export async function updateJobStatus(
  jobId: string,
  status: JobStatus,
  fields: Partial<ResearchJob> = {},
) {
  const updates: string[] = ["status = $2", "updated_at = now()"];
  const values: unknown[] = [jobId, status];
  let idx = values.length + 1;
  for (const [key, value] of Object.entries(fields)) {
    updates.push(`${key} = $${idx++}`);
    values.push(value);
  }
  const sql = `UPDATE research_jobs SET ${updates.join(", ")} WHERE id = $1`;
  await pool.query(sql, values);
}

export async function insertStep(
  jobId: string,
  title: string,
  order: number,
  toolHint?: string,
) {
  const { rows } = await pool.query(
    `INSERT INTO research_steps (job_id, title, step_order, status, tool_hint)
     VALUES ($1, $2, $3, 'pending', $4)
     RETURNING *`,
    [jobId, title, order, toolHint ?? null],
  );
  return rows[0];
}

export async function updateStep(
  stepId: string,
  status: string,
  result?: Record<string, unknown>,
) {
  await pool.query(
    `UPDATE research_steps
     SET status = $2, result = $3, updated_at = now()
     WHERE id = $1`,
    [stepId, status, result ?? null],
  );
}

export async function insertNote(params: {
  jobId: string;
  stepId?: string;
  role: string;
  importance: number;
  tokenCount: number;
  content: string;
  sourceUrl?: string;
}) {
  const { rows } = await pool.query(
    `INSERT INTO notes (job_id, step_id, role, importance, token_count, content, source_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.jobId,
      params.stepId ?? null,
      params.role,
      params.importance,
      params.tokenCount,
      params.content,
      params.sourceUrl ?? null,
    ],
  );
  return rows[0];
}

export async function attachSource(
  noteId: string,
  source: {
    url?: string;
    title?: string;
    snippet?: string;
    raw_storage_url?: string;
  },
) {
  await pool.query(
    `INSERT INTO sources (note_id, url, title, snippet, raw_storage_url)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      noteId,
      source.url ?? null,
      source.title ?? null,
      source.snippet ?? null,
      source.raw_storage_url ?? null,
    ],
  );
}

export async function listNotes(jobId: string) {
  const { rows } = await pool.query(
    `SELECT * FROM notes WHERE job_id = $1 ORDER BY importance DESC, created_at`,
    [jobId],
  );
  return rows;
}

export async function listRecentJobs(limit: number) {
  const { rows } = await pool.query<ResearchJob>(
    `SELECT id, question, status, created_at, updated_at, final_report
     FROM research_jobs
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function listSourcesByJob(jobId: string): Promise<SourceRecord[]> {
  const { rows } = await pool.query<SourceRecord>(
    `SELECT s.*
     FROM sources s
     INNER JOIN notes n ON n.id = s.note_id
     WHERE n.job_id = $1
     ORDER BY s.created_at`,
    [jobId],
  );
  return rows;
}
