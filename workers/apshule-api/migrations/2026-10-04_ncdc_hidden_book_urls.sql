ALTER TABLE curriculum_links
  ADD COLUMN IF NOT EXISTS syllabus_url TEXT,
  ADD COLUMN IF NOT EXISTS learner_book_url TEXT,
  ADD COLUMN IF NOT EXISTS teacher_guide_url TEXT;