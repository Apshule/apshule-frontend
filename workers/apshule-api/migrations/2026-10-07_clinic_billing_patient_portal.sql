ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN (
    'individual', 'teacher', 'school', 'superadmin',
    'mfi_admin', 'loan_officer', 'loan_manager', 'loan_director', 'borrower',
    'clinic_admin', 'doctor', 'nurse', 'receptionist', 'pharmacist', 'patient'
  ));

CREATE TABLE IF NOT EXISTS clinic_services (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  price NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS idx_clinic_services_org_active
  ON clinic_services(organization_id, active, name);

CREATE TABLE IF NOT EXISTS clinic_insurance_providers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  code TEXT,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  coverage_percent NUMERIC(5,2) NOT NULL DEFAULT 80
    CHECK (coverage_percent >= 0 AND coverage_percent <= 100),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_insurance_provider_code
  ON clinic_insurance_providers(organization_id, code)
  WHERE code IS NOT NULL AND length(trim(code)) > 0;
CREATE INDEX IF NOT EXISTS idx_clinic_insurance_providers_org_active
  ON clinic_insurance_providers(organization_id, active, name);

ALTER TABLE clinic_patients
  ADD COLUMN IF NOT EXISTS insurance_provider_id UUID
    REFERENCES clinic_insurance_providers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS insurance_member_number TEXT,
  ADD COLUMN IF NOT EXISTS insurance_valid_until DATE,
  ADD COLUMN IF NOT EXISTS portal_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS user_id UUID
    REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_clinic_patients_insurance_provider
  ON clinic_patients(organization_id, insurance_provider_id)
  WHERE insurance_provider_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_patients_user_id
  ON clinic_patients(user_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS clinic_billing_number_counters (
  organization_id UUID NOT NULL REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  period CHAR(6) NOT NULL CHECK (period ~ '^[0-9]{6}$'),
  number_type TEXT NOT NULL CHECK (number_type IN ('invoice', 'receipt', 'claim')),
  last_value INTEGER NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  PRIMARY KEY (organization_id, period, number_type)
);

CREATE TABLE IF NOT EXISTS clinic_invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES clinic_branches(id) ON DELETE SET NULL,
  patient_id UUID NOT NULL REFERENCES clinic_patients(id) ON DELETE CASCADE,
  visit_id UUID REFERENCES clinic_visits(id) ON DELETE SET NULL,
  insurance_provider_id UUID REFERENCES clinic_insurance_providers(id) ON DELETE SET NULL,
  invoice_number TEXT NOT NULL,
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  tax NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  insurance_covered NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (insurance_covered >= 0),
  patient_portion NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (patient_portion >= 0),
  patient_portion_paid NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (patient_portion_paid >= 0),
  insurance_portion_paid NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (insurance_portion_paid >= 0),
  amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  balance_due NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance_due >= 0),
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft', 'issued', 'partial', 'patient_settled',
      'insurance_settled', 'paid', 'cancelled'
    )),
  due_date DATE,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, invoice_number)
);
CREATE INDEX IF NOT EXISTS idx_clinic_invoices_org
  ON clinic_invoices(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinic_invoices_patient
  ON clinic_invoices(organization_id, patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinic_invoices_status
  ON clinic_invoices(organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinic_invoices_visit
  ON clinic_invoices(organization_id, visit_id)
  WHERE visit_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS clinic_invoice_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID NOT NULL REFERENCES clinic_invoices(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL
    CHECK (item_type IN ('consultation', 'prescription', 'service')),
  description TEXT NOT NULL,
  reference_id UUID,
  quantity NUMERIC(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  total NUMERIC(14,2) NOT NULL CHECK (total >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clinic_invoice_items_invoice
  ON clinic_invoice_items(invoice_id, created_at);

CREATE TABLE IF NOT EXISTS clinic_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES clinic_invoices(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES clinic_patients(id) ON DELETE CASCADE,
  receipt_number TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  applied_amount NUMERIC(14,2) NOT NULL CHECK (applied_amount >= 0),
  payment_method TEXT NOT NULL DEFAULT 'cash'
    CHECK (payment_method IN ('cash', 'momo', 'bank', 'insurance')),
  payment_reference TEXT,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  reversed BOOLEAN NOT NULL DEFAULT FALSE,
  reversed_at TIMESTAMPTZ,
  reversed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reversal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, receipt_number)
);
CREATE INDEX IF NOT EXISTS idx_clinic_payments_invoice
  ON clinic_payments(organization_id, invoice_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinic_payments_patient
  ON clinic_payments(organization_id, patient_id, paid_at DESC);

CREATE TABLE IF NOT EXISTS clinic_insurance_claims (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES clinic_invoices(id) ON DELETE CASCADE,
  provider_id UUID REFERENCES clinic_insurance_providers(id) ON DELETE SET NULL,
  claim_number TEXT NOT NULL,
  claim_amount NUMERIC(14,2) NOT NULL CHECK (claim_amount > 0),
  approved_amount NUMERIC(14,2) CHECK (approved_amount IS NULL OR approved_amount >= 0),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'approved', 'rejected', 'paid')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  payment_received_at TIMESTAMPTZ,
  rejection_reason TEXT,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, claim_number),
  UNIQUE (organization_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_clinic_insurance_claims_org_status
  ON clinic_insurance_claims(organization_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinic_insurance_claims_provider
  ON clinic_insurance_claims(organization_id, provider_id, status);

CREATE TABLE IF NOT EXISTS clinic_portal_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id UUID NOT NULL REFERENCES clinic_patients(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clinic_portal_log_patient
  ON clinic_portal_log(patient_id, created_at DESC);
