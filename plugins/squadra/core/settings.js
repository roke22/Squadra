// How this machine set the plugin up: its .env, and what the environment may and
// may not change.

import {
  readFileSync, existsSync, renameSync, chmodSync, mkdirSync, realpathSync,
  lstatSync,
} from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { claudeConfigDir, configDirNote, privateGroup, safeChain } from '../paths.js'
import { normalizeLevel } from '../observe.js'

// ps from the system, never from a PATH a project's settings could change.
export const PS_BIN = ['/bin/ps', '/usr/bin/ps'].find(p => existsSync(p)) ?? 'ps'

// Single source of truth: the plugin manifest.
export const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version } catch { return '0.0.0' }
})()

export const ROOT_DIR = join(claudeConfigDir(), 'channels', 'squadra')
if (configDirNote) process.stderr.write(`squadra: ${configDirNote}; using ${ROOT_DIR}\n`)
export const ROOT_ENV_FILE = join(ROOT_DIR, '.env')

// Formerly "Claude Swarm": move the old state folder once, so identities,
// pairings and settings carry over.
try {
  const legacy = join(ROOT_DIR, '..', 'swarm')
  if (!existsSync(ROOT_DIR) && existsSync(legacy)) renameSync(legacy, ROOT_DIR)
} catch {}

// Load ~/.claude/channels/squadra/.env into process.env. Plugin-spawned
// servers don't get an env block — this is where URL and token live.
// The server URL and token from .env win over the environment: a project's
// settings must not be able to point this session (and its identity secret)
// at another server: they come from .env only, never from the environment.
// Only SQUADRA_* keys are read (a line like NODE_OPTIONS=… is ignored).
const FILE_ONLY = ['SQUADRA_URL', 'SQUADRA_SERVER_TOKEN']
for (const k of FILE_ONLY) delete process.env[k]

// Where identities and allowlists live: only from this machine's .env, never
// from the environment a project could set.
delete process.env.SQUADRA_STATE_DIR

// What the environment says about observation and the permission relay: it
// can only make them stricter than the .env (see below).
const ENV_OBSERVE = process.env.SQUADRA_OBSERVE
const ENV_RELAY = process.env.SQUADRA_PERMISSION_RELAY
const FILE_ENV = {}
try {
  chmodSync(ROOT_ENV_FILE, 0o600)
  for (const line of readFileSync(ROOT_ENV_FILE, 'utf8').split(/\r?\n/)) { // (edited on Windows: CRLF)
    const m = line.match(/^(\w+)=(.*)$/)
    if (!m) continue
    const key = m[1].startsWith('SWARM_') ? `SQUADRA_${m[1].slice(6)}` : m[1]
    if (!key.startsWith('SQUADRA_')) continue
    FILE_ENV[key] = m[2]
    if (process.env[key] === undefined || FILE_ONLY.includes(key)) process.env[key] = m[2]
  }
} catch {}

// Custom state folder (absolute, from .env): one subfolder per name in it.
export const STATE_BASE = (() => {
  const d = FILE_ENV.SQUADRA_STATE_DIR
  delete process.env.SQUADRA_STATE_DIR
  if (!d) return null
  if (!isAbsolute(d)) { process.stderr.write(`squadra: SQUADRA_STATE_DIR must be an absolute path, ignoring "${d}"\n`); return null }
  // Ours, and nobody else can write in it (created now if missing, so nobody
  // can create it first).
  // Judged, and used, by its real path (a symlink to it is fine, as for
  // squadra-host: both must pick the same folder).
  let real
  try {
    mkdirSync(d, { recursive: true, mode: 0o700 })
    real = realpathSync(d)
    const st = lstatSync(real)
    // (Group-writable only for this user's private group, as with umask 002.)
    if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid()) || (st.mode & 0o002) || ((st.mode & 0o020) && !privateGroup(st.gid))) throw new Error('not private')
    // Nor inside a folder someone else could rename it out of (and swap).
    if (!safeChain(real, real)) throw new Error('not private')
  } catch {
    process.stderr.write(`squadra: SQUADRA_STATE_DIR ${d} must be a folder of this user that others can't write to; ignoring it\n`)
    return null
  }
  return real
})()
export const stateDirFor = name => join(STATE_BASE ?? ROOT_DIR, name)

// Formerly "Claude Swarm": SWARM_* keys in the .env file still work (read
// above as SQUADRA_*). SWARM_* in the environment are ignored.
export const SERVER_URL = (process.env.SQUADRA_URL ?? '').replace(/\/+$/, '')
export const SERVER_TOKEN = process.env.SQUADRA_SERVER_TOKEN ?? ''

