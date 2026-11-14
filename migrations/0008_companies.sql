-- One company per SEC CIK. A later registry (when and why a company was
-- added) and a company profile can ALTER in added_at, source, and filing
-- columns. Do not rename this table and do not replace it with a ticker-keyed table.
-- ticker is the symbol the app shows for that company. It is not the primary key.
CREATE TABLE companies (
  cik TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  name TEXT NOT NULL,
  exchange TEXT NOT NULL DEFAULT '',
  sic TEXT,
  sic_description TEXT,
  sector TEXT,
  names_fetched_at INTEGER,
  sic_fetched_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX companies_ticker_idx ON companies (ticker);

-- One-row clock so the exchange file is fetched at most once per day
-- even though the Worker cron runs every 5 minutes. Not a company record.
CREATE TABLE sec_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tickers_fetched_at INTEGER NOT NULL DEFAULT 0
);
