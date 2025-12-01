ALTER TABLE research_jobs
ADD COLUMN IF NOT EXISTS report_assets JSONB;
