-- Phase 2.5b: NCDC teacher retooling course and CPD certificates.
-- Additive only: preserve existing progress and unrelated Neon tables.

CREATE TABLE IF NOT EXISTS retooling_modules (
  id INT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  youtube_id TEXT,
  pdf_url TEXT,
  quiz_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  pass_score INT NOT NULL DEFAULT 80,
  display_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO retooling_modules
  (id, title, description, display_order, quiz_questions)
VALUES
  (1, 'Familiarisation', 'Overview of the NCDC competency-based curriculum and its rationale', 1,
   $$[
     {"q":"What does NCDC stand for?","options":["National Curriculum Development Centre","National Council for Distance Courses","New Curriculum Design Commission","National Coding Development Centre"],"correct":0},
     {"q":"CBC stands for:","options":["Class-Based Curriculum","Competency-Based Curriculum","Central Board Curriculum","Community-Based Curriculum"],"correct":1},
     {"q":"The CBC approach focuses on:","options":["Memorising facts","Learner competencies and application","Only exam grades","Teacher lectures"],"correct":1},
     {"q":"Which is NOT a key competency in CBC?","options":["Critical thinking","Communication","Rote memorisation","Creativity"],"correct":2},
     {"q":"A learner-centred classroom has:","options":["Teacher talking most of the time","Learners actively doing tasks","No group work","Only written tests"],"correct":1}
   ]$$::jsonb),
  (2, 'Curriculum Documents', 'Syllabus, teacher guides, learner books, and how they work together', 2, '[]'::jsonb),
  (3, 'Learner-Centred Methods', 'Moving from teacher-talk to active learning in the classroom', 3, '[]'::jsonb),
  (4, 'Assessment in CBC', 'Formative vs summative, scoring with identifiers A1/A2/A3, end-of-term assessment', 4, '[]'::jsonb),
  (5, 'Planning & Monitoring', 'Scheme of work, lesson plans, and tracking learner progress', 5, '[]'::jsonb),
  (6, 'Projects & PBL', 'Designing, guiding, and evaluating learner projects', 6, '[]'::jsonb),
  (7, 'ICT Integration', 'Using digital tools appropriately in Ugandan classrooms', 7, '[]'::jsonb),
  (8, 'Inclusion', 'Supporting learners with special needs in mainstream classes', 8, '[]'::jsonb),
  (9, 'Record Keeping', 'Class registers, marks sheets, and confidential record management', 9, '[]'::jsonb),
  (10, 'Ethics', 'Professional conduct, safeguarding, and the teacher code of conduct', 10, '[]'::jsonb)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE teacher_retooling_progress
  ADD COLUMN IF NOT EXISTS quiz_answers JSONB,
  ADD COLUMN IF NOT EXISTS quiz_passed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS practical_photo_base64 TEXT,
  ADD COLUMN IF NOT EXISTS module_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pdf_read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS certificate_url TEXT;

CREATE SEQUENCE IF NOT EXISTS cpd_certificate_number_seq;

CREATE TABLE IF NOT EXISTS cpd_certificates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  certificate_number TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  pdf_base64 TEXT NOT NULL,
  points INT NOT NULL DEFAULT 20
);

CREATE INDEX IF NOT EXISTS idx_cpd_teacher ON cpd_certificates(teacher_id);
CREATE INDEX IF NOT EXISTS idx_cpd_issued_at ON cpd_certificates(issued_at DESC);