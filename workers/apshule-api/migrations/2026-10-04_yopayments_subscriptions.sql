CREATE TABLE IF NOT EXISTS subscription_plans (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price NUMERIC NOT NULL,
  currency TEXT DEFAULT 'UGX',
  duration_days INT NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  display_order INT DEFAULT 0
);

INSERT INTO subscription_plans (code, name, price, currency, duration_days, display_order) VALUES
  ('daily', 'Daily', 500, 'UGX', 1, 1),
  ('weekly', 'Weekly', 3000, 'UGX', 7, 2),
  ('monthly', 'Monthly', 10000, 'UGX', 30, 3),
  ('term', 'Term', 50000, 'UGX', 90, 4),
  ('half_year', 'Half Year', 80000, 'UGX', 180, 5),
  ('full_year', 'Full Year', 150000, 'UGX', 365, 6)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS plan_code TEXT,
  ADD COLUMN IF NOT EXISTS subscription_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ipn_payload JSONB,
  ADD COLUMN IF NOT EXISTS ipn_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS yo_transaction_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_payments_plan_code ON payments(plan_code);

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending', 'completed', 'success', 'failed', 'cancelled'));

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  plan_code TEXT,
  payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_active ON user_subscriptions(active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_subscriptions_payment_unique
  ON user_subscriptions(payment_id)
  WHERE payment_id IS NOT NULL;