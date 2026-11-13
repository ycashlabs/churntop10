-- Live holdings sync and live order records.
-- Portable types only: TEXT columns and a standard index. Existing rows default to 'app'.
ALTER TABLE positions ADD COLUMN source TEXT NOT NULL DEFAULT 'app';
ALTER TABLE trades ADD COLUMN source TEXT NOT NULL DEFAULT 'app';
CREATE INDEX IF NOT EXISTS positions_mode_symbol_status_idx ON positions (mode, symbol, status);
CREATE INDEX IF NOT EXISTS trades_broker_order_idx ON trades (broker_order_id);
