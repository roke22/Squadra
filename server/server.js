#!/usr/bin/env node
/**
 * squadra-server — the "Telegram" for Squadra.
 *
 * A small subset of the Telegram Bot API, shaped closely enough that Squadra
 * plugin is a near-copy of the official Telegram channel plugin. Every Claude
 * Code session is an identity (a "bot" that also acts as a "user" for others).
 *
 * Auth:
 *   - Server token (admin): the dashboard, /admin/* and rotating identities.
 *   - Join token: registers new names, nothing else.
 *   - Machine secret: squadra-host's link (/host/connect).
 *   - Identity secret: returned once by /register; every other call uses it.
 *     The sender of a message is always derived from the secret, never from
 *     a request field: sending as another name takes that name's secret (and,
 *     while its session holds the name, that session's instance id).
 *
 * Only Node built-ins: node:http, node:sqlite (Node >= 22.13).
 */

import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, createReadStream, rmSync, statSync, chmodSync, openSync, closeSync, writeSync } from 'node:fs'
import { join, extname } from 'node:path'
import { parseArgs } from 'node:util'
import { watchFile } from 'node:fs'
import { createAcme, LETS_ENCRYPT, LETS_ENCRYPT_STAGING } from './acme.js'
import { acceptWebSocket } from './ws.js'

// --- config ------------------------------------------------------------------
//
// Command-line flags win over environment variables.
//
//   --host <ip>          interface to listen on (default 127.0.0.1: this machine only)
//   --all-interfaces     same as --host 0.0.0.0 (every IP of the machine)
//   --port <n>           default 7787
//   --public-url <url>   the address agents and browsers use, e.g. https://squadra.example.com
//                        (behind a TLS reverse proxy): the setup and enrollment commands use it, and
//                        the dashboard's terminal accepts it as its Origin
//   --trust-proxy        behind a reverse proxy: take the client's address from X-Forwarded-For
//   --data-dir <path>    default ./data
//
// HTTPS without a reverse proxy:
//   --domain <name>      get and renew a Let's Encrypt certificate automatically (needs ports 80 and 443)
//   --acme-email <addr>  contact address for Let's Encrypt (optional)
//   --acme-staging       use Let's Encrypt's staging environment (for trying it out)
//   --acme-directory <url>  another ACME server
//   --tls-cert <file> --tls-key <file>   use your own certificate (reloaded when the files change)
//   --http-port <n>      port for ACME challenges and the HTTP→HTTPS redirect (default 80)

