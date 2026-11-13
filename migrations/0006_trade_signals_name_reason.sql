-- Persist signal display name and reason text on each trade_signals row.
-- Portable types only: TEXT columns. Existing rows stay NULL until a new write or backfill.
ALTER TABLE trade_signals ADD COLUMN name TEXT;
ALTER TABLE trade_signals ADD COLUMN reason TEXT;
