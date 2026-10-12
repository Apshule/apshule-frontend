ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_earnings NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS teacher_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reg_no TEXT;
UPDATE users
SET referral_code = 'ASP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6))
WHERE sector = 'education' AND referral_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code_unique
  ON users (upper(referral_code)) WHERE referral_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_school_regno_unique
  ON users (school_id, lower(regexp_replace(reg_no, '\s+', '', 'g')))
  WHERE reg_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS referral_signups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referrer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  referred_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  signup_fee NUMERIC NOT NULL DEFAULT 0,
  commission NUMERIC NOT NULL DEFAULT 0,
  commission_percent NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ref_signups_referrer ON referral_signups(referrer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ref_signups_referred_user
  ON referral_signups(referred_user_id) WHERE referred_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS referral_earnings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source_signup_id UUID REFERENCES referral_signups(id) ON DELETE SET NULL,
  amount NUMERIC NOT NULL,
  type TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  paid_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ref_earnings_user ON referral_earnings(user_id, status);

CREATE TABLE IF NOT EXISTS apshule_team_applications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  education_background TEXT,
  current_school TEXT,
  subjects_taught TEXT,
  teaching_level TEXT,
  address TEXT,
  referred_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_team_apps_status ON apshule_team_applications(status);
