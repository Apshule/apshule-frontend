-- Phase 10C: add a current education marks workflow without replacing legacy
-- report-card columns used by older report-card routes.
CREATE TABLE IF NOT EXISTS teacher_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES school_subjects(id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (school_id, teacher_id, class_id, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_ta_teacher ON teacher_assignments(teacher_id, active);
CREATE INDEX IF NOT EXISTS idx_ta_class ON teacher_assignments(class_id, active);

-- Existing report_cards/report_marks predate Phase 10A and have legacy
-- required fields. Keep those intact and add the normalized references needed
-- by assignment-based marks entry.
ALTER TABLE report_cards
  ADD COLUMN IF NOT EXISTS class_id UUID REFERENCES classes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS learner_record_id UUID REFERENCES learners(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS class_teacher_comment TEXT,
  ADD COLUMN IF NOT EXISTS headteacher_comment TEXT,
  ADD COLUMN IF NOT EXISTS principal_comment TEXT,
  ADD COLUMN IF NOT EXISTS position_in_class INT,
  ADD COLUMN IF NOT EXISTS out_of_class INT,
  ADD COLUMN IF NOT EXISTS term_ended_on DATE,
  ADD COLUMN IF NOT EXISTS next_term_begins DATE,
  ADD COLUMN IF NOT EXISTS fees_balance NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_term_fees NUMERIC;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rc_learner_record_term_year
  ON report_cards(learner_record_id, term, year)
  WHERE learner_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rc_class_term_year ON report_cards(class_id, term, year);

ALTER TABLE report_marks
  ADD COLUMN IF NOT EXISTS subject_id UUID REFERENCES school_subjects(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS pct20 NUMERIC,
  ADD COLUMN IF NOT EXISTS pct80 NUMERIC,
  ADD COLUMN IF NOT EXISTS pct100 NUMERIC,
  ADD COLUMN IF NOT EXISTS descriptor TEXT,
  ADD COLUMN IF NOT EXISTS entered_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE UNIQUE INDEX IF NOT EXISTS idx_rm_card_subject_id
  ON report_marks(report_card_id, subject_id)
  WHERE subject_id IS NOT NULL;
