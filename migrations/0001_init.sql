CREATE TABLE owner (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  stepup_until INTEGER NOT NULL DEFAULT 0,
  recovery INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  profit_target_pct REAL NOT NULL,
  stop_loss_pct REAL NOT NULL,
  max_order_pct REAL NOT NULL,
  daily_loss_pct REAL NOT NULL,
  pdt_limit INTEGER NOT NULL,
  mode TEXT NOT NULL,
  killed INTEGER NOT NULL,
  day_start_equity REAL NOT NULL,
  day_start_date TEXT NOT NULL,
  cash REAL NOT NULL,
  account_number TEXT NOT NULL
);

CREATE TABLE top10 (
  rank INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL
);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  ref_id TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  verdict TEXT NOT NULL,
  message TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sim_orders (
  id TEXT PRIMARY KEY,
  ref_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  type TEXT NOT NULL,
  quantity REAL NOT NULL,
  limit_price REAL,
  stop_price REAL,
  status TEXT NOT NULL,
  role TEXT NOT NULL,
  opened_on TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sim_positions (
  symbol TEXT PRIMARY KEY,
  quantity REAL NOT NULL,
  avg_cost REAL NOT NULL,
  opened_on TEXT NOT NULL
);

CREATE TABLE day_trades (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  day TEXT NOT NULL
);

CREATE TABLE oauth_state (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE rh_client (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  client_id TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  registration_endpoint TEXT NOT NULL,
  issuer TEXT NOT NULL,
  resource TEXT NOT NULL
);

CREATE TABLE rh_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_ct TEXT NOT NULL,
  access_iv TEXT NOT NULL,
  refresh_ct TEXT,
  refresh_iv TEXT,
  expires_at TEXT,
  lifetime_secs INTEGER
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE audit_index (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL
);
