CREATE TABLE IF NOT EXISTS report_card_exports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id UUID REFERENCES schools(id) ON DELETE CASCADE,
  class_id UUID REFERENCES classes(id) ON DELETE SET NULL,
  term TEXT NOT NULL,
  year INT NOT NULL,
  generated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cards_count INT NOT NULL DEFAULT 0,
  zip_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_rce_school ON report_card_exports(school_id);
