-- APSHULE Phase 3C-1: loan products, applications, and approval workflow.
-- Apply only this scoped migration to the existing Neon database.

CREATE TABLE IF NOT EXISTS mfi_loan_products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  min_amount NUMERIC NOT NULL DEFAULT 50000,
  max_amount NUMERIC NOT NULL DEFAULT 5000000,
  default_amount NUMERIC,
  interest_rate NUMERIC NOT NULL DEFAULT 24,
  interest_method TEXT DEFAULT 'reducing_balance',
  term_months INT NOT NULL DEFAULT 12,
  repayment_frequency TEXT DEFAULT 'monthly',
  processing_fee_percent NUMERIC DEFAULT 2,
  insurance_fee_percent NUMERIC DEFAULT 1,
  late_fee_percent NUMERIC DEFAULT 2,
  grace_period_days INT DEFAULT 7,
  requires_collateral BOOLEAN DEFAULT FALSE,
  min_collateral_value NUMERIC,
  requires_guarantors INT DEFAULT 0,
  director_approval_threshold NUMERIC DEFAULT 2000000,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(organization_id, code)
);
CREATE INDEX IF NOT EXISTS idx_mlp_org ON mfi_loan_products(organization_id);

CREATE TABLE IF NOT EXISTS mfi_loan_applications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES mfi_branches(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES mfi_customers(id) ON DELETE CASCADE,
  product_id UUID REFERENCES mfi_loan_products(id) ON DELETE SET NULL,
  reference TEXT UNIQUE NOT NULL,
  requested_amount NUMERIC NOT NULL,
  approved_amount NUMERIC,
  purpose TEXT,
  term_months INT,
  interest_rate NUMERIC,
  interest_method TEXT,
  status TEXT DEFAULT 'draft',
  submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  approval_notes TEXT,
  rejection_reason TEXT,
  total_collateral_value NUMERIC DEFAULT 0,
  total_collateral_score INT DEFAULT 0,
  debt_to_income NUMERIC,
  documents JSONB DEFAULT '[]'::jsonb,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mla_org ON mfi_loan_applications(organization_id);
CREATE INDEX IF NOT EXISTS idx_mla_cust ON mfi_loan_applications(customer_id);
CREATE INDEX IF NOT EXISTS idx_mla_status ON mfi_loan_applications(status);
CREATE INDEX IF NOT EXISTS idx_mla_ref ON mfi_loan_applications(reference);

CREATE TABLE IF NOT EXISTS mfi_loan_application_collateral (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  application_id UUID REFERENCES mfi_loan_applications(id) ON DELETE CASCADE,
  collateral_id UUID REFERENCES mfi_collateral(id) ON DELETE CASCADE,
  linked_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(application_id, collateral_id)
);

CREATE TABLE IF NOT EXISTS mfi_loan_application_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  application_id UUID REFERENCES mfi_loan_applications(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mlah_app ON mfi_loan_application_history(application_id);
