-- Phase 1D: ReportAuto UG report cards.
-- Additive and scoped; do not rerun schema.sql on the existing Neon database.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS gender TEXT;

CREATE TABLE IF NOT EXISTS report_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  level TEXT NOT NULL UNIQUE,
  description TEXT,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO report_templates (name, level, description) VALUES
  ('Nursery Report Card', 'nursery', 'Baby/Middle/Top learning areas'),
  ('Primary Report Card', 'primary', 'P1-P7 subjects'),
  ('O-Level CBC Report Card', 'o_level', 'S1-S4 CBC'),
  ('A-Level CBC Report Card', 'a_level', 'S5-S6 CBC')
ON CONFLICT (level) DO NOTHING;

CREATE TABLE IF NOT EXISTS report_cards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_level TEXT NOT NULL REFERENCES report_templates(level),
  learner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  school_id UUID REFERENCES schools(id) ON DELETE CASCADE,
  class_name TEXT NOT NULL,
  term TEXT NOT NULL,
  year INT NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rc_learner ON report_cards(learner_id);
CREATE INDEX IF NOT EXISTS idx_rc_school ON report_cards(school_id);
CREATE INDEX IF NOT EXISTS idx_rc_class_term ON report_cards(class_name, term, year);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rc_learner_term_year
  ON report_cards(learner_id, term, year);

CREATE TABLE IF NOT EXISTS report_marks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_card_id UUID NOT NULL REFERENCES report_cards(id) ON DELETE CASCADE,
  subject_code TEXT,
  subject_name TEXT NOT NULL,
  a1 NUMERIC,
  a2 NUMERIC,
  a3 NUMERIC,
  avg NUMERIC,
  pct_20 NUMERIC,
  eot NUMERIC,
  pct_80 NUMERIC,
  pct_100 NUMERIC,
  identifier INT,
  grade TEXT,
  remarks TEXT,
  teacher_initials TEXT,
  teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rm_card ON report_marks(report_card_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rm_card_subject_name
  ON report_marks(report_card_id, subject_name);

CREATE TABLE IF NOT EXISTS teacher_signatures (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  teacher_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  signature_image_url TEXT,
  signature_draw_base64 TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS report_download_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_card_id UUID NOT NULL REFERENCES report_cards(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  download_count INT DEFAULT 1,
  downloaded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rdl_student ON report_download_logs(student_id);
CREATE INDEX IF NOT EXISTS idx_rdl_card ON report_download_logs(report_card_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rdl_card_student
  ON report_download_logs(report_card_id, student_id);

CREATE TABLE IF NOT EXISTS report_comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_card_id UUID NOT NULL REFERENCES report_cards(id) ON DELETE CASCADE,
  class_teacher_comment TEXT,
  headteacher_comment TEXT,
  principal_comment TEXT,
  auto_comments JSONB DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_comments_card
  ON report_comments(report_card_id);

CREATE TABLE IF NOT EXISTS report_auto_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  level TEXT NOT NULL,
  grade_pattern TEXT NOT NULL,
  comment TEXT NOT NULL,
  priority INT DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_auto_rules_level_grade_priority
  ON report_auto_rules(level, grade_pattern, priority);

INSERT INTO report_auto_rules (level, grade_pattern, comment, priority) VALUES
  ('nursery', 'A', 'Consistently demonstrates this skill.', 1),
  ('nursery', 'B', 'Usually demonstrates this skill.', 1),
  ('nursery', 'C', 'Demonstrates this skill with support.', 1),
  ('nursery', 'D', 'Continue guided practice with teacher support.', 1),
  ('nursery', 'E', 'Needs patient, guided practice and encouragement.', 1),
  ('primary', 'A', 'Excellent work! Keep it up.', 1),
  ('primary', 'B', 'Good effort. Push for A next term.', 1),
  ('primary', 'C', 'Satisfactory. More practice needed.', 1),
  ('primary', 'D', 'Work harder. Seek help from teacher.', 1),
  ('primary', 'E', 'Needs urgent improvement.', 1),
  ('o_level', 'A', 'Exceptional performance. Outstanding.', 1),
  ('o_level', 'B', 'Outstanding. Aim for A.', 1),
  ('o_level', 'C', 'Satisfactory. Improve in weaker areas.', 1),
  ('o_level', 'D', 'Basic. Extra study required.', 1),
  ('a_level', 'A', 'Exceptional. Strong candidate.', 1),
  ('a_level', 'B', 'Outstanding. Well done.', 1),
  ('a_level', 'C', 'Satisfactory. Build on strengths.', 1)
ON CONFLICT (level, grade_pattern, priority) DO NOTHING;

CREATE TABLE IF NOT EXISTS school_report_settings (
  school_id UUID PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  term_dates TEXT,
  fees TEXT,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);