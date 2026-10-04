CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS sectors (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled BOOLEAN DEFAULT FALSE,
  waitlist_enabled BOOLEAN DEFAULT TRUE,
  launched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO sectors (code, name, enabled, waitlist_enabled) VALUES
  ('education', 'Education', TRUE, FALSE),
  ('mfi', 'Microfinance', FALSE, TRUE),
  ('clinic', 'Clinic & Pharmacy', FALSE, TRUE),
  ('farm', 'Farming', FALSE, TRUE)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS schools (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  contact TEXT,
  location TEXT,
  logo TEXT,
  login_email TEXT UNIQUE,
  login_password_hash TEXT,
  login_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'individual'
    CHECK (role IN ('individual', 'teacher', 'school', 'superadmin')),
  sector TEXT DEFAULT 'education',
  waitlist BOOLEAN DEFAULT FALSE,
  school_id UUID REFERENCES schools(id) ON DELETE SET NULL,
  education_level TEXT,
  class_level VARCHAR(20),
  subjects_taught TEXT[] DEFAULT '{}',
  assigned_classes TEXT[] DEFAULT '{}',
  lin VARCHAR(50),
  school_verified BOOLEAN DEFAULT FALSE,
  address TEXT,
  profile_pic TEXT,
  subscription TEXT,
  subscription_active BOOLEAN DEFAULT FALSE,
  subscription_date TIMESTAMPTZ,
  login_count INT DEFAULT 0,
  last_login TIMESTAMPTZ,
  detected_location TEXT,
  reset_token TEXT,
  reset_token_expires TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS class_level VARCHAR(20),
  ADD COLUMN IF NOT EXISTS subjects_taught TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS assigned_classes TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS lin VARCHAR(50),
  ADD COLUMN IF NOT EXISTS school_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sector TEXT DEFAULT 'education',
  ADD COLUMN IF NOT EXISTS waitlist BOOLEAN DEFAULT FALSE;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('individual', 'teacher', 'school', 'superadmin'));
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email));
CREATE INDEX IF NOT EXISTS idx_users_school_id ON users(school_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_sector ON users(sector);
UPDATE users SET sector = 'education' WHERE sector IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_schools_login_email_lower
  ON schools(lower(login_email))
  WHERE login_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  fee TEXT NOT NULL,
  school_id UUID REFERENCES schools(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_school_id ON events(school_id);

CREATE TABLE IF NOT EXISTS pdfs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE pdfs
  ADD COLUMN IF NOT EXISTS class_level VARCHAR(30) DEFAULT 'unassigned',
  ADD COLUMN IF NOT EXISTS cover_color VARCHAR(20) DEFAULT '#FF8C42',
  ADD COLUMN IF NOT EXISTS display_order INT DEFAULT 0;
UPDATE pdfs SET class_level = 'unassigned' WHERE class_level IS NULL;
CREATE INDEX IF NOT EXISTS idx_pdfs_class ON pdfs(class_level);

CREATE TABLE IF NOT EXISTS video_mappings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key TEXT UNIQUE NOT NULL,
  subject TEXT NOT NULL,
  class_key TEXT NOT NULL,
  youtube_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subjects (
  level TEXT PRIMARY KEY,
  list TEXT[] NOT NULL DEFAULT '{}'
);
INSERT INTO subjects (level, list) VALUES
  ('primary', ARRAY['Mathematics','English','Science','Social Studies','Literacy','Religious Education','Agriculture']),
  ('secondary', ARRAY['Mathematics','English','Biology','Chemistry','Physics','History','Geography','Kiswahili','Commerce','Entrepreneurship','ICT','Literature','Economics','Fine Art','Physical Education','Agriculture'])
ON CONFLICT (level) DO NOTHING;

CREATE TABLE IF NOT EXISTS feedbacks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson TEXT,
  rating INT CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  comment TEXT,
  user_name TEXT,
  user_email TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedbacks_timestamp ON feedbacks(timestamp DESC);

CREATE TABLE IF NOT EXISTS video_views (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject TEXT,
  class_id TEXT,
  class_name TEXT,
  user_id UUID,
  user_name TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_video_views_timestamp ON video_views(timestamp DESC);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  plan TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT DEFAULT 'UGX',
  reference TEXT UNIQUE NOT NULL,
  yo_transaction_ref TEXT,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  phone TEXT,
  email TEXT,
  name TEXT,
  raw_response JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(reference);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);

CREATE TABLE IF NOT EXISTS revoked_tokens (
  token_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sector TEXT,
  action TEXT NOT NULL,
  target_table TEXT,
  target_id UUID,
  metadata JSONB,
  ip TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_sector ON audit_log(sector);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO settings (key, value) VALUES
  ('about', '{"vision":"To be Africa''s leading digital learning platform.","mission":"To provide quality, accessible education.","coreValues":["Excellence","Accessibility","Innovation"],"team":[{"name":"Tebuswake Abdallah","role":"CEO","photo":""}],"contact":{"phone":"+256705732540","email":"apshule@gmail.com","address":"Kampala","whatsapp":"+256705732540"}}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Phase 1A: NCDC / UNEB foundation tables.
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