// Why this session's secret and messages can't go to that server, or ''.
// Plain http only to this machine, or where the .env of this machine (never
// the environment) accepts it, as squadra-host does with --insecure.
// The environment can't turn off the certificate check either: a project's
// settings must not be able to hand the secret to whoever answers.
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
// What else Node takes from the environment to decide whom it trusts. Options
// that only tune the program are fine; anything else in NODE_OPTIONS can change
// the certificates, the proxy, or run code. (That code could also hide itself:
// this catches what can be seen, see docs/reference.md.)
const PLAIN_NODE_OPTION = /^--(max-old-space-size|max-semi-space-size|max-http-header-size|stack-size|no-warnings|no-deprecation|trace-warnings|trace-deprecation|enable-source-maps)(=[\w.-]*)?$/
const NODE_TRUST_SWITCHES = ['NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA']
export function transportProblem(url = SERVER_URL, file = FILE_ENV, env = process.env) {
  let u
  try { u = new URL(url) } catch { return `invalid server URL "${url}"` }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `the server URL must start with https:// (it is "${url}")`
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol === 'http:' && !loopback && file.SQUADRA_INSECURE !== '1') {
    return `refusing plain http to ${u.host}: this session's secret and messages would travel unencrypted. Use https, or add SQUADRA_INSECURE=1 to ${ROOT_ENV_FILE} if this is a trusted private network`
  }
  // (Read by Node when it starts, so it can only be refused here. A company
  // CA is fine if this machine's .env names the same file.)
  if (u.protocol === 'https:' && env.NODE_EXTRA_CA_CERTS && file.SQUADRA_EXTRA_CA !== env.NODE_EXTRA_CA_CERTS) {
    return `NODE_EXTRA_CA_CERTS (${env.NODE_EXTRA_CA_CERTS}) would be trusted for this server's certificate. If it is yours, add SQUADRA_EXTRA_CA=${env.NODE_EXTRA_CA_CERTS} to ${ROOT_ENV_FILE}; otherwise remove it from the environment`
  }
  if (!loopback) {
    const options = (env.NODE_OPTIONS ?? '').trim()
    if (options && file.SQUADRA_NODE_OPTIONS !== env.NODE_OPTIONS && !options.split(/\s+/).every(o => PLAIN_NODE_OPTION.test(o))) {
      return `NODE_OPTIONS (${options}) could change which server is trusted, or run code in this session. If it is yours, add SQUADRA_NODE_OPTIONS=${env.NODE_OPTIONS} to ${ROOT_ENV_FILE}`
    }
    for (const name of NODE_TRUST_SWITCHES) {
      if (env[name] && env[name] !== '0' && file[`SQUADRA_ALLOW_${name}`] !== '1') {
        return `${name} would change how this server's certificate or address is reached. If it is yours, add SQUADRA_ALLOW_${name}=1 to ${ROOT_ENV_FILE}`
      }
    }
  }
  return ''
}
export const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
export const GROUP_ID_RE = /^#[A-Za-z0-9_-]{1,32}$/
export const DEFAULT_COORDINATOR = 'coord'

// Live observation for the dashboard: off | activity | full (Spanish aliases
// accepted). The stricter of the .env and the environment: a project's
// settings can lower it, never raise it above what the user set.
export const OBSERVE_ORDER = ['off', 'activity', 'full']

// A setting's value as written: spaces and quotes around it don't count.
const settingValue = v => (v == null ? '' : String(v).trim().replace(/^(['"])(.*)\1$/, '$2').trim().toLowerCase())

// A level that is set but can't be read is the strictest ("off"), never full.
function observeLevel(v) {
  const t = settingValue(v)
  if (!t) return 'full'
  const l = normalizeLevel(t)
  if (!l) process.stderr.write(`squadra: unknown observation level "${t}": using off\n`)
  return l ?? 'off'
}

// (Read again at each login, the same way as at startup — SWARM_OBSERVE too,
// the last line wins: /squadra:configure observe applies to the next login.)
export function defaultObserve() {
  let fromFile = FILE_ENV.SQUADRA_OBSERVE
  try {
    let last
    for (const m of readFileSync(ROOT_ENV_FILE, 'utf8').matchAll(/^(?:SQUADRA|SWARM)_OBSERVE=(.*)$/gm)) last = m[1]
    fromFile = last
  } catch {}
  return [observeLevel(fromFile), observeLevel(ENV_OBSERVE)]
    .sort((a, b) => OBSERVE_ORDER.indexOf(a) - OBSERVE_ORDER.indexOf(b))[0]
}

// The permission relay is off if either the .env or the environment says so
// (squadra-host turns it off on machines that don't allow remote control).
// Only an explicit "on" (or true/yes/1) leaves a set value on.
const relaySetting = v => { const t = settingValue(v); return !t || ['on', 'true', 'yes', '1'].includes(t) }
export const RELAY_OFF = !relaySetting(FILE_ENV.SQUADRA_PERMISSION_RELAY) || !relaySetting(ENV_RELAY)

// hook.js finds this session's plugin through a socket named after the Claude Code process.
export const RUN_DIR = join(ROOT_DIR, 'run')
export const COORDINATOR_WORDS = new Set(['coordinador', 'coordinadora', 'coordinator', 'coord'])

export const log = msg => process.stderr.write(`squadra: ${msg}\n`)

// Permission-reply spec, same as the Telegram plugin:
// 5 lowercase letters a-z minus 'l'. Case-insensitive.
// Strict: no bare yes/no (conversational), no prefix/suffix chatter.
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export const MAX_CHUNK_LIMIT = 32_000
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
export const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

// How a worker's final report on a task can end.
export const REPORTS = ['done', 'blocked', 'failed', 'question']
