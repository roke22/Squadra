import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { DATA_DIR } from './config.js'

// What is common to all companies. Everything else is in each company's folder.
export function openControl() {
  const control = new DatabaseSync(join(DATA_DIR, 'control.db'))
  control.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA secure_delete = ON;
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    limits_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    delete_after INTEGER
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    totp_secret_enc TEXT,
    totp_enabled_at INTEGER,
    totp_last_step INTEGER,
    is_platform_admin INTEGER NOT NULL DEFAULT 0,
    disabled_at INTEGER,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS memberships (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, company_id)
  );
  CREATE TABLE IF NOT EXISTS login_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mfa_ok INTEGER NOT NULL DEFAULT 0,
    ip TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recovery_codes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at INTEGER,
    PRIMARY KEY (user_id, code_hash)
  );
  -- Links of one use: to join (kind invite) or to set a new password (kind reset).
  CREATE TABLE IF NOT EXISTS invitations (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    email TEXT NOT NULL,
    company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
    role TEXT,
    is_platform_admin INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS platform_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    user_id TEXT,
    action TEXT NOT NULL,
    target TEXT,
    ip TEXT,
    detail TEXT
  );
  -- Which company a machine's one-time code is for: a code says nothing itself.
  -- (The first company's codes aren't here: a code nobody knows goes to it.)
  CREATE TABLE IF NOT EXISTS enrollment_routes (
    code_hash TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
`)
  return control
}
