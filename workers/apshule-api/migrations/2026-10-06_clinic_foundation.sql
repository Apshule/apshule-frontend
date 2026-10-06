-- APSHULE Phase 4A: additive Clinic sector foundation.
-- Apply only this scoped migration; do not re-run schema.sql.

INSERT INTO sectors (code, name, enabled, waitlist_enabled, launched_at)
VALUES ('clinic', 'Clinic & Pharmacy', TRUE, FALSE, NOW())
ON CONFLICT (code) DO UPDATE
SET enabled = TRUE,
    waitlist_enabled = FALSE,
    launched_at = COALESCE(sectors.launched_at, EXCLUDED.launched_at);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN (
    'individual', 'teacher', 'school', 'superadmin',
    'mfi_admin', 'loan_officer', 'loan_manager', 'loan_director', 'borrower',
    'clinic_admin', 'doctor', 'nurse', 'receptionist', 'pharmacist'
  ));

CREATE TABLE IF NOT EXISTS clinic_organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  sector TEXT NOT NULL DEFAULT 'clinic' CHECK (sector = 'clinic'),
  registration_number TEXT,
  license_number TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  logo_base64 TEXT,
  brand_color TEXT NOT NULL DEFAULT '#00897B',
  city TEXT,
  district TEXT,
  country TEXT NOT NULL DEFAULT 'Uganda',
  patient_number_month TEXT,
  patient_number_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (patient_number_sequence BETWEEN 0 AND 9999),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE clinic_organizations
  ADD COLUMN IF NOT EXISTS patient_number_month TEXT;
ALTER TABLE clinic_organizations
  ADD COLUMN IF NOT EXISTS patient_number_sequence INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_organizations_created_by
  ON clinic_organizations(created_by)
  WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinic_organizations_sector
  ON clinic_organizations(sector);

CREATE TABLE IF NOT EXISTS clinic_branches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  address TEXT,
  city TEXT,
  district TEXT,
  phone TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clinic_branches_organization
  ON clinic_branches(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_branches_organization_code
  ON clinic_branches(organization_id, lower(code))
  WHERE code IS NOT NULL AND length(trim(code)) > 0;

CREATE TABLE IF NOT EXISTS clinic_patients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES clinic_branches(id) ON DELETE SET NULL,
  patient_number TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  gender TEXT,
  date_of_birth DATE,
  national_id TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  village TEXT,
  district TEXT,
  blood_group TEXT,
  allergies TEXT,
  chronic_conditions TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  photo_base64 TEXT,
  portal_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, patient_number)
);
CREATE INDEX IF NOT EXISTS idx_clinic_patients_organization
  ON clinic_patients(organization_id);
CREATE INDEX IF NOT EXISTS idx_clinic_patients_branch
  ON clinic_patients(branch_id);
CREATE INDEX IF NOT EXISTS idx_clinic_patients_phone
  ON clinic_patients(organization_id, phone);
CREATE INDEX IF NOT EXISTS idx_clinic_patients_name
  ON clinic_patients(organization_id, lower(last_name), lower(first_name));

CREATE TABLE IF NOT EXISTS clinic_staff (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES clinic_branches(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('doctor', 'nurse', 'receptionist', 'pharmacist')),
  employee_code TEXT,
  license_number TEXT,
  specialization TEXT,
  hired_on DATE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clinic_staff_organization
  ON clinic_staff(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_staff_user_unique
  ON clinic_staff(user_id);

CREATE TABLE IF NOT EXISTS clinic_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL UNIQUE REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'UGX',
  consultation_fee NUMERIC(12, 2) NOT NULL DEFAULT 20000,
  opening_time TIME NOT NULL DEFAULT '08:00',
  closing_time TIME NOT NULL DEFAULT '17:00',
  working_days TEXT[] NOT NULL DEFAULT ARRAY['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (consultation_fee >= 0),
  CHECK (opening_time < closing_time)
);

CREATE TABLE IF NOT EXISTS clinic_audit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_table TEXT,
  target_id UUID,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clinic_audit_organization
  ON clinic_audit(organization_id);
CREATE INDEX IF NOT EXISTS idx_clinic_audit_created_at
  ON clinic_audit(created_at DESC);

-- Patient numbers are scoped to an organization, so two clinics can both start at 0001.
