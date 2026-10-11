ALTER TABLE pdfs
  ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'lesson_notes',
  ADD COLUMN IF NOT EXISTS subject_code TEXT,
  ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0;

UPDATE pdfs
SET category = 'lesson_notes'
WHERE category IS NULL;

CREATE INDEX IF NOT EXISTS idx_pdfs_class_category_subject
  ON pdfs(class_level, category, subject_code);

CREATE INDEX IF NOT EXISTS idx_pdfs_class_category_sort
  ON pdfs(class_level, category, sort_order, display_order);
