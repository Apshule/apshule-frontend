CREATE TABLE IF NOT EXISTS video_projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES schools(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  sector TEXT NOT NULL DEFAULT 'education'
    CHECK (sector IN ('education', 'mfi', 'clinic', 'farm')),
  language TEXT NOT NULL DEFAULT 'en',
  visibility TEXT NOT NULL DEFAULT 'draft'
    CHECK (visibility IN ('draft', 'published')),
  duration_seconds INT NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  scenes JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(scenes) = 'array'),
  thumbnail_base64 TEXT
    CHECK (thumbnail_base64 IS NULL OR length(thumbnail_base64) <= 409600),
  published_url TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_projects_creator
  ON video_projects(created_by, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_projects_org
  ON video_projects(organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_projects_visibility
  ON video_projects(visibility, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_projects_sector
  ON video_projects(sector, visibility, updated_at DESC);

CREATE TABLE IF NOT EXISTS video_library (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES schools(id) ON DELETE SET NULL,
  project_id UUID UNIQUE REFERENCES video_projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  sector TEXT NOT NULL DEFAULT 'education'
    CHECK (sector IN ('education', 'mfi', 'clinic', 'farm')),
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  duration_seconds INT CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  language TEXT NOT NULL DEFAULT 'en',
  tags TEXT[],
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  views INT NOT NULL DEFAULT 0 CHECK (views >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_library_org
  ON video_library(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_library_category
  ON video_library(category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_library_sector
  ON video_library(sector, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_library_language
  ON video_library(language, created_at DESC);
