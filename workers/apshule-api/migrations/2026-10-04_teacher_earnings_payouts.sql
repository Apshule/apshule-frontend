-- Phase 2.5c: teacher lesson earnings and manually managed payout requests.
-- Additive only. Existing unattributed video views are intentionally not backfilled.

ALTER TABLE video_mappings
  ADD COLUMN IF NOT EXISTS teacher_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE video_views
  ADD COLUMN IF NOT EXISTS teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lesson_id TEXT,
  ADD COLUMN IF NOT EXISTS earnings_paid BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS earnings_amount NUMERIC(12, 2) NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS earnings_paid_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_vv_teacher ON video_views(teacher_id);
CREATE INDEX IF NOT EXISTS idx_vv_earnings_paid ON video_views(earnings_paid);
CREATE INDEX IF NOT EXISTS idx_vv_viewer_lesson_timestamp
  ON video_views(user_id, lesson_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS teacher_earnings_rate (
  id INT PRIMARY KEY CHECK (id = 1),
  per_view_ugx NUMERIC(12, 2) NOT NULL DEFAULT 5 CHECK (per_view_ugx > 0),
  min_withdrawal_ugx NUMERIC(12, 2) NOT NULL DEFAULT 10000 CHECK (min_withdrawal_ugx > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO teacher_earnings_rate (id, per_view_ugx, min_withdrawal_ugx)
VALUES (1, 5, 10000)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS payout_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'paid', 'rejected')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  paid_at TIMESTAMPTZ,
  paid_by UUID REFERENCES users(id) ON DELETE SET NULL,
  payment_method TEXT,
  payment_reference TEXT,
  notes TEXT,
  rejection_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_pr_teacher_requested
  ON payout_requests(teacher_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_pr_status ON payout_requests(status);