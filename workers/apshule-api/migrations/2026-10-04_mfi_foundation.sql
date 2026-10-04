-- APSHULE Phase 3A: additive MFI sector foundation.
-- Apply this scoped migration to the existing Neon database; do not re-run schema.sql.

UPDATE sectors
SET enabled = TRUE,
    waitlist_enabled = FALSE,
    launched_at = COALESCE(launched_at, NOW())
WHERE code = 'mfi';

INSERT INTO sectors (code, name, enabled, waitlist_enabled, launched_at)
VALUES ('mfi', 'Microfinance', TRUE, FALSE, NOW())
ON CONFLICT (code) DO UPDATE
SET enabled = TRUE,
    waitlist_enabled = FALSE,
    launched_at = COALESCE(sectors.launched_at, EXCLUDED.launched_at);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN (
    'individual', 'teacher', 'school', 'superadmin',
    'mfi_admin', 'loan_officer', 'loan_manager', 'loan_director', 'borrower'
  ));

CREATE TABLE IF NOT EXISTS mfi_organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  sector TEXT DEFAULT 'mfi',
  registration_number TEXT,
  tin TEXT,
  license_number TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  logo_base64 TEXT,
  brand_color TEXT DEFAULT '#0D47A1',
  city TEXT,
  district TEXT,
  country TEXT DEFAULT 'Uganda',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfi_organizations_sector
  ON mfi_organizations(sector);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mfi_organizations_created_by
  ON mfi_organizations(created_by) WHERE created_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS mfi_branches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  address TEXT,
  city TEXT,
  district TEXT,
  phone TEXT,
  manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfi_branch_org ON mfi_branches(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mfi_branch_org_code
  ON mfi_branches(organization_id, lower(code))
  WHERE code IS NOT NULL AND length(trim(code)) > 0;

CREATE TABLE IF NOT EXISTS mfi_customers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES mfi_branches(id) ON DELETE SET NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  gender TEXT,
  date_of_birth DATE,
  national_id TEXT,
  tin TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  village TEXT,
  district TEXT,
  occupation TEXT,
  monthly_income NUMERIC,
  photo_base64 TEXT,
  spouse_name TEXT,
  spouse_phone TEXT,
  nok_name TEXT,
  nok_relationship TEXT,
  nok_phone TEXT,
  status TEXT DEFAULT 'active',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (status IN ('active', 'inactive'))
);
CREATE INDEX IF NOT EXISTS idx_mfi_cust_org ON mfi_customers(organization_id);
CREATE INDEX IF NOT EXISTS idx_mfi_cust_branch ON mfi_customers(branch_id);
CREATE INDEX IF NOT EXISTS idx_mfi_cust_phone ON mfi_customers(phone);

CREATE TABLE IF NOT EXISTS mfi_guarantors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES mfi_customers(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  relationship TEXT,
  phone TEXT,
  national_id TEXT,
  address TEXT,
  occupation TEXT,
  monthly_income NUMERIC,
  photo_base64 TEXT,
  signature_base64 TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfi_guar_cust ON mfi_guarantors(customer_id);

CREATE TABLE IF NOT EXISTS mfi_officers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES mfi_branches(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('loan_officer', 'loan_manager', 'loan_director')),
  employee_code TEXT,
  hired_on DATE,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfi_off_org ON mfi_officers(organization_id);
CREATE INDEX IF NOT EXISTS idx_mfi_off_user ON mfi_officers(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mfi_officer_user_unique ON mfi_officers(user_id);

CREATE TABLE IF NOT EXISTS mfi_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES mfi_organizations(id) ON DELETE CASCADE UNIQUE,
  currency TEXT DEFAULT 'UGX',
  default_interest_rate NUMERIC DEFAULT 24,
  default_term_months INT DEFAULT 12,
  default_repayment_frequency TEXT DEFAULT 'monthly',
  late_fee_percent NUMERIC DEFAULT 2,
  grace_period_days INT DEFAULT 7,
  settings JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (default_interest_rate >= 0),
  CHECK (default_term_months > 0),
  CHECK (late_fee_percent >= 0),
  CHECK (grace_period_days >= 0)
);

CREATE TABLE IF NOT EXISTS mfi_audit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_table TEXT,
  target_id UUID,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfi_audit_org ON mfi_audit(organization_id);
CREATE INDEX IF NOT EXISTS idx_mfi_audit_created_at ON mfi_audit(created_at DESC);

-- Record the table count for this phase's foundation, excluding deferred loan lifecycle tables.
DO $$
BEGIN
  RAISE NOTICE 'APSHULE MFI Phase 3A creates seven foundation tables.';
END $$;