const { values: ARGS } = (() => {
  try {
    return parseArgs({
      options: {
        host: { type: 'string' },
        'all-interfaces': { type: 'boolean' },
        port: { type: 'string' },
        'public-url': { type: 'string' },
        'data-dir': { type: 'string' },
        domain: { type: 'string' },
        'acme-email': { type: 'string' },
        'acme-staging': { type: 'boolean' },
        'acme-directory': { type: 'string' },
        'tls-cert': { type: 'string' },
        'tls-key': { type: 'string' },
        'http-port': { type: 'string' },
        'trust-proxy': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (err) {
    process.stderr.write(`squadra-server: ${err.message}\nRun with --help to see the options.\n`)
    process.exit(2)
  }
})()

if (ARGS.help) {
  process.stdout.write(`Usage: node server.js [options]

  --host <ip>          Interface to listen on (default 127.0.0.1: this machine only). Env: HOST
  --all-interfaces     Listen on every IP of the machine (same as --host 0.0.0.0)
  --port <n>           Port (default 7787). Env: PORT
  --public-url <url>   Public address, e.g. https://squadra.example.com. Env: PUBLIC_URL
  --data-dir <path>    Database and files (default ./data). Env: DATA_DIR

HTTPS, built in (no reverse proxy needed):
  --domain <name>      Get and renew a Let's Encrypt certificate automatically. Env: SQUADRA_DOMAIN
                       Needs the domain's DNS pointing here and ports 80 and 443 reachable.
  --acme-email <addr>  Contact address for Let's Encrypt (optional). Env: ACME_EMAIL
  --acme-staging       Use Let's Encrypt staging (test certificates, higher limits)
  --acme-directory <url>  Another ACME server. Env: ACME_DIRECTORY
  --tls-cert <file>    Your own certificate (PEM, full chain). Env: TLS_CERT
  --tls-key <file>     Its private key (PEM). Env: TLS_KEY
                       Both are reloaded automatically when the files change.
  --http-port <n>      Port for ACME challenges and the HTTP→HTTPS redirect (default 80)
  --trust-proxy        Behind a reverse proxy: take the client address from X-Forwarded-For
                       (for rate limits). Only with a proxy that sets it. Env: TRUST_PROXY=1

With HTTPS the server listens on all interfaces and port 443 by default.

Examples:
  node server.js                                    # http://127.0.0.1:7787, this machine only
  node server.js --domain squadra.example.com       # https://squadra.example.com, automatic certificate
  node server.js --tls-cert full.pem --tls-key key.pem --public-url https://squadra.example.com
`)
  process.exit(0)
}

const DOMAIN = (ARGS.domain ?? process.env.SQUADRA_DOMAIN ?? '').trim().toLowerCase()
const TLS_CERT = ARGS['tls-cert'] ?? process.env.TLS_CERT ?? ''
const TLS_KEY = ARGS['tls-key'] ?? process.env.TLS_KEY ?? ''
// 'http' (default), 'acme' (automatic Let's Encrypt) or 'files' (your own certificate)
const TLS_MODE = DOMAIN ? 'acme' : (TLS_CERT || TLS_KEY) ? 'files' : 'http'
const TLS = TLS_MODE !== 'http'
const ACME_DIRECTORY = ARGS['acme-directory'] ?? process.env.ACME_DIRECTORY ?? (ARGS['acme-staging'] ? LETS_ENCRYPT_STAGING : LETS_ENCRYPT)
const ACME_EMAIL = ARGS['acme-email'] ?? process.env.ACME_EMAIL ?? ''
const HTTP_PORT = Number(ARGS['http-port'] ?? process.env.HTTP_PORT ?? 80)
const TRUST_PROXY = ARGS['trust-proxy'] === true || process.env.TRUST_PROXY === '1'

const PORT = Number(ARGS.port ?? process.env.PORT ?? (TLS ? 443 : 7787))
const HOST = ARGS['all-interfaces'] ? '0.0.0.0' : (ARGS.host ?? process.env.HOST ?? (TLS ? '0.0.0.0' : '127.0.0.1'))
const DATA_DIR = ARGS['data-dir'] ?? process.env.DATA_DIR ?? join(process.cwd(), 'data')
const PUBLIC_URL = (ARGS['public-url'] ?? process.env.PUBLIC_URL ?? (DOMAIN ? `https://${DOMAIN}${PORT === 443 ? '' : `:${PORT}`}` : '')).replace(/\/+$/, '')
for (const [label, n] of [['port', PORT], ['http port', HTTP_PORT]]) {
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    process.stderr.write(`squadra-server: invalid ${label} "${n}"\n`)
    process.exit(2)
  }
}
if (DOMAIN && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(DOMAIN)) {
  process.stderr.write(`squadra-server: invalid domain "${DOMAIN}"\n`)
  process.exit(2)
}
if (TLS_MODE === 'files' && !(TLS_CERT && TLS_KEY)) {
  process.stderr.write('squadra-server: --tls-cert and --tls-key go together\n')
  process.exit(2)
}
if (PUBLIC_URL && !/^https?:\/\/[^\s/]+/.test(PUBLIC_URL)) {
  process.stderr.write(`squadra-server: invalid public URL "${PUBLIC_URL}" (expected http(s)://host[:port])\n`)
  process.exit(2)
}

const MAX_TEXT = 32_000                    // per message, chars
const MAX_JSON_BODY = 1024 * 1024          // 1 MB
const MAX_FILE_BYTES = 50 * 1024 * 1024    // 50 MB
const UPLOAD_BUDGET_BYTES = 500 * 1024 * 1024 // per identity per hour
// Storage limits, so no session (or set of sessions) can fill the disk:
const STORED_BYTES_PER_HOUR = 30 * 1024 * 1024 // per identity: observation events, and message text, each
const MAX_FILES_BYTES = Number(process.env.SQUADRA_MAX_FILES_GB ?? 10) * 1024 ** 3 // attachments kept, in all
const MAX_EVENTS = Number(process.env.SQUADRA_MAX_EVENTS ?? 1_000_000)       // observation events kept, in all
const MAX_MESSAGES = Number(process.env.SQUADRA_MAX_MESSAGES ?? 2_000_000)   // messages kept, in all
const MAX_UPDATES = Number(process.env.SQUADRA_MAX_UPDATES ?? 500_000)       // undelivered updates kept, in all
const MAX_UPDATES_PER_SESSION = 10_000                                        // undelivered updates kept, per recipient
const MAX_IDENTITIES = Number(process.env.SQUADRA_MAX_SESSIONS ?? 500)
const UPDATE_TTL_MS = 24 * 60 * 60 * 1000  // like Telegram: unconfirmed updates kept 24h
const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const EVENT_TTL_MS = Number(process.env.OBSERVE_TTL_HOURS ?? 24) * 60 * 60 * 1000 // live-observation events
const UI_FILE = new URL('./ui.html', import.meta.url)
// xterm.js for the web terminal, vendored (see vendor/README.md).
const VENDOR_FILES = {
  '/vendor/xterm.js': ['./vendor/xterm.js', 'text/javascript; charset=utf-8'],
  '/vendor/addon-fit.js': ['./vendor/addon-fit.js', 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': ['./vendor/xterm.css', 'text/css; charset=utf-8'],
}

// Public files (the page, xterm.js, squadra-host) are read once and kept:
// every answer shares the same bytes, so requests piled up on a connection
// that doesn't read can't make the server copy a file for each. Read again
// only when the file changes on disk.
const fileCache = new Map() // path -> { body, mtimeMs, size, ...extra }
function cachedFile(file, extra = () => ({})) {
  let st
  try { st = statSync(file) } catch { return null }
  if (!st.isFile()) return null
  const key = String(file)
  const c = fileCache.get(key)
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c
  const body = readFileSync(file)
  const entry = { body, mtimeMs: st.mtimeMs, size: st.size, ...extra(body) }
  fileCache.set(key, entry)
  return entry
}

// The dashboard page: a strict Content-Security-Policy (only its own inline
// script, by hash, and scripts from this server), and no framing.
function pageHeaders(html) {
  const text = html.toString('utf8')
  const hashes = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`)
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src 'self' ${hashes.join(' ')}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin', // a page that opened the dashboard can't steer it
    ...(TLS ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  }
}
// Single source of truth: server/package.json.
const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version } catch { return '0.0.0' }
})()
const POLL_MAX_TIMEOUT_S = 50
const RATE_LIMIT_PER_MIN = 120             // messages per sender per minute
const ONLINE_GRACE_MS = 15 * 1000          // gap allowed between two polls of a live plugin
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const GROUP_RE = /^#[A-Za-z0-9_-]{1,32}$/
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

// --- storage -----------------------------------------------------------------

// Messages, attachments and observation are private: only this user can read
// the data folder and what the server creates in it.
process.umask(0o077)
mkdirSync(join(DATA_DIR, 'files'), { recursive: true, mode: 0o700 })
for (const p of [DATA_DIR, join(DATA_DIR, 'files')]) { try { chmodSync(p, 0o700) } catch {} }
for (const f of ['squadra.db', 'squadra.db-wal', 'squadra.db-shm']) { try { chmodSync(join(DATA_DIR, f), 0o600) } catch {} }

// Server token: SQUADRA_SERVER_TOKEN if set; otherwise the one saved in
// DATA_DIR/server-token; otherwise a new one, generated and saved there so
// restarts keep the same token and plugins don't need reconfiguring.
const TOKEN_FILE = join(DATA_DIR, 'server-token')
const { token: SERVER_TOKEN, source: TOKEN_SOURCE } = (() => {
  const fromEnv = process.env.SQUADRA_SERVER_TOKEN ?? process.env.SWARM_SERVER_TOKEN // SWARM_: former name
  if (fromEnv) {
    if (fromEnv.length < 16) {
      process.stderr.write('squadra-server: SQUADRA_SERVER_TOKEN must be at least 16 chars\n')
      process.exit(1)
    }
    return { token: fromEnv, source: 'env SQUADRA_SERVER_TOKEN' }
  }
  try {
    const saved = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (saved.length >= 16) return { token: saved, source: TOKEN_FILE }
  } catch {}
  const generated = randomBytes(24).toString('hex')
  writeFileSync(TOKEN_FILE, generated + '\n', { mode: 0o600 })
  return { token: generated, source: `${TOKEN_FILE} (new)` }
})()
// Join token: lets a machine register NEW session names (POST /register
// without reset) and nothing else. It is what plugins and enrolled machines
// keep on disk; the server token above is the admin credential (dashboard,
// web terminals, /admin, rotating identities) and never leaves the browser.
const JOIN_TOKEN_FILE = join(DATA_DIR, 'join-token')
let { token: JOIN_TOKEN, source: JOIN_TOKEN_SOURCE } = (() => {
  const fromEnv = process.env.SQUADRA_JOIN_TOKEN
  if (fromEnv) {
    if (fromEnv.length < 16 || fromEnv === SERVER_TOKEN) {
      process.stderr.write('squadra-server: SQUADRA_JOIN_TOKEN must be at least 16 chars and differ from the server token\n')
      process.exit(1)
    }
    return { token: fromEnv, source: 'env SQUADRA_JOIN_TOKEN' }
  }
  try {
    const saved = readFileSync(JOIN_TOKEN_FILE, 'utf8').trim()
    if (saved.length >= 16 && saved !== SERVER_TOKEN) return { token: saved, source: JOIN_TOKEN_FILE }
  } catch {}
  const generated = `sj_${randomBytes(24).toString('hex')}`
  writeFileSync(JOIN_TOKEN_FILE, generated + '\n', { mode: 0o600 })
  return { token: generated, source: `${JOIN_TOKEN_FILE} (new)` }
})()

const db = new DatabaseSync(join(DATA_DIR, 'squadra.db'))
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
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
  ['host_enrollments', 'ticket', 'TEXT'],              // a random id for the code (shown to the dashboard)
  ['hosts', 'enrollment', 'TEXT'],                     // the ticket of the code it enrolled with
]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
}
// When a machine first connected (null: enrolled, never connected yet). The
// machines already there when the column is added have connected before.
if (!db.prepare('PRAGMA table_info(hosts)').all().some(c => c.name === 'first_connected_at')) {
  db.exec('ALTER TABLE hosts ADD COLUMN first_connected_at INTEGER')
  db.exec('UPDATE hosts SET first_connected_at = last_seen_at')
}
db.exec('CREATE INDEX IF NOT EXISTS updates_sender ON updates(recipient, sender, update_id)')
db.exec('CREATE INDEX IF NOT EXISTS updates_by_sender ON updates(sender)')
db.exec('CREATE INDEX IF NOT EXISTS group_members_by_name ON group_members(name, group_id)')
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

const sha256 = s => createHash('sha256').update(s).digest('hex')
const now = () => Date.now()
const unix = ms => Math.floor(ms / 1000)

// --- errors ------------------------------------------------------------------

class ApiError extends Error {
  constructor(code, description, extra) {
    super(description)
    this.code = code
    this.extra = extra
  }
}
const bad = d => new ApiError(400, `Bad Request: ${d}`)

// Periodic work: an error (e.g. the database is busy) is logged, never fatal.
const guarded = fn => () => {
  try { fn() } catch (err) { process.stderr.write(`squadra-server: ${fn.name || 'timer'}: ${err?.stack ?? err}\n`) }
}

// --- identities --------------------------------------------------------------

function register(name, reset) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw bad('name must match [A-Za-z0-9_-]{1,32}')
  const existing = db.prepare('SELECT name FROM identities WHERE name = ?').get(name)
  if (existing && !reset) {
    throw new ApiError(409, `Conflict: identity "${name}" already registered. Use the existing secret, or register with reset: true to rotate it.`)
  }
  const secret = `sq_${randomBytes(24).toString('base64url')}`
  if (existing) {
    db.prepare('UPDATE identities SET secret_hash = ? WHERE name = ?').run(sha256(secret), name)
    // A rotated identity must not keep a stale poller (or answer) alive.
    dropAnswer(name); servedUpTo.delete(name)
    const w = waiters.get(name)
    if (w) finishPoll(w, conflict())
  } else {
    db.prepare('INSERT INTO identities (name, secret_hash, created_at, epoch) VALUES (?, ?, ?, ?)').run(name, sha256(secret), now(), randomBytes(12).toString('hex'))
  }
  return { name, secret }
}

function identityFromSecret(secret) {
  if (!secret) return null
  const row = db.prepare('SELECT name FROM identities WHERE secret_hash = ?').get(sha256(secret))
  return row ? row.name : null
}

function identityExists(name) {
  return !!db.prepare('SELECT 1 FROM identities WHERE name = ?').get(name)
}

// last_seen_at is written at most every 10 s per name (one database write per
// request would let a refused caller keep the database busy).
const lastTouched = new Map()
function touch(name) {
  const t = now()
  if (t - (lastTouched.get(name) ?? 0) < 10_000) return
  lastTouched.set(name, t)
  db.prepare('UPDATE identities SET last_seen_at = ? WHERE name = ?').run(t, name)
}

// --- users / chats / messages as Telegram-shaped objects ----------------------

// squadra_identity: which registration of that name it is (sessions pin it:
// a name deleted and registered again by someone else is told apart).
const epochOf = name => db.prepare('SELECT epoch FROM identities WHERE name = ?').get(name)?.epoch ?? undefined
const userObj = name => ({ id: name, is_bot: false, first_name: name, username: name, squadra_identity: epochOf(name) })

// The chat a recipient sees. In a DM, Telegram's chat.id is the other party's
// id, so replying to chat_id goes back to the sender. Same here.
function chatFor(target, fromName) {
  if (target.startsWith('#')) return { id: target, type: 'group', title: target }
  return { id: fromName, type: 'private', username: fromName, first_name: fromName }
}

function fileRow(fileId) {
  return fileId ? db.prepare('SELECT * FROM files WHERE file_id = ?').get(fileId) : null
}

function messageObj(row, { withReply = true } = {}) {
  const msg = {
    message_id: row.id,
    from: userObj(row.from_name),
    chat: chatFor(row.target, row.from_name),
    date: unix(row.created_at),
  }
  if (row.edited_at) msg.edit_date = unix(row.edited_at)
  if (row.system) msg.squadra_notice = true // generated by the server, not by the sender
  const f = fileRow(row.file_id)
  if (f) {
    if (row.text) msg.caption = row.text
    const fileInfo = { file_id: f.file_id, file_unique_id: f.file_unique_id, file_size: f.size }
    if (row.file_kind === 'photo') msg.photo = [fileInfo]
    else msg.document = { ...fileInfo, file_name: f.name ?? undefined, mime_type: f.mime ?? undefined }
  } else {
    msg.text = row.text ?? ''
  }
  if (withReply && row.reply_to) {
    const r = db.prepare('SELECT * FROM messages WHERE id = ?').get(row.reply_to)
    // (Only while its author can still see what it quotes: after leaving a
    // group, a later edit of the quoted message isn't shown through it.)
    if (r && (row.system || canSeeMessage(row.from_name, r))) {
      // The quoted message is only a reference: its first 500 characters
      // (a short reply can't make the server store a long text again).
      const q = messageObj(r, { withReply: false })
      for (const k of ['text', 'caption']) if (typeof q[k] === 'string' && q[k].length > 500) q[k] = `${cutText(q[k], 500)}…`
      msg.reply_to_message = q
    }
  }
  return msg
}

// The last member left: the group and its history go away, so a new group
// with the same name starts empty.
// An owner that leaves (or is deleted) passes the group to the member who
// has been in it longest: someone can still invite.
function handOverGroup(id, leaving) {
  if (db.prepare('SELECT owner FROM groups WHERE id = ?').get(id)?.owner !== leaving) return
  const next = db.prepare('SELECT name FROM group_members WHERE group_id = ? ORDER BY joined_at, name LIMIT 1').get(id)?.name
  if (next) db.prepare('UPDATE groups SET owner = ? WHERE id = ?').run(next, id)
}
// Two sessions that have written to each other (since both current
// identities exist), or share a group: only then does one see the other's
// presence (getChat, and when a send says who is offline).
function related(name, id) {
  if (id === name) return true
  const ident = db.prepare('SELECT created_at FROM identities WHERE name = ?').get(id)
  if (!ident) return false
  const since = Math.max(identityCreatedAt(name), ident.created_at)
  const wrote = (a, b) => db.prepare('SELECT 1 FROM messages WHERE from_name = ? AND target = ? AND system = 0 AND auto = 0 AND created_at >= ? LIMIT 1').get(a, b, since)
  return !!((wrote(name, id) && wrote(id, name)) ||
    db.prepare('SELECT 1 FROM group_members a JOIN group_members b ON a.group_id = b.group_id WHERE a.name = ? AND b.name = ? LIMIT 1').get(name, id))
}
function closeGroup(id) {
  if (!GROUP_RE.test(String(id))) return // only groups have a history to delete
  db.prepare('DELETE FROM groups WHERE id = ?').run(id)
  db.prepare('DELETE FROM group_invites WHERE group_id = ?').run(id)
  db.prepare('DELETE FROM messages WHERE target = ?').run(id)
}

// A message is visible to whoever sent it, received it, or is in its group —
// and only from that identity's creation on: a name deleted and registered
// again doesn't inherit the old one's history.
const identityCreatedAt = name => db.prepare('SELECT created_at FROM identities WHERE name = ?').get(name)?.created_at ?? Infinity
function canSeeMessage(name, row) {
  if (row.created_at < identityCreatedAt(name)) return false
  if (row.from_name === name || row.target === name) return true
  if (!row.target.startsWith('#')) return false
  const member = db.prepare('SELECT joined_at FROM group_members WHERE group_id = ? AND name = ?').get(row.target, name)
  return !!member && row.created_at >= (member.joined_at ?? 0)
}

// Who receives a message sent to `target` by `from`.
function recipientsOf(target, from) {
  if (target.startsWith('#')) {
    return db.prepare('SELECT name FROM group_members WHERE group_id = ? AND name != ?').all(target, from).map(r => r.name)
  }
  return [target]
}

function resolveTarget(chatId, from) {
  if (typeof chatId !== 'string' || chatId === '') throw bad('chat_id is required')
  if (chatId.startsWith('#')) {
    if (!GROUP_RE.test(chatId)) throw bad('invalid group id')
    if (!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND name = ?').get(chatId, from)) {
      throw new ApiError(403, `Forbidden: not a member of ${chatId}`)
    }
    return chatId
  }
  if (!NAME_RE.test(chatId) || !identityExists(chatId)) throw bad('chat not found')
  if (chatId === from) throw bad('cannot message yourself')
  return chatId
}

// --- rate limit --------------------------------------------------------------

const sendLog = new Map() // name -> timestamps (ms) of recent sends (messages, edits, reactions, groups)

// A sliding-window counter: at most `max` hits per `windowMs` for a key.
const windows = new Map() // bucket -> Map(key -> timestamps)
function allow(bucket, key, max, windowMs = 60_000) {
  const t = now()
  if (!windows.has(bucket)) windows.set(bucket, new Map())
  const m = windows.get(bucket)
  const recent = (m.get(key) ?? []).filter(x => t - x < windowMs)
  if (recent.length >= max) { m.set(key, recent); return false }
  recent.push(t)
  m.set(key, recent)
  return true
}
setInterval(() => {
  const t = now()
  for (const m of windows.values()) for (const [k, v] of m) if (!v.some(x => t - x < 3600_000)) m.delete(k)
}, 10 * 60_000).unref()

// IPv6 clients are counted per /64 (one machine usually has a whole /64).
function ipKey(ip) {
  const raw = String(ip ?? '?')
  // IPv4 (also as ::ffff:a.b.c.d) as it is; IPv6 by its /64, written out in
  // full first ("2600:3c03::1" and "2600:3c03:0:0::2" are the same network).
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw)
  if (v4) return v4[1]
  if (!raw.includes(':')) return raw
  const a = raw.replace(/%.*$/, '').toLowerCase()
  const [head, tail] = a.includes('::') ? a.split('::') : [a, null]
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = tail === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64'
}
// Reads (getMe, getChat, getFile, chat actions, polls that don't wait): a
// generous budget, so one session can't keep the server busy with them.
function readLimit(name, bucket = 'read') {
  if (!allow(bucket, name, 600)) throw new ApiError(429, 'Too Many Requests: retry in a minute', { parameters: { retry_after: 60 } })
}

// Joining and inviting: 60 a minute per session, apart from the sending
// budget (a plugin retrying invites to names that don't exist yet must not
// keep its session from sending).
function groupLimit(name) {
  if (!allow('group-ops', name, 60)) throw new ApiError(429, 'Too Many Requests: retry in a minute', { parameters: { retry_after: 60 } })
}
function rateLimit(name) {
  const t = now()
  const recent = (sendLog.get(name) ?? []).filter(x => t - x < 60_000)
  if (recent.length >= RATE_LIMIT_PER_MIN) {
    const retry = Math.ceil((60_000 - (t - recent[0])) / 1000)
    throw new ApiError(429, `Too Many Requests: retry after ${retry}`, { parameters: { retry_after: retry } })
  }
  recent.push(t)
  sendLog.set(name, recent)
}

// --- updates & long polling ---------------------------------------------------

const waiters = new Map() // name -> { res, timer, offset, limit }

const conflict = () => new ApiError(409, 'Conflict: terminated by other getUpdates request; make sure that only one squadra plugin instance is running for this name')

const pushCount = new Map()
const MAX_UPDATES_PER_SENDER = 500 // undelivered, per sender and recipient
function pushUpdate(recipient, payload, sender = null) {
  db.prepare('INSERT INTO updates (recipient, payload, created_at, sender) VALUES (?, ?, ?, ?)').run(recipient, JSON.stringify(payload), now(), sender)
  // One sender can't push out what others sent: its own oldest go first.
  if (sender) db.prepare('DELETE FROM updates WHERE recipient = ? AND sender = ? AND update_id <= (SELECT update_id FROM updates WHERE recipient = ? AND sender = ? ORDER BY update_id DESC LIMIT 1 OFFSET ?)').run(recipient, sender, recipient, sender, MAX_UPDATES_PER_SENDER)
  // A recipient that never picks them up keeps at most the newest
  // MAX_UPDATES_PER_SESSION (checked every 500 updates, not on each one).
  const n = (pushCount.get(recipient) ?? 0) + 1
  pushCount.set(recipient, n % 500)
  if (n >= 500) db.prepare('DELETE FROM updates WHERE recipient = ? AND update_id <= (SELECT update_id FROM updates WHERE recipient = ? ORDER BY update_id DESC LIMIT 1 OFFSET ?)').run(recipient, recipient, MAX_UPDATES_PER_SESSION)
  const w = waiters.get(recipient)
  if (w) {
    const updates = readUpdates(recipient, w.offset, w.limit)
    if (updates.length) finishPoll(w, null, updates)
  }
}

// At most about 1 MB per answer (always at least one update): the plugin
// simply asks again for the rest.
const MAX_ANSWER_BYTES = 1024 * 1024
const servedUpTo = new Map() // name -> highest update_id already handed out
function readUpdates(recipient, offset, limit) {
  const out = []
  let bytes = 0
  for (const r of db.prepare('SELECT update_id, payload FROM updates WHERE recipient = ? AND update_id >= ? ORDER BY update_id LIMIT ?').iterate(recipient, offset, limit)) {
    const size = Buffer.byteLength(r.payload)
    if (out.length && bytes + size > MAX_ANSWER_BYTES) break
    bytes += size
    out.push({ update_id: r.update_id, ...JSON.parse(r.payload) })
  }
  if (out.length) servedUpTo.set(recipient, Math.max(servedUpTo.get(recipient) ?? 0, out[out.length - 1].update_id))
  return out
}
const lastAnswer = new Map() // name -> the last immediate answer (still being sent?)
function dropAnswer(name) {
  const pa = lastAnswer.get(name)
  if (pa && !pa.res.writableFinished && !pa.res.destroyed) { try { pa.res.destroy() } catch {} }
  lastAnswer.delete(name)
}

function finishPoll(w, err, result = []) {
  clearTimeout(w.timer)
  if (waiters.get(w.name) === w) waiters.delete(w.name)
  if (w.res.writableEnded) return
  if (!err) markPolled(w.name)
  if (err) sendError(w.res, err)
  else sendJson(w.res, 200, { ok: true, result })
}

function getUpdates(name, params, res) {
  const n = (v, d) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d)
  const offset = n(params.offset, 0)
  const limit = Math.max(1, Math.min(n(params.limit, 100), 100))
  const timeout = Math.max(0, Math.min(n(params.timeout, 0), POLL_MAX_TIMEOUT_S))

  // Session lease: once a session holds the name, only that session (its
  // instance) may poll; a caller without an instance is refused, so a copy of
  // the secret can't read or drain its queue. Names nobody claimed get the
  // plain Telegram behaviour below.
  const instance = params.instance != null ? String(params.instance) : ''
  if (instance && !/^[A-Za-z0-9_-]{8,64}$/.test(instance)) throw bad('invalid instance')
  if (instance) checkLease(name, instance)
  else if (leases.has(name)) throw new ApiError(409, `Conflict: "${name}" is held by a Squadra session`, { parameters: { reason: 'name_in_use' } })
  if (timeout === 0) readLimit(name) // after the checks: a refused caller doesn't use the holder's budget

  // Asking again for updates already handed out (offset at or below what was
  // served) and getting them at once counts like a quick poll; a plugin
  // working through its queue always asks for new ones and is never limited.
  // Decided before reading anything.
  const rereads = offset <= (servedUpTo.get(name) ?? -1) &&
    !!db.prepare('SELECT 1 FROM updates WHERE recipient = ? AND update_id >= ? LIMIT 1').get(name, offset)
  if (timeout !== 0 && rereads) readLimit(name, 'poll')
  // An answer still being sent to this name: no second one meanwhile.
  // (Only for the same session instance, and only for a short while: a
  // connection that never finishes can't block the name.)
  const pa = lastAnswer.get(name)
  if (pa && pa.instance === instance && Date.now() - pa.at < 30_000 && !pa.res.writableFinished && !pa.res.destroyed && !pa.res.closed) {
    throw new ApiError(429, 'Too Many Requests: the previous answer is still being sent')
  }

  // Like Telegram: an offset confirms every update below it.
  if (offset > 0) db.prepare('DELETE FROM updates WHERE recipient = ? AND update_id < ?').run(name, offset)

  // Newest poller wins; the previous one gets 409, exactly like Telegram.
  // (With leases, both pollers belong to the same session.)
  const prev = waiters.get(name)
  if (prev) finishPoll(prev, conflict())

  const updates = readUpdates(name, offset, limit)
  if (updates.length || timeout === 0) {
    markPolled(name)
    // An earlier answer to this name still unread is dropped: a name never
    // holds more than one unread answer on the server.
    dropAnswer(name)
    lastAnswer.set(name, { res, at: Date.now(), instance })
    return sendJson(res, 200, { ok: true, result: updates })
  }
  markPolled(name)

  const w = { name, res, offset, limit, timer: null }
  w.timer = setTimeout(() => finishPoll(w, null, []), timeout * 1000)
  res.on('close', () => {
    clearTimeout(w.timer)
    if (waiters.get(name) === w) waiters.delete(name)
    // The plugin dropped the connection mid-poll: its session ended (or lost
    // the network). Offline right away instead of after the grace window.
    if (!res.writableEnded) presence.set(name, { ...(presence.get(name) ?? {}), lastPollAt: now(), disconnected: true, pollingSince: null })
  })
  waiters.set(name, w)
}

// --- methods -----------------------------------------------------------------

// Delivery rules (not part of the Bot API):
// - A worker only receives messages while it's connected. Sending to a
//   disconnected worker is refused, so a task never waits in a queue for a
//   session that may not come back; the sender can give it to someone else.
// - A coordinator always receives: messages to it are queued while it's away.
// - Sessions with no known role (plain Bot API clients) keep Telegram's
//   behaviour: queued.
function roleOf(name) {
  return db.prepare('SELECT role FROM identities WHERE name = ?').get(name)?.role ?? null
}

// Control characters (except newline and tab), bidi overrides and blank
// fillers: invisible
// in the dashboard, but they survive copy and paste into a terminal.
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\u115f\u1160\u17b4\u17b5\u2065\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}\u180b-\u180f\ufe00-\ufe0f\u{e0100}-\u{e01ef}\p{Cf}]/gu
// Some of them are part of real text, and are kept where they are: a joiner
// (ZWJ/ZWNJ) between two non-ASCII letters or emoji (👩‍💻, Persian, Sinhala);
// one variation selector right after the character it varies (葛󠄀, Mongolian);
// the tags of a subdivision flag (🏴 England); the format marks that start
// Arabic, Syriac or Kaithi numbers or join hieroglyphs and shorthand.
const isBase = c => c > 0x7f && /[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u20E3]/u.test(String.fromCodePoint(c))
// (Only the subdivision flags emoji actually has: England, Scotland, Wales.)
const FLAG_TAGS = /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}/gu
// Each mark only before a character of its own kind (an invisible one
// can't sit before an ASCII letter).
const KEPT_MARKS = [
  [/^[\u0600-\u0605\u06dd\u0890\u0891\u08e2]$/u, /^\p{Nd}$/u],     // Arabic number signs (they are drawn)
  [/^[\u{110bd}\u{110cd}]$/u, /^(?![0-9])\p{Nd}$/u],                      // Kaithi number signs
  [/^\u070f$/u, /^\p{Script=Syriac}$/u],
  [/^[\u{13430}-\u{1343f}]$/u, /^\p{Script=Egyptian_Hieroglyphs}$/u],
  [/^[\u{1bca0}-\u{1bca3}]$/u, /^\p{Script=Duployan}$/u],
]
function keptInContext(ch, at, text) {
  const c = ch.codePointAt(0)
  const before = at > 0 ? text.codePointAt(at - 1 - (at > 1 && /[\udc00-\udfff]/.test(text[at - 1]) ? 1 : 0)) : null
  const after = text.codePointAt(at + ch.length) ?? null
  if (c === 0x200c || c === 0x200d) return before !== null && after !== null && isBase(before) && isBase(after)
  const vs = x => (x >= 0xfe00 && x <= 0xfe0f) || (x >= 0xe0100 && x <= 0xe01ef) || (x >= 0x180b && x <= 0x180d) || x === 0x180f
  // (A keycap: 1️⃣ is "1", U+FE0F, U+20E3.)
  if (c === 0xfe0f && before !== null && /^[0-9#*]$/.test(String.fromCodePoint(before)) && after === 0x20e3) return true
  if (vs(c)) return before !== null && isBase(before) && !vs(before)
  const mark = KEPT_MARKS.find(([m]) => m.test(ch))
  if (mark) return after !== null && mark[1].test(String.fromCodePoint(after))
  return false
}
// Two passes: first what is never kept goes, then the rest is judged by
// its neighbours as they are now (a filler can't make a joiner look kept).
const MAYBE_KEPT = /^[\u200c\u200d\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u180b-\u180d\u180f\u{e0020}-\u{e007f}\u0600-\u0605\u06dd\u070f\u0890\u0891\u08e2\u{110bd}\u{110cd}\u{13430}-\u{1343f}\u{1bca0}-\u{1bca3}]$/u
// Then again until nothing changes (what one pass drops can leave another
// character without the neighbour it was kept for); after a few passes,
// whatever is left of them goes, except subdivision flags.
function contextPass(text, keep) {
  // (The tags of the subdivision flags are text. Matches come in order: one
  // pointer over the flags, so it stays linear.)
  const flags = [...text.matchAll(FLAG_TAGS)].map(m => [m.index, m.index + m[0].length])
  let f = 0
  return text.replace(UNSAFE_CHARS, (ch, at, all) => {
    while (f < flags.length && flags[f][1] <= at) f++
    const inFlag = f < flags.length && at >= flags[f][0]
    return inFlag || (keep && keptInContext(ch, at, all)) ? ch : ''
  })
}
// Cut clean text to n characters without leaving anything dangling at the
// cut: half a surrogate pair, or a joiner or selector with nothing after it.
function cutText(t, n) {
  let s = t.length > n ? t.slice(0, n) : t
  for (let i = 0; i < 4 && /(?:[\u200c\u200d\ufe00-\ufe0f\ud800-\udbff]|\udb40[\udd00-\uddef])$/.test(s); i++) s = s.replace(/(?:[\u200c\u200d\ufe00-\ufe0f\ud800-\udbff]|\udb40[\udd00-\uddef])$/, '')
  return s
}
const cleanText = t => {
  if (typeof t !== 'string') return t
  let maybe = 0
  let out = t.replace(UNSAFE_CHARS, ch => (MAYBE_KEPT.test(ch) ? (maybe++, ch) : ''))
  // Judging each one by its neighbours costs more than the rest of the text:
  // a text with hundreds of them (no real one has) loses them all, except
  // subdivision flags.
  if (maybe > 256) return contextPass(out, false)
  for (let i = 0; i < 4; i++) {
    const next = contextPass(out, true)
    if (next === out) return out
    out = next
  }
  return contextPass(out, false)
}

function storeMessage(from, target, { text, replyTo, fileId, fileKind, system = false, auto = false }) {
  if (text != null && typeof text !== 'string') throw bad('text must be a string')
  // (Far too long is refused before the cleaning, which costs the whole text.)
  if (text && text.length > MAX_TEXT * 2) throw bad(`message is too long (max ${MAX_TEXT} chars)`)
  text = cleanText(text)
  if (text && text.length > MAX_TEXT) throw bad(`message is too long (max ${MAX_TEXT} chars)`)
  if (!text && !fileId) throw bad('message text is empty')
  let reply = null
  if (replyTo != null && replyTo !== '') {
    reply = Number(replyTo)
    // Only a message the sender can see: otherwise the reply would hand its
    // text back (reply_to_message) to someone who never received it.
    const replied = Number.isInteger(reply) ? db.prepare('SELECT * FROM messages WHERE id = ?').get(reply) : null
    if (!replied || !canSeeMessage(from, replied)) throw bad('message to be replied not found')
  }
  // A standalone session (role "solo") is outside every squad: it neither
  // sends nor takes messages.
  if (!system && roleOf(from) === 'solo') throw new ApiError(403, 'Forbidden: this is a standalone session: it does not message other sessions')
  if (!system && !target.startsWith('#') && roleOf(target) === 'solo') throw new ApiError(403, `Forbidden: "${target}" is a standalone Claude Code session: it does not take messages from other sessions`)
  const recipients = recipientsOf(target, from)
  // (When it was last seen only for a session it is related to, as getChat.)
  const offline = recipients.filter(r => !isOnline(r)).map(r => ({
    name: r,
    last_seen_at: presence.get(r)?.lastPollAt && related(from, r) ? unix(presence.get(r).lastPollAt) : null, // (no queue count per member)
    queued: roleOf(r) !== 'worker',
  }))
  const dropped = offline.filter(o => !o.queued)
  if (!system && !target.startsWith('#') && dropped.length) {
    const o = dropped[0]
    throw new ApiError(403, `Forbidden: "${o.name}" is a worker and is not connected right now; the message was not sent`,
      { parameters: { reason: 'recipient_offline', name: o.name, last_seen_at: o.last_seen_at } })
  }
  const info = db.prepare('INSERT INTO messages (from_name, target, text, reply_to, file_id, file_kind, created_at, system, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(from, target, text ?? null, reply, fileId ?? null, fileKind ?? null, now(), system ? 1 : 0, auto ? 1 : 0)
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid)
  const msg = messageObj(row)
  broadcast('message', messageView(row))
  const skip = new Set(dropped.map(o => o.name))
  // (A notice about a worker counts as the worker's: it shares that worker's
  // queue cap and goes when the worker is deleted.)
  inTx(() => { for (const r of recipients) if (!skip.has(r)) pushUpdate(r, { message: msg }, from) })
  // Tell the sender who isn't connected: queued (coordinators) or, in a group,
  // skipped (workers).
  return offline.length ? { ...msg, squadra_offline_recipients: offline } : msg
}

// --- live observation ------------------------------------------------------------
//
// Each session's plugin posts what it's doing (hook events + transcript). The
// server keeps 24h of events, derives a current state per session, and pushes
// everything to dashboard clients as it happens.

const EVENT_KINDS = new Set([
  'observe_start', 'session_start', 'prompt', 'tool_start', 'tool_end', 'text', 'usage',
  'notification', 'subagent_start', 'subagent_stop', 'stop', 'compact', 'compacted', 'session_end',
])
const MAX_EVENT_JSON = 20_000
const activity = new Map() // name -> derived state

// An event as seen by the dashboard. The plugin's own "id" (tool use id or
// subagent id) is exposed as "ref"; "id" is always the event's row id.
// What each kind of event may carry, and of which type. Anything else is
// dropped — the dashboard renders these fields, so nothing a session sends
// reaches it untyped (and no event can pass itself off as a message).
// (Cut before cleaning too: cleaning costs the whole text.)
const STR = max => v => (typeof v === 'string' ? cutText(cleanText(v.slice(0, max * 2)), max) : undefined)
const INT = v => (Number.isSafeInteger(v) && v >= 0 ? v : undefined)
const PCT = v => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : undefined)
const BOOL = v => (typeof v === 'boolean' ? v : undefined)
const EVENT_COMMON = { cwd: STR(1000), agent: STR(100) }
const EVENT_SCHEMA = {
  observe_start: { level: STR(20) },
  session_start: { source: STR(40), model: STR(100) },
  prompt: { text: STR(20_000), channel: BOOL },
  tool_start: { id: STR(100), tool: STR(200), summary: STR(2000), detail: STR(20_000) },
  tool_end: { id: STR(100), tool: STR(200), ok: BOOL, interrupted: BOOL, summary: STR(2000), duration_ms: INT, detail: STR(20_000) },
  text: { text: STR(20_000) },
  usage: { context_tokens: INT, model: STR(100), context_window: INT, compact_at: INT, context_pct: PCT },
  notification: { type: STR(60), text: STR(1000) },
  subagent_start: { id: STR(100) },
  subagent_stop: { id: STR(100), text: STR(20_000) },
  stop: { background_tasks: INT },
  compact: { trigger: STR(20) },
  compacted: { trigger: STR(20), summary: STR(20_000) },
  session_end: { reason: STR(100) },
}
function cleanEvent(kind, data) {
  const out = {}
  const schema = { ...EVENT_COMMON, ...(EVENT_SCHEMA[kind] ?? {}) }
  if (!data || typeof data !== 'object') return out
  for (const [k, check] of Object.entries(schema)) {
    if (!Object.hasOwn(data, k)) continue
    const v = check(data[k])
    if (v !== undefined) out[k] = v
  }
  return out
}

// (Stored events were cleaned when they came in: read back as they are,
// never cleaned again — that would cost the whole text on every read.)
function eventView(rowId, session, ts, kind, data, { stored = false } = {}) {
  const { id: ref, ...rest } = stored ? (data && typeof data === 'object' ? data : {}) : cleanEvent(kind, data)
  return { ...rest, ...(ref != null ? { ref } : {}), id: rowId, session, ts, kind }
}

function activityOf(name) {
  if (!activity.has(name)) activity.set(name, { state: 'unknown', since: null, last_event_at: null })
  return activity.get(name)
}

function applyEvent(name, ev) {
  const a = activityOf(name)
  const set = state => { if (a.state !== state) { a.state = state; a.since = ev.ts } }
  a.last_event_at = Math.max(a.last_event_at ?? 0, ev.ts)
  if (typeof ev.cwd === 'string') a.cwd = ev.cwd
  switch (ev.kind) {
    case 'observe_start': a.observe = ev.level; if (ev.cwd) a.cwd = ev.cwd; if (a.state === 'unknown' || a.state === 'ended') set('idle'); break
    case 'session_start': if (ev.cwd) a.cwd = ev.cwd; if (ev.model) a.model = ev.model; set('idle'); break
    case 'prompt': set('working'); break
    case 'tool_start':
      if (ev.agent) break // tools run by subagents: the main session is inside its Task/Agent tool
      a.tool = { id: ev.ref, name: ev.tool, summary: ev.summary, since: ev.ts }
      set('tool')
      break
    case 'tool_end':
      if (ev.agent) break
      if (!a.tool || !ev.ref || a.tool.id === ev.ref) { a.tool = null; set('working') }
      break
    // (Claude's text is read from its transcript, so the last one of a turn
    // can arrive after the turn ended: one written before that end doesn't
    // make the session "working" again.)
    case 'text': if (a.state !== 'waiting' && !(a.state === 'idle' && a.stopped_at && ev.ts <= a.stopped_at)) set('working'); break
    case 'usage':
      a.context_tokens = ev.context_tokens
      if (ev.model) a.model = ev.model
      if (ev.compact_at) { a.compact_at = ev.compact_at; a.context_window = ev.context_window; a.context_pct = ev.context_pct }
      break
    case 'notification':
      if (['permission_prompt', 'elicitation_dialog', 'agent_needs_input', 'elicitation_url_dialog'].includes(ev.type)) { a.waiting = ev.text; set('waiting') }
      else if (ev.type === 'idle_prompt') set('idle')
      break
    case 'stop': a.tool = null; a.stopped_at = ev.ts; set('idle'); break
    case 'compact': set('compacting'); break
    case 'compacted':
      // Fresh context: the size is unknown until the next model response.
      a.context_tokens = null; a.context_pct = null; a.context_warned = false
      if (a.state === 'compacting') set('working')
      break
    case 'session_end': a.tool = null; set('ended'); break
  }
  if (a.state !== 'waiting') a.waiting = null
}

// Per identity: at most 120 observe calls and 3000 events a minute.
const observeLog = new Map() // name -> [{ t, n }]
// Bytes stored per identity in the last hour, per kind (events, text).
const storedLog = new Map() // `${kind}:${name}` -> [{ t, bytes }]
// Kept per minute (at most 60 buckets per key), so checking costs the same
// however much a session sends.
function spendStorage(kind, name, bytes, max = STORED_BYTES_PER_HOUR) {
  const t = now()
  const minute = Math.floor(t / 60_000)
  const key = `${kind}:${name}`
  const buckets = (storedLog.get(key) ?? []).filter(b => minute - b.m < 60)
  const used = buckets.reduce((s, b) => s + b.bytes, 0)
  if (used + bytes > max) throw new ApiError(429, `Too Many Requests: storage budget for this hour used up (${kind})`, { parameters: { retry_after: 600 } })
  const last = buckets[buckets.length - 1]
  if (last && last.m === minute) last.bytes += bytes
  else buckets.push({ m: minute, bytes })
  storedLog.set(key, buckets)
}

function observeBudget(name, n) {
  // And at most 30 000 events an hour per session: the events kept in all are
  // capped, and one session must not push everybody else's out.
  // (The per-minute limit first: a call it refuses doesn't use up the hour's.)
  const t = now()
  const recent = (observeLog.get(name) ?? []).filter(x => t - x.t < 60_000)
  const events = recent.reduce((sum, x) => sum + x.n, 0)
  if (recent.length >= 120 || events + n > 3000) throw new ApiError(429, 'Too Many Requests: observation rate limit', { parameters: { retry_after: 10 } })
  spendStorage('eventcount', name, n, 30_000)
  recent.push({ t, n })
  observeLog.set(name, recent)
}

function observe(name, p) {
  const events = Array.isArray(p.events) ? p.events : null
  if (!events || events.length > 200) throw bad('events must be an array of at most 200 items')
  observeBudget(name, events.length)
  const insert = db.prepare('INSERT INTO events (session, ts, kind, data) VALUES (?, ?, ?, ?)')
  // The whole batch is checked first, then stored at once: all of it or none
  // (a refusal halfway would store part of it and the retry would repeat it).
  const batch = []
  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || !EVENT_KINDS.has(ev.kind)) continue
    // Whole milliseconds within the events' lifetime: the history cursor relies on it.
    const ts = Number.isSafeInteger(ev.ts) ? Math.max(now() - EVENT_TTL_MS, Math.min(ev.ts, now() + 5000)) : now()
    const kind = ev.kind
    const rest = cleanEvent(kind, ev)
    const data = JSON.stringify(rest)
    if (data.length > MAX_EVENT_JSON) continue
    batch.push({ ts, kind, rest, data })
  }
  // Charged on what was sent, not on what is kept: text cleaned away (it
  // cost the cleaning all the same) counts too.
  spendStorage('events', name, Math.max(batch.reduce((n, e) => n + e.data.length, 0), Math.min(JSON.stringify(events).length, 1_048_576)))
  let stored = 0
  inTx(() => { for (const { ts, kind, rest, data } of batch) {
    const info = insert.run(name, ts, kind, data)
    const view = eventView(Number(info.lastInsertRowid), name, ts, kind, rest, { stored: true })
    const before = activityOf(name)
    const wasWarned = !!before.context_warned
    applyEvent(name, view)
    contextNotices(name, view, wasWarned)
    broadcast('event', view)
    stored++
  } })
  if (stored) broadcast('session', sessionView(name))
  return { stored }
}

// Tell a worker's coordinator when its context is nearly full (once per fill-up)
// and when it compacts. Only live events, never the startup replay.
const CONTEXT_WARN_PCT = 80
const NOTICE_COOLDOWN_MS = Number(process.env.SQUADRA_NOTICE_COOLDOWN_MS ?? 5 * 60_000) // per worker, per kind
function contextNotices(name, ev, wasWarned) {
  const a = activityOf(name)
  if (ev.kind === 'usage' && ev.context_pct != null && ev.context_pct >= CONTEXT_WARN_PCT && !wasWarned) {
    a.context_warned = true
    // Its own cooldown too: compaction events reset the flag.
    if (now() - (a.context_notice_at ?? 0) < NOTICE_COOLDOWN_MS) return
    a.context_notice_at = now()
    announce(name, `📈 ${name} has used ${ev.context_pct}% of its context; it will auto-compact soon. Avoid giving it a large new task now, or prefer a worker with more room.`)
  }
  if (ev.kind === 'compacted') {
    // At most one compaction notice every 5 minutes per worker: alternating
    // usage/compacted events must not flood the coordinator.
    if (now() - (a.compact_notice_at ?? 0) < NOTICE_COOLDOWN_MS) return
    a.compact_notice_at = now()
    announce(name, `🗜️ ${name} compacted its context (${ev.trigger === 'manual' ? 'manual' : 'automatic'}). Its Squadra role and the latest messages it received were restored; if its task depends on details only you know, send them to it again.`)
  }
}

const methods = {
  observe,

  getMe(name) {
    readLimit(name)
    return { ...userObj(name), is_bot: true }
  },

  sendMessage(name, p) {
    rateLimit(name)
    spendStorage('text', name, String(p.text ?? '').length)
    const target = resolveTarget(p.chat_id, name)
    return storeMessage(name, target, {
      text: p.text,
      replyTo: p.reply_to_message_id ?? p.reply_parameters?.message_id,
      auto: p.squadra_auto === true,
    })
  },

  editMessageText(name, p) {
    rateLimit(name)
    const id = Number(p.message_id)
    if (typeof p.text !== 'string' || !p.text) throw bad('text is required')
    if (p.text.length > MAX_TEXT * 2) throw bad(`message is too long (max ${MAX_TEXT} chars)`)
    // (Charged on the text as sent, before the cleaning and the lookup, which
    // cost the same whether or not the edit goes through.)
    spendStorage('text', name, p.text.length)
    p.text = cleanText(p.text)
    if (p.text.length > MAX_TEXT) throw bad(`message is too long (max ${MAX_TEXT} chars)`)
    if (!p.text) throw bad('text is required')
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
    // Server notices carry the worker's name but are the server's words: not editable.
    // (Only this identity's own messages: a name registered again can't edit the old one's.)
    if (!row || row.system || row.from_name !== name || row.target !== String(p.chat_id) || row.created_at < identityCreatedAt(name)) throw bad('message to edit not found')
    if (row.file_id) throw bad('there is no text in the message to edit')
    if (row.text === p.text) throw bad('message is not modified')
    // Still allowed to write there (a group you left is closed to you).
    resolveTarget(row.target, name)
    db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(p.text, now(), id)
    const edited = db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
    const msg = messageObj(edited)
    // Only to whoever can see the original, and not queued for workers that
    // are offline (like a new message).
    for (const r of recipientsOf(row.target, name)) {
      if (!canSeeMessage(r, edited)) continue
      if (!isOnline(r) && roleOf(r) === 'worker') continue
      pushUpdate(r, { edited_message: msg }, name)
    }
    // The dashboard shows the new text too (what the recipients now have).
    broadcast('edited', messageView(edited))
    return msg
  },

  setMessageReaction(name, p) {
    rateLimit(name)
    const id = Number(p.message_id)
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
    // You can react to messages you received: DMs addressed to you, or groups you're in.
    if (!row || row.from_name === name || !canSeeMessage(name, row)) throw bad('message not found')
    const reaction = Array.isArray(p.reaction) ? p.reaction : []
    const emoji = typeof reaction[0]?.emoji === 'string' ? cutText(cleanText(reaction[0].emoji.slice(0, 64)), 16) || null : null
    if (emoji) {
      db.prepare('INSERT OR REPLACE INTO reactions (message_id, from_name, emoji, created_at) VALUES (?, ?, ?, ?)').run(id, name, emoji, now())
    } else {
      db.prepare('DELETE FROM reactions WHERE message_id = ? AND from_name = ?').run(id, name)
    }
    // Counted as this sender's (the per-sender queue cap applies), and only to
    // an author who can still see the message (not a later holder of the name).
    if (row.from_name !== name && canSeeMessage(row.from_name, row)) {
      pushUpdate(row.from_name, {
        message_reaction: {
          chat: chatFor(row.target, name),
          message_id: id,
          user: userObj(name),
          date: unix(now()),
          old_reaction: [],
          new_reaction: emoji ? [{ type: 'emoji', emoji }] : [],
        },
      }, name)
    }
    return true
  },

  sendChatAction(name, p) {
    readLimit(name, 'action')
    resolveTarget(p.chat_id, name)
    const action = ['typing', 'upload_document', 'upload_photo'].includes(p.action) ? p.action : 'typing'
    chatActions.set(`${name}->${p.chat_id}`, { action, at: now() })
    return true
  },

  getFile(name, p) {
    readLimit(name)
    const f = fileRow(String(p.file_id ?? ''))
    if (!f || !canSeeFile(name, f.file_id)) throw bad('wrong file_id or the file is temporarily unavailable')
    return { file_id: f.file_id, file_unique_id: f.file_unique_id, file_size: f.size, file_path: f.path }
  },

  // A session claims its name before polling. First come, first served: while
  // the session holding the name is online, any other session is refused.
  claimSession(name, p) {
    const instance = String(p.instance ?? '')
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(instance)) throw bad('instance is required')
    const lease = leases.get(name)
    // A connected session keeps its name: nobody can take it over (not even
    // with its identity secret). The dashboard admin can disconnect it.
    // (Checked before the rate limit: a copy of the secret refused here must
    // not use up the budget of the session that holds the name.)
    if (lease && lease.instance !== instance && holdsName(name, lease)) throw nameInUse(name, lease)
    if (!allow('claim', name, 20)) throw new ApiError(429, 'Too Many Requests: retry in a minute')
    // (solo: a plain Claude Code session opened from the dashboard, outside any squad.)
    const role = ['coordinator', 'worker', 'solo'].includes(p.role) ? p.role : null
    const coordinator = role === 'worker' && NAME_RE.test(String(p.coordinator ?? '')) ? String(p.coordinator) : null
    if (role) db.prepare('UPDATE identities SET role = ?, coordinator = ? WHERE name = ?').run(role, coordinator, name)
    // An archived session that logs in again is active again.
    if (db.prepare('UPDATE identities SET archived_at = NULL WHERE name = ? AND archived_at IS NOT NULL').run(name).changes) {
      setImmediate(() => broadcast('session', sessionView(name)))
    }
    if (!lease || lease.instance !== instance) setLease(name, instance)
    else delete lease.restoredUntil
    markPolled(name) // a claim is a sign of life: don't let the down sweep fire before the first poll
    return { name, role, since: unix(leases.get(name).since) }
  },

  // reason: 'logout' (the user left) or 'exit' (Claude Code is closing).
  releaseSession(name, p) {
    const lease = leases.get(name)
    if (lease && lease.instance === String(p.instance ?? '')) {
      if (!allow('release', name, 20)) throw new ApiError(429, 'Too Many Requests: retry in a minute')
      if (!lease.downNotified) announceDown(name, p.reason === 'exit' ? 'exit' : 'logout')
      dropLease(name)
      const w = waiters.get(name)
      if (w) finishPoll(w, null, [])
      presence.set(name, { ...(presence.get(name) ?? {}), lastPollAt: now(), disconnected: true, pollingSince: null })
    }
    return true
  },

  // Groups are private: whoever creates one owns it, and others join only
  // after the group's owner invites them (inviteToGroup).
  joinGroup(name, p) {
    groupLimit(name) // (their own budget: retried invites can't block sending)
    const id = String(p.chat_id ?? '')
    if (!GROUP_RE.test(id)) throw bad('group id must look like #name')
    const members = () => db.prepare('SELECT name FROM group_members WHERE group_id = ? ORDER BY name').all(id).map(r => r.name)
    const ownerOf = () => db.prepare('SELECT owner FROM groups WHERE id = ?').get(id)?.owner ?? null
    // Not just "true": whether this created the group, who owns it and who is in
    // it, so a session can tell if someone set the group up before it.
    if (db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND name = ?').get(id, name)) return { created: false, owner: ownerOf(), members: members() }
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id)
    // Every limit before anything is written (a refused join leaves no empty group behind).
    // A session is in at most 50 groups.
    if (db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE name = ?').get(name).n >= 50) throw new ApiError(403, 'Forbidden: a session can be in at most 50 groups')
    let created = false
    if (!group) {
      // At most 50 groups owned per session.
      if (db.prepare('SELECT COUNT(*) AS n FROM groups WHERE owner = ?').get(name).n >= 50) throw new ApiError(403, 'Forbidden: a session can own at most 50 groups')
      db.prepare('INSERT INTO groups (id, created_at, owner) VALUES (?, ?, ?)').run(id, now(), name)
      created = true
    } else if (!db.prepare('SELECT 1 FROM group_invites WHERE group_id = ? AND name = ?').get(id, name)) {
      throw new ApiError(403, `Forbidden: ${id} is private; a member has to invite "${name}" first`, { parameters: { reason: 'not_invited' } })
    } else if (db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(id).n >= 50) {
      // At most 50 members: every message to a group is written once per member.
      throw new ApiError(403, 'Forbidden: a group has at most 50 members')
    }
    db.prepare('INSERT OR IGNORE INTO group_members (group_id, name, joined_at) VALUES (?, ?, ?)').run(id, name, now())
    db.prepare('DELETE FROM group_invites WHERE group_id = ? AND name = ?').run(id, name)
    return { created, owner: created ? name : ownerOf(), members: members() }
  },

  inviteToGroup(name, p) {
    groupLimit(name) // (their own budget: retried invites can't block sending)
    const id = String(p.chat_id ?? '')
    const who = String(p.name ?? '')
    if (!GROUP_RE.test(id)) throw bad('group id must look like #name')
    if (!NAME_RE.test(who) || !identityExists(who)) throw bad('no session with that name')
    if (!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND name = ?').get(id, name)) {
      throw new ApiError(403, `Forbidden: not a member of ${id}`)
    }
    const owner = db.prepare('SELECT owner FROM groups WHERE id = ?').get(id)?.owner
    if (owner && owner !== name) throw new ApiError(403, `Forbidden: only the group's owner ("${owner}") invites to ${id}`)
    db.prepare('INSERT OR IGNORE INTO group_invites (group_id, name, invited_by, created_at) VALUES (?, ?, ?, ?)').run(id, who, name, now())
    return true
  },

  leaveChat(name, p) {
    rateLimit(name)
    const id = String(p.chat_id ?? '')
    // Only groups can be left (closing one deletes its messages: a DM's
    // "chat id" is a session name and must never get here).
    if (!GROUP_RE.test(id)) throw bad('chat_id must be a group (#name)')
    if (!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND name = ?').get(id, name)) throw bad('not a member of that group')
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND name = ?').run(id, name)
    // The last one out closes the group (it can be created again from scratch).
    if (!db.prepare('SELECT 1 FROM group_members WHERE group_id = ?').get(id)) closeGroup(id)
    else handOverGroup(id, name)
    return true
  },

  // A session sees who exists (and when it was registered, for the
  // coordinator pin), but presence, queue and context only of sessions it
  // talks to: messages both ways, or a group they share.
  getChat(name, p) {
    readLimit(name, 'chat') // its own budget: other reads can't use it up
    const id = String(p.chat_id ?? '')
    if (id.startsWith('#')) {
      const members = db.prepare('SELECT name FROM group_members WHERE group_id = ?').all(id).map(r => r.name)
      if (!members.includes(name)) throw bad('chat not found')
      return { id, type: 'group', title: id, members }
    }
    const ident = db.prepare('SELECT created_at, epoch FROM identities WHERE name = ?').get(id)
    if (!ident) throw bad('chat not found')
    // Writing to a session isn't enough (anyone can): it has to have written back.
    // (Only messages since both current identities exist: a name deleted and
    // registered again starts with no relations.)
    if (!related(name, id)) return { id, type: 'private', username: id, created_at: unix(ident.created_at), squadra_identity: ident.epoch, presence_hidden: true }
    const a = activity.get(id)
    return {
      id, type: 'private', username: id, created_at: unix(ident.created_at), squadra_identity: ident.epoch, ...presenceOf(id),
      context: a?.context_pct != null ? { pct: a.context_pct, tokens: a.context_tokens, compact_at: a.compact_at } : null,
    }
  },
}

const chatActions = new Map()

function canSeeFile(name, fileId) {
  const msgs = db.prepare('SELECT * FROM messages WHERE file_id = ?').all(fileId)
  return msgs.some(m => canSeeMessage(name, m))
}

// Presence: a plugin is "online" while it long-polls. It dies with its Claude
// Code session (stdin EOF), so online means the session is running.
const presence = new Map() // name -> { pollingSince, lastPollAt, disconnected }

// Leases: which session (plugin instance) holds each name. Kept in the
// database too: after a server restart, the names that were held stay
// reserved for their sessions for RESTART_GRACE_MS, so a copy of a secret
// can't grab a name while its session reconnects.
const leases = new Map() // name -> { instance, since, downNotified, restoredUntil? }
const RESTART_GRACE_MS = 2 * 60 * 1000
for (const r of db.prepare('SELECT name, instance, since FROM leases').all()) {
  leases.set(r.name, { instance: r.instance, since: r.since, downNotified: false, restoredUntil: now() + RESTART_GRACE_MS })
}

function setLease(name, instance) {
  dropAnswer(name) // a new holder starts clean (and an unread answer of the old one goes)
  servedUpTo.delete(name)
  const lease = { instance, since: now(), downNotified: false }
  leases.set(name, lease)
  db.prepare('INSERT OR REPLACE INTO leases (name, instance, since) VALUES (?, ?, ?)').run(name, instance, lease.since)
  return lease
}

function dropLease(name) {
  leases.delete(name)
  db.prepare('DELETE FROM leases WHERE name = ?').run(name)
}

// The lease's session still has the name: it is online, or the server just
// restarted and it hasn't had time to reconnect.
function holdsName(name, lease) {
  return isOnline(name) || (lease?.restoredUntil ?? 0) > now()
}

function nameInUse(name, lease) {
  const p = presence.get(name)
  const ago = p?.lastPollAt ? Math.round((now() - p.lastPollAt) / 1000) : null
  return new ApiError(409, `Conflict: name "${name}" is in use by another active session (connected since ${new Date(lease.since).toISOString()}${ago != null ? `, last seen ${ago}s ago` : ''})`,
    { parameters: { reason: 'name_in_use', since: unix(lease.since) } })
}

function kickHolder(name) {
  const w = waiters.get(name)
  if (w) finishPoll(w, new ApiError(409, `Conflict: name "${name}" was taken over by another session`, { parameters: { reason: 'taken_over' } }))
  presence.set(name, { ...(presence.get(name) ?? {}), lastPollAt: now(), disconnected: true, pollingSince: null })
}

function checkLease(name, instance) {
  const lease = leases.get(name)
  if (!lease) {
    setLease(name, instance)
    return
  }
  if (lease.instance === instance) {
    delete lease.restoredUntil
    // Same session polling again after we announced it down (network blip).
    if (lease.downNotified) {
      lease.downNotified = false
      db.prepare('INSERT OR REPLACE INTO leases (name, instance, since) VALUES (?, ?, ?)').run(name, lease.instance, lease.since)
      announce(name, `🔌 ${name} is back online (same session).`)
    }
    return
  }
  if (holdsName(name, lease)) {
    throw new ApiError(409, `Conflict: name "${name}" was taken over by another session`, { parameters: { reason: 'taken_over' } })
  }
  setLease(name, instance) // previous holder is gone
}

// --- down notices ---------------------------------------------------------------
//
// When a worker leaves (logout), its Claude Code closes, or it stops polling
// (crash, lost network), its coordinator gets one notice from the server. The
// worker's undelivered messages are dropped and listed, so they never turn up
// later as stale work.

function announce(worker, text) {
  const row = db.prepare('SELECT role, coordinator FROM identities WHERE name = ?').get(worker)
  if (row?.role !== 'worker' || !row.coordinator || roleOf(row.coordinator) !== 'coordinator') return
  // A session picks its coordinator itself: notices only reach a coordinator
  // that has written to this worker, so nobody can fill a coordinator's chat
  // by declaring itself its worker.
  const since = Math.max(identityCreatedAt(worker), identityCreatedAt(row.coordinator))
  if (!db.prepare('SELECT 1 FROM messages WHERE from_name = ? AND target = ? AND system = 0 AND auto = 0 AND created_at >= ? LIMIT 1').get(row.coordinator, worker, since)) return
  // At most 10 notices a minute per worker, so a session can't flood a coordinator.
  if (!allow('notice', `${worker}->${row.coordinator}`, 10)) return
  try {
    storeMessage(worker, row.coordinator, { text, system: true })
  } catch (err) {
    process.stderr.write(`squadra-server: notice for ${row.coordinator} failed: ${err.message}\n`)
  }
}

function announceDown(worker, reason) {
  const lease = leases.get(worker)
  if (lease) lease.downNotified = true
  // Only a worker's queue is dropped (its tasks go back to the coordinator);
  // what waits for a coordinator, or a session without a role, is kept.
  if (roleOf(worker) !== 'worker') return
  // Drop what the worker never picked up.
  // Only the coordinator's own messages are quoted (the tasks to reassign),
  // at most 10; anything else (other sessions, groups) is only counted: a
  // notice must not show the coordinator what it couldn't see. Only those
  // few rows are read (a queue can hold thousands).
  const coord = db.prepare('SELECT coordinator FROM identities WHERE name = ?').get(worker)?.coordinator
  const total = db.prepare('SELECT COUNT(*) AS n FROM updates WHERE recipient = ?').get(worker).n
  const coordRows = coord ? db.prepare('SELECT payload FROM updates WHERE recipient = ? AND sender = ? ORDER BY update_id LIMIT 11').all(worker, coord) : []
  const coordCount = coord ? db.prepare('SELECT COUNT(*) AS n FROM updates WHERE recipient = ? AND sender = ?').get(worker, coord).n : 0
  db.prepare('DELETE FROM updates WHERE recipient = ?').run(worker)
  const fromCoord = coordRows.map(u => JSON.parse(u.payload).message).filter(m => m && !m.squadra_notice && m.chat?.type === 'private')
  const msgs = { length: total }
  const others = total - coordCount
  // Quoted as data: this text was written by the sender, not by the server.
  const lost = fromCoord.slice(0, 10)
    .map(m => `${JSON.stringify((m.text ?? m.caption ?? '(attachment)').replace(/\s+/g, ' ').slice(0, 120))}`)
  if (coordCount > 10) lost.push(`and ${coordCount - 10} more of yours`)
  if (others) lost.push(`and ${others} from other sessions or groups`)
  const what = {
    logout: `🔌 ${worker} left Squadra (logout).`,
    exit: `🔌 ${worker} disconnected: its Claude Code session was closed.`,
    lost: `⚠️ ${worker} is DOWN: it stopped responding (lost connection or its machine went down).`,
  }[reason]
  const parts = [what]
  if (msgs.length) parts.push(`It never picked up ${msgs.length} message(s), which were dropped: ${lost.join('; ')}.`)
  parts.push('If it had a task in progress, it will not finish it: consider reassigning it to another active worker.')
  announce(worker, parts.join(' '))
}

// Leases whose holder stopped polling without releasing (crash, lost network).
// Sessions held before a restart keep their names for RESTART_GRACE_MS from
// when the server is actually answering again (not from when it started
// loading), and nobody is declared lost before that.
let serving = false
function nowServing() {
  if (serving) return
  serving = true
  for (const lease of leases.values()) if (lease.restoredUntil) lease.restoredUntil = now() + RESTART_GRACE_MS
}
function sweepLeases() {
  if (!serving) return
  for (const [name, lease] of leases) {
    if (!lease.downNotified && !holdsName(name, lease)) {
      announceDown(name, 'lost')
      // Gone: a server restart doesn't keep the name for it any more (the same
      // session can still come back: its instance is still known here).
      db.prepare('DELETE FROM leases WHERE name = ?').run(name)
    }
  }
}
setInterval(guarded(sweepLeases), 3000).unref()

function markPolled(name) {
  const p = presence.get(name)
  const back = !p || p.disconnected || now() - p.lastPollAt >= ONLINE_GRACE_MS
  presence.set(name, { pollingSince: p && !p.disconnected && p.pollingSince ? p.pollingSince : now(), lastPollAt: now(), disconnected: false })
  // An archived session that comes back (also without logging in again, after
  // a network blip) is active again, as one that claims its name is.
  if (back && db.prepare('UPDATE identities SET archived_at = NULL WHERE name = ? AND archived_at IS NOT NULL').run(name).changes) broadcast('session', sessionView(name))
}

function isOnline(name) {
  if (waiters.has(name)) return true
  const p = presence.get(name)
  return !!p && !p.disconnected && now() - p.lastPollAt < ONLINE_GRACE_MS
}

function presenceOf(name) {
  const online = isOnline(name)
  const p = presence.get(name)
  const lastMsg = db.prepare('SELECT MAX(created_at) AS t FROM messages WHERE from_name = ?').get(name)?.t
  const pending = db.prepare('SELECT COUNT(*) AS n FROM updates WHERE recipient = ?').get(name)?.n ?? 0
  return {
    online,
    connected_since: online && p?.pollingSince ? unix(p.pollingSince) : null,
    last_seen_at: p?.lastPollAt ? unix(p.lastPollAt) : null,
    last_message_at: lastMsg ? unix(lastMsg) : null,
    pending_updates: pending,
  }
}

// An upload's type: only a plain "type/subtype" (no parameters, nothing
// long), or none — it is stored and sent on with the file.
const uploadMime = v => {
  const t = String(v ?? '').split(';')[0].trim().toLowerCase()
  return /^[a-z0-9][\w.+-]{0,60}\/[a-z0-9][\w.+-]{0,60}$/.test(t) && t !== 'application/octet-stream' ? t : null
}

// Upload: raw body, params in the query string (sendDocument / sendPhoto).
const uploadsInFlight = new Map() // name -> { n, bytes }
let uploadBytesInFlight = 0 // all sessions' uploads still arriving
async function upload(name, kind, query, req, stillValid = () => {}) {
  rateLimit(name)
  const target = resolveTarget(query.get('chat_id'), name)
  spendStorage('text', name, String(query.get('caption') ?? '').length) // a caption is message text
  const fileName = (query.get('filename') ?? 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file'
  // Disk budget: at most 500 MB of uploads per identity per hour, counting
  // the ones still arriving; and at most two at a time.
  const declared = Number(req.headers['content-length'])
  if (!Number.isSafeInteger(declared) || declared <= 0) throw new ApiError(411, 'Length Required')
  if (declared > MAX_FILE_BYTES) throw new ApiError(413, `Request Entity Too Large (max ${MAX_FILE_BYTES} bytes)`)
  const flight = uploadsInFlight.get(name) ?? { n: 0, bytes: 0 }
  const lastHour = db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE owner = ? AND created_at > ?').get(name, now() - 3600_000).n
  if (flight.n >= 2) throw new ApiError(429, 'Too Many Requests: two uploads at a time')
  if (lastHour + flight.bytes + declared > UPLOAD_BUDGET_BYTES) throw new ApiError(429, 'Too Many Requests: upload budget for this hour used up')
  // Per session, at most 2 GB kept (so one session can't fill the server's total alone).
  if (db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE owner = ?').get(name).n + declared > 2 * 1024 ** 3) throw new ApiError(429, 'Too Many Requests: this session keeps 2 GB of attachments already; old ones expire after 7 days')
  if (db.prepare('SELECT COUNT(*) AS n FROM files WHERE owner = ?').get(name).n >= 10_000) throw new ApiError(429, 'Too Many Requests: this session keeps too many attachments; old ones expire after 7 days')
  const allFiles = db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files').get().n
  // (Counting every session's uploads still arriving.)
  if (allFiles + uploadBytesInFlight + declared > MAX_FILES_BYTES) throw new ApiError(507, 'Insufficient Storage: the server keeps no more attachments until old ones expire')
  flight.n++; flight.bytes += declared
  uploadsInFlight.set(name, flight)
  uploadBytesInFlight += declared
  const ext = (extname(fileName).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin')
  const fileId = `f_${randomBytes(12).toString('base64url')}`
  const uniqueId = randomBytes(6).toString('hex')
  const rel = `files/${fileId}${ext}`
  // Written to disk as it arrives (not held in memory), and removed if
  // anything below fails.
  let size
  try {
    size = await readBodyToFile(req, Math.min(declared, MAX_FILE_BYTES), join(DATA_DIR, rel))
  } finally {
    flight.n--; flight.bytes -= declared
    uploadBytesInFlight -= declared
    if (!flight.n) uploadsInFlight.delete(name)
  }
  try {
    if (size === 0) throw bad('file is empty')
    stillValid()
    // (The recipient again too: it may have been deleted while the file arrived.)
    resolveTarget(query.get('chat_id'), name)
  } catch (err) { rmSync(join(DATA_DIR, rel), { force: true }); throw err }
  const realKind = kind === 'photo' && PHOTO_EXTS.has(ext) ? 'photo' : 'document'
  db.prepare('INSERT INTO files (file_id, file_unique_id, path, name, mime, size, owner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(fileId, uniqueId, rel, fileName, uploadMime(req.headers['content-type']), size, name, now())
  try {
    return storeMessage(name, target, {
      text: query.get('caption') || null,
      replyTo: query.get('reply_to_message_id'),
      fileId,
      fileKind: realKind,
    })
  } catch (err) {
    // (Not sent: the file goes too.)
    db.prepare('DELETE FROM files WHERE file_id = ?').run(fileId)
    rmSync(join(DATA_DIR, rel), { force: true })
    throw err
  }
}

// --- admin (server token) ----------------------------------------------------

const adminMethods = {
  register(p) {
    return register(p.name, p.reset === true)
  },
  rotateJoinToken: () => rotateJoinToken(),
  listIdentities() {
    return db.prepare('SELECT name, created_at, last_seen_at FROM identities ORDER BY name').all()
      .map(r => ({ name: r.name, created_at: unix(r.created_at), ...presenceOf(r.name) }))
  },
  deleteIdentity(p) {
    return deleteSession(String(p.name ?? ''))
  },
  listGroups() {
    return allGroups()
  },
}

// --- maintenance -------------------------------------------------------------

function cleanup() {
  const t = now()
  // Groups nobody is in (left behind by older versions) are closed.
  for (const g of db.prepare('SELECT id FROM groups WHERE NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = groups.id)').all()) closeGroup(g.id)
  db.prepare('DELETE FROM updates WHERE created_at < ?').run(t - UPDATE_TTL_MS)
  db.prepare('DELETE FROM updates WHERE update_id <= (SELECT update_id FROM updates ORDER BY update_id DESC LIMIT 1 OFFSET ?)').run(MAX_UPDATES)
  for (const f of db.prepare('SELECT file_id, path FROM files WHERE created_at < ?').all(t - FILE_TTL_MS)) {
    try { rmSync(join(DATA_DIR, f.path), { force: true }) } catch {}
    db.prepare('DELETE FROM files WHERE file_id = ?').run(f.file_id)
  }
  db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE created_at < ?)').run(t - MESSAGE_TTL_MS)
  db.prepare('DELETE FROM reactions WHERE created_at < ? OR message_id NOT IN (SELECT id FROM messages)').run(t - MESSAGE_TTL_MS)
  db.prepare('DELETE FROM messages WHERE created_at < ?').run(t - MESSAGE_TTL_MS)
  db.prepare('DELETE FROM events WHERE ts < ?').run(t - EVENT_TTL_MS)
  // Over the caps: the oldest go first.
  db.prepare('DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)').run(MAX_EVENTS)
  db.prepare('DELETE FROM messages WHERE id <= (SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET ?)').run(MAX_MESSAGES)
  for (const [k, v] of storedLog) if (!v.some(b => Math.floor(t / 60_000) - b.m < 60)) storedLog.delete(k)
  for (const [k, v] of chatActions) if (t - v.at > 10_000) chatActions.delete(k)
  for (const [k, v] of sendLog) if (!v.some(x => t - x < 60_000)) sendLog.delete(k)
  for (const [k, v] of observeLog) if (!v.some(x => t - x.t < 60_000)) observeLog.delete(k)
}
setInterval(guarded(cleanup), 60 * 1000).unref()
cleanup()

// --- http --------------------------------------------------------------------

// --- dashboard (server token) ------------------------------------------------------

function sessionView(name) {
  const row = db.prepare('SELECT name, role, coordinator, created_at, archived_at, cleared_at, host_id, opened_role FROM identities WHERE name = ?').get(name)
  if (!row) return { name, deleted: true }
  const a = activityOf(name)
  return {
    name,
    role: row.role ?? null,
    coordinator: row.coordinator ?? null,
    archived_at: row.archived_at ?? null,
    cleared_at: row.cleared_at ?? null,
    host_id: row.host_id ?? null, // the machine that opened it from the dashboard
    opened_role: row.host_id && ['coordinator', 'worker', 'solo'].includes(row.opened_role) ? row.opened_role : null, // and as what
    ...presenceOf(name),
    activity: { ...a, tool: a.tool ? { ...a.tool } : null },
  }
}

// Every group with its members, in one query.
function allGroups() {
  const byId = new Map(db.prepare('SELECT id FROM groups ORDER BY id').all().map(g => [g.id, { id: g.id, members: [] }]))
  for (const r of db.prepare('SELECT group_id, name FROM group_members').all()) byId.get(r.group_id)?.members.push(r.name)
  return [...byId.values()]
}

function messageView(row) {
  const f = fileRow(row.file_id)
  return {
    id: row.id,
    from: row.from_name,
    target: row.target,
    text: row.text != null ? (row.text.length > 4000 ? `${cutText(row.text, 4000)}…` : row.text) : null,
    file: f ? { name: f.name, size: f.size, kind: row.file_kind } : null,
    system: !!row.system,
    created_at: row.created_at,
    edited_at: row.edited_at ?? null,
  }
}

const sseClients = new Set()

function broadcast(type, data) {
  if (sseClients.size === 0) return
  const chunk = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    if (res.writableEnded) { sseClients.delete(res); continue }
    // A dashboard that stopped reading: drop it (it reconnects and reloads).
    if (res.writableLength > 8 * 1024 * 1024) { sseClients.delete(res); res.destroy(); continue }
    res.write(chunk)
  }
}

// Presence and role changes don't come with events: watch them.
const lastSessionKey = new Map()
setInterval(guarded(() => {
  if (sseClients.size === 0) return
  for (const { name } of db.prepare('SELECT name FROM identities').all()) {
    const v = sessionView(name)
    const key = `${v.online}|${v.role}|${v.coordinator}|${v.pending_updates}|${v.archived_at}`
    if (lastSessionKey.get(name) !== key) {
      lastSessionKey.set(name, key)
      broadcast('session', v)
    }
  }
}), 2000).unref()
setInterval(() => broadcast('ping', { t: now() }), 20_000).unref()

const dashboard = {
  // One session's history for the chat view: its events and Squadra
  // messages it sent or received, merged by time, newest page first. Paginate
  // backwards with ?before=<next_before>. The cursor is exact (time, type, id),
  // so items sharing a millisecond are never skipped or repeated.
  // Order (newest first): ts DESC, then events before messages, then id DESC.
  timeline(q) {
    const session = q.get('session')
    if (!session) throw bad('session is required')
    const limit = Math.max(1, Math.min(Number(q.get('limit') ?? 150) || 150, 500))
    let cts = Number.MAX_SAFE_INTEGER, crank = 2, cid = 0 // start: newer than anything
    const raw = q.get('before')
    if (raw) {
      const m = /^(\d+):([01]):(\d+)$/.exec(raw)
      if (!m) throw bad('invalid before cursor')
      cts = Number(m[1]); crank = Number(m[2]); cid = Number(m[3])
    }
    // Strictly older than the cursor, per item type (event rank 1, message rank 0).
    const evCond = crank === 2 ? 'ts <= ?' : crank === 1 ? '(ts < ? OR (ts = ? AND id < ?))' : 'ts < ?'
    const evArgs = crank === 1 ? [cts, cts, cid] : [cts]
    const msgCond = crank === 0 ? '(created_at < ? OR (created_at = ? AND id < ?))' : 'created_at <= ?'
    const msgArgs = crank === 0 ? [cts, cts, cid] : [crank === 1 ? cts : cts]
    // Nothing from before the chat was cleared.
    const since = db.prepare('SELECT cleared_at FROM identities WHERE name = ?').get(session)?.cleared_at ?? 0
    const evs = db.prepare(`SELECT * FROM events WHERE session = ? AND kind != 'usage' AND ts > ? AND ${evCond} ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(session, since, ...evArgs, limit)
      .map(r => ({ ...eventView(r.id, r.session, r.ts, r.kind, JSON.parse(r.data), { stored: true }), t: 'event' }))
    // What this session could see (canSeeMessage): nothing from before its
    // identity was created (a name registered again starts empty), and in
    // groups only what came after it joined.
    const born = identityCreatedAt(session)
    // One ordered, indexed query per source (sent, received, each group),
    // each LIMITed, merged here: a page costs a page, not the whole history.
    const floor = Math.max(since + 1, born === Infinity ? Number.MAX_SAFE_INTEGER : born)
    // (Only ids and times per source; the rows themselves are read once, for the page.)
    const page = (where, ...args) => db.prepare(`SELECT id, created_at FROM messages WHERE ${where} AND created_at >= ? AND ${msgCond} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, floor, ...msgArgs, limit)
    const keys = [...page('from_name = ?', session), ...page('target = ?', session)]
    const inGroup = db.prepare(`SELECT id, created_at FROM messages WHERE target = ? AND from_name != ? AND created_at >= ? AND ${msgCond} ORDER BY created_at DESC, id DESC LIMIT ?`)
    for (const g of db.prepare('SELECT group_id, joined_at FROM group_members WHERE name = ?').all(session)) {
      keys.push(...inGroup.all(g.group_id, session, Math.max(floor, g.joined_at ?? 0), ...msgArgs, limit))
    }
    const seenIds = new Set()
    const ids = keys.filter(r => !seenIds.has(r.id) && seenIds.add(r.id))
      .sort((a, b) => b.created_at - a.created_at || b.id - a.id).slice(0, limit).map(r => r.id)
    const byId = db.prepare('SELECT * FROM messages WHERE id = ?')
    const msgs = ids.map(id => byId.get(id)).filter(Boolean)
      .map(r => ({ t: 'message', ts: r.created_at, ...messageView(r) }))
    const rank = x => (x.t === 'event' ? 1 : 0)
    const merged = [...evs, ...msgs]
      .sort((a, b) => b.ts - a.ts || rank(b) - rank(a) || b.id - a.id)
      .slice(0, limit)
    const last = merged[merged.length - 1]
    return {
      items: merged.reverse(),
      next_before: last ? `${last.ts}:${rank(last)}:${last.id}` : null,
      has_more: merged.length === limit,
    }
  },

  state() {
    return {
      server_time: now(),
      version: VERSION,
      sessions: db.prepare('SELECT name FROM identities ORDER BY name').all().map(r => sessionView(r.name)),
      hosts: listHosts(),
      groups: allGroups(),
    }
  },
  events(q) {
    const limit = Math.max(1, Math.min(Number(q.get('limit') ?? 300) || 300, 1000))
    const before = Number(q.get('before') ?? Number.MAX_SAFE_INTEGER)
    const session = q.get('session')
    const rows = session
      ? db.prepare('SELECT * FROM events WHERE session = ? AND id < ? ORDER BY id DESC LIMIT ?').all(session, before, limit)
      : db.prepare('SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
    return rows.reverse().map(r => eventView(r.id, r.session, r.ts, r.kind, JSON.parse(r.data), { stored: true }))
  },
  hosts() {
    return listHosts()
  },
  messages(q) {
    const limit = Math.max(1, Math.min(Number(q.get('limit') ?? 200) || 200, 1000))
    const before = Number(q.get('before') ?? Number.MAX_SAFE_INTEGER)
    const session = q.get('session')
    const rows = session
      ? db.prepare(`SELECT * FROM messages WHERE id < ? AND (from_name = ? OR target = ? OR target IN (SELECT group_id FROM group_members WHERE name = ?)) ORDER BY id DESC LIMIT ?`).all(before, session, session, session, limit)
      : db.prepare('SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
    return rows.reverse().map(messageView)
  },
}

// --- dashboard actions -------------------------------------------------------------

// Clear a session's chat: its own activity is deleted; squadra messages stay
// (they're also part of the other side's chat) but are hidden from this one.
function clearChat(name) {
  if (!identityExists(name)) throw bad('session not found')
  const at = now()
  db.prepare('DELETE FROM events WHERE session = ?').run(name)
  db.prepare('UPDATE identities SET cleared_at = ? WHERE name = ?').run(at, name)
  broadcast('cleared', { session: name, at })
  return { session: name, cleared_at: at }
}

// Delete a session from the server. Only while it's disconnected: a live
// session would just come back. Its messages stay in other sessions' chats.
function deleteSession(name, { requireOffline = true } = {}) {
  if (!identityExists(name)) throw bad('session not found')
  if (requireOffline && isOnline(name)) {
    throw new ApiError(409, `Conflict: "${name}" is connected; it can only be deleted when disconnected`, { parameters: { reason: 'session_online' } })
  }
  const groupsOf = db.prepare('SELECT group_id FROM group_members WHERE name = ?').all(name).map(r => r.group_id)
  db.prepare('DELETE FROM identities WHERE name = ?').run(name)
  db.prepare('DELETE FROM group_members WHERE name = ?').run(name)
  db.prepare('DELETE FROM group_invites WHERE name = ? OR invited_by = ?').run(name, name)
  for (const g of groupsOf) if (!db.prepare('SELECT 1 FROM group_members WHERE group_id = ?').get(g)) closeGroup(g); else handOverGroup(g, name)
  // Workers that pointed at it no longer do: a new session with this name
  // won't receive their notices.
  db.prepare('UPDATE identities SET coordinator = NULL WHERE coordinator = ?').run(name)
  db.prepare('DELETE FROM updates WHERE recipient = ?').run(name)
  // What it queued for others goes too (it may be why it was deleted).
  db.prepare('DELETE FROM updates WHERE sender = ?').run(name)
  db.prepare('DELETE FROM events WHERE session = ?').run(name)
  // Its attachments go too (they count against the server's total).
  for (const f of db.prepare('SELECT file_id, path FROM files WHERE owner = ?').all(name)) {
    try { rmSync(join(DATA_DIR, f.path), { force: true }) } catch {}
    db.prepare('DELETE FROM files WHERE file_id = ?').run(f.file_id)
  }
  dropLease(name)
  dropAnswer(name); servedUpTo.delete(name); lastTouched.delete(name); pushCount.delete(name)
  activity.delete(name)
  presence.delete(name)
  lastSessionKey.delete(name)
  const w = waiters.get(name)
  if (w) finishPoll(w, new ApiError(401, 'Unauthorized'))
  broadcast('session', { name, deleted: true })
  return { session: name, deleted: true }
}

// Archive: hide a disconnected session from the main views, keeping its history.
function setArchived(name, archived) {
  if (!identityExists(name)) throw bad('session not found')
  if (archived && isOnline(name)) {
    throw new ApiError(409, `Conflict: "${name}" is connected; it can only be archived when disconnected`, { parameters: { reason: 'session_online' } })
  }
  db.prepare('UPDATE identities SET archived_at = ? WHERE name = ?').run(archived ? now() : null, name)
  const view = sessionView(name)
  broadcast('session', view)
  return view
}

// Disconnect a session from the dashboard: its secret is replaced (and the
// new one thrown away), so whoever holds a copy of the old one is out for
// good. The session can then be archived or deleted; to use the name again,
// open it again from the dashboard on its machine, or delete it.
function kickSession(name) {
  if (!identityExists(name)) throw bad('session not found')
  const lease = leases.get(name)
  kickHolder(name)
  // What it had queued for others isn't delivered — dropped first, so the
  // notice that it left (queued as its own) still reaches its coordinator.
  db.prepare('DELETE FROM updates WHERE sender = ?').run(name)
  if (lease && !lease.downNotified) announceDown(name, 'logout')
  dropLease(name)
  register(name, true)
  broadcast('session', sessionView(name))
  process.stderr.write(`squadra-server: session "${name}" disconnected from the dashboard\n`)
  return sessionView(name)
}

const dashboardActions = {
  kick: p => kickSession(String(p.session ?? '')),
  clear: p => clearChat(String(p.session ?? '')),
  delete: p => deleteSession(String(p.session ?? '')),
  archive: p => setArchived(String(p.session ?? ''), true),
  unarchive: p => setArchived(String(p.session ?? ''), false),
  'hosts/enroll': (p, req) => createEnrollment(p, req),
  'hosts/rename': p => renameHost(String(p.host ?? ''), p.name),
  'hosts/remove': p => removeHost(String(p.host ?? '')),
  'hosts/folders': p => changeHostFolders(p),
  'terminals/open': p => openTerminalOn(p),
  'terminals/kill': p => killTerminalOn(p),
  'terminal/ticket': () => newTerminalTicket(),
}

// --- hosts: machines that open sessions for the dashboard ------------------------------
//
// A host is squadra-host running on a machine. It joins with a one-time code
// the dashboard generates (POST /host/enroll), gets its own secret, and keeps a
// WebSocket open to /host/connect. Through it the server can only ask for a
// session *spec* (name, role, folder, compact window) — the host validates it
// against its own local rules and always runs the same fixed command — and
// relay terminal output and keystrokes for the dashboard's web terminal.
//
// Sessions are never opened by Claude: only the dashboard (the user) can.

const ENROLL_TTL_MS = 15 * 60 * 1000
const HOST_REPLY_TIMEOUT_MS = 20_000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O, 1/I
const HOST_SCRIPT = [new URL('../host/squadra-host.mjs', import.meta.url), new URL('./squadra-host.mjs', import.meta.url)]
// The installers that prepare a machine and run squadra-host (install/ in
// the repository, or next to this file in the Docker image).
const INSTALLERS = { 'linux.sh': 'text/x-shellscript; charset=utf-8', 'macos.sh': 'text/x-shellscript; charset=utf-8', 'windows.bat': 'text/plain; charset=utf-8' }
const installer = name => cachedFile(new URL(`../install/${name}`, import.meta.url)) ?? cachedFile(new URL(`./install/${name}`, import.meta.url))
const hostScript = () => {
  for (const f of HOST_SCRIPT) {
    const c = cachedFile(f, body => ({ sha: createHash('sha256').update(body).digest('hex') }))
    if (c) return c
  }
  return null
}

const hostLinks = new Map() // host id -> { ws, info, connectedAt, pending: Map(req -> {resolve, reject, timer}), viewers: Map(term -> Set(viewer)) }
let hostReqSeq = 0

function hostRow(id) {
  return db.prepare('SELECT * FROM hosts WHERE id = ?').get(id)
}

function hostView(row) {
  const link = hostLinks.get(row.id)
  let info = null
  try { info = link?.info ?? JSON.parse(row.info ?? 'null') } catch {}
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    last_seen_at: link ? now() : row.last_seen_at,
    online: !!link,
    // Enrolled but never connected (it failed, or was never started).
    pending: !link && row.first_connected_at == null,
    connected_since: link?.connectedAt ?? null,
    enrollment: row.enrollment ?? null, // which "Add machine" code it used
    info,
  }
}

const listHosts = () => db.prepare('SELECT * FROM hosts ORDER BY name').all().map(hostView)

function broadcastHost(id) {
  const row = hostRow(id)
  broadcast('host', row ? hostView(row) : { id, removed: true })
}

function enrollCode() {
  const bytes = randomBytes(8)
  const chars = [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
  return `${chars.slice(0, 4)}-${chars.slice(4)}`
}

// Dashboard: a one-time code, valid 15 minutes, and the command to run on the machine.
function createEnrollment(p, req) {
  const name = String(p.name ?? '').trim()
  if (name && !/^[\p{L}\p{N} ._-]{1,40}$/u.test(name)) throw bad('the name may have letters, digits, spaces, dots, dashes and underscores (max 40)')
  const code = enrollCode()
  const t = now()
  db.prepare('DELETE FROM host_enrollments WHERE expires_at < ?').run(t)
  // (A random id, not derived from the code: the dashboard tells the machine
  // that used this very code from any other one that connects.)
  const ticket = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO host_enrollments (code_hash, name, created_at, expires_at, configure_plugin, ticket) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256(code), name, t, t + ENROLL_TTL_MS, p.configure_plugin === true ? 1 : 0, ticket)
  const base = serverBaseUrl(req)
  const q = s => `'${String(s).replace(/'/g, `'\\''`)}'` // always a single shell word
  // The command checks the program it downloads against this server's copy
  // (sha256sum on Linux, shasum on macOS) before running it.
  const sha = hostScript()?.sha ?? null
  const verify = sha ? ` && echo ${q(`${sha}  squadra-host.mjs`)} | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -)` : ''
  return {
    code,
    enrollment: ticket,
    expires_at: t + ENROLL_TTL_MS,
    server_url: base,
    sha256: sha,
    // The Squadra plugin release that goes with this server (squadra-host pins the same one).
    plugin_command: `claude plugin marketplace add roke22/Squadra#v${VERSION} && claude plugin install squadra@squadra`,
    // One command per system: the installer prepares the machine (tmux, Node,
    // Claude Code) and runs squadra-host with this code. (Windows: inside WSL.)
    install: {
      linux: `curl -fsSL ${q(`${base}/install/linux.sh`)} | bash -s -- ${q(base)} ${code}${sha ? ` --sha256 ${sha}` : ''}`,
      macos: `curl -fsSL ${q(`${base}/install/macos.sh`)} | bash -s -- ${q(base)} ${code}${sha ? ` --sha256 ${sha}` : ''}`,
      windows: `irm ${q(`${base}/install/windows.bat`)} -OutFile "$env:TEMP\\squadra-install.bat"; & "$env:TEMP\\squadra-install.bat" ${base} ${code}`,
    },
    // Just squadra-host, on a machine that already has what it needs.
    // Downloaded into a new private folder: nobody can swap the file between the check and the run.
    command: `cd "$(mktemp -d)" && curl -fsSLo squadra-host.mjs ${q(`${base}/host/squadra-host.mjs`)}${verify} && node squadra-host.mjs enroll ${q(base)} ${code}`,
  }
}

// The address hosts and plugins use: PUBLIC_URL, or what the browser used.
function serverBaseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL
  const fwd = h => (TRUST_PROXY ? String(req.headers[h] ?? '').split(',')[0].trim() : '')
  let proto = fwd('x-forwarded-proto') || (TLS ? 'https' : 'http')
  if (proto !== 'http' && proto !== 'https') proto = TLS ? 'https' : 'http'
  let host = String(req.headers.host ?? '') // never X-Forwarded-Host: set PUBLIC_URL behind a proxy
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host)) host = `127.0.0.1:${PORT}`
  return `${proto}://${host}`
}

// Host side: trade the code for a permanent secret. Public, rate-limited.
// The client's address. Behind a reverse proxy every request comes from the
// proxy, so with --trust-proxy the last X-Forwarded-For entry (the one the
// proxy itself added) is used.
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map(x => x.trim()).filter(Boolean)
    if (xff.length) return xff[xff.length - 1].slice(0, 64)
  }
  return req.socket.remoteAddress ?? '?'
}

