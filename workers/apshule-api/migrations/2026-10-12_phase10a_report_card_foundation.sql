ALTER TABLE schools ADD COLUMN IF NOT EXISTS motto TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS short_code TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS street TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS po_box TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS report_theme TEXT DEFAULT 'blue';
ALTER TABLE schools ADD COLUMN IF NOT EXISTS report_logo_base64 TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS report_header_notes TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS report_footer_text TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS report_signature_base64 TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE schools
SET short_code = lower(regexp_replace(left(name, 3), '[^a-z0-9]', '', 'g')) || left(replace(id::text, '-', ''), 5)
WHERE short_code IS NULL OR btrim(short_code) = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_schools_short_code_unique ON schools(lower(short_code));

CREATE TABLE IF NOT EXISTS classes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  level TEXT NOT NULL,
  stream TEXT,
  class_teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
  avg_age NUMERIC,
  fees_next_term NUMERIC,
  school_pay_code TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (school_id, name)
);
CREATE INDEX IF NOT EXISTS idx_classes_school ON classes(school_id);

CREATE TABLE IF NOT EXISTS learners (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id UUID REFERENCES classes(id) ON DELETE SET NULL,
  reg_no TEXT NOT NULL,
  lin TEXT,
  full_name TEXT NOT NULL,
  gender TEXT,
  age INT,
  date_of_birth DATE,
  section TEXT,
  house TEXT,
  residence TEXT,
  combination TEXT,
  photo_base64 TEXT,
  parent_name TEXT,
  parent_phone TEXT,
  parent_email TEXT,
  phone TEXT,
  school_short_code TEXT,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  fees_balance NUMERIC NOT NULL DEFAULT 0,
  days_attended INT NOT NULL DEFAULT 0,
  days_absent INT NOT NULL DEFAULT 0,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (school_id, reg_no)
);
CREATE INDEX IF NOT EXISTS idx_learners_class ON learners(class_id);
CREATE INDEX IF NOT EXISTS idx_learners_school ON learners(school_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_learners_school_reg_normalized
  ON learners(school_id, lower(regexp_replace(reg_no, '\s+', '', 'g')));

CREATE TABLE IF NOT EXISTS school_subjects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  code TEXT,
  name TEXT NOT NULL,
  level TEXT NOT NULL,
  papers INT NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ss_school_level ON school_subjects(school_id, level);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ss_school_level_name ON school_subjects(school_id, level, lower(name));

CREATE TABLE IF NOT EXISTS school_grading_systems (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  grade_code TEXT NOT NULL,
  min_score NUMERIC NOT NULL,
  max_score NUMERIC NOT NULL,
  descriptor TEXT,
  comment TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (school_id, level, grade_code)
);

CREATE TABLE IF NOT EXISTS nursery_learning_areas (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  max_score INT NOT NULL DEFAULT 100,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE (school_id, code)
);

CREATE TABLE IF NOT EXISTS nursery_activities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE (school_id, code)
);
