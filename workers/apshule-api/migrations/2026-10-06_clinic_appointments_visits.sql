-- APSHULE Phase 4B-1: additive Clinic appointment and visit records.
-- This migration creates new Phase 4B tables only; Phase 4A Clinic tables are unchanged.

CREATE TABLE IF NOT EXISTS clinic_number_counters (
  organization_id UUID NOT NULL
    REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period ~ '^[0-9]{6}$'),
  record_type TEXT NOT NULL CHECK (record_type IN ('appointment', 'visit')),
  current_value INTEGER NOT NULL DEFAULT 0
    CHECK (current_value BETWEEN 0 AND 9999),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, period, record_type)
);

CREATE TABLE IF NOT EXISTS clinic_appointments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL
    REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES clinic_branches(id) ON DELETE SET NULL,
  patient_id UUID NOT NULL
    REFERENCES clinic_patients(id) ON DELETE CASCADE,
  doctor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  appointment_number TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (duration_minutes BETWEEN 5 AND 480),
  reason TEXT,
  cancellation_reason TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN (
      'scheduled', 'checked_in', 'in_progress',
      'completed', 'cancelled', 'no_show'
    )),
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, appointment_number)
);
CREATE INDEX IF NOT EXISTS idx_clinic_appointments_org_date
  ON clinic_appointments(organization_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_clinic_appointments_patient
  ON clinic_appointments(organization_id, patient_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_clinic_appointments_doctor
  ON clinic_appointments(organization_id, doctor_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_clinic_appointments_status
  ON clinic_appointments(organization_id, status, scheduled_for);

CREATE TABLE IF NOT EXISTS clinic_visits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL
    REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES clinic_branches(id) ON DELETE SET NULL,
  patient_id UUID NOT NULL
    REFERENCES clinic_patients(id) ON DELETE CASCADE,
  appointment_id UUID REFERENCES clinic_appointments(id) ON DELETE SET NULL,
  doctor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  visit_number TEXT NOT NULL,
  visit_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  visit_ended_at TIMESTAMPTZ,
  chief_complaint TEXT,
  symptoms TEXT,
  vitals JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(vitals) = 'object'),
  examination_notes TEXT,
  diagnosis TEXT,
  diagnosis_code TEXT,
  treatment_plan TEXT,
  referral TEXT,
  follow_up_date DATE,
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'referred', 'voided')),
  deleted_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, visit_number)
);
CREATE INDEX IF NOT EXISTS idx_clinic_visits_org_started
  ON clinic_visits(organization_id, visit_started_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinic_visits_patient
  ON clinic_visits(organization_id, patient_id, visit_started_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinic_visits_doctor
  ON clinic_visits(organization_id, doctor_id, visit_started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_visits_one_per_appointment
  ON clinic_visits(organization_id, appointment_id)
  WHERE appointment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS clinic_visit_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL
    REFERENCES clinic_organizations(id) ON DELETE CASCADE,
  visit_id UUID NOT NULL REFERENCES clinic_visits(id) ON DELETE CASCADE,
  note_type TEXT,
  note_text TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clinic_visit_notes_org_visit
  ON clinic_visit_notes(organization_id, visit_id, created_at);