// Enrollment attempts: 10 a minute per address (IPv6 per /64). There is no
// overall cap on purpose: anyone could use it to block real enrollments, and
// codes are 40 bits, single use and valid 15 minutes, so guessing one is out
// of reach even from many addresses.
const enrollAttempts = new Map() // ip -> timestamps
function checkEnrollRate(req) {
  const ip = ipKey(clientIp(req))
  const t = now()
  const recent = (enrollAttempts.get(ip) ?? []).filter(x => t - x < 60_000)
  if (recent.length >= 10) throw new ApiError(429, 'Too Many Requests: retry in a minute')
  recent.push(t)
  enrollAttempts.set(ip, recent)
}


setInterval(() => {
  const t = now()
  for (const [k, v] of enrollAttempts) if (!v.some(x => t - x < 60_000)) enrollAttempts.delete(k)
}, 60_000).unref()

function enrollHost(p, req) {
  const ip = clientIp(req)
  const t = now()
  const code = String(p.code ?? '').trim().toUpperCase()
  const row = db.prepare('SELECT * FROM host_enrollments WHERE code_hash = ?').get(sha256(code))
  if (!row || row.expires_at < t) {
    throw new ApiError(403, 'Forbidden: the code is wrong or has expired; generate a new one in the dashboard (Machines → + Add machine)')
  }
  db.prepare('DELETE FROM host_enrollments WHERE code_hash = ?').run(row.code_hash) // single use
  const id = `h_${randomBytes(8).toString('hex')}`
  const info = ownTerminals(sanitizeHostInfo(p.info), id)
  const secret = `sh_${randomBytes(32).toString('base64url')}`
  // The hostname comes from the machine: keep only the characters a name may have.
  const fromHost = String(info?.hostname ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40)
  const name = row.name || fromHost || id
  db.prepare('INSERT INTO hosts (id, name, secret_hash, created_at, last_seen_at, info, enrollment) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, uniqueHostName(name), sha256(secret), t, t, JSON.stringify(info), row.ticket ?? null)
  broadcastHost(id)
  process.stderr.write(`squadra-server: host "${hostRow(id).name}" (${id}) enrolled from ${ip}\n`)
  return {
    id, secret, name: hostRow(id).name,
    // The plugin's server address always; the join token only if the admin
    // asked for it (sessions opened from the dashboard don't need it: their
    // names are registered by the server).
    plugin: { url: serverBaseUrl(req), ...(row.configure_plugin ? { token: JOIN_TOKEN } : {}) },
  }
}

function uniqueHostName(name) {
  let candidate = name.slice(0, 40)
  for (let i = 2; db.prepare('SELECT 1 FROM hosts WHERE name = ?').get(candidate); i++) candidate = `${name.slice(0, 36)}-${i}`
  return candidate
}

// What a host says about itself is shown in the dashboard: keep it small and typed.
function sanitizeHostInfo(info) {
  if (!info || typeof info !== 'object') return null
  const str = (v, n = 200) => typeof v === 'string' ? cleanText(v.slice(0, n * 2)).slice(0, n) : null
  const terminals = (Array.isArray(info.terminals) ? info.terminals : []).slice(0, 64).map(t => ({
    id: str(t?.id, 40),
    // A terminal is shown by its session's name, which is its id (a machine
    // can't label one of its terminals as another machine's session).
    name: str(t?.id, 40),
    role: ['coordinator', 'worker', 'solo'].includes(t?.role) ? t.role : null,
    coordinator: str(t?.coordinator, 40),
    folder: str(t?.folder, 500),
    compact_window: Number.isInteger(t?.compact_window) ? t.compact_window : null,
    created_at: Number.isFinite(t?.created_at) ? t.created_at : null,
  })).filter(t => t.id && NAME_RE.test(t.id))
  return {
    hostname: str(info.hostname, 100),
    platform: str(info.platform, 40),
    arch: str(info.arch, 40),
    node: str(info.node, 40),
    tmux: str(info.tmux, 40),
    claude: str(info.claude, 80),
    version: str(info.version, 40),
    folders: (Array.isArray(info.folders) ? info.folders : []).slice(0, 50).map(f => str(f, 500)).filter(Boolean),
    home: str(info.home, 500),
    // (Older machines don't say: their folders are changed there only.)
    folders_from_dashboard: info.folders_from_dashboard === true,
    max_sessions: Number.isInteger(info.max_sessions) ? info.max_sessions : null,
    allow_input: info.allow_input !== false,
    plugin: info.plugin && typeof info.plugin === 'object'
      ? { installed: info.plugin.installed === true, enabled: info.plugin.enabled === true, version: str(info.plugin.version, 40) }
      : null,
    terminals,
  }
}

// A machine can only list sessions it opened: a name the server reserved for
// another machine is dropped from what it says it runs.
function ownTerminals(info, hostId) {
  if (!info) return info
  info.terminals = info.terminals.filter(t => {
    const owner = db.prepare('SELECT host_id FROM identities WHERE name = ?').get(t.id)?.host_id
    return !owner || owner === hostId
  })
  return info
}

// Ask a connected host for something and wait for its reply.
function askHost(id, msg) {
  const link = hostLinks.get(id)
  if (!link) {
    if (!hostRow(id)) throw bad('host not found')
    throw new ApiError(409, 'Conflict: that machine is not connected right now', { parameters: { reason: 'host_offline' } })
  }
  const req = ++hostReqSeq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      link.pending.delete(req)
      reject(new ApiError(504, 'Gateway Timeout: the machine did not answer in time'))
    }, HOST_REPLY_TIMEOUT_MS)
    link.pending.set(req, { resolve, reject, timer })
    link.ws.send(JSON.stringify({ ...msg, req }))
  })
}

