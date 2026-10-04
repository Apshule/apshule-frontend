-- APSHULE Phase 1A: additive NCDC / UNEB foundation tables.
-- This migration is intentionally scoped; do not re-run the full schema.sql on Neon.
CREATE TABLE IF NOT EXISTS uneb_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject TEXT NOT NULL,
  class_level TEXT NOT NULL,
  topic TEXT NOT NULL,
  scenario_text TEXT,
  competency TEXT,
  marking_grid JSONB DEFAULT '{}'::jsonb,
  source_year TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_uneb_subject ON uneb_items(subject);
CREATE INDEX IF NOT EXISTS idx_uneb_class ON uneb_items(class_level);

CREATE TABLE IF NOT EXISTS ca_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  learner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  school_id UUID REFERENCES schools(id) ON DELETE CASCADE,
  subject TEXT,
  competency TEXT,
  evidence_1 TEXT,
  evidence_2 TEXT,
  evidence_3 TEXT,
  final_level TEXT,
  term TEXT,
  teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ca_learner ON ca_records(learner_id);
CREATE INDEX IF NOT EXISTS idx_ca_school ON ca_records(school_id);
CREATE INDEX IF NOT EXISTS idx_ca_teacher ON ca_records(teacher_id);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  learner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  school_id UUID REFERENCES schools(id) ON DELETE CASCADE,
  class_name TEXT,
  subject TEXT,
  title TEXT,
  lin TEXT,
  qr_code TEXT,
  milestone_1_date TIMESTAMPTZ,
  milestone_1_photo TEXT,
  milestone_1_status TEXT DEFAULT 'pending',
  milestone_2_date TIMESTAMPTZ,
  milestone_2_photo TEXT,
  milestone_2_status TEXT DEFAULT 'pending',
  final_date TIMESTAMPTZ,
  final_photo TEXT,
  final_status TEXT DEFAULT 'pending',
  teacher_observed_tick BOOLEAN DEFAULT FALSE,
  viva_audio_path TEXT,
  similarity_flag BOOLEAN DEFAULT FALSE,
  previous_title_check TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proj_learner ON projects(learner_id);
CREATE INDEX IF NOT EXISTS idx_proj_school ON projects(school_id);
CREATE INDEX IF NOT EXISTS idx_proj_class ON projects(class_name);

CREATE TABLE IF NOT EXISTS curriculum_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject TEXT,
  class_level TEXT,
  topic TEXT,
  syllabus_ref TEXT,
  learner_book_page TEXT,
  teacher_guide_page TEXT,
  summary_text TEXT,
  activity_suggestion TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cur_subject ON curriculum_links(subject);
CREATE INDEX IF NOT EXISTS idx_cur_class ON curriculum_links(class_level);

CREATE TABLE IF NOT EXISTS teacher_retooling_progress (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  teacher_id UUID REFERENCES users(id) ON DELETE CASCADE,
  module_id INT NOT NULL,
  completed BOOLEAN DEFAULT FALSE,
  quiz_score INT,
  practical_upload_path TEXT,
  certificate_issued BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (teacher_id, module_id)
);
CREATE INDEX IF NOT EXISTS idx_retool_teacher ON teacher_retooling_progress(teacher_id);
CREATE INDEX IF NOT EXISTS idx_retool_module ON teacher_retooling_progress(module_id);