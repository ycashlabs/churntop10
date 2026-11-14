-- TOTP backup sign-in / step-up (one owner). Portable to Postgres.
ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'passkey';
ALTER TABLE sessions ADD COLUMN stepup_method TEXT NOT NULL DEFAULT '';
UPDATE sessions SET auth_method = 'recovery' WHERE recovery = 1;

CREATE TABLE totp (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret_ct TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  last_step INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  enrolled_at INTEGER NOT NULL
);

CREATE TABLE totp_backup_codes (
  code_hash TEXT PRIMARY KEY,
  used_at INTEGER
);
