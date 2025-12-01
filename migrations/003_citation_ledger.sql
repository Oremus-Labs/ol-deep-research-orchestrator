CREATE TABLE IF NOT EXISTS citation_ledger (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  source_id UUID,
  citation_number INTEGER NOT NULL,
  title TEXT,
  url TEXT,
  accessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_citation_ledger_job_hash
  ON citation_ledger(job_id, source_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_citation_ledger_job_number
  ON citation_ledger(job_id, citation_number);

CREATE TABLE IF NOT EXISTS section_drafts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tokens INTEGER NOT NULL DEFAULT 0,
  content TEXT,
  citation_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_section_drafts_job_section
  ON section_drafts(job_id, section_key);
CREATE INDEX IF NOT EXISTS idx_section_drafts_status
  ON section_drafts(status);
