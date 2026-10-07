-- Phase 5B additions only: preserve the seven Phase 5A tables except for
-- farm_workers.face_hash, and keep all operations in separate tables.

CREATE TABLE IF NOT EXISTS farm_movements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES farm_organizations(id) ON DELETE CASCADE,
  animal_id UUID NOT NULL REFERENCES farm_animals(id) ON DELETE CASCADE,
  from_location_id UUID REFERENCES farm_locations(id) ON DELETE SET NULL,
  to_location_id UUID REFERENCES farm_locations(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'transfer')),
  movement_type TEXT NOT NULL CHECK (length(btrim(movement_type)) > 0),
  reason TEXT,
  count INT NOT NULL DEFAULT 1 CHECK (count > 0),
  moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_farm_mov_org
  ON farm_movements(organization_id);
CREATE INDEX IF NOT EXISTS idx_farm_mov_animal
  ON farm_movements(animal_id);
CREATE INDEX IF NOT EXISTS idx_farm_mov_date
  ON farm_movements(moved_at DESC);
CREATE INDEX IF NOT EXISTS idx_farm_mov_org_date
  ON farm_movements(organization_id, moved_at DESC);

CREATE TABLE IF NOT EXISTS farm_egg_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES farm_organizations(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES farm_locations(id) ON DELETE CASCADE,
  animal_type_id UUID REFERENCES farm_animal_types(id) ON DELETE SET NULL,
  record_date DATE NOT NULL,
  shift TEXT NOT NULL CHECK (shift IN ('Morning', 'Afternoon', 'Evening')),
  eggs_collected INT NOT NULL DEFAULT 0 CHECK (eggs_collected >= 0),
  eggs_broken INT NOT NULL DEFAULT 0 CHECK (eggs_broken >= 0),
  eggs_good INT NOT NULL DEFAULT 0 CHECK (eggs_good >= 0),
  notes TEXT,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT farm_egg_counts_consistent
    CHECK (eggs_broken <= eggs_collected AND eggs_good = eggs_collected - eggs_broken),
  CONSTRAINT farm_egg_shift_unique
    UNIQUE (organization_id, location_id, record_date, shift)
);

CREATE INDEX IF NOT EXISTS idx_farm_egg_org
  ON farm_egg_records(organization_id);
CREATE INDEX IF NOT EXISTS idx_farm_egg_date
  ON farm_egg_records(record_date DESC);
CREATE INDEX IF NOT EXISTS idx_farm_egg_org_date
  ON farm_egg_records(organization_id, record_date DESC);

CREATE TABLE IF NOT EXISTS farm_attendance (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES farm_organizations(id) ON DELETE CASCADE,
  worker_id UUID NOT NULL REFERENCES farm_workers(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  check_in TIMESTAMPTZ,
  check_out TIMESTAMPTZ,
  hours_worked NUMERIC CHECK (hours_worked IS NULL OR hours_worked >= 0),
  status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent', 'late')),
  face_match_score INT CHECK (face_match_score IS NULL OR face_match_score BETWEEN 0 AND 64),
  notes TEXT,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT farm_attendance_time_order
    CHECK (check_in IS NULL OR check_out IS NULL OR check_out >= check_in),
  CONSTRAINT farm_attendance_worker_day_unique
    UNIQUE (organization_id, worker_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS idx_farm_att_org
  ON farm_attendance(organization_id);
CREATE INDEX IF NOT EXISTS idx_farm_att_date
  ON farm_attendance(attendance_date DESC);
CREATE INDEX IF NOT EXISTS idx_farm_att_org_date
  ON farm_attendance(organization_id, attendance_date DESC);
CREATE INDEX IF NOT EXISTS idx_farm_att_worker_date
  ON farm_attendance(worker_id, attendance_date DESC);

CREATE TABLE IF NOT EXISTS farm_health_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES farm_organizations(id) ON DELETE CASCADE,
  animal_id UUID NOT NULL REFERENCES farm_animals(id) ON DELETE CASCADE,
  log_date DATE NOT NULL,
  log_type TEXT NOT NULL CHECK (log_type IN ('checkup', 'vaccination', 'illness', 'treatment', 'recovery')),
  description TEXT,
  treatment TEXT,
  vet_name TEXT,
  cost NUMERIC CHECK (cost IS NULL OR cost >= 0),
  next_due_date DATE,
  photos JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(photos) = 'array'),
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_farm_health_animal
  ON farm_health_logs(animal_id);
CREATE INDEX IF NOT EXISTS idx_farm_health_date
  ON farm_health_logs(log_date DESC);
CREATE INDEX IF NOT EXISTS idx_farm_health_org_date
  ON farm_health_logs(organization_id, log_date DESC);
CREATE INDEX IF NOT EXISTS idx_farm_health_due
  ON farm_health_logs(organization_id, next_due_date)
  WHERE next_due_date IS NOT NULL;

ALTER TABLE farm_workers
  ADD COLUMN IF NOT EXISTS face_hash TEXT;
