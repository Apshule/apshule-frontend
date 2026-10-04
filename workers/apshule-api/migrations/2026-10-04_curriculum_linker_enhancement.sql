-- Phase 2.5A: persist teacher curriculum favorites and recent views.
-- Apply only this additive migration to the existing Neon database.

CREATE TABLE IF NOT EXISTS curriculum_favorites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  curriculum_link_id UUID NOT NULL REFERENCES curriculum_links(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (teacher_id, curriculum_link_id)
);

CREATE INDEX IF NOT EXISTS idx_cfav_teacher
  ON curriculum_favorites(teacher_id);

CREATE TABLE IF NOT EXISTS curriculum_recent (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  curriculum_link_id UUID NOT NULL REFERENCES curriculum_links(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crecent_teacher
  ON curriculum_recent(teacher_id, viewed_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_curriculum_view_threshold_day
  ON audit_log(actor_id, (metadata->>'view_date'))
  WHERE action = 'curriculum_link.view_threshold';