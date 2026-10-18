-- Run once against your existing D1 database:
--   npx wrangler d1 execute hungerr-db --remote --file=migrations/002_secure_payments.sql

ALTER TABLE orders ADD COLUMN pay_paise INTEGER;   -- exact amount the customer must pay, in paise
ALTER TABLE orders ADD COLUMN expires_at TEXT;     -- ISO time the payment window closes
ALTER TABLE orders ADD COLUMN paid_at TEXT;

-- Old orders were "paid" by the open verify/webhook endpoints, so none were truly verified.
-- Relabel them so you can review them instead of trusting them.
UPDATE orders SET status = 'PAID_UNVERIFIED'
  WHERE status = 'PAID' AND payment_ref IN ('YOUPI-VERIFIED', 'GATEWAY-PAID');
UPDATE orders SET status = 'EXPIRED' WHERE status = 'PENDING';

-- Only one pending order may hold a given payable amount at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_pending_amount
  ON orders(pay_paise) WHERE status = 'PENDING' AND pay_paise IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_status_exp ON orders(status, expires_at);

-- Every alert forwarded by the phone, matched or not (look here if a payment doesn't confirm)
CREATE TABLE IF NOT EXISTS bank_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  sender TEXT,
  body TEXT NOT NULL,
  amount_paise INTEGER,
  utr TEXT,
  outcome TEXT NOT NULL,       -- MATCHED, UNMATCHED, UNPARSED, IGNORED_SOURCE, IGNORED_NOT_CREDIT
  matched_cid TEXT,
  dedupe_key TEXT UNIQUE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_ip_ts ON attempts(ip, ts);
