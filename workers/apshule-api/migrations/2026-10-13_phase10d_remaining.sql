ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS head_teacher_name TEXT,
  ADD COLUMN IF NOT EXISTS principal_name TEXT,
  ADD COLUMN IF NOT EXISTS class_teacher_comment_template TEXT;

CREATE TABLE IF NOT EXISTS learner_projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  learner_id UUID REFERENCES learners(id) ON DELETE CASCADE,
  report_card_id UUID REFERENCES report_cards(id) ON DELETE CASCADE,
  term TEXT,
  year INT,
  project_name TEXT NOT NULL,
  score NUMERIC,
  out_of NUMERIC DEFAULT 10,
  percentage NUMERIC,
  grade TEXT,
  remarks TEXT,
  teacher_initials TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_learner_projects_card ON learner_projects(report_card_id);

CREATE TABLE IF NOT EXISTS nursery_activity_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_card_id UUID NOT NULL REFERENCES report_cards(id) ON DELETE CASCADE,
  activity_id UUID NOT NULL REFERENCES nursery_activities(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'not_assessed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(report_card_id, activity_id)
);
