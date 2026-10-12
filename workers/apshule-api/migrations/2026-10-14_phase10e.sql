CREATE TABLE IF NOT EXISTS school_report_card_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID REFERENCES schools(id) ON DELETE CASCADE UNIQUE,
  status TEXT NOT NULL DEFAULT 'trial',
  trial_used BOOLEAN NOT NULL DEFAULT FALSE,
  trial_used_at TIMESTAMPTZ,
  paid_until TIMESTAMPTZ,
  waived_until TIMESTAMPTZ,
  waived_by UUID REFERENCES users(id) ON DELETE SET NULL,
  waiver_reason TEXT,
  payment_reference TEXT,
  price_ugx NUMERIC NOT NULL DEFAULT 100000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS learner_fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID REFERENCES schools(id) ON DELETE CASCADE,
  learner_id UUID REFERENCES learners(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  year INT NOT NULL,
  total_fees NUMERIC NOT NULL DEFAULT 0,
  amount_paid NUMERIC NOT NULL DEFAULT 0,
  balance NUMERIC NOT NULL DEFAULT 0,
  school_pay_ref TEXT,
  notes TEXT,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(learner_id,term,year)
);
CREATE INDEX IF NOT EXISTS idx_lf_learner ON learner_fees(learner_id);
CREATE TABLE IF NOT EXISTS learner_bulk_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID REFERENCES schools(id) ON DELETE CASCADE,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  file_name TEXT,
  total_rows INT NOT NULL DEFAULT 0,
  created_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