function dropHostLink(hostId, link) {
  for (const p of link.pending.values()) { clearTimeout(p.timer); p.reject(new ApiError(502, 'Bad Gateway: the machine disconnected')) }
  link.pending.clear()
  for (const [term, set] of link.viewers) for (const v of set) { v.ws.send(JSON.stringify({ t: 'host_down', host: hostId, term })); v.attached.delete(`${hostId}\0${term}`) }
  link.viewers.clear()
}

function openHostLink(ws, req, row) {
  let link = null
  let hostId = null
  const hello = setTimeout(() => ws.close(4000, 'hello expected'), 10_000)
  // squadra-host pings every 25 s: a machine silent for 90 s is gone (it
  // crashed, slept or lost its network without closing), not online.
  let lastHeard = now()
  const alive = setInterval(() => { if (now() - lastHeard > 90_000) ws.close(4008, 'nothing heard for 90 seconds') }, 30_000)
  alive.unref?.()
  ws.onactivity = () => { lastHeard = now() }
  ws.onmessage = text => {
    lastHeard = now()
    let m
    try { m = JSON.parse(text) } catch {}
    if (!m || typeof m !== 'object' || Array.isArray(m)) return link ? undefined : ws.close(4000, 'hello expected')
    if (!link) {
      // (Authenticated when the socket was accepted: the hello carries its info.)
      if (m.t !== 'hello') return ws.close(4000, 'hello expected')
      // Disconnected from the dashboard meanwhile.
      if (!db.prepare('SELECT 1 FROM hosts WHERE id = ?').get(row.id)) return ws.close(4001, 'unknown or disconnected host')
      clearTimeout(hello)
      ws.maxMessage = 8 * 1024 * 1024 // terminal screens can be large (squadra-host keeps them under 2 MB)
      hostId = row.id
      // One live connection per host: the newest wins. The old one is cleaned
      // up first (its requests fail, its viewers are told).
      const old = hostLinks.get(hostId)
      if (old) { hostLinks.delete(hostId); dropHostLink(hostId, old); old.ws.close(4002, 'replaced by a newer connection') }
      // A hello without info: until the machine sends it (right after the
      // welcome), the last one known is shown.
      let known = null
      try { known = JSON.parse(row.info ?? 'null') } catch {}
      link = { ws, info: ownTerminals(sanitizeHostInfo(m.info ?? known), row.id), connectedAt: now(), pending: new Map(), viewers: new Map() }
      hostLinks.set(hostId, link)
      db.prepare('UPDATE hosts SET last_seen_at = ?, info = ?, first_connected_at = COALESCE(first_connected_at, ?) WHERE id = ?').run(now(), JSON.stringify(link.info), now(), hostId)
      ws.send(JSON.stringify({ t: 'welcome', host: { id: hostId, name: row.name } }))
      process.stderr.write(`squadra-server: host "${row.name}" connected from ${req.socket.remoteAddress}\n`)
      broadcastHost(hostId)
      return
    }
    switch (m.t) {
      case 'ping':
        // (Answered: the machine notices a server that silently went away.
        // Not to one that doesn't read its answers, and a few a minute.)
        if (ws.buffered > 64 * 1024) { ws.close(4008, 'not reading'); break }
        if (allow('hostping', hostId, 30)) ws.send(JSON.stringify({ t: 'pong' }))
        break
      case 'info':
        // squadra-host sends it when something changes: a machine sending
        // it nonstop is ignored (each one is a database write and a broadcast).
        if (!allow('hostinfo', hostId, 60)) break
        link.info = ownTerminals(sanitizeHostInfo(m.info), hostId)
        db.prepare('UPDATE hosts SET last_seen_at = ?, info = ? WHERE id = ?').run(now(), JSON.stringify(link.info), hostId)
        broadcastHost(hostId)
        break
      case 'reply': {
        const p = link.pending.get(m.req)
        if (!p) break
        link.pending.delete(m.req)
        clearTimeout(p.timer)
        // (Only text from the machine: anything else is its generic refusal.)
        const why = typeof m.error === 'string' ? m.error : 'refused by the machine'
        if (m.ok) p.resolve(m.result ?? true)
        else p.reject(new ApiError(400, `Bad Request: ${cleanText(why.slice(0, 1000)).slice(0, 500)}`, { parameters: { reason: 'machine_refused' } }))
        break
      }
      case 'screen': case 'out': case 'exit': case 'notice': {
        if (typeof m.term !== 'string') break
        const term = m.term
        const set = link.viewers.get(term)
        if (!set) break
        const withData = m.t === 'out' || m.t === 'screen' // only output carries data
        const out = JSON.stringify({ t: m.t, host: hostId, term, data: withData && typeof m.data === 'string' ? m.data : undefined, text: typeof m.text === 'string' ? cleanText(m.text.slice(0, 600)).slice(0, 300) : undefined })
        for (const v of set) {
          // A viewer that can't keep up misses output and gets a fresh screen later.
          if (v.ws.buffered > 4 * 1024 * 1024) { if (withData) v.stale = true; continue }
          // Caught up after missing output: ask the machine for a fresh screen.
          if (v.stale && v.ws.buffered < 1024 * 1024) { v.stale = false; link.ws.send(JSON.stringify({ t: 'refresh', term })) }
          v.ws.send(out)
        }
        if (m.t === 'exit') link.viewers.delete(term)
        break
      }
    }
  }
  ws.onclose = () => {
    clearTimeout(hello)
    clearInterval(alive)
    if (!link || hostLinks.get(hostId) !== link) return
    hostLinks.delete(hostId)
    dropHostLink(hostId, link)
    if (hostRow(hostId)) db.prepare('UPDATE hosts SET last_seen_at = ? WHERE id = ?').run(now(), hostId)
    process.stderr.write(`squadra-server: host ${hostId} disconnected\n`)
    broadcastHost(hostId)
  }
}

