-- ═══════════════════════════════════════════════════════════════
-- RevifyRCM — auth schema
-- Run once against your Postgres database.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS accounts (
  id              BIGSERIAL PRIMARY KEY,
  username        TEXT UNIQUE NOT NULL,
  email           TEXT,
  phone           TEXT,
  password_hash   TEXT NOT NULL,          -- scrypt: salt:hash
  role            TEXT NOT NULL,          -- admin | supervisor | provider | scheduler | employee
  full_name       TEXT NOT NULL,
  title           TEXT,
  initials        TEXT,
  provider_id     TEXT,                   -- links a provider login to their schedule column
  scope           TEXT DEFAULT 'self',    -- all | facility | self
  status          TEXT DEFAULT 'active',  -- active | disabled | locked
  must_change     BOOLEAN DEFAULT FALSE,
  mfa_enabled     BOOLEAN DEFAULT FALSE,
  mfa_secret      TEXT,                   -- base32 TOTP secret
  failed_attempts INT DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_login      TIMESTAMPTZ,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS accounts_username_idx ON accounts (LOWER(username));
CREATE INDEX IF NOT EXISTS accounts_role_idx     ON accounts (role);

-- password reset tokens
CREATE TABLE IF NOT EXISTS reset_tokens (
  token       TEXT PRIMARY KEY,
  account_id  BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- login / logout audit, also feeds the Track Hours report
CREATE TABLE IF NOT EXISTS login_events (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
  username    TEXT,
  event       TEXT,          -- login | logout | failed | mfa_failed | reset
  ip          TEXT,
  user_agent  TEXT,
  at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS login_events_acct_idx ON login_events (account_id, at DESC);

-- audit trail for admin changes to accounts
CREATE TABLE IF NOT EXISTS account_audit (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT,
  action      TEXT,
  target      TEXT,
  detail      JSONB,
  at          TIMESTAMPTZ DEFAULT NOW()
);
