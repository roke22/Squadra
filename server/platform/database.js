import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { now } from './basics.js'
import { logError } from './http.js'

export function openDatabase(dir) {
  const db = new DatabaseSync(join(dir, 'squadra.db'))
  db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA secure_delete = ON;
  CREATE TABLE IF NOT EXISTS identities (
    name TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS group_invites (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    invited_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, name)
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    PRIMARY KEY (group_id, name)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_name TEXT NOT NULL,
    target TEXT NOT NULL,
    text TEXT,
    reply_to INTEGER,
    file_id TEXT,
    file_kind TEXT,
    created_at INTEGER NOT NULL,
    edited_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS updates (
    update_id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS updates_recipient ON updates(recipient, update_id);
  CREATE TABLE IF NOT EXISTS files (
    file_id TEXT PRIMARY KEY,
    file_unique_id TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT,
    mime TEXT,
    size INTEGER NOT NULL,
    owner TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_session ON events(session, id);
  CREATE TABLE IF NOT EXISTS hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    secret_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    info TEXT
  );
  CREATE TABLE IF NOT EXISTS host_enrollments (
    code_hash TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    configure_plugin INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL,
    from_name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, from_name)
  );
  CREATE TABLE IF NOT EXISTS leases (
    name TEXT PRIMARY KEY,
    instance TEXT NOT NULL,
    since INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS squad_templates (
    name TEXT PRIMARY KEY,
    spec TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  -- What the dashboard says of a squad (its coordinator's name): a title,
  -- its goal, and where its card is in the org chart.
  CREATE TABLE IF NOT EXISTS squads (
    coordinator TEXT PRIMARY KEY,
    title TEXT,
    goal TEXT,
    x REAL,
    y REAL,
    updated_at INTEGER NOT NULL
  );
  -- Who did what in this company: never what a message or a terminal said.
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    who TEXT,
    action TEXT NOT NULL,
    target TEXT,
    ip TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
  -- Two coordinators (of two squads) that work with each other: a < b.
  CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    options TEXT,
    recommended TEXT,
    ref TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS squad_links (
    a TEXT NOT NULL,
    b TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (a, b)
  );
`)

  // Indexes for the per-session message lookups (presence, relations, files):
  // without them every one of those reads the whole table.
  db.exec(`
  CREATE INDEX IF NOT EXISTS messages_from ON messages(from_name, target, created_at);
  CREATE INDEX IF NOT EXISTS messages_target ON messages(target, created_at);
  CREATE INDEX IF NOT EXISTS messages_file ON messages(file_id);
  CREATE INDEX IF NOT EXISTS messages_from_time ON messages(from_name, created_at);
  CREATE INDEX IF NOT EXISTS messages_time ON messages(created_at);
  CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS events_session_ts ON events(session, ts, id);
  CREATE INDEX IF NOT EXISTS updates_time ON updates(created_at);
  CREATE INDEX IF NOT EXISTS files_path ON files(path);
  CREATE INDEX IF NOT EXISTS files_owner ON files(owner, created_at);
  CREATE INDEX IF NOT EXISTS files_time ON files(created_at);
`)

  // Additive migrations for databases created by earlier versions.
  for (const [table, column, type] of [
    ['identities', 'role', 'TEXT'],          // coordinator | worker, set at login
    ['identities', 'coordinator', 'TEXT'],   // a worker's coordinator
    ['messages', 'system', 'INTEGER NOT NULL DEFAULT 0'], // notices generated by the server
    ['identities', 'cleared_at', 'INTEGER'], // dashboard: the session's chat was cleared at (ms)
    ['identities', 'archived_at', 'INTEGER'], // dashboard: archived (hidden from the main views) at (ms)
    ['groups', 'owner', 'TEXT'],                         // who created the group (null: created before groups were private)
    ['identities', 'host_id', 'TEXT'],                   // the machine that opened it from the dashboard (its name is reserved for it)
    ['group_members', 'joined_at', 'INTEGER'],           // only messages from then on are visible to the member
    ['messages', 'auto', 'INTEGER NOT NULL DEFAULT 0'],  // an automatic reply (pairing code, /help): no "relation"
    ['updates', 'sender', 'TEXT'],                       // who it came from (per-sender queue cap)
    ['identities', 'epoch', 'TEXT'],                     // random, per registration: what sessions pin (a name registered again gets a new one)
    ['identities', 'opened_role', 'TEXT'],               // the role the dashboard opened it with (on a machine)
    ['identities', 'opened_persona', 'TEXT'],            // and the persona (skill or agent id on that machine)
    ['identities', 'persona', 'TEXT'],                   // the persona it says it follows, set at login (JSON: kind, name, description)
    ['identities', 'description', 'TEXT'],               // what it is for, written in the dashboard (org chart)
    ['messages', 'fyi', 'INTEGER NOT NULL DEFAULT 0'],   // information only: no report expected
    ['identities', 'needs_approval', 'INTEGER NOT NULL DEFAULT 0'], // registered with the join token: can't direct workers until approved in the dashboard
    ['messages', 'sig', 'TEXT'],                         // the sender's signature (the plugin's signing.js): the server only carries it
    ['messages', 'report', 'TEXT'],                      // a worker's final report on a task: done | blocked | failed | question
    ['host_enrollments', 'ticket', 'TEXT'],              // a random id for the code (shown to the dashboard)
    ['hosts', 'enrollment', 'TEXT'],                     // the ticket of the code it enrolled with
    ['hosts', 'public_key', 'TEXT'],                     // the machine's key, from its first proof: its secret alone isn't enough after that
    ['identities', 'public_key', 'TEXT'],                // the same for a session
    ['identities', 'proven_instance', 'TEXT'],           // the session id that proved it holds that key
    ['inbox', 'version', 'INTEGER NOT NULL DEFAULT 1'],  // goes up each time its coordinator changes it
    ['inbox', 'updated_at', 'INTEGER'],                  // when it last did
    ['inbox', 'answer', 'TEXT'],                         // what the user answered from the dashboard
    ['inbox', 'answered_by', 'TEXT'],                    // and who
    ['inbox', 'closed_reason', 'TEXT'],                  // why its coordinator closed it
  ]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }

  // When a machine first connected (null: enrolled, never connected yet). The
  // machines already there when the column is added have connected before.
  if (!db.prepare('PRAGMA table_info(hosts)').all().some(c => c.name === 'first_connected_at')) {
    db.exec('BEGIN; ALTER TABLE hosts ADD COLUMN first_connected_at INTEGER; UPDATE hosts SET first_connected_at = last_seen_at; COMMIT')
  }
  db.exec('CREATE INDEX IF NOT EXISTS updates_sender ON updates(recipient, sender, update_id)')
  db.exec('CREATE INDEX IF NOT EXISTS updates_by_sender ON updates(sender)')
  db.exec('CREATE INDEX IF NOT EXISTS group_members_by_name ON group_members(name, group_id)')
  db.exec('CREATE INDEX IF NOT EXISTS groups_owner ON groups(owner)')

  // "Have these two written to each other?" (getChat, notices): only real
  // messages count, so a pile of automatic replies can't make it a scan.
  db.exec('CREATE INDEX IF NOT EXISTS messages_relation ON messages(from_name, target, created_at) WHERE system = 0 AND auto = 0')
  db.exec("UPDATE identities SET epoch = lower(hex(randomblob(12))) WHERE epoch IS NULL")

  // Several writes in one transaction (one disk sync instead of one each).
  // Re-entrant: an inner call just joins the outer transaction.
  let txDepth = 0
  function inTx(fn) {
    if (txDepth) return fn()
    db.exec('BEGIN')
    txDepth++
    try { return fn() } finally { txDepth--; db.exec('COMMIT') }
  }

  let lastTruncate = now()
  function truncateLog() {
    lastTruncate = now()
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch (err) { logError(`could not truncate the write-ahead log: ${err.message}`) }
  }

  // (What was deleted is overwritten in the database file, but stays in the
  // write-ahead log until this.)
  function truncateLogHourly() {
    if (now() - lastTruncate >= 3600_000) truncateLog()
  }

  const AUDIT_KEPT_MS = 365 * 24 * 3600_000
  const AUDIT_MAX = 200_000
  const audit = (actor, action, target, ip) => db.prepare('INSERT INTO audit (at, who, action, target, ip) VALUES (?, ?, ?, ?, ?)')
    .run(now(), actor?.email ?? (actor?.token ? 'server token' : null), String(action).slice(0, 60), target == null ? null : String(target).slice(0, 200), ip == null ? null : String(ip).slice(0, 64))
  function auditLog({ before = Number.MAX_SAFE_INTEGER, limit = 100 } = {}) {
    return db.prepare('SELECT id, at, who, action, target, ip FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
  }
  function cleanupAudit() {
    db.prepare('DELETE FROM audit WHERE at < ?').run(now() - AUDIT_KEPT_MS)
    db.prepare('DELETE FROM audit WHERE id <= (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET ?)').run(AUDIT_MAX)
  }

  return { db, inTx, truncateLog, truncateLogHourly, audit, auditLog, cleanupAudit }
}