// Dashboard web terminal: one WebSocket per browser tab, authenticated with
// the server token in its first message, multiplexing every terminal it shows.
function openViewerLink(ws, req) {
  // (Authenticated when the socket was accepted, with a one-time ticket.)
  const viewer = { ws, attached: new Set(), typed: new Set() }
  ws.maxMessage = 1024 * 1024 // (an image pasted into a terminal; text is at most 64 KB)
  const detachAll = () => {
    for (const key of viewer.attached) {
      const [host, term] = key.split('\0')
      detach(host, term)
    }
    viewer.attached.clear()
  }
  function detach(host, term) {
    const link = hostLinks.get(host)
    const set = link?.viewers.get(term)
    if (!set) return
    set.delete(viewer)
    if (!set.size) { link.viewers.delete(term); link.ws.send(JSON.stringify({ t: 'detach', term })) }
  }
  const size = (c, r) => ({ cols: Math.floor(Math.max(20, Math.min(Number(c) || 120, 500))), rows: Math.floor(Math.max(5, Math.min(Number(r) || 36, 200))) })
  ws.onmessage = text => {
    let m
    try { m = JSON.parse(text) } catch {}
    if (!m || typeof m !== 'object' || Array.isArray(m)) return
    const host = String(m.host ?? '')
    const term = String(m.term ?? '')
    const key = `${host}\0${term}`
    const link = hostLinks.get(host)
    // A dashboard can't make a machine work nonstop: at most 300 terminal
    // messages every 10 seconds per dashboard socket.
    const t = now()
    viewer.msgTimes = (viewer.msgTimes ?? []).filter(x => t - x < 10_000)
    if (viewer.msgTimes.length >= 300) return
    viewer.msgTimes.push(t)
    if (m.t === 'attach') {
      if (!link) return ws.send(JSON.stringify({ t: 'host_down', host, term }))
      if (!NAME_RE.test(term)) return
      // Already watching it: a refresh at the new size, nothing else.
      if (viewer.attached.has(key)) return link.ws.send(JSON.stringify({ t: 'resize', term, ...size(m.cols, m.rows) })), link.ws.send(JSON.stringify({ t: 'refresh', term }))
      if (!link.viewers.has(term)) link.viewers.set(term, new Set())
      link.viewers.get(term).add(viewer)
      viewer.attached.add(key)
      process.stderr.write(`squadra-server: dashboard (${req.socket.remoteAddress}) is viewing "${term}" on host ${host}\n`)
      return link.ws.send(JSON.stringify({ t: 'attach', term, ...size(m.cols, m.rows) }))
    }
    if (!viewer.attached.has(key) || !link) return
    if (m.t === 'detach') { viewer.attached.delete(key); return detach(host, term) }
    if (m.t === 'resize') return link.ws.send(JSON.stringify({ t: 'resize', term, ...size(m.cols, m.rows) }))
    if (m.t === 'refresh') { viewer.stale = false; return link.ws.send(JSON.stringify({ t: 'refresh', term })) }
    if (m.t === 'in' && typeof m.data === 'string' && m.data.length <= 64 * 1024) {
      if (!viewer.typed.has(key)) {
        viewer.typed.add(key)
        process.stderr.write(`squadra-server: dashboard (${req.socket.remoteAddress}) is typing in "${term}" on host ${host}\n`)
      }
      return link.ws.send(JSON.stringify({ t: 'in', term, data: m.data }))
    }
    // An image pasted into the terminal: to the machine, which saves it and
    // pastes its path into Claude Code (a few a minute per terminal).
    if (m.t === 'image' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(m.type) && typeof m.data === 'string' && m.data.length <= 800_000) {
      if (!allow('paste-image', key, 20)) return ws.send(JSON.stringify({ t: 'notice', host, term, text: 'too many images pasted: wait a minute' }))
      return link.ws.send(JSON.stringify({ t: 'image', term, type: m.type, data: m.data }))
    }
  }
  ws.onclose = () => detachAll()
  ws.send(JSON.stringify({ t: 'ready' }))
}

