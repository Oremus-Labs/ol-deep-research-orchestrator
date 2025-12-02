ALTER TABLE research_jobs
  ADD COLUMN IF NOT EXISTS clarification_prompts JSONB NOT NULL DEFAULT '[]'::jsonb;

