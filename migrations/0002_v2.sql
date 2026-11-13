ALTER TABLE app_settings ADD COLUMN order_cap INTEGER NOT NULL DEFAULT 100;

ALTER TABLE sim_positions ADD COLUMN buy_rule_id TEXT;
ALTER TABLE sim_positions ADD COLUMN buy_rule_version INTEGER;
ALTER TABLE sim_positions ADD COLUMN sell_rule_id TEXT;
ALTER TABLE sim_positions ADD COLUMN sell_rule_version INTEGER;

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  name TEXT NOT NULL,
  side TEXT NOT NULL,
  body TEXT NOT NULL,
  signals TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_history (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  version INTEGER NOT NULL,
  detail TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sim_trades (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  quantity REAL NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL NOT NULL,
  pnl REAL NOT NULL,
  opened_on TEXT NOT NULL,
  closed_at INTEGER NOT NULL,
  buy_rule_id TEXT,
  buy_rule_version INTEGER,
  sell_rule_id TEXT,
  sell_rule_version INTEGER,
  signals TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sim_selected_rules (
  rule_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS quote_bars (
  symbol TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price REAL NOT NULL,
  volume REAL NOT NULL,
  PRIMARY KEY (symbol, ts)
);
