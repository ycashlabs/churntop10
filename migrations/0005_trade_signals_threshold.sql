-- Persist the decision cutoff for each recorded trade signal.
-- Portable types only. Existing rows default to NULL until backfilled or overwritten.
ALTER TABLE trade_signals ADD COLUMN threshold REAL;
