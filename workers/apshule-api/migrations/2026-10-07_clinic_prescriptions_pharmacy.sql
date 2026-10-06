-- APSHULE Phase 4B-2: additive prescriptions and basic pharmacy inventory.
-- Phase 4A and Phase 4B-1 tables remain unchanged.

CREATE TABLE IF NOT EXISTS clinic_rx_number_counters (
  organization_id UUID NOT NULL
    REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period ~ '^[0-9]{6}$'),
  current_value INTEGER NOT NULL DEFAULT 0
    CHECK (current_value BETWEEN 0 AND 9999),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, period)
);

CREATE TABLE IF NOT EXISTS clinic_medicines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL
    REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (btrim(code) <> ''),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  generic_name TEXT,
  category TEXT,
  form TEXT,
  strength TEXT,
  manufacturer TEXT,
  unit TEXT NOT NULL DEFAULT 'tablet',
  reorder_level INTEGER NOT NULL DEFAULT 20 CHECK (reorder_level >= 0),
  current_stock INTEGER NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
  cost_price NUMERIC(14,2) CHECK (cost_price IS NULL OR cost_price >= 0),
  selling_price NUMERIC(14,2) CHECK (selling_price IS NULL OR selling_price >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS idx_clinic_medicines_org
  ON clinic_medicines(organization_id);
CREATE INDEX IF NOT EXISTS idx_clinic_medicines_org_name
  ON clinic_medicines(organization_id, name);
CREATE INDEX IF NOT EXISTS idx_clinic_medicines_org_category
  ON clinic_medicines(organization_id, category);
CREATE INDEX IF NOT EXISTS idx_clinic_medicines_stock
  ON clinic_medicines(organization_id, current_stock, reorder_level)
  WHERE active IS TRUE;

CREATE TABLE IF NOT EXISTS clinic_prescriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL
    REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  visit_id UUID REFERENCES clinic_visits(id) ON DELETE SET NULL,
  patient_id UUID NOT NULL REFERENCES clinic_patients(id) ON DELETE CASCADE,
  doctor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  prescription_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'dispensed', 'cancelled')),
  notes TEXT,
  dispensed_at TIMESTAMPTZ,
  dispensed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, prescription_number)
);
CREATE INDEX IF NOT EXISTS idx_clinic_prescriptions_org
  ON clinic_prescriptions(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinic_prescriptions_patient
  ON clinic_prescriptions(organization_id, patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinic_prescriptions_visit
  ON clinic_prescriptions(organization_id, visit_id);
CREATE INDEX IF NOT EXISTS idx_clinic_prescriptions_doctor
  ON clinic_prescriptions(organization_id, doctor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinic_prescriptions_status
  ON clinic_prescriptions(organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS clinic_prescription_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  prescription_id UUID NOT NULL
    REFERENCES clinic_prescriptions(id) ON DELETE CASCADE,
  medicine_id UUID REFERENCES clinic_medicines(id) ON DELETE SET NULL,
  medicine_name TEXT NOT NULL CHECK (btrim(medicine_name) <> ''),
  dosage TEXT NOT NULL CHECK (btrim(dosage) <> ''),
  frequency TEXT NOT NULL CHECK (btrim(frequency) <> ''),
  duration TEXT NOT NULL CHECK (btrim(duration) <> ''),
  route TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  instructions TEXT,
  dispensed_quantity INTEGER NOT NULL DEFAULT 0
    CHECK (dispensed_quantity >= 0 AND dispensed_quantity <= quantity),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clinic_prescription_items_rx
  ON clinic_prescription_items(prescription_id, created_at);
CREATE INDEX IF NOT EXISTS idx_clinic_prescription_items_medicine
  ON clinic_prescription_items(medicine_id)
  WHERE medicine_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS clinic_stock_movements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL
    REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  medicine_id UUID NOT NULL
    REFERENCES clinic_medicines(id) ON DELETE CASCADE,
  movement_type TEXT NOT NULL
    CHECK (movement_type IN ('restock', 'adjustment', 'expiry', 'damage', 'return', 'dispense')),
  quantity INTEGER NOT NULL CHECK (quantity <> 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reference TEXT,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (movement_type IN ('restock', 'return') AND quantity > 0)
    OR (movement_type IN ('expiry', 'damage', 'dispense') AND quantity < 0)
    OR movement_type = 'adjustment'
  )
);
CREATE INDEX IF NOT EXISTS idx_clinic_stock_movements_org
  ON clinic_stock_movements(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinic_stock_movements_medicine
  ON clinic_stock_movements(organization_id, medicine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinic_stock_movements_reference
  ON clinic_stock_movements(organization_id, reference)
  WHERE reference IS NOT NULL;
