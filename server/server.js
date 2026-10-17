#!/usr/bin/env node
/**
 * squadra-server — the "Telegram" for Squadra.
 *
 * A small subset of the Telegram Bot API, shaped closely enough that Squadra
 * plugin is a near-copy of the official Telegram channel plugin. Every Claude
 * Code session is an identity (a "bot" that also acts as a "user" for others).
 *
 * Auth has two levels:
 *   - SQUADRA_SERVER_TOKEN: needed to register identities and for admin calls.
 *   - Identity secret: returned once by /register; every other call uses it.
 *     The sender of a message is always derived from the secret, never from
 *     a request field, so a session can't impersonate another.
 *
 * Only Node built-ins: node:http, node:sqlite (Node >= 22.13).
 */

import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, createReadStream, rmSync, statSync } from 'node:fs'
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
//                        (behind a TLS reverse proxy); only used to print the right setup command
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

mkdirSync(join(DATA_DIR, 'files'), { recursive: true })

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
`)

// Additive migrations for databases created by earlier versions.
for (const [table, column, type] of [
  ['identities', 'role', 'TEXT'],          // coordinator | worker, set at login
  ['identities', 'coordinator', 'TEXT'],   // a worker's coordinator
  ['messages', 'system', 'INTEGER NOT NULL DEFAULT 0'], // notices generated by the server
  ['identities', 'cleared_at', 'INTEGER'], // dashboard: the session's chat was cleared at (ms)
  ['identities', 'archived_at', 'INTEGER'], // dashboard: archived (hidden from the main views) at (ms)
  ['groups', 'owner', 'TEXT'],
  ['identities', 'host_id', 'TEXT'],       // the machine that opened it from the dashboard (its name is reserved for it)             // who created the group (null: created before groups were private)
]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
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
    // A rotated identity must not keep a stale poller alive.
    const w = waiters.get(name)
    if (w) finishPoll(w, conflict())
  } else {
    db.prepare('INSERT INTO identities (name, secret_hash, created_at) VALUES (?, ?, ?)').run(name, sha256(secret), now())
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

function touch(name) {
  db.prepare('UPDATE identities SET last_seen_at = ? WHERE name = ?').run(now(), name)
}

// --- users / chats / messages as Telegram-shaped objects ----------------------

const userObj = name => ({ id: name, is_bot: false, first_name: name, username: name })

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
    if (r) msg.reply_to_message = messageObj(r, { withReply: false })
  }
  return msg
}

// A message is visible to whoever sent it, received it, or is in its group —
// and only from that identity's creation on: a name deleted and registered
// again doesn't inherit the old one's history.
const identityCreatedAt = name => db.prepare('SELECT created_at FROM identities WHERE name = ?').get(name)?.created_at ?? Infinity
function canSeeMessage(name, row) {
  if (row.created_at < identityCreatedAt(name)) return false
  if (row.from_name === name || row.target === name) return true
  return row.target.startsWith('#') && !!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND name = ?').get(row.target, name)
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
  const a = String(ip ?? '?').replace(/^::ffff:/, '')
  return a.includes(':') ? a.split(':').slice(0, 4).join(':') + '::/64' : a
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

function pushUpdate(recipient, payload) {
  db.prepare('INSERT INTO updates (recipient, payload, created_at) VALUES (?, ?, ?)').run(recipient, JSON.stringify(payload), now())
  const w = waiters.get(recipient)
  if (w) {
    const updates = readUpdates(recipient, w.offset, w.limit)
    if (updates.length) finishPoll(w, null, updates)
  }
}

function readUpdates(recipient, offset, limit) {
  return db.prepare('SELECT update_id, payload FROM updates WHERE recipient = ? AND update_id >= ? ORDER BY update_id LIMIT ?')
    .all(recipient, offset, limit)
    .map(r => ({ update_id: r.update_id, ...JSON.parse(r.payload) }))
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
  const offset = Number(params.offset ?? 0)
  const limit = Math.max(1, Math.min(Number(params.limit ?? 100), 100))
  const timeout = Math.max(0, Math.min(Number(params.timeout ?? 0), POLL_MAX_TIMEOUT_S))

  // Session lease: if the plugin identifies its session (instance), only the
  // session holding the name may poll. Plugins that don't send an instance
  // get the plain Telegram behaviour below.
  const instance = params.instance != null ? String(params.instance) : null
  if (instance) checkLease(name, instance)

  // Like Telegram: an offset confirms every update below it.
  if (offset > 0) db.prepare('DELETE FROM updates WHERE recipient = ? AND update_id < ?').run(name, offset)

  // Newest poller wins; the previous one gets 409, exactly like Telegram.
  // (With leases, both pollers belong to the same session.)
  const prev = waiters.get(name)
  if (prev) finishPoll(prev, conflict())

  const updates = readUpdates(name, offset, limit)
  if (updates.length || timeout === 0) {
    markPolled(name)
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

function storeMessage(from, target, { text, replyTo, fileId, fileKind, system = false }) {
  if (text != null && typeof text !== 'string') throw bad('text must be a string')
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
  const recipients = recipientsOf(target, from)
  const offline = recipients.filter(r => !isOnline(r)).map(r => ({
    name: r,
    last_seen_at: presenceOf(r).last_seen_at,
    queued: roleOf(r) !== 'worker',
  }))
  const dropped = offline.filter(o => !o.queued)
  if (!system && !target.startsWith('#') && dropped.length) {
    const o = dropped[0]
    throw new ApiError(403, `Forbidden: "${o.name}" is a worker and is not connected right now; the message was not sent`,
      { parameters: { reason: 'recipient_offline', name: o.name, last_seen_at: o.last_seen_at } })
  }
  const info = db.prepare('INSERT INTO messages (from_name, target, text, reply_to, file_id, file_kind, created_at, system) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(from, target, text ?? null, reply, fileId ?? null, fileKind ?? null, now(), system ? 1 : 0)
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid)
  const msg = messageObj(row)
  broadcast('message', messageView(row))
  const skip = new Set(dropped.map(o => o.name))
  for (const r of recipients) if (!skip.has(r)) pushUpdate(r, { message: msg })
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
const STR = max => v => (typeof v === 'string' ? v.slice(0, max) : undefined)
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

function eventView(rowId, session, ts, kind, data) {
  const { id: ref, ...rest } = cleanEvent(kind, data)
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
    case 'text': if (a.state !== 'waiting') set('working'); break
    case 'usage':
      a.context_tokens = ev.context_tokens
      if (ev.model) a.model = ev.model
      if (ev.compact_at) { a.compact_at = ev.compact_at; a.context_window = ev.context_window; a.context_pct = ev.context_pct }
      break
    case 'notification':
      if (['permission_prompt', 'elicitation_dialog', 'agent_needs_input', 'elicitation_url_dialog'].includes(ev.type)) { a.waiting = ev.text; set('waiting') }
      else if (ev.type === 'idle_prompt') set('idle')
      break
    case 'stop': a.tool = null; set('idle'); break
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
function observeBudget(name, n) {
  const t = now()
  const recent = (observeLog.get(name) ?? []).filter(x => t - x.t < 60_000)
  const events = recent.reduce((sum, x) => sum + x.n, 0)
  if (recent.length >= 120 || events + n > 3000) throw new ApiError(429, 'Too Many Requests: observation rate limit', { parameters: { retry_after: 10 } })
  recent.push({ t, n })
  observeLog.set(name, recent)
}

function observe(name, p) {
  const events = Array.isArray(p.events) ? p.events : null
  if (!events || events.length > 200) throw bad('events must be an array of at most 200 items')
  observeBudget(name, events.length)
  const insert = db.prepare('INSERT INTO events (session, ts, kind, data) VALUES (?, ?, ?, ?)')
  let stored = 0
  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || !EVENT_KINDS.has(ev.kind)) continue
    const ts = Number.isFinite(ev.ts) ? Math.min(ev.ts, now() + 5000) : now()
    const kind = ev.kind
    const rest = cleanEvent(kind, ev)
    const data = JSON.stringify(rest)
    if (data.length > MAX_EVENT_JSON) continue
    const info = insert.run(name, ts, kind, data)
    const view = eventView(Number(info.lastInsertRowid), name, ts, kind, rest)
    const before = activityOf(name)
    const wasWarned = !!before.context_warned
    applyEvent(name, view)
    contextNotices(name, view, wasWarned)
    broadcast('event', view)
    stored++
  }
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
    return { ...userObj(name), is_bot: true }
  },

  sendMessage(name, p) {
    rateLimit(name)
    const target = resolveTarget(p.chat_id, name)
    return storeMessage(name, target, {
      text: p.text,
      replyTo: p.reply_to_message_id ?? p.reply_parameters?.message_id,
    })
  },

  editMessageText(name, p) {
    rateLimit(name)
    const id = Number(p.message_id)
    if (typeof p.text !== 'string' || !p.text) throw bad('text is required')
    if (p.text.length > MAX_TEXT) throw bad(`message is too long (max ${MAX_TEXT} chars)`)
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
    // Server notices carry the worker's name but are the server's words: not editable.
    if (!row || row.system || row.from_name !== name || row.target !== String(p.chat_id)) throw bad('message to edit not found')
    if (row.file_id) throw bad('there is no text in the message to edit')
    if (row.text === p.text) throw bad('message is not modified')
    db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(p.text, now(), id)
    const msg = messageObj(db.prepare('SELECT * FROM messages WHERE id = ?').get(id))
    for (const r of recipientsOf(row.target, name)) pushUpdate(r, { edited_message: msg })
    return msg
  },

  setMessageReaction(name, p) {
    rateLimit(name)
    const id = Number(p.message_id)
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
    // You can react to messages you received: DMs addressed to you, or groups you're in.
    if (!row || row.from_name === name || !canSeeMessage(name, row)) throw bad('message not found')
    const reaction = Array.isArray(p.reaction) ? p.reaction : []
    const emoji = typeof reaction[0]?.emoji === 'string' ? reaction[0].emoji.slice(0, 16) : null
    if (emoji) {
      db.prepare('INSERT OR REPLACE INTO reactions (message_id, from_name, emoji, created_at) VALUES (?, ?, ?, ?)').run(id, name, emoji, now())
    } else {
      db.prepare('DELETE FROM reactions WHERE message_id = ? AND from_name = ?').run(id, name)
    }
    if (row.from_name !== name) {
      pushUpdate(row.from_name, {
        message_reaction: {
          chat: chatFor(row.target, name),
          message_id: id,
          user: userObj(name),
          date: unix(now()),
          old_reaction: [],
          new_reaction: emoji ? [{ type: 'emoji', emoji }] : [],
        },
      })
    }
    return true
  },

  sendChatAction(name, p) {
    resolveTarget(p.chat_id, name)
    const action = ['typing', 'upload_document', 'upload_photo'].includes(p.action) ? p.action : 'typing'
    chatActions.set(`${name}->${p.chat_id}`, { action, at: now() })
    return true
  },

  getFile(name, p) {
    const f = fileRow(String(p.file_id ?? ''))
    if (!f || !canSeeFile(name, f.file_id)) throw bad('wrong file_id or the file is temporarily unavailable')
    return { file_id: f.file_id, file_unique_id: f.file_unique_id, file_size: f.size, file_path: f.path }
  },

  // A session claims its name before polling. First come, first served: while
  // the session holding the name is online, any other session is refused.
  claimSession(name, p) {
    if (!allow('claim', name, 20)) throw new ApiError(429, 'Too Many Requests: retry in a minute')
    const instance = String(p.instance ?? '')
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(instance)) throw bad('instance is required')
    const lease = leases.get(name)
    if (lease && lease.instance !== instance && isOnline(name)) {
      if (p.force !== true) throw nameInUse(name, lease)
      // Forced takeover: the current holder is told on its next poll.
      kickHolder(name)
    }
    const role = p.role === 'coordinator' ? 'coordinator' : p.role === 'worker' ? 'worker' : null
    const coordinator = role === 'worker' && NAME_RE.test(String(p.coordinator ?? '')) ? String(p.coordinator) : null
    if (role) db.prepare('UPDATE identities SET role = ?, coordinator = ? WHERE name = ?').run(role, coordinator, name)
    // An archived session that logs in again is active again.
    if (db.prepare('UPDATE identities SET archived_at = NULL WHERE name = ? AND archived_at IS NOT NULL').run(name).changes) {
      setImmediate(() => broadcast('session', sessionView(name)))
    }
    if (!lease || lease.instance !== instance) leases.set(name, { instance, since: now(), downNotified: false })
    markPolled(name) // a claim is a sign of life: don't let the down sweep fire before the first poll
    return { name, role, since: unix(leases.get(name).since) }
  },

  // reason: 'logout' (the user left) or 'exit' (Claude Code is closing).
  releaseSession(name, p) {
    if (!allow('release', name, 20)) throw new ApiError(429, 'Too Many Requests: retry in a minute')
    const lease = leases.get(name)
    if (lease && lease.instance === String(p.instance ?? '')) {
      if (!lease.downNotified) announceDown(name, p.reason === 'exit' ? 'exit' : 'logout')
      leases.delete(name)
      const w = waiters.get(name)
      if (w) finishPoll(w, null, [])
      presence.set(name, { ...(presence.get(name) ?? {}), lastPollAt: now(), disconnected: true, pollingSince: null })
    }
    return true
  },

  // Groups are private: whoever creates one owns it, and others join only
  // after a member invites them (inviteToGroup).
  joinGroup(name, p) {
    rateLimit(name)
    const id = String(p.chat_id ?? '')
    if (!GROUP_RE.test(id)) throw bad('group id must look like #name')
    const members = () => db.prepare('SELECT name FROM group_members WHERE group_id = ? ORDER BY name').all(id).map(r => r.name)
    const ownerOf = () => db.prepare('SELECT owner FROM groups WHERE id = ?').get(id)?.owner ?? null
    // Not just "true": whether this created the group, who owns it and who is in
    // it, so a session can tell if someone set the group up before it.
    if (db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND name = ?').get(id, name)) return { created: false, owner: ownerOf(), members: members() }
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id)
    let created = false
    if (!group) {
      db.prepare('INSERT INTO groups (id, created_at, owner) VALUES (?, ?, ?)').run(id, now(), name)
      created = true
    } else if (!db.prepare('SELECT 1 FROM group_invites WHERE group_id = ? AND name = ?').get(id, name)) {
      throw new ApiError(403, `Forbidden: ${id} is private; a member has to invite "${name}" first`, { parameters: { reason: 'not_invited' } })
    }
    db.prepare('INSERT OR IGNORE INTO group_members (group_id, name) VALUES (?, ?)').run(id, name)
    db.prepare('DELETE FROM group_invites WHERE group_id = ? AND name = ?').run(id, name)
    return { created, owner: created ? name : ownerOf(), members: members() }
  },

  inviteToGroup(name, p) {
    rateLimit(name)
    const id = String(p.chat_id ?? '')
    const who = String(p.name ?? '')
    if (!GROUP_RE.test(id)) throw bad('group id must look like #name')
    if (!NAME_RE.test(who) || !identityExists(who)) throw bad('no session with that name')
    if (!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND name = ?').get(id, name)) {
      throw new ApiError(403, `Forbidden: not a member of ${id}`)
    }
    db.prepare('INSERT OR IGNORE INTO group_invites (group_id, name, invited_by, created_at) VALUES (?, ?, ?, ?)').run(id, who, name, now())
    return true
  },

  leaveChat(name, p) {
    const id = String(p.chat_id ?? '')
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND name = ?').run(id, name)
    // The last one out closes the group (it can be created again from scratch).
    if (!db.prepare('SELECT 1 FROM group_members WHERE group_id = ?').get(id)) db.prepare('DELETE FROM groups WHERE id = ?').run(id)
    return true
  },

  getChat(name, p) {
    const id = String(p.chat_id ?? '')
    if (id.startsWith('#')) {
      const members = db.prepare('SELECT name FROM group_members WHERE group_id = ?').all(id).map(r => r.name)
      if (!members.includes(name)) throw bad('chat not found')
      return { id, type: 'group', title: id, members }
    }
    const ident = db.prepare('SELECT created_at FROM identities WHERE name = ?').get(id)
    if (!ident) throw bad('chat not found')
    const a = activity.get(id)
    return {
      id, type: 'private', username: id, created_at: unix(ident.created_at), ...presenceOf(id),
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

// Leases: which session (plugin instance) holds each name. In memory: after a
// server restart the first session to poll claims its name again.
const leases = new Map() // name -> { instance, since }

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
    leases.set(name, { instance, since: now() }) // e.g. after a server restart
    return
  }
  if (lease.instance === instance) {
    // Same session polling again after we announced it down (network blip).
    if (lease.downNotified) {
      lease.downNotified = false
      announce(name, `🔌 ${name} is back online (same session).`)
    }
    return
  }
  if (isOnline(name)) {
    throw new ApiError(409, `Conflict: name "${name}" was taken over by another session`, { parameters: { reason: 'taken_over' } })
  }
  leases.set(name, { instance, since: now(), downNotified: false }) // previous holder is gone
}

// --- down notices ---------------------------------------------------------------
//
// When a worker leaves (logout), its Claude Code closes, or it stops polling
// (crash, lost network), its coordinator gets one notice from the server. The
// worker's undelivered messages are dropped and listed, so they never turn up
// later as stale work.

function announce(worker, text) {
  const row = db.prepare('SELECT role, coordinator FROM identities WHERE name = ?').get(worker)
  if (row?.role !== 'worker' || !row.coordinator || !identityExists(row.coordinator)) return
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
  // Drop what the worker never picked up.
  const pending = db.prepare('SELECT update_id, payload FROM updates WHERE recipient = ? ORDER BY update_id').all(worker)
  db.prepare('DELETE FROM updates WHERE recipient = ?').run(worker)
  const lost = pending
    .map(u => JSON.parse(u.payload).message)
    .filter(m => m && !m.squadra_notice)
    // Quoted as data: this text was written by the sender, not by the server.
    .map(m => `${JSON.stringify((m.text ?? m.caption ?? '(attachment)').replace(/\s+/g, ' ').slice(0, 120))} (written by ${m.from.id})`)
  const what = {
    logout: `🔌 ${worker} left Squadra (logout).`,
    exit: `🔌 ${worker} disconnected: its Claude Code session was closed.`,
    lost: `⚠️ ${worker} is DOWN: it stopped responding (lost connection or its machine went down).`,
  }[reason]
  const parts = [what]
  if (lost.length) parts.push(`It never picked up ${lost.length} message(s), which were dropped: ${lost.join('; ')}.`)
  parts.push('If it had a task in progress, it will not finish it: consider reassigning it to another active worker.')
  announce(worker, parts.join(' '))
}

// Leases whose holder stopped polling without releasing (crash, lost network).
function sweepLeases() {
  for (const [name, lease] of leases) {
    if (!lease.downNotified && !isOnline(name)) announceDown(name, 'lost')
  }
}
setInterval(sweepLeases, 3000).unref()

function markPolled(name) {
  const p = presence.get(name)
  presence.set(name, { pollingSince: p && !p.disconnected && p.pollingSince ? p.pollingSince : now(), lastPollAt: now(), disconnected: false })
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

// Upload: raw body, params in the query string (sendDocument / sendPhoto).
const uploadsInFlight = new Map() // name -> { n, bytes }
async function upload(name, kind, query, req) {
  rateLimit(name)
  const target = resolveTarget(query.get('chat_id'), name)
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
  flight.n++; flight.bytes += declared
  uploadsInFlight.set(name, flight)
  let buf
  try {
    buf = await readBody(req, Math.min(declared, MAX_FILE_BYTES))
  } finally {
    flight.n--; flight.bytes -= declared
    if (!flight.n) uploadsInFlight.delete(name)
  }
  if (buf.length === 0) throw bad('file is empty')
  const ext = (extname(fileName).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin')
  const fileId = `f_${randomBytes(12).toString('base64url')}`
  const uniqueId = randomBytes(6).toString('hex')
  const rel = `files/${fileId}${ext}`
  writeFileSync(join(DATA_DIR, rel), buf)
  const realKind = kind === 'photo' && PHOTO_EXTS.has(ext) ? 'photo' : 'document'
  db.prepare('INSERT INTO files (file_id, file_unique_id, path, name, mime, size, owner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(fileId, uniqueId, rel, fileName, req.headers['content-type'] && req.headers['content-type'] !== 'application/octet-stream' ? String(req.headers['content-type']) : null, buf.length, name, now())
  return storeMessage(name, target, {
    text: query.get('caption') || null,
    replyTo: query.get('reply_to_message_id'),
    fileId,
    fileKind: realKind,
  })
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
    return db.prepare('SELECT id FROM groups ORDER BY id').all().map(g => ({
      id: g.id,
      members: db.prepare('SELECT name FROM group_members WHERE group_id = ?').all(g.id).map(r => r.name),
    }))
  },
}

// --- maintenance -------------------------------------------------------------

function cleanup() {
  const t = now()
  db.prepare('DELETE FROM updates WHERE created_at < ?').run(t - UPDATE_TTL_MS)
  for (const f of db.prepare('SELECT file_id, path FROM files WHERE created_at < ?').all(t - FILE_TTL_MS)) {
    try { rmSync(join(DATA_DIR, f.path), { force: true }) } catch {}
    db.prepare('DELETE FROM files WHERE file_id = ?').run(f.file_id)
  }
  db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE created_at < ?)').run(t - MESSAGE_TTL_MS)
  db.prepare('DELETE FROM messages WHERE created_at < ?').run(t - MESSAGE_TTL_MS)
  db.prepare('DELETE FROM events WHERE ts < ?').run(t - EVENT_TTL_MS)
  for (const [k, v] of chatActions) if (t - v.at > 10_000) chatActions.delete(k)
  for (const [k, v] of sendLog) if (!v.some(x => t - x < 60_000)) sendLog.delete(k)
  for (const [k, v] of observeLog) if (!v.some(x => t - x.t < 60_000)) observeLog.delete(k)
}
setInterval(cleanup, 10 * 60 * 1000).unref()
cleanup()

// --- http --------------------------------------------------------------------

// --- dashboard (server token) ------------------------------------------------------

function sessionView(name) {
  const row = db.prepare('SELECT name, role, coordinator, created_at, archived_at, cleared_at FROM identities WHERE name = ?').get(name)
  if (!row) return { name, deleted: true }
  const a = activityOf(name)
  return {
    name,
    role: row.role ?? null,
    coordinator: row.coordinator ?? null,
    archived_at: row.archived_at ?? null,
    cleared_at: row.cleared_at ?? null,
    ...presenceOf(name),
    activity: { ...a, tool: a.tool ? { ...a.tool } : null },
  }
}

function messageView(row) {
  const f = fileRow(row.file_id)
  return {
    id: row.id,
    from: row.from_name,
    target: row.target,
    text: row.text != null ? (row.text.length > 4000 ? `${row.text.slice(0, 4000)}…` : row.text) : null,
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
setInterval(() => {
  if (sseClients.size === 0) return
  for (const { name } of db.prepare('SELECT name FROM identities').all()) {
    const v = sessionView(name)
    const key = `${v.online}|${v.role}|${v.coordinator}|${v.pending_updates}|${v.archived_at}`
    if (lastSessionKey.get(name) !== key) {
      lastSessionKey.set(name, key)
      broadcast('session', v)
    }
  }
}, 2000).unref()
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
    const limit = Math.max(1, Math.min(Number(q.get('limit') ?? 150), 500))
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
      .map(r => ({ ...eventView(r.id, r.session, r.ts, r.kind, JSON.parse(r.data)), t: 'event' }))
    const msgs = db.prepare(`SELECT * FROM messages WHERE (from_name = ? OR target = ? OR target IN (SELECT group_id FROM group_members WHERE name = ?)) AND created_at > ? AND ${msgCond} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(session, session, session, since, ...msgArgs, limit)
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
      groups: db.prepare('SELECT id FROM groups ORDER BY id').all().map(g => ({
        id: g.id,
        members: db.prepare('SELECT name FROM group_members WHERE group_id = ?').all(g.id).map(r => r.name),
      })),
    }
  },
  events(q) {
    const limit = Math.max(1, Math.min(Number(q.get('limit') ?? 300), 1000))
    const before = Number(q.get('before') ?? Number.MAX_SAFE_INTEGER)
    const session = q.get('session')
    const rows = session
      ? db.prepare('SELECT * FROM events WHERE session = ? AND id < ? ORDER BY id DESC LIMIT ?').all(session, before, limit)
      : db.prepare('SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
    return rows.reverse().map(r => eventView(r.id, r.session, r.ts, r.kind, JSON.parse(r.data)))
  },
  hosts() {
    return listHosts()
  },
  messages(q) {
    const limit = Math.max(1, Math.min(Number(q.get('limit') ?? 200), 1000))
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
  db.prepare('DELETE FROM identities WHERE name = ?').run(name)
  db.prepare('DELETE FROM group_members WHERE name = ?').run(name)
  db.prepare('DELETE FROM group_invites WHERE name = ?').run(name)
  db.prepare('DELETE FROM updates WHERE recipient = ?').run(name)
  db.prepare('DELETE FROM events WHERE session = ?').run(name)
  leases.delete(name)
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

const dashboardActions = {
  clear: p => clearChat(String(p.session ?? '')),
  delete: p => deleteSession(String(p.session ?? '')),
  archive: p => setArchived(String(p.session ?? ''), true),
  unarchive: p => setArchived(String(p.session ?? ''), false),
  'hosts/enroll': (p, req) => createEnrollment(p, req),
  'hosts/rename': p => renameHost(String(p.host ?? ''), p.name),
  'hosts/remove': p => removeHost(String(p.host ?? '')),
  'terminals/open': p => openTerminalOn(p),
  'terminals/kill': p => killTerminalOn(p),
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
    connected_since: link?.connectedAt ?? null,
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
  db.prepare('INSERT INTO host_enrollments (code_hash, name, created_at, expires_at, configure_plugin) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(code), name, t, t + ENROLL_TTL_MS, p.configure_plugin === false ? 0 : 1)
  const base = serverBaseUrl(req)
  const q = s => `'${String(s).replace(/'/g, `'\\''`)}'` // always a single shell word
  // The command checks the program it downloads against this server's copy
  // (sha256sum on Linux, shasum on macOS) before running it.
  const file = HOST_SCRIPT.find(f => { try { return statSync(f).isFile() } catch { return false } })
  const sha = file ? createHash('sha256').update(readFileSync(file)).digest('hex') : null
  const verify = sha ? ` && echo ${q(`${sha}  squadra-host.mjs`)} | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -)` : ''
  return {
    code,
    expires_at: t + ENROLL_TTL_MS,
    server_url: base,
    sha256: sha,
    command: `curl -fsSLo squadra-host.mjs ${q(`${base}/host/squadra-host.mjs`)}${verify} && node squadra-host.mjs enroll ${q(base)} ${code}`,
  }
}

// The address hosts and plugins use: PUBLIC_URL, or what the browser used.
function serverBaseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL
  const fwd = h => (TRUST_PROXY ? String(req.headers[h] ?? '').split(',')[0].trim() : '')
  let proto = fwd('x-forwarded-proto') || (TLS ? 'https' : 'http')
  if (proto !== 'http' && proto !== 'https') proto = TLS ? 'https' : 'http'
  let host = fwd('x-forwarded-host') || String(req.headers.host ?? '')
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

// Enrollment attempts: 10 a minute per address, 60 a minute overall (so a
// flood from many addresses still can't brute-force codes).
const enrollAttempts = new Map() // ip -> timestamps
let enrollGlobal = []
function checkEnrollRate(req) {
  const ip = ipKey(clientIp(req))
  const t = now()
  enrollGlobal = enrollGlobal.filter(x => t - x < 60_000)
  const recent = (enrollAttempts.get(ip) ?? []).filter(x => t - x < 60_000)
  if (recent.length >= 10 || enrollGlobal.length >= 60) throw new ApiError(429, 'Too Many Requests: retry in a minute')
  recent.push(t)
  enrollGlobal.push(t)
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
  if (!row || row.expires_at < t) throw new ApiError(403, 'Forbidden: the code is wrong or has expired; generate a new one in the dashboard (Hosts → Add)')
  db.prepare('DELETE FROM host_enrollments WHERE code_hash = ?').run(row.code_hash) // single use
  const info = sanitizeHostInfo(p.info)
  const id = `h_${randomBytes(8).toString('hex')}`
  const secret = `sh_${randomBytes(32).toString('base64url')}`
  // The hostname comes from the machine: keep only the characters a name may have.
  const fromHost = String(info?.hostname ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40)
  const name = row.name || fromHost || id
  db.prepare('INSERT INTO hosts (id, name, secret_hash, created_at, last_seen_at, info) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, uniqueHostName(name), sha256(secret), t, t, JSON.stringify(info))
  broadcastHost(id)
  process.stderr.write(`squadra-server: host "${hostRow(id).name}" (${id}) enrolled from ${ip}\n`)
  return {
    id, secret, name: hostRow(id).name,
    ...(row.configure_plugin ? { plugin: { url: serverBaseUrl(req), token: JOIN_TOKEN } } : {}),
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
  const str = (v, n = 200) => typeof v === 'string' ? v.slice(0, n) : null
  const terminals = (Array.isArray(info.terminals) ? info.terminals : []).slice(0, 64).map(t => ({
    id: str(t?.id, 40),
    name: str(t?.name, 40),
    role: t?.role === 'coordinator' || t?.role === 'worker' ? t.role : null,
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
    max_sessions: Number.isInteger(info.max_sessions) ? info.max_sessions : null,
    allow_input: info.allow_input !== false,
    plugin: info.plugin && typeof info.plugin === 'object'
      ? { installed: info.plugin.installed === true, enabled: info.plugin.enabled === true, version: str(info.plugin.version, 40) }
      : null,
    terminals,
  }
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

function openHostLink(ws, req) {
  let link = null
  let hostId = null
  const hello = setTimeout(() => ws.close(4000, 'hello expected'), 10_000)
  ws.onmessage = text => {
    let m
    try { m = JSON.parse(text) } catch {}
    if (!m || typeof m !== 'object' || Array.isArray(m)) return link ? undefined : ws.close(4000, 'hello expected')
    if (!link) {
      const row = m.t === 'hello' && typeof m.secret === 'string' ? db.prepare('SELECT * FROM hosts WHERE secret_hash = ?').get(sha256(m.secret)) : null
      if (!row) return ws.close(4001, 'unknown or disconnected host')
      clearTimeout(hello)
      ws.onauthed?.()
      ws.maxMessage = 4 * 1024 * 1024 // terminal screens can be large
      hostId = row.id
      // One live connection per host: the newest wins.
      hostLinks.get(hostId)?.ws.close(4002, 'replaced by a newer connection')
      link = { ws, info: sanitizeHostInfo(m.info), connectedAt: now(), pending: new Map(), viewers: new Map() }
      hostLinks.set(hostId, link)
      db.prepare('UPDATE hosts SET last_seen_at = ?, info = ? WHERE id = ?').run(now(), JSON.stringify(link.info), hostId)
      ws.send(JSON.stringify({ t: 'welcome', host: { id: hostId, name: row.name } }))
      process.stderr.write(`squadra-server: host "${row.name}" connected from ${req.socket.remoteAddress}\n`)
      broadcastHost(hostId)
      return
    }
    switch (m.t) {
      case 'info':
        link.info = sanitizeHostInfo(m.info)
        db.prepare('UPDATE hosts SET last_seen_at = ?, info = ? WHERE id = ?').run(now(), JSON.stringify(link.info), hostId)
        broadcastHost(hostId)
        break
      case 'reply': {
        const p = link.pending.get(m.req)
        if (!p) break
        link.pending.delete(m.req)
        clearTimeout(p.timer)
        if (m.ok) p.resolve(m.result ?? true)
        else p.reject(new ApiError(400, `Bad Request: ${String(m.error ?? 'refused by the machine').slice(0, 500)}`))
        break
      }
      case 'screen': case 'out': case 'exit': case 'notice': {
        const term = String(m.term ?? '')
        const set = link.viewers.get(term)
        if (!set) break
        const out = JSON.stringify({ t: m.t, host: hostId, term, data: typeof m.data === 'string' ? m.data : undefined, text: typeof m.text === 'string' ? m.text.slice(0, 300) : undefined })
        for (const v of set) {
          // A viewer that can't keep up misses output and gets a fresh screen later.
          if (m.t === 'out' && v.ws.buffered > 4 * 1024 * 1024) { v.stale = true; continue }
          v.ws.send(out)
        }
        if (m.t === 'exit') link.viewers.delete(term)
        break
      }
    }
  }
  ws.onclose = () => {
    clearTimeout(hello)
    if (!link || hostLinks.get(hostId) !== link) return
    hostLinks.delete(hostId)
    for (const p of link.pending.values()) { clearTimeout(p.timer); p.reject(new ApiError(502, 'Bad Gateway: the machine disconnected')) }
    for (const [term, set] of link.viewers) for (const v of set) { v.ws.send(JSON.stringify({ t: 'host_down', host: hostId, term })); v.attached.delete(`${hostId}\0${term}`) }
    if (hostRow(hostId)) db.prepare('UPDATE hosts SET last_seen_at = ? WHERE id = ?').run(now(), hostId)
    process.stderr.write(`squadra-server: host ${hostId} disconnected\n`)
    broadcastHost(hostId)
  }
}

// Dashboard web terminal: one WebSocket per browser tab, authenticated with
// the server token in its first message, multiplexing every terminal it shows.
function openViewerLink(ws, req) {
  const viewer = { ws, attached: new Set(), authed: false, typed: new Set() }
  const hello = setTimeout(() => ws.close(4000, 'auth expected'), 10_000)
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
    if (!m || typeof m !== 'object' || Array.isArray(m)) return viewer.authed ? undefined : ws.close(4000, 'auth expected')
    if (!viewer.authed) {
      if (m.t !== 'auth' || typeof m.token !== 'string' || !isServerToken(m.token)) return ws.close(4001, 'unauthorized')
      clearTimeout(hello)
      ws.onauthed?.()
      viewer.authed = true
      ws.maxMessage = 256 * 1024
      return ws.send(JSON.stringify({ t: 'ready' }))
    }
    const host = String(m.host ?? '')
    const term = String(m.term ?? '')
    const key = `${host}\0${term}`
    const link = hostLinks.get(host)
    if (m.t === 'attach') {
      if (!link) return ws.send(JSON.stringify({ t: 'host_down', host, term }))
      if (!NAME_RE.test(term)) return
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
  }
  ws.onclose = () => { clearTimeout(hello); detachAll() }
}

function onUpgrade(req, socket, head) {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '')
  if (path !== '/host/connect' && path !== '/api/terminal') {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
    return
  }
  // The dashboard's terminal socket only from the dashboard's own page (a
  // browser always sends Origin; squadra-host sends none).
  if (path === '/api/terminal' && req.headers.origin) {
    let ok = false
    try { ok = new URL(req.headers.origin).host === req.headers.host } catch {}
    if (!ok) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
  }
  // Not yet authenticated sockets: a few per address, and a cap overall.
  // Separate pools for machines and dashboards: one can't starve the other.
  const pool = path === '/host/connect' ? pendingSockets.host : pendingSockets.terminal
  const ip = ipKey(clientIp(req))
  if (pool.total >= 100 || (pool.byIp.get(ip) ?? 0) >= 20) {
    socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n')
    return
  }
  const ws = acceptWebSocket(req, socket, head, { maxMessage: 16 * 1024 })
  if (!ws) return
  wsClients.add(ws)
  pool.total++
  pool.byIp.set(ip, (pool.byIp.get(ip) ?? 0) + 1)
  let counted = true
  const uncount = () => {
    if (!counted) return
    counted = false
    pool.total--
    const n = (pool.byIp.get(ip) ?? 1) - 1
    if (n > 0) pool.byIp.set(ip, n); else pool.byIp.delete(ip)
  }
  ws.onauthed = uncount // called by the link once it has authenticated
  if (path === '/host/connect') openHostLink(ws, req)
  else openViewerLink(ws, req)
  const handler = ws.onclose
  ws.onclose = () => { wsClients.delete(ws); uncount(); handler() }
}
const pendingSockets = { host: { total: 0, byIp: new Map() }, terminal: { total: 0, byIp: new Map() } }
const wsClients = new Set()

function removeHost(id) {
  const row = hostRow(id)
  if (!row) throw bad('host not found')
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
async function openTerminalOn(p) {
  const id = String(p.host ?? '')
  const spec = p.spec && typeof p.spec === 'object' && !Array.isArray(p.spec) ? { ...p.spec } : null
  if (!spec) throw bad('spec is required')
  delete spec.identity
  const name = String(spec.name ?? '')
  if (!NAME_RE.test(name)) throw bad('name must match [A-Za-z0-9_-]{1,32}')
  if (!hostLinks.has(id)) return askHost(id, { t: 'open', spec }) // reports host_offline / not found
  if (isOnline(name)) {
    throw new ApiError(409, `Conflict: a session named "${name}" is already connected`, { parameters: { reason: 'name_in_use' } })
  }
  const existing = db.prepare('SELECT host_id FROM identities WHERE name = ?').get(name)
  if (existing && existing.host_id !== id) {
    throw new ApiError(409, `Conflict: the name "${name}" is already registered by another session; pick another name, or delete that session in the dashboard`, { parameters: { reason: 'name_taken' } })
  }
  let created = false
  if (!existing) {
    spec.identity = register(name, false).secret
    db.prepare('UPDATE identities SET host_id = ? WHERE name = ?').run(id, name)
    created = true
  }
  try {
    const result = await askHost(id, { t: 'open', spec })
    process.stderr.write(`squadra-server: opened session "${name}" on host ${id}\n`)
    return result
  } catch (err) {
    if (created) db.prepare('DELETE FROM identities WHERE name = ? AND host_id = ?').run(name, id)
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
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) })
  res.end(data)
}

function sendError(res, err) {
  if (err instanceof ApiError) {
    sendJson(res, err.code, { ok: false, error_code: err.code, description: err.message, ...(err.extra ?? {}) })
  } else {
    process.stderr.write(`squadra-server: internal error: ${err?.stack ?? err}\n`)
    sendJson(res, 500, { ok: false, error_code: 500, description: 'Internal Server Error' })
  }
}

// Request body, up to `max` bytes. A client that stops sending for 30 s is
// cut off (requests have no overall timeout, for long polls and uploads).
const BODY_IDLE_MS = 30_000
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > max) {
      reject(new ApiError(413, `Request Entity Too Large (max ${max} bytes)`))
      req.destroy()
      return
    }
    const chunks = []
    let size = 0
    let idle = null
    const arm = () => {
      clearTimeout(idle)
      idle = setTimeout(() => { reject(new ApiError(408, 'Request Timeout')); req.destroy() }, BODY_IDLE_MS)
    }
    arm()
    req.on('data', c => {
      arm()
      size += c.length
      if (size > max) {
        clearTimeout(idle)
        reject(new ApiError(413, `Request Entity Too Large (max ${max} bytes)`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { clearTimeout(idle); resolve(Buffer.concat(chunks)) })
    req.on('error', err => { clearTimeout(idle); reject(err) })
    req.on('close', () => clearTimeout(idle))
  })
}

// Request parameters: query string plus a JSON object body. A plain object
// with no prototype, and only the body's own keys: "__proto__" and friends
// can't make a parameter appear that wasn't sent.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
async function readParams(req, url, max = MAX_JSON_BODY) {
  const params = Object.create(null)
  for (const [k, v] of url.searchParams) if (!RESERVED_KEYS.has(k)) params[k] = v
  if (req.method === 'POST') {
    const buf = await readBody(req, max)
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

async function handle(req, res) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (path === '/health') return sendJson(res, 200, { ok: true, result: 'ok', version: VERSION })

    // Dashboard page: public HTML; it asks for the server token and sends it
    // with every /api call.
    if (req.method === 'GET' && (path === '/' || path === '/ui')) {
      const html = readFileSync(UI_FILE)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-store', ...pageHeaders(html) })
      return res.end(html)
    }
    // The web terminal (xterm.js), served from here rather than a CDN.
    if (req.method === 'GET' && Object.hasOwn(VENDOR_FILES, path)) {
      const [file, type] = VENDOR_FILES[path]
      const body = readFileSync(new URL(file, import.meta.url))
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' })
      return res.end(body)
    }

    // squadra-host: the program itself (public, like the dashboard page) and enrollment.
    if (req.method === 'GET' && path === '/host/squadra-host.mjs') {
      const file = HOST_SCRIPT.find(f => { try { return statSync(f).isFile() } catch { return false } })
      if (!file) throw new ApiError(404, 'Not Found')
      const js = readFileSync(file)
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': js.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      return res.end(js)
    }
    if (path === '/host/enroll') {
      if (req.method !== 'POST') throw new ApiError(405, 'Method Not Allowed')
      checkEnrollRate(req)
      return sendJson(res, 200, { ok: true, result: enrollHost(await readParams(req, url, 64 * 1024), req) })
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
      const params = await readParams(req, url)
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
    touch(name)

    if (req.method === 'GET' && path.startsWith('/file/')) {
      const rel = decodeURIComponent(path.slice('/file/'.length))
      const f = db.prepare('SELECT * FROM files WHERE path = ?').get(rel)
      if (!f || !canSeeFile(name, f.file_id)) throw new ApiError(404, 'Not Found')
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

    const method = path.slice(1)
    if (method === 'sendDocument' || method === 'sendPhoto') {
      if (req.method !== 'POST') throw new ApiError(405, 'Method Not Allowed')
      const msg = await upload(name, method === 'sendPhoto' ? 'photo' : 'document', url.searchParams, req)
      return sendJson(res, 200, { ok: true, result: msg })
    }
    if (method === 'getUpdates') {
      const params = await readParams(req, url)
      return getUpdates(name, params, res)
    }
    const fn = own(methods, method)
    if (!fn) throw new ApiError(404, 'Not Found: method not found')
    const params = await readParams(req, url)
    return sendJson(res, 200, { ok: true, result: fn(name, params) })
  } catch (err) {
    sendError(res, err)
  }
}

// Rebuild each session's derived state from the stored events (last 24h).
for (const r of db.prepare('SELECT * FROM events ORDER BY id').iterate()) {
  applyEvent(r.session, eventView(r.id, r.session, r.ts, r.kind, JSON.parse(r.data)))
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const servers = []

function startupBanner(scheme) {
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

function listen(srv, port, host) {
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
  const creds = await obtain()
  https = httpsServer(creds)
  await listen(https, PORT, HOST).catch(err => failListen(err, PORT))
  startupBanner('https')
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
