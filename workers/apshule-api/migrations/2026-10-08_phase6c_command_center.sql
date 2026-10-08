-- APSHULE Phase 6C: Command Center, consent, and PDPO support.
-- Additive migration for the existing Neon database. Do not re-run schema.sql.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS actor_email TEXT,
  ADD COLUMN IF NOT EXISTS actor_role TEXT,
  ADD COLUMN IF NOT EXISTS device_info JSONB,
  ADD COLUMN IF NOT EXISTS result TEXT NOT NULL DEFAULT 'success';

CREATE TABLE IF NOT EXISTS institution_branding (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  institution_id UUID NOT NULL,
  sector TEXT NOT NULL CHECK (sector IN ('education', 'mfi', 'clinic', 'farm')),
  display_name TEXT,
  dual_logo_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  appshule_logo_position TEXT NOT NULL DEFAULT 'right'
    CHECK (appshule_logo_position IN ('left', 'right')),
  appshule_logo_size INT NOT NULL DEFAULT 32 CHECK (appshule_logo_size BETWEEN 16 AND 120),
  institution_logo_size INT NOT NULL DEFAULT 40 CHECK (institution_logo_size BETWEEN 16 AND 120),
  show_appshule_name BOOLEAN NOT NULL DEFAULT TRUE,
  show_institution_name BOOLEAN NOT NULL DEFAULT TRUE,
  header_bg_color TEXT,
  header_text_color TEXT NOT NULL DEFAULT '#FFFFFF',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (institution_id, sector)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  granted BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (role, permission)
);
INSERT INTO role_permissions (role, permission, granted)
VALUES ('superadmin', '*', TRUE)
ON CONFLICT (role, permission) DO NOTHING;

CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('global', 'sector', 'institution', 'role')),
  target_sector TEXT,
  target_institution_id UUID,
  target_role TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'urgent')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  dismissed_by UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ann_target_active
  ON announcements (target_type, target_sector, active, starts_at DESC);

CREATE TABLE IF NOT EXISTS user_consent (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL CHECK (consent_type IN ('tos', 'privacy', 'data_processing', 'marketing')),
  version TEXT NOT NULL,
  consented BOOLEAN NOT NULL DEFAULT TRUE,
  consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip TEXT,
  user_agent TEXT,
  UNIQUE (user_id, consent_type, version)
);
CREATE INDEX IF NOT EXISTS idx_consent_user ON user_consent(user_id, consented_at DESC);

CREATE TABLE IF NOT EXISTS data_deletion_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  user_email TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  admin_notes TEXT,
  scheduled_for TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ddr_status ON data_deletion_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ddr_user ON data_deletion_requests(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ddr_one_open_request_per_user
  ON data_deletion_requests(user_id)
  WHERE user_id IS NOT NULL AND status IN ('pending', 'approved');

CREATE TABLE IF NOT EXISTS institution_control_state (
  sector TEXT NOT NULL CHECK (sector IN ('education', 'mfi', 'clinic', 'farm')),
  institution_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sector, institution_id)
);

CREATE TABLE IF NOT EXISTS command_center_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  settings JSONB NOT NULL DEFAULT '{
    "default_language": "en",
    "timezone": "Africa/Kampala",
    "session_timeout_minutes": 60,
    "password_min_length": 8,
    "require_two_factor": false,
    "backup_reminder_days": 30
  }'::jsonb,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