function onUpgrade(req, socket, head) {
  // Node hands the socket over without its error listener: a client that
  // resets it after being refused must not raise an uncaught error.
  socket.on('error', () => {})
  // Nothing in a request can take the server down. An address that isn't
  // even a URL is the client's mistake: refused, not logged.
  try { upgrade(req, socket, head) } catch (err) {
    if (err?.code === 'ERR_INVALID_URL') return refuseSocket(socket, '400 Bad Request')
    logError(`bad upgrade request: ${err.message}`)
    try { socket.destroy() } catch {}
  }
}

// A refused upgrade (or bad request) is answered and then closed for good:
// end() alone leaves the socket half open as long as the client wants.
function refuseSocket(socket, status) {
  try { socket.end(`HTTP/1.1 ${status}\r\n\r\n`) } catch {}
  setTimeout(() => { try { socket.destroy() } catch {} }, 1000).unref()
}
function upgrade(req, socket, head) {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '')
  // squadra-host never sends an Origin: a browser page can't hold machine slots.
  if (path === '/host/connect' && req.headers.origin) { refuseSocket(socket, '403 Forbidden'); return }
  if (path !== '/host/connect' && path !== '/api/terminal') {
    refuseSocket(socket, '404 Not Found')
    return
  }
  // The dashboard's terminal socket only from the dashboard's own page (a
  // browser always sends Origin; squadra-host sends none).
  if (path === '/api/terminal' && req.headers.origin) {
    let ok = false
    try {
      const origin = new URL(req.headers.origin).host
      ok = origin === req.headers.host || (!!PUBLIC_URL && origin === new URL(PUBLIC_URL).host)
    } catch {}
    if (!ok) { refuseSocket(socket, '403 Forbidden'); return }
  }
  // Authenticated before the socket is accepted, so nobody without a
  // credential holds a connection open: the credential comes as a
  // subprotocol ("squadra", "auth.<credential>"). The dashboard's is a
  // one-time ticket (POST /api/terminal/ticket); a machine's is its secret.
  const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(x => x.trim())
  const cred = offered.find(x => x.startsWith('auth.'))?.slice('auth.'.length) ?? ''
  // (Credentials are random, 192 bits or more: a wrong one costs one lookup.)
  const refuse = (status, text) => refuseSocket(socket, `${status} ${text}`)
  if (!offered.includes('squadra') || !cred) {
    // squadra-host older than 0.0.2 (it sent its secret in a message): it is
    // told why, in the close reason it prints, and the log says so (once a
    // minute at most). The socket is closed at once.
    if (path === '/host/connect' && req.headers.upgrade?.toLowerCase() === 'websocket') {
      if (allow('old-host-log', 'all', 1)) process.stderr.write(`squadra-server: a squadra-host older than 0.0.2 tried to connect from ${req.socket.remoteAddress}: update it (see the README)\n`)
      const old = acceptWebSocket(req, socket, head, { log: logError, maxMessage: 1024 })
      old?.close(4426, 'this squadra-host is older than the server (0.0.2): update it: add the machine again from the dashboard (+ Add machine)')
      return
    }
    return refuse(426, 'Upgrade Required')
  }
  let host = null
  if (path === '/host/connect') {
    host = db.prepare('SELECT * FROM hosts WHERE secret_hash = ?').get(sha256(cred))
    // A machine reconnecting nonstop would write to the database and update
    // every dashboard each time: at most 30 connections a minute.
    if (host && !allow('hosthello', host.id, 30)) return refuse(429, 'Too Many Requests')
  } else if (!takeTerminalTicket(cred)) return refuse(401, 'Unauthorized')
  const ws = acceptWebSocket(req, socket, head, { log: logError, maxMessage: 16 * 1024, protocol: 'squadra' })
  if (!ws) return
  // A machine that was disconnected is told so (and stops), at once.
  if (path === '/host/connect' && !host) { ws.close(4001, 'unknown or disconnected host'); return }
  wsClients.add(ws)
  if (path === '/host/connect') openHostLink(ws, req, host)
  else openViewerLink(ws, req)
  const handler = ws.onclose
  ws.onclose = () => { wsClients.delete(ws); handler() }
}

