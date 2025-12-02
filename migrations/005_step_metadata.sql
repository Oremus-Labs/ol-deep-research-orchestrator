ALTER TABLE research_steps
  ADD COLUMN theme TEXT;

ALTER TABLE research_steps
  ADD COLUMN iteration INTEGER NOT NULL DEFAULT 0;
