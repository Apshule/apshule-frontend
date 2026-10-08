ALTER TABLE pdfs
  ADD COLUMN IF NOT EXISTS resolved_pdf_url TEXT,
  ADD COLUMN IF NOT EXISTS resolve_status TEXT DEFAULT 'unresolved',
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pdfs_resolve_status
  ON pdfs(resolve_status);

ALTER TABLE curriculum_links
  ADD COLUMN IF NOT EXISTS resolved_syllabus_url TEXT,
  ADD COLUMN IF NOT EXISTS resolved_learner_book_url TEXT,
  ADD COLUMN IF NOT EXISTS resolved_teacher_guide_url TEXT;