// One-time tickets for the dashboard's terminal socket (a browser can't send
// an Authorization header on a WebSocket): 30 seconds, used once.
const terminalTickets = new Map() // ticket -> expires (ms)
function newTerminalTicket() {
  for (const [t, exp] of terminalTickets) if (exp < Date.now()) terminalTickets.delete(t)
  if (terminalTickets.size >= 100) terminalTickets.delete(terminalTickets.keys().next().value)
  const ticket = randomBytes(24).toString('base64url')
  terminalTickets.set(ticket, Date.now() + 30_000)
  return { ticket }
}
function takeTerminalTicket(ticket) {
  const exp = ticket ? terminalTickets.get(ticket) : undefined
  if (exp === undefined) return false
  terminalTickets.delete(ticket)
  return exp >= Date.now()
}
const wsClients = new Set()

function removeHost(id) {
  const row = hostRow(id)
  if (!row) throw bad('host not found')
  db.prepare('UPDATE identities SET host_id = NULL WHERE host_id = ?').run(id) // no longer "opened from the dashboard"
  db.prepare('DELETE FROM hosts WHERE id = ?').run(id)
  hostLinks.get(id)?.ws.close(4001, 'this machine was disconnected from the dashboard')
  broadcast('host', { id, removed: true })
  process.stderr.write(`squadra-server: host "${row.name}" (${id}) removed from the dashboard\n`)
  return { id, removed: true }
}

function renameHost(id, name) {
  name = String(name ?? '').trim()
  if (!/^[\p{L}\p{N} ._-]{1,40}$/u.test(name)) throw bad('the name may have letters, digits, spaces, dots, dashes and underscores (max 40)')
  if (!hostRow(id)) throw bad('host not found')
  if (db.prepare('SELECT 1 FROM hosts WHERE name = ? AND id != ?').get(name, id)) throw bad(`another machine is already called "${name}"`)
  db.prepare('UPDATE hosts SET name = ? WHERE id = ?').run(name, id)
  broadcastHost(id)
  return hostView(hostRow(id))
}

// Open a session on a host. The spec is passed through as-is: the host is the
// one that validates it (its rules are local and the server can't widen them).
// Here we only refuse names already taken by a connected session.
// The name is reserved here, for this machine: the server registers it and
// hands its secret to the machine with the spec, so nobody holding the join
// token can grab the name first. A name registered by some other session is
// refused (delete that session in the dashboard to free it).
// Allow or remove a folder on a machine: the machine checks it against its
// own rules (and may keep its folders to itself) and answers with its list.
async function changeHostFolders(p) {
  const id = String(p.host ?? '')
  const action = p.action === 'add' || p.action === 'remove' ? p.action : null
  if (!action) throw bad('action must be add or remove')
  const path = typeof p.path === 'string' ? p.path.trim() : ''
  if (!path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) throw bad('a folder path is needed')
  const r = await askHost(id, { t: 'folders', action, path })
  return { folders: (Array.isArray(r?.folders) ? r.folders : []).slice(0, 50).filter(f => typeof f === 'string').map(f => cleanText(f.slice(0, 1000)).slice(0, 500)) }
}

async function openTerminalOn(p) {
  const id = String(p.host ?? '')
  const spec = p.spec && typeof p.spec === 'object' && !Array.isArray(p.spec) ? { ...p.spec } : null
  if (!spec) throw bad('spec is required')
  delete spec.identity
  const name = String(spec.name ?? '')
  if (!NAME_RE.test(name)) throw bad('name must match [A-Za-z0-9_-]{1,32}')
  if (!hostLinks.has(id)) return askHost(id, { t: 'open', spec }) // reports host_offline / not found
  if (holdsName(name, leases.get(name))) {
    throw new ApiError(409, `Conflict: a session named "${name}" is already connected`, { parameters: { reason: 'name_in_use' } })
  }
  const existing = db.prepare('SELECT host_id FROM identities WHERE name = ?').get(name)
  if (existing && existing.host_id !== id) {
    throw new ApiError(409, `Conflict: the name "${name}" is already registered by another session; pick another name, or delete that session in the dashboard`, { parameters: { reason: 'name_taken' } })
  }
  // Already running there (its plugin just not connected right now), or
  // being opened right now (a second click, another tab): its secret is left
  // alone, and the machine would refuse a second one anyway.
  const key = `${id}\0${name}`
  if (hostLinks.get(id)?.info?.terminals?.some(t => t.id === name) || opening.has(key)) {
    throw new ApiError(409, `Conflict: a session named "${name}" is already open on that machine`, { parameters: { reason: 'open_on_host' } })
  }
  opening.set(key, now())
  let timedOut = false
  try { return await openNow(id, name, spec, existing) } catch (err) {
    timedOut = err instanceof ApiError && err.code === 504
    throw err
  } finally {
    // (Kept a little after a timeout only: the machine may still be opening it.
    // Once it answered, yes or no, the name is free to try again.)
    if (timedOut) setTimeout(() => opening.delete(key), 15_000).unref?.()
    else opening.delete(key)
  }
}
const opening = new Map() // "host\0name" -> since: an open in progress
async function openNow(id, name, spec, existing) {
  let created = false
  // The role it was opened with (the dashboard trusts that one, not whatever
  // the session claims later).
  const openedRole = spec.role === 'coordinator' || spec.role === 'solo' ? spec.role : 'worker'
  if (!existing) {
    spec.identity = register(name, false).secret
    db.prepare('UPDATE identities SET host_id = ?, opened_role = ? WHERE name = ?').run(id, openedRole, name)
    created = true
  } else {
    // Already this machine's name, and not connected: a new secret goes with
    // it, so the session can log in even if the last one never arrived (or
    // the session was disconnected from the dashboard).
    dropLease(name)
    spec.identity = register(name, true).secret
    db.prepare('UPDATE identities SET opened_role = ? WHERE name = ?').run(openedRole, name)
  }
  try {
    const result = await askHost(id, { t: 'open', spec })
    process.stderr.write(`squadra-server: opened session "${name}" on host ${id}\n`)
    return result
  } catch (err) {
    // Only when the machine said no: after a timeout it may still open the
    // session, and the name must stay reserved for it.
    if (created && err instanceof ApiError && err.code === 400) db.prepare('DELETE FROM identities WHERE name = ? AND host_id = ?').run(name, id)
    throw err
  }
}

async function killTerminalOn(p) {
  const id = String(p.host ?? '')
  const term = String(p.term ?? '')
  if (!NAME_RE.test(term)) throw bad('invalid session')
  return askHost(id, { t: 'kill', term })
}

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let nginx/caddy buffer it
  })
  res.write(`event: hello\ndata: ${JSON.stringify(dashboard.state())}\n\n`)
  sseClients.add(res)
  req.on('close', () => sseClients.delete(res))
}

function sendJson(res, status, body) {
  if (res.writableEnded) return
  const data = JSON.stringify(body)
  // (Never cached: answers carry messages and session state.)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(data)
}

// Error lines in the log: at most 60 a minute in all (a client that keeps
// causing them can't fill the disk), and how many were left out.
let errorsDropped = 0
function logError(text) {
  if (!allow('error-log', 'all', 60)) { errorsDropped++; return }
  if (errorsDropped) { process.stderr.write(`squadra-server: (${errorsDropped} more errors not logged)\n`); errorsDropped = 0 }
  process.stderr.write(`squadra-server: ${text}\n`)
}
function sendError(res, err) {
  if (err instanceof ApiError) {
    sendJson(res, err.code, { ok: false, error_code: err.code, description: err.message, ...(err.extra ?? {}) })
  } else if (err instanceof RangeError || err instanceof URIError || err?.code === 'ERR_INVALID_URL' ||
    (err instanceof TypeError && /primitive value|toPrimitive/.test(err.message))) {
    // A parameter that can't even be read (nested a thousand times, an object
    // where text was expected…): the client's mistake, not worth a stack trace.
    sendJson(res, 400, { ok: false, error_code: 400, description: 'Bad Request: invalid parameters' })
  } else {
    logError(`internal error: ${err?.stack ?? err}`)
    sendJson(res, 500, { ok: false, error_code: 500, description: 'Internal Server Error' })
  }
}

// Request body, up to `max` bytes. A client that stops sending for 30 s is
// cut off (requests have no overall timeout, for long polls and uploads).
const BODY_IDLE_MS = 30_000
// Bodies are held in memory while they arrive: a whole body within a
// deadline (a minute; uploads: one per 64 KB/s, at least a minute), and
// what goes past each body's first 64 KB at most BODY_BYTES_IN_FLIGHT across
// the server, so slow senders can't pile up — while small bodies (every
// poll, every message) never wait on big ones. Requests anyone can send
// (enrollment, registration) have their own small pool and a short deadline.
const BODY_BYTES_IN_FLIGHT = 256 * 1024 * 1024
const bodyPools = {
  main: { bytes: 0, cap: BODY_BYTES_IN_FLIGHT, free: 64 * 1024 },
  // (A registration's body, at most 4 KB, never counts: enrollments can't block it.)
  public: { bytes: 0, cap: 4 * 1024 * 1024, free: 4096, deadline: 10_000 },
}
// An upload, straight to its file: the same limits as readBody (size, idle
// time, overall deadline), without holding it in memory. Returns its size.
function readBodyToFile(req, max, path) {
  return new Promise((resolve, reject) => {
    let fd
    try { fd = openSync(path, 'wx', 0o600) } catch (err) { reject(err); return }
    let size = 0
    let done = false
    let idle = null
    const finish = ok => {
      if (done) return false
      done = true
      clearTimeout(idle); clearTimeout(deadline)
      try { closeSync(fd) } catch {}
      if (!ok) rmSync(path, { force: true })
      return true
    }
    const fail = err => { if (finish(false)) { reject(err); req.destroy() } }
    const deadline = setTimeout(() => fail(new ApiError(408, 'Request Timeout')), Math.max(60_000, Math.ceil(max / 65_536) * 1000))
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => fail(new ApiError(408, 'Request Timeout')), BODY_IDLE_MS) }
    arm()
    req.on('data', c => {
      if (done) return
      arm()
      size += c.length
      if (size > max) return fail(new ApiError(413, `Request Entity Too Large (max ${max} bytes)`))
      try { writeSync(fd, c) } catch (err) { fail(err) }
    })
    req.on('end', () => { if (finish(true)) resolve(size) })
    req.on('error', () => { if (finish(false)) reject(new ApiError(400, 'Bad Request: connection closed')) })
    req.on('close', () => { if (finish(false)) reject(new ApiError(400, 'Bad Request: connection closed')) })
  })
}

// A request for a held name without the holder's session id. With no id at
// all it is most likely a plugin older than 0.0.2: said so.
const notHolder = (name, inst) => inst
  ? new ApiError(409, `Conflict: "${name}" is connected from another session`, { parameters: { reason: 'name_in_use' } })
  : new ApiError(409, `Conflict: "${name}" is connected, and this request has no session id: update the Squadra plugin (0.0.2 or later) on that machine`, { parameters: { reason: 'name_in_use' } })
function readBody(req, max, { pool: poolName = 'main' } = {}) {
  const pool = bodyPools[poolName]
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > max) {
      reject(new ApiError(413, `Request Entity Too Large (max ${max} bytes)`))
      req.destroy()
      return
    }
    const chunks = []
    let size = 0
    let idle = null
    let done = false
    let counted = 0
    const finish = () => { if (done) return false; done = true; clearTimeout(idle); clearTimeout(deadline); pool.bytes -= counted; return true }
    const fail = err => { if (finish()) { reject(err); req.destroy() } }
    const deadline = setTimeout(() => fail(new ApiError(408, 'Request Timeout')), pool.deadline ?? Math.max(60_000, Math.ceil(max / 65_536) * 1000))
    const arm = () => {
      clearTimeout(idle)
      idle = setTimeout(() => fail(new ApiError(408, 'Request Timeout')), BODY_IDLE_MS)
    }
    arm()
    req.on('data', c => {
      if (done) return
      arm()
      size += c.length
      const count = Math.max(0, size - pool.free) - counted
      counted += count
      pool.bytes += count
      if (size > max) return fail(new ApiError(413, `Request Entity Too Large (max ${max} bytes)`))
      if (pool.bytes > pool.cap) return fail(new ApiError(503, 'Service Unavailable: the server is busy receiving other requests; retry'))
      chunks.push(c)
    })
    req.on('end', () => { if (finish()) resolve(Buffer.concat(chunks)) })
    // (A client that drops the connection mid-body is its own business, not an internal error.)
    req.on('error', () => { if (finish()) reject(new ApiError(400, 'Bad Request: connection closed')) })
    req.on('close', () => { if (finish()) reject(new ApiError(400, 'Bad Request: connection closed')) })
  })
}

// A session's requests still sending their body: at most 8 at a time. While
// a session holds the name, requests without its session id (a copy of the
// secret) have their own 2, so they can never use up the holder's.
const bodiesInFlight = new Map()
async function readParamsAs(name, req, url) {
  const lease = leases.get(name)
  const other = lease && String(req.headers['x-squadra-instance'] ?? '') !== lease.instance
  const key = other ? `${name}\0other` : name
  const n = bodiesInFlight.get(key) ?? 0
  if (n >= (other ? 2 : 8)) throw new ApiError(429, 'Too Many Requests: too many requests still sending their body')
  bodiesInFlight.set(key, n + 1)
  try { return await readParams(req, url) } finally {
    const m = (bodiesInFlight.get(key) ?? 1) - 1
    if (m > 0) bodiesInFlight.set(key, m); else bodiesInFlight.delete(key)
  }
}

// Request parameters: query string plus a JSON object body. A plain object
// with no prototype, and only the body's own keys: "__proto__" and friends
// can't make a parameter appear that wasn't sent.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
async function readParams(req, url, max = MAX_JSON_BODY, opts) {
  const params = Object.create(null)
  for (const [k, v] of url.searchParams) if (!RESERVED_KEYS.has(k)) params[k] = v
  if (req.method === 'POST') {
    const buf = await readBody(req, max, opts)
    if (buf.length) {
      let body
      try { body = JSON.parse(buf.toString('utf8')) } catch { throw bad('body is not valid JSON') }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be a JSON object')
      for (const k of Object.keys(body)) if (!RESERVED_KEYS.has(k)) params[k] = body[k]
    }
  }
  return params
}

const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined)

function bearer(req) {
  const h = req.headers.authorization ?? ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

const sameSecret = (token, secret) => typeof token === 'string' && token !== '' &&
  timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(sha256(secret)))
const isServerToken = token => sameSecret(token, SERVER_TOKEN)
const isJoinToken = token => sameSecret(token, JOIN_TOKEN)

// A new join token: machines configured with the old one can no longer
// register new names (their existing identities keep working).
function rotateJoinToken() {
  if (process.env.SQUADRA_JOIN_TOKEN) throw new ApiError(409, 'Conflict: the join token comes from SQUADRA_JOIN_TOKEN; change it there')
  JOIN_TOKEN = `sj_${randomBytes(24).toString('hex')}`
  JOIN_TOKEN_SOURCE = JOIN_TOKEN_FILE
  writeFileSync(JOIN_TOKEN_FILE, JOIN_TOKEN + '\n', { mode: 0o600 })
  process.stderr.write('squadra-server: join token rotated\n')
  return { join_token: JOIN_TOKEN }
}

// Every request: at most 32 answers waiting on one connection (requests
// piled up without reading the answers), and a connection whose request
// body never finishes arriving is closed shortly after it was answered
// (an early refusal doesn't read it; trickled bytes would keep it open).
const inFlightBySocket = new WeakMap()
function guardRequest(req, res) {
  const sock = req.socket
  const n = (inFlightBySocket.get(sock) ?? 0) + 1
  inFlightBySocket.set(sock, n)
  res.once('close', () => inFlightBySocket.set(sock, (inFlightBySocket.get(sock) ?? 1) - 1))
  if (n > 32) { sock.destroy(); return false }
  res.once('finish', () => {
    if (req.complete) return
    const t = setTimeout(() => { if (!req.complete) sock.destroy() }, 2000)
    t.unref?.()
    req.once('end', () => clearTimeout(t))
  })
  return true
}

