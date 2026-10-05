-- APSHULE Phase 3C-2: disbursements, schedules, payments, reversals and credit notes.
-- Apply only this additive migration to the existing Neon database.

ALTER TABLE mfi_customers DROP CONSTRAINT IF EXISTS mfi_customers_status_check;
ALTER TABLE mfi_customers
  ADD CONSTRAINT mfi_customers_status_check
  CHECK (status IN ('active', 'inactive', 'has_active_loan'));

CREATE TABLE IF NOT EXISTS mfi_loans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  application_id UUID UNIQUE REFERENCES mfi_loan_applications(id) ON DELETE SET NULL,
  customer_id UUID NOT NULL REFERENCES mfi_customers(id) ON DELETE RESTRICT,
  product_id UUID REFERENCES mfi_loan_products(id) ON DELETE SET NULL,
  branch_id UUID REFERENCES mfi_branches(id) ON DELETE SET NULL,
  loan_number TEXT NOT NULL UNIQUE,
  principal NUMERIC NOT NULL CHECK (principal > 0),
  interest_rate NUMERIC NOT NULL DEFAULT 0,
  interest_method TEXT NOT NULL CHECK (interest_method IN ('flat', 'reducing_balance')),
  term_months INT NOT NULL CHECK (term_months BETWEEN 1 AND 360),
  repayment_frequency TEXT NOT NULL CHECK (repayment_frequency IN ('monthly', 'biweekly', 'weekly')),
  late_fee_percent NUMERIC NOT NULL DEFAULT 0,
  grace_period_days INT NOT NULL DEFAULT 0,
  total_interest NUMERIC NOT NULL DEFAULT 0,
  total_fees NUMERIC NOT NULL DEFAULT 0,
  total_repayable NUMERIC NOT NULL DEFAULT 0,
  total_paid NUMERIC NOT NULL DEFAULT 0,
  total_principal_paid NUMERIC NOT NULL DEFAULT 0,
  total_interest_paid NUMERIC NOT NULL DEFAULT 0,
  total_fees_paid NUMERIC NOT NULL DEFAULT 0,
  total_late_fees NUMERIC NOT NULL DEFAULT 0,
  outstanding_balance NUMERIC NOT NULL DEFAULT 0,
  disbursement_method TEXT NOT NULL CHECK (disbursement_method IN ('cash', 'mobile_money', 'bank')),
  disbursement_reference TEXT,
  disbursed_at TIMESTAMPTZ NOT NULL,
  first_installment_date DATE NOT NULL,
  maturity_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'past_due', 'defaulted', 'completed', 'written_off')),
  days_overdue INT NOT NULL DEFAULT 0 CHECK (days_overdue >= 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  disbursed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfi_loans_org_status ON mfi_loans(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_mfi_loans_customer ON mfi_loans(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mfi_loans_branch ON mfi_loans(organization_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_mfi_loans_disbursed_at ON mfi_loans(organization_id, disbursed_at DESC);

CREATE TABLE IF NOT EXISTS mfi_loan_schedules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  loan_id UUID NOT NULL REFERENCES mfi_loans(id) ON DELETE CASCADE,
  installment_number INT NOT NULL CHECK (installment_number > 0),
  due_date DATE NOT NULL,
  principal_due NUMERIC NOT NULL DEFAULT 0 CHECK (principal_due >= 0),
  interest_due NUMERIC NOT NULL DEFAULT 0 CHECK (interest_due >= 0),
  fees_due NUMERIC NOT NULL DEFAULT 0 CHECK (fees_due >= 0),
  total_due NUMERIC NOT NULL DEFAULT 0 CHECK (total_due >= 0),
  principal_paid NUMERIC NOT NULL DEFAULT 0 CHECK (principal_paid >= 0),
  interest_paid NUMERIC NOT NULL DEFAULT 0 CHECK (interest_paid >= 0),
  fees_paid NUMERIC NOT NULL DEFAULT 0 CHECK (fees_paid >= 0),
  late_fee_due NUMERIC NOT NULL DEFAULT 0 CHECK (late_fee_due >= 0),
  late_fee_paid NUMERIC NOT NULL DEFAULT 0 CHECK (late_fee_paid >= 0),
  total_paid NUMERIC NOT NULL DEFAULT 0 CHECK (total_paid >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'partial', 'overdue', 'paid')),
  days_late INT NOT NULL DEFAULT 0 CHECK (days_late >= 0),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (loan_id, installment_number)
);
CREATE INDEX IF NOT EXISTS idx_mfi_loan_schedules_due ON mfi_loan_schedules(due_date, status);
CREATE INDEX IF NOT EXISTS idx_mfi_loan_schedules_loan_status ON mfi_loan_schedules(loan_id, status, due_date);

CREATE TABLE IF NOT EXISTS mfi_loan_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  loan_id UUID NOT NULL REFERENCES mfi_loans(id) ON DELETE CASCADE,
  receipt_number TEXT NOT NULL UNIQUE,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  principal_applied NUMERIC NOT NULL DEFAULT 0 CHECK (principal_applied >= 0),
  interest_applied NUMERIC NOT NULL DEFAULT 0 CHECK (interest_applied >= 0),
  fees_applied NUMERIC NOT NULL DEFAULT 0 CHECK (fees_applied >= 0),
  late_fees_applied NUMERIC NOT NULL DEFAULT 0 CHECK (late_fees_applied >= 0),
  overpayment NUMERIC NOT NULL DEFAULT 0 CHECK (overpayment >= 0),
  schedule_allocations JSONB NOT NULL DEFAULT '[]'::jsonb,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'mobile_money', 'bank')),
  payment_reference TEXT,
  paid_at TIMESTAMPTZ NOT NULL,
  notes TEXT,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reversed_at TIMESTAMPTZ,
  reversed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reversal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (reversed_at IS NULL AND reversed_by IS NULL AND reversal_reason IS NULL) OR
    (reversed_at IS NOT NULL AND reversed_by IS NOT NULL AND reversal_reason IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_mfi_loan_payments_loan ON mfi_loan_payments(loan_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_mfi_loan_payments_org ON mfi_loan_payments(organization_id, paid_at DESC);

CREATE TABLE IF NOT EXISTS mfi_credit_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  loan_id UUID NOT NULL REFERENCES mfi_loans(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  issued_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfi_credit_notes_loan ON mfi_credit_notes(loan_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mfi_loan_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  loan_id UUID NOT NULL REFERENCES mfi_loans(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfi_loan_history_loan ON mfi_loan_history(loan_id, created_at, id);
