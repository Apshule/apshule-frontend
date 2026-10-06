-- APSHULE Phase 3C-3: MFI reporting, restructures, write-offs, and borrower access.
-- Additive only. Apply this scoped migration to the existing Neon database.

ALTER TABLE mfi_customers
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS portal_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mfi_customers_user_id
  ON mfi_customers(user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mfi_customers_portal
  ON mfi_customers(organization_id, portal_enabled)
  WHERE portal_enabled IS TRUE;

CREATE TABLE IF NOT EXISTS mfi_customer_portal_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES mfi_customers(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfi_customer_portal_log_customer
  ON mfi_customer_portal_log(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mfi_customer_portal_log_org
  ON mfi_customer_portal_log(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mfi_loan_restructures (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  loan_id UUID NOT NULL REFERENCES mfi_loans(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  old_annual_rate NUMERIC NOT NULL,
  new_annual_rate NUMERIC NOT NULL,
  old_term_months INT NOT NULL,
  new_term_months INT NOT NULL,
  old_repayment_frequency TEXT NOT NULL,
  new_repayment_frequency TEXT NOT NULL,
  old_maturity_date DATE NOT NULL,
  new_maturity_date DATE NOT NULL,
  old_outstanding_balance NUMERIC NOT NULL CHECK (old_outstanding_balance >= 0),
  new_outstanding_balance NUMERIC NOT NULL CHECK (new_outstanding_balance >= 0),
  old_total_repayable NUMERIC NOT NULL CHECK (old_total_repayable >= 0),
  new_total_repayable NUMERIC NOT NULL CHECK (new_total_repayable >= 0),
  remaining_principal NUMERIC NOT NULL CHECK (remaining_principal >= 0),
  capitalized_interest NUMERIC NOT NULL DEFAULT 0 CHECK (capitalized_interest >= 0),
  capitalized_fees NUMERIC NOT NULL DEFAULT 0 CHECK (capitalized_fees >= 0),
  installment_amount NUMERIC,
  first_installment_date DATE NOT NULL,
  schedule_count INT NOT NULL CHECK (schedule_count > 0),
  approved_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfi_loan_restructures_loan
  ON mfi_loan_restructures(loan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mfi_loan_restructures_org
  ON mfi_loan_restructures(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mfi_umra_submissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  period_month INT NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  period_year INT NOT NULL CHECK (period_year BETWEEN 2000 AND 2200),
  report_type TEXT NOT NULL CHECK (
    report_type IN ('monthly_summary', 'quarterly_risk_classification')
  ),
  report_data JSONB NOT NULL,
  submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, period_month, period_year, report_type)
);
CREATE INDEX IF NOT EXISTS idx_mfi_umra_submissions_period
  ON mfi_umra_submissions(organization_id, period_year DESC, period_month DESC);

ALTER TABLE mfi_loans
  ADD COLUMN IF NOT EXISTS written_off BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS written_off_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS written_off_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS written_off_reason TEXT,
  ADD COLUMN IF NOT EXISTS written_off_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS write_off_event_id UUID,
  ADD COLUMN IF NOT EXISTS write_off_status_before TEXT,
  ADD COLUMN IF NOT EXISTS write_off_outstanding_before NUMERIC,
  ADD COLUMN IF NOT EXISTS write_off_reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS write_off_reversed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS write_off_reversal_reason TEXT;

ALTER TABLE mfi_loan_schedules
  DROP CONSTRAINT IF EXISTS mfi_loan_schedules_status_check;
ALTER TABLE mfi_loan_schedules
  ADD CONSTRAINT mfi_loan_schedules_status_check
  CHECK (status IN ('pending', 'partial', 'overdue', 'paid', 'restructured'));

ALTER TABLE mfi_loan_schedules
  DROP CONSTRAINT IF EXISTS mfi_loan_schedules_loan_id_installment_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mfi_loan_schedules_active_installment
  ON mfi_loan_schedules(loan_id, installment_number)
  WHERE status <> 'restructured';