async function handle(req, res) {
  if (!guardRequest(req, res)) return
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (path === '/health') return sendJson(res, 200, { ok: true, result: 'ok', version: VERSION })

    // Dashboard page: public HTML; it asks for the server token and sends it
    // with every /api call.
    if (req.method === 'GET' && (path === '/' || path === '/ui')) {
      const page = cachedFile(UI_FILE, body => ({ headers: pageHeaders(body) }))
      if (!page) throw new ApiError(404, 'Not Found')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.body.length, 'Cache-Control': 'no-store', ...page.headers })
      return res.end(page.body)
    }
    // The web terminal (xterm.js), served from here rather than a CDN.
    if (req.method === 'GET' && Object.hasOwn(VENDOR_FILES, path)) {
      const [file, type] = VENDOR_FILES[path]
      const f = cachedFile(new URL(file, import.meta.url))
      if (!f) throw new ApiError(404, 'Not Found')
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': f.body.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' })
      return res.end(f.body)
    }

    // squadra-host: the program itself (public, like the dashboard page) and enrollment.
    if (req.method === 'GET' && path === '/host/squadra-host.mjs') {
      const f = hostScript()
      if (!f) throw new ApiError(404, 'Not Found')
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': f.body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      return res.end(f.body)
    }
    if (req.method === 'GET' && path.startsWith('/install/') && Object.hasOwn(INSTALLERS, path.slice('/install/'.length))) {
      const f = installer(path.slice('/install/'.length))
      if (!f) throw new ApiError(404, 'Not Found')
      res.writeHead(200, { 'Content-Type': INSTALLERS[path.slice('/install/'.length)], 'Content-Length': f.body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      return res.end(f.body)
    }
    if (path === '/host/enroll') {
      if (req.method !== 'POST') throw new ApiError(405, 'Method Not Allowed')
      checkEnrollRate(req)
      return sendJson(res, 200, { ok: true, result: enrollHost(await readParams(req, url, 64 * 1024, { pool: 'public' }), req) })
    }

    const token = bearer(req)

    if (path.startsWith('/api/')) {
      if (!token || !isServerToken(token)) throw new ApiError(401, 'Unauthorized')
      const what = path.slice('/api/'.length)
      if (req.method === 'POST') {
        const act = own(dashboardActions, what)
        if (!act) throw new ApiError(404, 'Not Found')
        return sendJson(res, 200, { ok: true, result: await act(await readParams(req, url), req) })
      }
      if (req.method !== 'GET') throw new ApiError(405, 'Method Not Allowed')
      if (what === 'stream') return openStream(req, res)
      const fn = own(dashboard, what)
      if (!fn) throw new ApiError(404, 'Not Found')
      return sendJson(res, 200, { ok: true, result: fn(url.searchParams) })
    }

    // Registration: the join token registers new names; the server token can
    // also rotate an existing name's secret (reset).
    if (path === '/register') {
      const admin = isServerToken(token)
      if (!admin && !isJoinToken(token)) throw new ApiError(401, 'Unauthorized')
      // New names: 10 a minute per address and 60 overall, and a cap in all,
      // so per-session budgets can't be multiplied by registering more names.
      if (!admin && (!allow('register-ip', ipKey(clientIp(req)), 10) || !allow('register', 'all', 60))) {
        throw new ApiError(429, 'Too Many Requests: retry in a minute')
      }
      if (!admin && db.prepare('SELECT COUNT(*) AS n FROM identities').get().n >= MAX_IDENTITIES) {
        throw new ApiError(403, `Forbidden: this server already has ${MAX_IDENTITIES} sessions; delete some in the dashboard (or raise SQUADRA_MAX_SESSIONS)`)
      }
      const params = await readParams(req, url, admin ? MAX_JSON_BODY : 4096, admin ? undefined : { pool: 'public' })
      if (params.reset === true && !admin) {
        throw new ApiError(403, 'Forbidden: only the server (admin) token can rotate an existing identity; delete the session from the dashboard and register it again, or ask the admin')
      }
      return sendJson(res, 200, { ok: true, result: register(params.name, admin && params.reset === true) })
    }
    // Admin: server token only.
    if (path.startsWith('/admin/')) {
      if (!isServerToken(token)) throw new ApiError(401, 'Unauthorized')
      const fn = own(adminMethods, path.slice('/admin/'.length))
      if (!fn) throw new ApiError(404, 'Not Found: method not found')
      const params = await readParams(req, url)
      return sendJson(res, 200, { ok: true, result: fn(params) })
    }

    // Everything else: identity secret.
    const name = identityFromSecret(token)
    if (!name) throw new ApiError(401, 'Unauthorized')
    // Once a session holds this name, only that session (its instance id,
    // which the plugin keeps in memory) can act as it: a copy of
    // identity.json alone can't speak for a coordinator. Another session can
    // only take the name over by claiming it once the holder is gone.
    const lease = leases.get(name)
    // (claim, poll and release check the instance themselves.)
    if (lease && path !== '/claimSession' && path !== '/getUpdates' && path !== '/releaseSession') {
      const inst = String(req.headers['x-squadra-instance'] ?? '')
      if (inst !== lease.instance) throw notHolder(name, inst)
    }
    touch(name)

    if (req.method === 'GET' && path.startsWith('/file/')) {
      readLimit(name, 'download')
      let rel
      try { rel = decodeURIComponent(path.slice('/file/'.length)) } catch { throw new ApiError(404, 'Not Found') }
      const f = db.prepare('SELECT * FROM files WHERE path = ?').get(rel)
      if (!f || !canSeeFile(name, f.file_id)) throw new ApiError(404, 'Not Found')
      spendStorage('download', name, f.size, 2 * 1024 ** 3) // at most 2 GB of downloads an hour
      const full = join(DATA_DIR, f.path)
      const st = statSync(full)
      res.writeHead(200, {
        'Content-Type': f.mime ?? 'application/octet-stream',
        'Content-Length': st.size,
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'attachment',
      })
      createReadStream(full).on('error', () => res.destroy()).pipe(res)
      return
    }

    // Checked again once the body has arrived: a request that started before
    // its session was disconnected, deleted or taken over by another session
    // doesn't act after it.
    const stillValid = () => {
      if (identityFromSecret(token) !== name) throw new ApiError(401, 'Unauthorized')
      const l = leases.get(name)
      if (l && path !== '/claimSession' && path !== '/getUpdates' && path !== '/releaseSession' &&
        String(req.headers['x-squadra-instance'] ?? '') !== l.instance) {
        throw notHolder(name, String(req.headers['x-squadra-instance'] ?? ''))
      }
    }
    const method = path.slice(1)
    if (method === 'sendDocument' || method === 'sendPhoto') {
      if (req.method !== 'POST') throw new ApiError(405, 'Method Not Allowed')
      const msg = await upload(name, method === 'sendPhoto' ? 'photo' : 'document', url.searchParams, req, stillValid)
      return sendJson(res, 200, { ok: true, result: msg })
    }
    if (method === 'getUpdates') {
      const params = await readParamsAs(name, req, url)
      stillValid()
      return getUpdates(name, params, res)
    }
    const fn = own(methods, method)
    if (!fn) throw new ApiError(404, 'Not Found: method not found')
    const params = await readParamsAs(name, req, url)
    stillValid()
    // A claim comes with its session id in the header too, like every later
    // request: a plugin that doesn't send it (older than 0.0.2) would claim
    // the name and then fail at everything — it is told now instead.
    if (method === 'claimSession' && String(req.headers['x-squadra-instance'] ?? '') !== String(params.instance ?? '')) {
      throw notHolder(name, String(req.headers['x-squadra-instance'] ?? ''))
    }
    return sendJson(res, 200, { ok: true, result: fn(name, params) })
  } catch (err) {
    sendError(res, err)
  }
}

// Data stored by a version before 0.0.2 was cleaned with older rules (or
// none): cleaned again once, here, in batches, resuming where it stopped if
// the server is stopped meanwhile, and saying how far it got.
db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)')
const metaGet = k => db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v
const metaSet = (k, v) => db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(k, String(v))
function recleanOnce(key, table, select, fix) {
  if (metaGet(`${key}_done`)) return
  // (The row id under its own name: in a table whose primary key is an
  // INTEGER, "rowid" would come back named after that key instead.)
  const page = db.prepare(`SELECT rowid AS rid_, ${select} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 1000`)
  const saved = Number(metaGet(`${key}_last`))
  let last = Number.isSafeInteger(saved) && saved > 0 ? saved : 0, done = 0
  for (;;) {
    const rows = page.all(last)
    if (!rows.length) break
    inTx(() => { for (const r of rows) fix(r); last = rows[rows.length - 1].rid_; metaSet(`${key}_last`, last) })
    done += rows.length
    if (done % 50_000 < 1000) process.stderr.write(`squadra-server: cleaning ${table} stored by an older version: ${done} done…\n`)
  }
  metaSet(`${key}_done`, now())
}
{
  const upd = db.prepare('UPDATE events SET data = ?, ts = ? WHERE id = ?')
  recleanOnce('events_cleaned_v2', 'events', 'id, kind, ts, data', r => {
    let data
    try { data = JSON.stringify(cleanEvent(r.kind, JSON.parse(r.data))) } catch { data = '{}' }
    // (Whole milliseconds: the history cursor relies on it.)
    const ts = Math.round(Number(r.ts) || 0)
    if (data !== r.data || ts !== r.ts) upd.run(data, ts, r.id)
  })
}
{
  const upd = db.prepare('UPDATE messages SET text = ? WHERE id = ?')
  recleanOnce('messages_cleaned_v2', 'messages', 'id, text', r => {
    if (typeof r.text === 'string') { const t = cleanText(r.text); if (t !== r.text) upd.run(t, r.id) }
  })
  const updFile = db.prepare('UPDATE files SET name = ?, mime = ? WHERE file_id = ?')
  recleanOnce('files_cleaned_v2', 'files', 'file_id, name, mime', r => {
    const name = typeof r.name === 'string' ? cleanText(r.name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file' : r.name
    const mime = uploadMime(r.mime)
    if (name !== r.name || mime !== r.mime) updFile.run(name, mime, r.file_id)
  })
  const updReaction = db.prepare('UPDATE reactions SET emoji = ? WHERE rowid = ?')
  recleanOnce('reactions_cleaned_v2', 'reactions', 'emoji', r => {
    if (typeof r.emoji === 'string') { const e = cleanText(r.emoji.slice(0, 64)).slice(0, 16); if (e !== r.emoji) updReaction.run(e, r.rid_) }
  })
  const updHost = db.prepare('UPDATE hosts SET info = ? WHERE id = ?')
  recleanOnce('hosts_cleaned_v2', 'hosts', 'id, info', r => {
    let info = null
    try { info = JSON.stringify(ownTerminals(sanitizeHostInfo(JSON.parse(r.info ?? 'null')), r.id)) } catch {}
    if (info !== r.info) updHost.run(info, r.id)
  })
  // Updates queued before senders were recorded: whose they are, from the
  // message they carry (so a delete or a kick removes them too).
  if (!metaGet('updates_sender_v2')) {
    db.exec(`UPDATE updates SET sender = COALESCE(json_extract(payload, '$.message.from.id'), json_extract(payload, '$.edited_message.from.id'), json_extract(payload, '$.message_reaction.user.id')) WHERE sender IS NULL`)
    metaSet('updates_sender_v2', now())
  }
}

// Rebuild each session's derived state from the stored events (last 24h).
for (const r of db.prepare('SELECT * FROM events ORDER BY id').iterate()) {
  applyEvent(r.session, eventView(r.id, r.session, r.ts, r.kind, JSON.parse(r.data), { stored: true }))
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const servers = []

function startupBanner(scheme) {
  nowServing()
  const everywhere = HOST === '0.0.0.0' || HOST === '::'
  const url = PUBLIC_URL || `${scheme}://${everywhere ? '<this-machine-ip>' : HOST}:${PORT}`
  const lines = [
    `squadra-server v${VERSION}: listening on ${scheme}://${HOST}:${PORT}${everywhere ? ' (all interfaces)' : ''} (data: ${DATA_DIR})`,
    '',
    `  Server token — admin: signs in to the dashboard. Keep it in the browser only (${TOKEN_SOURCE}):`,
    `    ${SERVER_TOKEN}`,
    '',
    `  Join token — for machines: registers new sessions, nothing else (${JOIN_TOKEN_SOURCE}).`,
    '  Configure each machine from Claude Code with:',
    `    /squadra:configure ${url} ${JOIN_TOKEN}`,
    `  Dashboard: ${url}/`,
  ]
  if (TRUST_PROXY && !PUBLIC_URL) {
    lines.push('', '  ⚠️  --trust-proxy without --public-url: set the public address so enrollment commands',
      '      and machines use it (forwarded Host headers are never trusted for that).')
  }
  if (!TLS && !PUBLIC_URL && !everywhere && LOOPBACK.has(HOST)) {
    lines.push('', '  Only reachable from this machine. To serve your domain over HTTPS, start with',
      '  --domain your-domain (automatic Let\'s Encrypt certificate). See --help.')
  }
  if (!TLS && !LOOPBACK.has(HOST) && !PUBLIC_URL.startsWith('https://')) {
    lines.push('', '  ⚠️  Listening beyond this machine over plain HTTP: the server token, session secrets and',
      '      everything the dashboard shows travel unencrypted. Use --domain (built-in HTTPS),',
      '      a TLS reverse proxy (see deploy/), or a private network such as Tailscale.')
  }
  process.stderr.write(lines.join('\n') + '\n\n')
}

// Connections per address: at most 256 at once, room for several machines
// behind one NAT with many sessions each (behind a trusted proxy all come
// from it, so then none is counted). A connection idle for 2 minutes is
// closed (long polls answer within 50 s, the dashboard's stream pings every
// 20 s, and WebSockets turn this off for themselves).
const connectionsByIp = new Map()
function listen(srv, port, host) {
  // A malformed request only closes its own connection.
  srv.on('clientError', (err, socket) => refuseSocket(socket, '400 Bad Request'))
  srv.timeout = 120_000
  srv.on('connection', socket => {
    if (TRUST_PROXY) return
    const ip = ipKey(socket.remoteAddress)
    const n = (connectionsByIp.get(ip) ?? 0) + 1
    connectionsByIp.set(ip, n)
    socket.once('close', () => { const m = (connectionsByIp.get(ip) ?? 1) - 1; if (m > 0) connectionsByIp.set(ip, m); else connectionsByIp.delete(ip) })
    if (n > 256) {
      // (Said in the log, at most once a minute: behind a tunnel or proxy
      // without --trust-proxy every client shares one address.)
      if (allow('conn-cap-log', 'all', 1)) process.stderr.write(`squadra-server: ${ip} has 256 connections open: refusing more (behind a reverse proxy or tunnel? start with --trust-proxy)\n`)
      socket.destroy()
    }
  })
  return new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(port, host, () => { srv.off('error', reject); resolve() })
  })
}

function failListen(err, port) {
  const hint = err.code === 'EACCES' && port < 1024
    ? ` Ports below 1024 need privileges: run as root, grant it with "sudo setcap cap_net_bind_service=+ep $(command -v node)", or use Docker with -p ${port}:${port}.`
    : err.code === 'EADDRINUSE' ? ' Something else is already using that port.' : ''
  process.stderr.write(`squadra-server: cannot listen on port ${port}: ${err.message}.${hint}\n`)
  process.exit(1)
}

function httpsServer(creds) {
  const srv = createHttpsServer({ key: creds.key, cert: creds.cert }, handle)
  srv.requestTimeout = 0 // long polls and big uploads manage their own limits
  srv.on('upgrade', onUpgrade)
  servers.push(srv)
  return srv
}

// A bug reached by some request must not take the whole server down: logged.
// (Rate limited like every error line: nothing a client causes fills the disk.
// Set before any server starts, also while waiting for a certificate.)
process.on('uncaughtException', err => logError(`uncaught: ${err?.stack ?? err}`))
process.on('unhandledRejection', err => logError(`unhandled rejection: ${err?.stack ?? err}`))

if (TLS_MODE === 'http') {
  const srv = createHttpServer(handle)
  srv.requestTimeout = 0
  srv.on('upgrade', onUpgrade)
  servers.push(srv)
  listen(srv, PORT, HOST).then(() => startupBanner('http'), err => failListen(err, PORT))
} else if (TLS_MODE === 'files') {
  const read = () => ({ key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) })
  let creds
  try { creds = read() } catch (err) {
    process.stderr.write(`squadra-server: cannot read the certificate: ${err.message}\n`)
    process.exit(2)
  }
  const srv = httpsServer(creds)
  listen(srv, PORT, HOST).then(() => startupBanner('https'), err => failListen(err, PORT))
  // Renewed by certbot or similar: pick the new files up without restarting.
  for (const f of [TLS_CERT, TLS_KEY]) {
    watchFile(f, { interval: 60_000 }, () => {
      try { srv.setSecureContext(read()); process.stderr.write('squadra-server: certificate reloaded\n') }
      catch (err) { process.stderr.write(`squadra-server: certificate reload failed: ${err.message}\n`) }
    }).unref?.()
  }
} else {
  // Automatic certificate. Port 80 answers ACME challenges and redirects
  // everything else to HTTPS; HTTPS starts as soon as a certificate is ready.
  const acme = createAcme({
    domain: DOMAIN,
    email: ACME_EMAIL,
    directory: ACME_DIRECTORY,
    dir: join(DATA_DIR, 'tls'),
    log: m => process.stderr.write(`squadra-server: ${m}\n`),
  })
  const challengeServer = createHttpServer((req, res) => {
    if (!guardRequest(req, res)) return
    const m = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(req.url ?? '')
    if (m) {
      const answer = acme.challenge(m[1])
      res.writeHead(answer ? 200 : 404, { 'Content-Type': 'text/plain' })
      return res.end(answer ?? 'not found')
    }
    res.writeHead(301, { Location: `${PUBLIC_URL}${req.url ?? '/'}` })
    res.end()
  })
  servers.push(challengeServer)
  await listen(challengeServer, HTTP_PORT, HOST).catch(err => failListen(err, HTTP_PORT))

  let https = null
  const obtain = async () => {
    for (let attempt = 1; ; attempt++) {
      try { return await acme.ensureCertificate() } catch (err) {
        const delay = Math.min(60_000 * attempt, 30 * 60_000)
        process.stderr.write(`squadra-server: could not get a certificate for ${DOMAIN}: ${err.message}\n` +
          `  Check that the domain's DNS points to this machine and that port ${HTTP_PORT} is reachable from the internet. Retrying in ${delay / 60_000} min.\n`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  // A stored certificate that is still valid is served right away, even if
  // it is due for renewal: renewing (below) must not keep HTTPS down while
  // the certificate authority can't be reached.
  const kept = acme.storedCertificate()
  const creds = kept && Date.now() < kept.expires - 60_000 ? kept : await obtain()
  https = httpsServer(creds)
  await listen(https, PORT, HOST).catch(err => failListen(err, PORT))
  startupBanner('https')
  if (creds === kept && Date.now() >= kept.renewAt) {
    acme.ensureCertificate().then(c => { if (c.renewed) { https.setSecureContext({ key: c.key, cert: c.cert }); process.stderr.write('squadra-server: certificate renewed\n') } },
      err => process.stderr.write(`squadra-server: certificate renewal failed (will retry): ${err.message}\n`))
  }
  // Check twice a day; renew 30 days before expiry and swap it in live.
  setInterval(async () => {
    try {
      const c = await acme.ensureCertificate()
      if (c.renewed) { https.setSecureContext({ key: c.key, cert: c.cert }); process.stderr.write('squadra-server: certificate renewed\n') }
    } catch (err) {
      process.stderr.write(`squadra-server: certificate renewal failed (will retry): ${err.message}\n`)
    }
  }, 12 * 60 * 60 * 1000).unref()
}

// Ctrl+C / SIGTERM: close right away. Dashboards keep a stream open (and
// reconnect), sessions keep a long poll open, and browsers keep idle
// keep-alive sockets: don't wait for any of them.
let stopping = false
function shutdown(signal) {
  if (stopping) {
    process.stderr.write('squadra-server: forced exit\n')
    process.exit(1)
  }
  stopping = true
  process.stderr.write(`\nsquadra-server: ${signal} received, shutting down…\n`)
  for (const w of [...waiters.values()]) finishPoll(w, null, [])
  for (const res of sseClients) { try { res.end() } catch {} }
  sseClients.clear()
  for (const ws of wsClients) ws.close(1001, 'server shutting down')
  for (const srv of servers) { srv.close(); srv.closeAllConnections?.() }
  try { db.close() } catch {}
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
