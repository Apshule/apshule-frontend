-- APSHULE Phase 5A: Farm sector foundation only.
-- The seven Farm tables below support organizations, locations, workers,
-- animal types, animal records, settings, and audit history.

UPDATE sectors
SET enabled = TRUE,
    waitlist_enabled = FALSE,
    launched_at = COALESCE(launched_at, NOW())
WHERE code = 'farm';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN (
    'individual', 'teacher', 'school', 'superadmin',
    'mfi_admin', 'loan_officer', 'loan_manager', 'loan_director', 'borrower',
    'clinic_admin', 'doctor', 'nurse', 'receptionist', 'pharmacist', 'patient',
    'farm_admin', 'farm_manager', 'farm_worker'
  ));

CREATE TABLE IF NOT EXISTS farm_organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  sector TEXT NOT NULL DEFAULT 'farm' CHECK (sector = 'farm'),
  registration_number TEXT,
  tin TEXT,
  address TEXT,
  city TEXT,
  district TEXT,
  country TEXT DEFAULT 'Uganda',
  phone TEXT,
  email TEXT,
  website TEXT,
  logo_base64 TEXT,
  brand_color TEXT DEFAULT '#2E7D32',
  farm_type TEXT DEFAULT 'mixed',
  size_acres NUMERIC CHECK (size_acres IS NULL OR size_acres >= 0),
  animal_tag_sequence INTEGER NOT NULL DEFAULT 0 CHECK (animal_tag_sequence >= 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS farm_locations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES farm_organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  code TEXT,
  address TEXT,
  district TEXT,
  size_acres NUMERIC CHECK (size_acres IS NULL OR size_acres >= 0),
  manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS idx_farm_loc_org ON farm_locations(organization_id, active);

CREATE TABLE IF NOT EXISTS farm_workers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES farm_organizations(id) ON DELETE CASCADE,
  location_id UUID REFERENCES farm_locations(id) ON DELETE SET NULL,
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'farm_worker'
    CHECK (role IN ('farm_manager', 'farm_worker')),
  employee_code TEXT,
  phone TEXT,
  national_id TEXT,
  hired_on DATE,
  wage_type TEXT DEFAULT 'daily',
  wage_rate NUMERIC CHECK (wage_rate IS NULL OR wage_rate >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_farm_worker_org ON farm_workers(organization_id, active);
CREATE INDEX IF NOT EXISTS idx_farm_worker_user ON farm_workers(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_farm_worker_org_employee_code
  ON farm_workers(organization_id, employee_code)
  WHERE employee_code IS NOT NULL AND btrim(employee_code) <> '';

CREATE TABLE IF NOT EXISTS farm_animal_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES farm_organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (btrim(code) <> ''),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'head',
  tracking_mode TEXT NOT NULL DEFAULT 'individual'
    CHECK (tracking_mode IN ('individual', 'batch')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS idx_farm_animal_types_org
  ON farm_animal_types(organization_id, active, name);

CREATE TABLE IF NOT EXISTS farm_animals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES farm_organizations(id) ON DELETE CASCADE,
  location_id UUID REFERENCES farm_locations(id) ON DELETE SET NULL,
  animal_type_id UUID REFERENCES farm_animal_types(id) ON DELETE SET NULL,
  tag_number TEXT,
  name TEXT,
  gender TEXT,
  date_of_birth DATE,
  weight_kg NUMERIC CHECK (weight_kg IS NULL OR weight_kg >= 0),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  health_status TEXT NOT NULL DEFAULT 'healthy',
  photo_base64 TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_farm_animal_org
  ON farm_animals(organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_farm_animal_loc
  ON farm_animals(organization_id, location_id);
CREATE INDEX IF NOT EXISTS idx_farm_animal_tag
  ON farm_animals(organization_id, tag_number)
  WHERE tag_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_farm_animal_unique_tag
  ON farm_animals(organization_id, tag_number)
  WHERE tag_number IS NOT NULL AND status <> 'deleted';

CREATE TABLE IF NOT EXISTS farm_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL UNIQUE REFERENCES farm_organizations(id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'UGX',
  timezone TEXT NOT NULL DEFAULT 'Africa/Kampala',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS farm_audit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES farm_organizations(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_table TEXT,
  target_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_farm_audit_org
  ON farm_audit(organization_id, created_at DESC);
