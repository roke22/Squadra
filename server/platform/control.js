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
