ALTER TABLE research_jobs
  ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE research_jobs
   SET last_heartbeat = COALESCE(last_heartbeat, COALESCE(updated_at, now()));

CREATE INDEX IF NOT EXISTS idx_research_jobs_status_last_heartbeat
  ON research_jobs (status, last_heartbeat DESC);
