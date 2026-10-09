ALTER TABLE pdfs
  ADD COLUMN IF NOT EXISTS storage_type TEXT DEFAULT 'url',
  ADD COLUMN IF NOT EXISTS r2_key TEXT,
  ADD COLUMN IF NOT EXISTS file_size INT,
  ADD COLUMN IF NOT EXISTS mime_type TEXT,
  ADD COLUMN IF NOT EXISTS subject TEXT;

UPDATE pdfs
SET storage_type = 'url'
WHERE storage_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_pdfs_storage_type ON pdfs(storage_type);
