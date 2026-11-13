ALTER TABLE app_settings ADD COLUMN trading_capital REAL NOT NULL DEFAULT 0;

CREATE TABLE signals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE INDEX signals_status_idx ON signals (status);

CREATE TABLE trading_rules (
  id TEXT PRIMARY KEY,
  side TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE rule_versions (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (rule_id) REFERENCES trading_rules (id)
);
CREATE INDEX rule_versions_rule_idx ON rule_versions (rule_id, version);

CREATE TABLE rule_signals (
  rule_version_id TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  params TEXT NOT NULL,
  PRIMARY KEY (rule_version_id, signal_id),
  FOREIGN KEY (rule_version_id) REFERENCES rule_versions (id),
  FOREIGN KEY (signal_id) REFERENCES signals (id)
);

CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL,
  trading_capital_snapshot REAL NOT NULL,
  profit_target_pct REAL NOT NULL,
  stop_loss_pct REAL NOT NULL,
  buy_rule_version_id TEXT,
  sell_rule_version_id TEXT,
  avg_cost REAL NOT NULL,
  qty REAL NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  FOREIGN KEY (buy_rule_version_id) REFERENCES rule_versions (id),
  FOREIGN KEY (sell_rule_version_id) REFERENCES rule_versions (id)
);
CREATE INDEX positions_mode_status_idx ON positions (mode, status);
CREATE INDEX positions_symbol_idx ON positions (symbol);

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
  rule_version_id TEXT,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  limit_price REAL,
  fill_price REAL,
  session TEXT NOT NULL,
  bid_at_order REAL,
  ask_at_order REAL,
  capital_snapshot REAL NOT NULL,
  size_reason TEXT NOT NULL,
  exit_reason TEXT,
  broker_order_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (position_id) REFERENCES positions (id),
  FOREIGN KEY (rule_version_id) REFERENCES rule_versions (id)
);
CREATE INDEX trades_position_idx ON trades (position_id);

CREATE TABLE trade_signals (
  trade_id TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  value REAL,
  passed INTEGER NOT NULL,
  PRIMARY KEY (trade_id, signal_id),
  FOREIGN KEY (trade_id) REFERENCES trades (id),
  FOREIGN KEY (signal_id) REFERENCES signals (id)
);

CREATE TABLE price_marks (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  price REAL NOT NULL,
  FOREIGN KEY (position_id) REFERENCES positions (id)
);
CREATE INDEX price_marks_position_at_idx ON price_marks (position_id, at);

CREATE TABLE position_reviews (
  position_id TEXT PRIMARY KEY,
  pnl_dollars REAL NOT NULL,
  pnl_pct REAL NOT NULL,
  hold_minutes INTEGER NOT NULL,
  exit_type TEXT NOT NULL,
  best_price REAL,
  worst_price REAL,
  spy_change_at_entry REAL,
  session_at_entry TEXT,
  spread_cost REAL,
  adds_count INTEGER NOT NULL,
  adds_helped INTEGER,
  bot_note TEXT NOT NULL,
  user_note TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (position_id) REFERENCES positions (id)
);

CREATE TABLE position_capital_history (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
  old_value REAL NOT NULL,
  new_value REAL NOT NULL,
  at INTEGER NOT NULL,
  FOREIGN KEY (position_id) REFERENCES positions (id)
);
CREATE INDEX position_capital_history_idx ON position_capital_history (position_id, at);

CREATE TABLE position_exit_settings_history (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value REAL NOT NULL,
  new_value REAL NOT NULL,
  at INTEGER NOT NULL,
  FOREIGN KEY (position_id) REFERENCES positions (id)
);
CREATE INDEX position_exit_settings_history_idx ON position_exit_settings_history (position_id, at);

CREATE TABLE rule_score_snapshots (
  id TEXT PRIMARY KEY,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  mode TEXT NOT NULL,
  rule_id TEXT,
  rule_version_id TEXT,
  trades INTEGER NOT NULL,
  win_rate REAL,
  avg_pnl_pct REAL,
  worst_loss REAL,
  net_after_costs REAL,
  computed_at INTEGER NOT NULL,
  FOREIGN KEY (rule_id) REFERENCES trading_rules (id),
  FOREIGN KEY (rule_version_id) REFERENCES rule_versions (id)
);
CREATE INDEX rule_score_snapshots_period_idx ON rule_score_snapshots (mode, period_end);

CREATE TABLE signal_score_snapshots (
  id TEXT PRIMARY KEY,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  mode TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  win_rate_true REAL,
  avg_pnl_true REAL,
  sample_true INTEGER NOT NULL,
  win_rate_false REAL,
  avg_pnl_false REAL,
  sample_false INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  FOREIGN KEY (signal_id) REFERENCES signals (id)
);
CREATE INDEX signal_score_snapshots_period_idx ON signal_score_snapshots (mode, period_end, signal_id);
