-- APSHULE Phase 3B: additive MFI collateral management.
-- Apply only this scoped migration to the existing Neon database.

CREATE TABLE IF NOT EXISTS mfi_collateral_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  base_score INT DEFAULT 50 CHECK (base_score BETWEEN 0 AND 100),
  requires_valuation BOOLEAN DEFAULT TRUE,
  requires_legal BOOLEAN DEFAULT FALSE,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mct_org ON mfi_collateral_types(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mct_org_code
  ON mfi_collateral_types(organization_id, upper(code))
  WHERE organization_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mfi_collateral (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES mfi_branches(id) ON DELETE SET NULL,
  customer_id UUID NOT NULL REFERENCES mfi_customers(id) ON DELETE CASCADE,
  collateral_type_id UUID REFERENCES mfi_collateral_types(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  estimated_value NUMERIC NOT NULL CHECK (estimated_value >= 0),
  currency TEXT DEFAULT 'UGX',
  condition TEXT,
  location TEXT,
  photos JSONB DEFAULT '[]'::jsonb,
  documents JSONB DEFAULT '[]'::jsonb,
  score INT CHECK (score BETWEEN 0 AND 100),
  score_breakdown JSONB,
  status TEXT DEFAULT 'draft' CHECK (status IN (
    'draft', 'pending_review', 'approved', 'rejected', 'awaiting_valuation',
    'valued', 'awaiting_legal', 'legal_cleared', 'legal_issue'
  )),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  valuer_id UUID,
  valuer_name TEXT,
  valuer_phone TEXT,
  valuation_report JSONB,
  valuation_date TIMESTAMPTZ,
  legal_officer_id UUID,
  legal_officer_name TEXT,
  legal_status TEXT CHECK (legal_status IS NULL OR legal_status IN ('clear', 'disputed', 'encumbered')),
  legal_notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mc_org ON mfi_collateral(organization_id);
CREATE INDEX IF NOT EXISTS idx_mc_cust ON mfi_collateral(customer_id);
CREATE INDEX IF NOT EXISTS idx_mc_status ON mfi_collateral(status);
CREATE INDEX IF NOT EXISTS idx_mc_branch ON mfi_collateral(branch_id);
CREATE INDEX IF NOT EXISTS idx_mc_type ON mfi_collateral(collateral_type_id);

CREATE TABLE IF NOT EXISTS mfi_valuers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  license_number TEXT,
  specializations TEXT[],
  address TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfi_valuers_org ON mfi_valuers(organization_id);

CREATE TABLE IF NOT EXISTS mfi_legal_officers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES mfi_organizations(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  law_firm TEXT,
  license_number TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfi_legal_officers_org ON mfi_legal_officers(organization_id);
