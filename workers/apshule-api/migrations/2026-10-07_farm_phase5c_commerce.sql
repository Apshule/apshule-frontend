-- APSHULE Phase 5C: Farm produce, sales, expenses, and camera registry.
-- This migration creates only new Phase 5C tables; it does not alter 5A/5B tables.

CREATE TABLE IF NOT EXISTS farm_produce (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES farm_organizations(id) ON DELETE CASCADE,
  location_id UUID REFERENCES farm_locations(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'kg',
  current_stock NUMERIC NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
  reorder_level NUMERIC NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  cost_price NUMERIC CHECK (cost_price IS NULL OR cost_price >= 0),
  selling_price NUMERIC CHECK (selling_price IS NULL OR selling_price >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_farm_prod_org ON farm_produce(organization_id);
CREATE INDEX IF NOT EXISTS idx_farm_prod_location ON farm_produce(organization_id, location_id, active);

CREATE TABLE IF NOT EXISTS farm_produce_movements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES farm_organizations(id) ON DELETE CASCADE,
  produce_id UUID NOT NULL REFERENCES farm_produce(id) ON DELETE CASCADE,
  movement_type TEXT NOT NULL
    CHECK (movement_type IN ('harvest', 'purchase', 'adjustment', 'loss', 'return', 'sale')),
  quantity NUMERIC NOT NULL CHECK (quantity <> 0),
  balance_after NUMERIC NOT NULL CHECK (balance_after >= 0),
  unit_cost NUMERIC CHECK (unit_cost IS NULL OR unit_cost >= 0),
  reference TEXT,
  notes TEXT,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_farm_pm_prod ON farm_produce_movements(produce_id);
CREATE INDEX IF NOT EXISTS idx_farm_pm_org_date ON farm_produce_movements(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_farm_pm_type_date ON farm_produce_movements(organization_id, movement_type, created_at DESC);

CREATE TABLE IF NOT EXISTS farm_sales (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES farm_organizations(id) ON DELETE CASCADE,
  location_id UUID REFERENCES farm_locations(id) ON DELETE SET NULL,
  sale_number TEXT NOT NULL,
  buyer_name TEXT,
  buyer_phone TEXT,
  sale_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_owner_review'
    CHECK (status IN (
      'pending_owner_review', 'payment_confirmed', 'release_authorized',
      'released', 'closed', 'rejected', 'cancelled'
    )),
  payment_channel TEXT
    CHECK (payment_channel IS NULL OR payment_channel IN (
      'mobile_money', 'paypal', 'bank', 'card'
    )),
  external_payment_reference TEXT,
  payment_confirmation_notes TEXT,
  payment_confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  payment_confirmed_at TIMESTAMPTZ,
  verbal_authorization_audio TEXT,
  release_authorization_notes TEXT,
  release_authorized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  release_authorized_at TIMESTAMPTZ,
  released_by UUID REFERENCES users(id) ON DELETE SET NULL,
  released_at TIMESTAMPTZ,
  rejection_reason TEXT,
  rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  rejected_at TIMESTAMPTZ,
  closed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  subtotal NUMERIC NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount NUMERIC NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total NUMERIC NOT NULL DEFAULT 0 CHECK (total >= 0),
  amount_paid NUMERIC NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  balance_due NUMERIC NOT NULL DEFAULT 0 CHECK (balance_due >= 0),
  notes TEXT,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Sale-number series restart monthly per organization.
  UNIQUE (organization_id, sale_number),
  CHECK (discount <= subtotal),
  CHECK (total = subtotal - discount),
  CHECK (amount_paid <= total),
  CHECK (balance_due = total - amount_paid),
  CHECK (
    (status = 'pending_owner_review' AND amount_paid = 0)
    OR status <> 'pending_owner_review'
  )
);
CREATE INDEX IF NOT EXISTS idx_farm_sale_org ON farm_sales(organization_id, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_farm_sale_date ON farm_sales(sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_farm_sale_recorder ON farm_sales(organization_id, recorded_by, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_farm_sale_status ON farm_sales(organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS farm_sale_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sale_id UUID NOT NULL REFERENCES farm_sales(id) ON DELETE CASCADE,
  produce_id UUID REFERENCES farm_produce(id) ON DELETE SET NULL,
  produce_name TEXT NOT NULL,
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC NOT NULL CHECK (unit_price >= 0),
  total NUMERIC NOT NULL CHECK (total >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_farm_sale_items_sale ON farm_sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_farm_sale_items_product ON farm_sale_items(produce_id);

CREATE TABLE IF NOT EXISTS farm_expenses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES farm_organizations(id) ON DELETE CASCADE,
  location_id UUID REFERENCES farm_locations(id) ON DELETE SET NULL,
  expense_date DATE NOT NULL,
  category TEXT NOT NULL CHECK (btrim(category) <> ''),
  description TEXT,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL DEFAULT 'cash'
    CHECK (payment_method IN ('cash', 'momo', 'bank', 'credit')),
  reference TEXT,
  vendor TEXT,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_farm_exp_org ON farm_expenses(organization_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_farm_exp_date ON farm_expenses(expense_date DESC);

CREATE TABLE IF NOT EXISTS farm_cameras (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES farm_organizations(id) ON DELETE CASCADE,
  location_id UUID REFERENCES farm_locations(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  camera_type TEXT NOT NULL DEFAULT 'ip',
  stream_url TEXT,
  purpose TEXT
    CHECK (purpose IS NULL OR purpose IN ('egg_counting', 'animal_monitoring', 'security', 'feed_check')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_farm_cam_org ON farm_cameras(organization_id, active);
