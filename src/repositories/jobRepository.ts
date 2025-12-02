import { PoolClient, QueryResult } from "pg";
import { pool } from "../db";
import {
  CitationLedgerRecord,
  JobStatus,
  ResearchJob,
  ResearchStep,
  SectionDraftRecord,
  SourceRecord,
} from "../types/job";

interface EnqueueInput {
  question: string;
  options: Record<string, unknown>;
  metadata: Record<string, unknown>;
  depth?: string;
  maxSteps?: number;
  maxDurationSeconds?: number;
  status?: JobStatus;
}

export async function enqueueJob(input: EnqueueInput): Promise<ResearchJob> {
  const result = await pool.query<ResearchJob>(
    `INSERT INTO research_jobs (question, options, metadata, status, depth, max_steps, max_duration_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.question,
      input.options ?? {},
      input.metadata ?? {},
      input.status ?? "queued",
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

export async function listSteps(jobId: string): Promise<ResearchStep[]> {
  const { rows } = await pool.query<ResearchStep>(
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
      `UPDATE research_jobs
          SET status='running', started_at = now(), updated_at = now(), last_heartbeat = now()
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
  const updates: string[] = ["status = $2", "updated_at = now()", "last_heartbeat = now()"];
  const values: unknown[] = [jobId, status];
  let idx = values.length + 1;
  for (const [key, value] of Object.entries(fields)) {
    updates.push(`${key} = $${idx++}`);
    values.push(value);
  }
  const sql = `UPDATE research_jobs SET ${updates.join(", ")} WHERE id = $1`;
  await pool.query(sql, values);
}

export async function deleteJob(jobId: string) {
  await pool.query("DELETE FROM research_jobs WHERE id = $1", [jobId]);
}

export async function insertStep(
  jobId: string,
  title: string,
  order: number,
  toolHint?: string,
  theme?: string,
  iteration?: number,
) {
  const { rows } = await pool.query(
    `INSERT INTO research_steps (job_id, title, step_order, status, tool_hint, theme, iteration)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6)
     RETURNING *`,
    [jobId, title, order, toolHint ?? null, theme ?? null, iteration ?? 0],
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

export async function findCitationByHash(
  jobId: string,
  sourceHash: string,
): Promise<CitationLedgerRecord | null> {
  const { rows } = await pool.query<CitationLedgerRecord>(
    `SELECT * FROM citation_ledger WHERE job_id = $1 AND source_hash = $2`,
    [jobId, sourceHash],
  );
  return rows[0] ?? null;
}

export async function insertCitationLedgerEntry(params: {
  jobId: string;
  sourceHash: string;
  sourceId?: string;
  citationNumber: number;
  title?: string;
  url?: string;
  accessedAt?: string;
}): Promise<CitationLedgerRecord> {
  const { rows } = await pool.query<CitationLedgerRecord>(
    `INSERT INTO citation_ledger
     (job_id, source_hash, source_id, citation_number, title, url, accessed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.jobId,
      params.sourceHash,
      params.sourceId ?? null,
      params.citationNumber,
      params.title ?? null,
      params.url ?? null,
      params.accessedAt ?? null,
    ],
  );
  return rows[0];
}

export async function listCitationLedger(
  jobId: string,
): Promise<CitationLedgerRecord[]> {
  const { rows } = await pool.query<CitationLedgerRecord>(
    `SELECT * FROM citation_ledger WHERE job_id = $1 ORDER BY citation_number`,
    [jobId],
  );
  return rows;
}

export async function getNextCitationNumber(jobId: string): Promise<number> {
  const { rows } = await pool.query<{ max: number }>(
    `SELECT COALESCE(MAX(citation_number), 0) AS max FROM citation_ledger WHERE job_id = $1`,
    [jobId],
  );
  return (rows[0]?.max ?? 0) + 1;
}

export async function createSectionDraft(params: {
  jobId: string;
  sectionKey: string;
  status?: string;
  tokens?: number;
  content?: string;
  citationMap?: Record<string, unknown>;
}): Promise<SectionDraftRecord> {
  const { rows } = await pool.query<SectionDraftRecord>(
    `INSERT INTO section_drafts
     (job_id, section_key, status, tokens, content, citation_map)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      params.jobId,
      params.sectionKey,
      params.status ?? "pending",
      params.tokens ?? 0,
      params.content ?? null,
      params.citationMap ?? {},
    ],
  );
  return rows[0];
}

export async function updateSectionDraft(
  id: string,
  changes: {
    status?: string;
    tokens?: number;
    content?: string | null;
    citationMap?: Record<string, unknown>;
  },
) {
  const updates = ["updated_at = now()"];
  const values: unknown[] = [id];
  let idx = 2;

  if (changes.status !== undefined) {
    updates.push(`status = $${idx++}`);
    values.push(changes.status);
  }
  if (changes.tokens !== undefined) {
    updates.push(`tokens = $${idx++}`);
    values.push(changes.tokens);
  }
  if (changes.content !== undefined) {
    updates.push(`content = $${idx++}`);
    values.push(changes.content);
  }
  if (changes.citationMap !== undefined) {
    updates.push(`citation_map = $${idx++}`);
    values.push(changes.citationMap);
  }

  if (updates.length === 1) {
    return;
  }

  await pool.query(
    `UPDATE section_drafts
     SET ${updates.join(", ")}
     WHERE id = $1`,
    values,
  );
}

export async function listSectionDrafts(
  jobId: string,
): Promise<SectionDraftRecord[]> {
  const { rows } = await pool.query<SectionDraftRecord>(
    `SELECT * FROM section_drafts WHERE job_id = $1 ORDER BY created_at`,
    [jobId],
  );
  return rows;
}

export async function getSectionDraft(
  jobId: string,
  sectionKey: string,
): Promise<SectionDraftRecord | null> {
  const { rows } = await pool.query<SectionDraftRecord>(
    `SELECT * FROM section_drafts WHERE job_id = $1 AND section_key = $2`,
    [jobId, sectionKey],
  );
  return rows[0] ?? null;
}

export async function touchJobHeartbeat(jobId: string) {
  await pool.query(
    `UPDATE research_jobs SET last_heartbeat = now(), updated_at = now() WHERE id = $1`,
    [jobId],
  );
}

interface RescueParams {
  startThresholdMs: number;
  heartbeatThresholdMs: number;
  graceMs: number;
}

export async function rescueStaleJobs(params: RescueParams) {
  const { rows } = await pool.query<{
    id: string;
    started_at: string | null;
    created_at: string;
    updated_at: string;
    last_heartbeat: string | null;
    max_duration_seconds: string | null;
    has_steps: boolean;
  }>(
    `SELECT j.id,
            j.started_at,
            j.created_at,
            j.updated_at,
            j.last_heartbeat,
            j.max_duration_seconds,
            EXISTS (SELECT 1 FROM research_steps s WHERE s.job_id = j.id) AS has_steps
       FROM research_jobs j
      WHERE j.status = 'running'`,
  );

  const now = Date.now();
  const rescues: { id: string; reason: "start" | "heartbeat" }[] = [];

  const toMs = (value?: string | null) => (value ? Date.parse(value) : undefined);

  for (const row of rows) {
    const startedMs = toMs(row.started_at) ?? toMs(row.created_at);
    if (!row.has_steps) {
      if (startedMs && now - startedMs > params.startThresholdMs) {
        rescues.push({ id: row.id, reason: "start" });
      }
      continue;
    }

    const heartbeatBase = toMs(row.last_heartbeat) ?? toMs(row.updated_at) ?? startedMs;
    if (!heartbeatBase) {
      continue;
    }
    let threshold = params.heartbeatThresholdMs;
    const maxDurationSeconds =
      row.max_duration_seconds === null || row.max_duration_seconds === undefined
        ? null
        : Number(row.max_duration_seconds);
    if (typeof maxDurationSeconds === "number" && Number.isFinite(maxDurationSeconds)) {
      threshold = Math.min(threshold, maxDurationSeconds * 1000 + params.graceMs);
    }
    if (now - heartbeatBase > threshold) {
      rescues.push({ id: row.id, reason: "heartbeat" });
    }
  }

  if (!rescues.length) {
    return [];
  }

  const jobIds = rescues.map((r) => r.id);
  await pool.query(
    `UPDATE research_jobs
        SET status='queued', started_at = NULL, updated_at = now(), last_heartbeat = now()
      WHERE id = ANY($1::uuid[])`,
    [jobIds],
  );

  await pool.query(
    `UPDATE research_steps
        SET status='pending', updated_at = now()
      WHERE job_id = ANY($1::uuid[])
        AND status = 'running'`,
    [jobIds],
  );

  return rescues;
}
