ALTER TABLE farm_sales
  DROP CONSTRAINT IF EXISTS farm_sales_payment_channel_check;

ALTER TABLE farm_sales
  DROP CONSTRAINT IF EXISTS farm_sales_payment_channel_allowed_check;

ALTER TABLE farm_sales
  ADD CONSTRAINT farm_sales_payment_channel_allowed_check
  CHECK (payment_channel IS NULL OR payment_channel IN (
    'mobile_money', 'paypal', 'bank', 'card'
  ));
