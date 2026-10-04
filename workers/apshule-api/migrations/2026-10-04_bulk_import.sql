-- Phase 2A: school-scoped student and teacher bulk-import history.
-- Additive and scoped; do not rerun schema.sql on the existing Neon database.

CREATE TABLE IF NOT EXISTS bulk_import_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  imported_by UUID REFERENCES users(id) ON DELETE SET NULL,
  import_type TEXT NOT NULL CHECK (import_type IN ('students', 'teachers')),
  total_rows INT NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  created_count INT NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  skipped_count INT NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  error_count INT NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bil_school ON bulk_import_log(school_id);
CREATE INDEX IF NOT EXISTS idx_bil_type ON bulk_import_log(import_type);