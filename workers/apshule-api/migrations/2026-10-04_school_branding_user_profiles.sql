-- Phase 2C: school branding and user profile fields.
-- Additive only; do not rerun the full schema.sql against the existing Neon database.

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS brand_color TEXT DEFAULT '#4B2E9E',
  ADD COLUMN IF NOT EXISTS motto TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS website TEXT,
  ADD COLUMN IF NOT EXISTS term_ended_on DATE,
  ADD COLUMN IF NOT EXISTS next_term_begins_on DATE,
  ADD COLUMN IF NOT EXISTS next_term_fees NUMERIC,
  ADD COLUMN IF NOT EXISTS logo_base64 TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_base64 TEXT,
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS session_version INT NOT NULL DEFAULT 0;