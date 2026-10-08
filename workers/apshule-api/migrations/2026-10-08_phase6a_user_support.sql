CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  language TEXT DEFAULT 'en',
  data_saver TEXT DEFAULT 'auto',
  theme TEXT DEFAULT 'auto',
  notifications_enabled BOOLEAN DEFAULT TRUE,
  timezone TEXT DEFAULT 'Africa/Kampala',
  settings JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id
  ON user_preferences(user_id);

CREATE TABLE IF NOT EXISTS bug_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  user_role TEXT,
  sector TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT,
  severity TEXT DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  screenshot_base64 TEXT,
  device_info JSONB,
  url TEXT,
  status TEXT DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'wont_fix')),
  admin_notes TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_status_created
  ON bug_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bug_reports_sector_severity
  ON bug_reports(sector, severity);
CREATE INDEX IF NOT EXISTS idx_bug_reports_user_created
  ON bug_reports(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sync_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  sync_type TEXT NOT NULL,
  items_synced INT DEFAULT 0,
  items_failed INT DEFAULT 0,
  duration_ms INT,
  triggered_by TEXT,
  error_summary TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_history_user_created
  ON sync_history(user_id, created_at DESC);
