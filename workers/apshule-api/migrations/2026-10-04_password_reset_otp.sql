-- Phase 2B: short-lived OTP-based password resets.
-- Apply only this additive migration to the existing Neon database.

CREATE TABLE IF NOT EXISTS password_reset_otps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  otp_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  used_at TIMESTAMPTZ,
  reset_token_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE password_reset_otps
  ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_prot_user ON password_reset_otps(user_id);
CREATE INDEX IF NOT EXISTS idx_prot_expires ON password_reset_otps(expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_prot_user_created ON password_reset_otps(user_id, created_at DESC);