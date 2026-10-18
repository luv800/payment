-- Fresh-install schema (existing databases: run migrations/002_secure_payments.sql instead)
CREATE TABLE IF NOT EXISTS customers (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gender TEXT,
  dob TEXT,
  branch TEXT,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  cid TEXT UNIQUE NOT NULL,
  ts TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'New',
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  branch TEXT,
  mode TEXT,
  pay TEXT,
  subtotal INTEGER,
  total INTEGER,
  items TEXT NOT NULL,
  payment_ref TEXT,
  utr TEXT,
  pay_paise INTEGER,
  expires_at TEXT,
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_ts ON orders(ts);
CREATE INDEX IF NOT EXISTS idx_orders_cid ON orders(cid);
CREATE INDEX IF NOT EXISTS idx_orders_status_exp ON orders(status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_pending_amount
  ON orders(pay_paise) WHERE status = 'PENDING' AND pay_paise IS NOT NULL;

CREATE TABLE IF NOT EXISTS attempts (ip TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_attempts_ip_ts ON attempts(ip, ts);

CREATE TABLE IF NOT EXISTS bank_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  sender TEXT,
  body TEXT NOT NULL,
  amount_paise INTEGER,
  utr TEXT,
  outcome TEXT NOT NULL,
  matched_cid TEXT,
  dedupe_key TEXT UNIQUE NOT NULL
);
