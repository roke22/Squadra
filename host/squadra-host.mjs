#!/usr/bin/env node
/**
 * squadra-host — opens Claude Code sessions on this machine for the Squadra
 * dashboard, and lets the dashboard see and type into their terminals.
 *
 * Security model: the server can only ask for a session *spec* — a name, a
 * role, a folder and the auto-compact window — never a command. Every field is
 * validated here, against limits that live in this machine's settings file
 * (allowed folders, maximum sessions, whether the web terminal may type), so a
 * compromised server cannot widen them. The command is always the same:
 *
 *   claude --dangerously-load-development-channels plugin:squadra@squadra [--continue]
 *
 * Typing in a session's terminal from the dashboard is, by nature, the same as
 * sitting at this machine: anyone holding the dashboard can make Claude run
 * things. Turn it off with "allow_input": false in settings.json if you only
 * want to watch.
 *
 * Sessions run in tmux (a private server: tmux -L squadra), so they survive
 * restarts of this program and can be attached locally:
 *   tmux -L squadra attach -t sq-<name>
 *
 * Requirements: Node >= 22.13, tmux >= 3.2 and Claude Code. No npm dependencies.
 * Runs on Linux and macOS. On Windows, run it inside WSL (it needs tmux).
 */

import { execFile, execFileSync, spawn } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, statSync, lstatSync, readlinkSync, openSync, readSync, closeSync, renameSync, copyFileSync, rmSync, chmodSync, accessSync, constants as FS } from 'node:fs'
import { homedir, hostname, platform, arch, userInfo, tmpdir } from 'node:os'
import { join, resolve, sep, isAbsolute, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

const VERSION = '0.0.4'
const run = promisify(execFile)

const CONFIG_DIR = process.env.SQUADRA_HOST_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'squadra-host')
const CREDENTIALS_FILE = join(CONFIG_DIR, 'credentials.json')
const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json')
const INSTALLED_SCRIPT = join(CONFIG_DIR, 'squadra-host.mjs')

const TMUX_SOCKET = process.env.SQUADRA_TMUX_SOCKET ?? 'squadra'
const PREFIX = 'sq-'
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const COMPACT_MIN = 50_000
const COMPACT_MAX = 1_000_000
const DEFAULT_SETTINGS = { folders: [], max_sessions: 8, allow_input: true, allow_resume: true, claude_command: 'claude' }
// The user's home from the user database (not $HOME).
const HOME = (() => { try { return userInfo().homedir || homedir() } catch { return homedir() } })()
// Never allowed as a place to open sessions, whatever settings.json says:
// a folder where credentials, caches or this program's configuration live,
// a system or shared temporary folder, or any folder that CONTAINS one of
// those or your home (/home, /Users…).
const FORBIDDEN_TREES = [
  '.claude', '.ssh', '.config', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.local', '.cache', 'Library',
].map(d => join(HOME, d)).concat([
  CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR, process.env.XDG_CONFIG_HOME,
  '/etc', '/root', '/proc', '/sys', '/dev', '/boot', '/usr', '/bin', '/sbin', '/lib', '/opt/homebrew', '/System', '/Library',
  '/var/root', '/var/lib', '/var/log', '/var/run', '/var/spool', '/private/etc', '/private/var/root',
  // Shared temporary folders (other users can plant a repository there).
  // SQUADRA_HOST_TEST_ALLOW_TMP=1 lifts this, for the test suite only.
  ...(process.env.SQUADRA_HOST_TEST_ALLOW_TMP === '1' ? [] : ['/tmp', '/var/tmp', '/private/tmp', '/var/folders', '/private/var/folders', tmpdir()]),
// (Not this user's own home, though: run as root — --allow-root —, /root is
// where its projects are, judged like any home: the folders inside it are
// fine, the whole of it only with --allow-home, its credentials never.)
].filter(d => d && resolve(d) !== resolve(HOME)))
const realOr = p => { try { return realpathSync.native(p) } catch { return resolve(p) } }
// macOS file systems ignore case: compare that way there.
const norm = p => (platform() === 'darwin' ? p.toLowerCase() : p)
const within = (path, dir) => norm(path) === norm(dir) || norm(path).startsWith(norm(dir.endsWith(sep) ? dir : dir + sep))
// The same, also by the folders' identity (device and inode), as the plugin
// judges CLAUDE_CONFIG_DIR: where case or Unicode normalization is ignored
// (WSL's /mnt/c, casefold folders, macOS) two spellings are one folder.
function withinById(path, dir) {
  if (within(path, dir)) return true
  let id
  try { const st = statSync(dir, { bigint: true }); id = `${st.dev}:${st.ino}` } catch { return false }
  for (let x = path; ; x = dirname(x)) {
    try { const st = statSync(x, { bigint: true }); if (`${st.dev}:${st.ino}` === id) return true } catch {}
    if (dirname(x) === x) return false
  }
}
// The home folder itself (not a folder inside it).
const isHome = real => [HOME, realOr(HOME)].some(h => within(real, h) && within(h, real))
// allowHome: the home folder itself is fine (started with --allow-home);
// a folder that contains it, and the credentials folders inside it, never.
function forbiddenFolder(real, { allowHome = false } = {}) {
  const home = allowHome && isHome(real)
  if (real === '/' || (!home && (within(HOME, real) || within(realOr(HOME), real)))) return allowHome ? 'a folder that contains your home' : 'your whole home, or a folder that contains it (start squadra-host with --allow-home to allow the home folder itself)'
  const trees = FORBIDDEN_TREES.map(realOr)
  if (trees.some(d => within(real, d))) return 'a system, temporary, credentials or configuration folder'
  if (!home && trees.some(d => within(d, real))) return 'a folder that contains a system or credentials folder'
  // Someone else's folder, or one anyone can write to (a shared drop-box) —
  // the folder itself or any folder above it, where someone else could swap
  // it for another one.
  const me = typeof process.getuid === 'function' ? process.getuid() : null
  for (let dir = real, first = true; ; first = false) {
    let st
    try { st = statSync(dir) } catch { return 'a folder that cannot be checked' }
    if (me !== null && st.uid !== me && (first || st.uid !== 0)) return first ? 'a folder owned by another user' : 'inside a folder owned by another user'
    if ((st.mode & 0o002) && (first || !(st.mode & 0o1000))) return first ? 'a folder anyone can write to' : 'inside a folder anyone can write to'
    // Writable by a group that isn't this user's own: its members could plant
    // hooks there (folders owned by root above it are fine).
    // (On macOS everyone's own group is "staff", shared: there no group-writable
    // folder counts as private. Root's folders above aren't exempt either.)
    // (The sticky bit only protects what is inside a folder, never the session's own.)
    if ((st.mode & 0o020) && (first || !(st.mode & 0o1000)) && !privateGroup(st.gid)) {
      return `${first ? 'a folder another group can write to' : 'inside a folder another group can write to'} (if that group is only yours: chmod g-w ${dir})`
    }
    // Others given write access with an ACL (the mode bits don't show it).
    // (The session's own folder: any ACL, even a default one that only
    // what is created inside will get.)
    if (aclGrantsWrite(dir, st, { always: first })) return first ? 'a folder with an ACL that lets others write to it' : 'inside a folder with an ACL that lets others write to it'
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

// Text that came from the server, printed on this terminal: no control
// characters (no escape sequences).
const plain = v => String(v ?? '').replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '?')

const log = m => process.stderr.write(`squadra-host: ${m}\n`)
const die = (m, code = 1) => { process.stderr.write(`squadra-host: ${m}\n`); process.exit(code) }

// --- files ------------------------------------------------------------------------

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, data, mode = 0o600) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode })
  chmodSync(file, mode)
}

// Settings are this machine's own rules. The server can read them (to offer
// the right folders); from the dashboard only the folders can be changed, and
// only within the rules below (unless folders_from_dashboard is false).
//   folders           where sessions may be opened (and anything inside)
//   folders_from_dashboard  whether the dashboard may add and remove folders (default true)
//   allow_home        whether the whole home folder may be one of them (default
//                     false; set by starting with --allow-home). Sessions opened
//                     there never get their permission prompts answered remotely
//   allow_resume      whether a session may continue the last conversation in its folder (default true)
//   max_sessions      at most this many at once
//   allow_input       whether the dashboard may type in the terminals
//   permission_relay  whether a session's coordinator may answer its permission
//                     prompts from another session (default: same as allow_input)
//   coordinators      if set, the only coordinator names a worker may be given
//   claude_command    the Claude Code executable
// Each warning about settings.json once (until the file changes), not on
// every message.
const settingsWarned = new Set()
function warnSettings(msg) {
  let tag = ''
  try { tag = String(statSync(SETTINGS_FILE).mtimeMs) } catch {}
  if (settingsWarned.has(tag + msg)) return
  if (settingsWarned.size > 100) settingsWarned.clear()
  settingsWarned.add(tag + msg)
  log(msg)
}

function loadSettings() {
  let raw = {}
  try { raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) } catch (err) {
    // Settings that exist but can't be read: the strictest ones, never the defaults.
    if (err.code !== 'ENOENT') {
      if (!loadSettings.warned) { loadSettings.warned = true; log(`⚠️  cannot read ${SETTINGS_FILE} (${err.message}): no folders, no typing, no permission relay until it is fixed`) }
      return { ...DEFAULT_SETTINGS, folders: [], allow_input: false, permission_relay: false, allow_resume: false, allow_home: false, folders_from_dashboard: false, coordinators: [] }
    }
  }
  loadSettings.warned = false
  const strict = { ...DEFAULT_SETTINGS, folders: [], allow_input: false, permission_relay: false, allow_resume: false, allow_home: false, folders_from_dashboard: false, coordinators: [] }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnSettings(`⚠️  ${SETTINGS_FILE} must hold a JSON object: no folders, no typing, no permission relay until it is fixed`)
    return strict
  }
  const s = { ...DEFAULT_SETTINGS, ...raw }
  s.allow_home = raw.allow_home === true
  s.folders = (Array.isArray(s.folders) ? s.folders : [])
    .filter(f => typeof f === 'string' && isAbsolute(f) && !forbiddenFolder(realOr(f), { allowHome: s.allow_home }))
  if (raw.max_sessions === undefined) s.max_sessions = DEFAULT_SETTINGS.max_sessions
  else if (Number.isInteger(s.max_sessions) && s.max_sessions >= 0) s.max_sessions = Math.min(s.max_sessions, 64)
  else { warnSettings(`⚠️  max_sessions in ${SETTINGS_FILE} must be a whole number: no sessions until it is fixed`); s.max_sessions = 0 }
  // A value of the wrong type is read as the strict choice, never as "on".
  const bool = (k, dflt) => {
    if (s[k] === undefined) return dflt
    if (typeof s[k] === 'boolean') return s[k]
    warnSettings(`⚠️  ${k} in ${SETTINGS_FILE} must be true or false: taken as false`)
    return false
  }
  s.allow_input = bool('allow_input', true)
  s.permission_relay = bool('permission_relay', s.allow_input)
  s.allow_resume = bool('allow_resume', true)
  s.folders_from_dashboard = bool('folders_from_dashboard', true)
  // A coordinators pin that can't be read refuses every coordinator (it
  // never turns into "any").
  if (s.coordinators === undefined || (Array.isArray(s.coordinators) && s.coordinators.length === 0)) s.coordinators = []
  else if (Array.isArray(s.coordinators) && s.coordinators.every(c => typeof c === 'string' && NAME_RE.test(c))) s.coordinators = [...s.coordinators]
  else {
    warnSettings(`⚠️  coordinators in ${SETTINGS_FILE} must be a list of session names: no coordinator is accepted until it is fixed`)
    s.coordinators = ['(invalid "coordinators" setting)']
  }
  s.claude_command = typeof s.claude_command === 'string' && s.claude_command ? s.claude_command : 'claude'
  return s
}

// The Claude Code executable as an absolute path. A bare name is looked up
// only in absolute PATH entries, so a "." in PATH can never make a session
// run a "claude" file from the project folder.
function claudeBinary(cmd = loadSettings().claude_command) {
  const ok = p => { try { accessSync(p, FS.X_OK); return statSync(p).isFile() } catch { return false } }
  if (cmd.includes('/')) {
    if (!isAbsolute(cmd) || !ok(cmd)) throw new Error(`claude_command must be an absolute path to an executable: ${cmd}`)
    const why = untrustedExecutable(cmd)
    if (why) throw new Error(`refusing ${cmd} as Claude Code: ${why}`)
    return throughDispatcher(cmd, 'claude')
  }
  for (const dir of String(process.env.PATH ?? '').split(':')) {
    if (!isAbsolute(dir)) continue
    const p = join(dir, cmd)
    if (ok(p) && !untrustedExecutable(p)) return throughDispatcher(p, 'claude')
  }
  throw new Error(`"${cmd}" (Claude Code) was not found on the PATH (in a folder only you or root can change)`)
}

// Version managers' shims (volta, asdf, nodenv) pick the program from the
// folder they run in — a session's folder is a repository, which could name
// its own. Such a shim is replaced by the program it picks from the home
// folder (`volta which`, `asdf which`, `nodenv which`), checked like any other.
const dispatcherCache = new Map() // path -> { at, real }
function dispatcherOf(p) {
  const real = realOr(p)
  if (/(^|\/)volta-shim$/.test(real)) return { tool: 'volta', args: ['which'] }
  // (Only its first 64 KB: node or a native claude are 100+ MB; an asdf
  // shim lists every installed version before its exec line.)
  let head = ''
  try {
    const fd = openSync(real, 'r')
    try { const buf = Buffer.alloc(65536); head = buf.toString('latin1', 0, readSync(fd, buf, 0, 65536, 0)) } finally { closeSync(fd) }
  } catch {}
  if (/^#!/.test(head)) {
    if (/\basdf\b[^\n]*\bexec\b/.test(head) || /^# asdf-plugin:/m.test(head)) return { tool: 'asdf', args: ['which'] }
    if (/\bnodenv\b[^\n]*\bexec\b/.test(head)) return { tool: 'nodenv', args: ['which'] }
  }
  return null
}
function throughDispatcher(p, name) {
  const d = dispatcherOf(p)
  if (!d) return p
  const cached = dispatcherCache.get(p)
  if (cached && Date.now() - cached.at < 60_000) return cached.real
  let found = ''
  try {
    // (volta sits next to volta-shim itself: ~/.volta/bin holds only the
    // shims when volta comes from Homebrew, a distribution or cargo.)
    // (The version manager itself passes the same checks as any program run here.)
    const tool = d.tool === 'volta' ? join(dirname(realOr(p)), 'volta') : findTrusted(d.tool)
    if (!tool || untrustedExecutable(tool)) throw new Error(`no trusted ${d.tool}`)
    found = execFileSync(tool, [...d.args, name], { cwd: HOME, encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: computeTrustedFolders() } }).trim().split('\n')[0]
  } catch {}
  if (!found || !isAbsolute(found)) throw new Error(`${p} is a ${d.tool} shim (it picks the program from the session's folder) and the real ${name} couldn't be found: set claude_command in ${SETTINGS_FILE} to the real executable`)
  const why = untrustedExecutable(found) ?? (dispatcherOf(found) ? 'it is another shim' : null)
  if (why) throw new Error(`refusing ${found} (from the ${d.tool} shim ${p}): ${why}`)
  if (dispatcherCache.size > 50) dispatcherCache.clear()
  dispatcherCache.set(p, { at: Date.now(), real: found })
  return found
}

// A program this machine runs: it and its folder must belong to you or root,
// nobody else may be able to change them, and it can't come from a folder
// where sessions are opened (a repository could ship its own "claude").
// A group only this user is in: its own group, with no other member listed
// in /etc/group and no other account having it as its main group. On macOS
// (where everyone's group is "staff") never. If it can't be told: not private.
// A group is private when it is named after this user (the "user private
// group" convention) and no one else is in it: every /etc/group line with that
// gid, and no other account in /etc/passwd with it as its main group. For an
// account from a directory service (LDAP, sssd) that isn't in /etc/passwd,
// only its own group whose gid is its uid, as getent reports it with no
// other member. On macOS (where everyone's group is "staff") never.
const privateGroupCache = new Map() // gid -> { ok, at }
function privateGroup(gid) {
  if (typeof process.getgid !== 'function' || gid !== process.getgid() || platform() === 'darwin') return false
  const cached = privateGroupCache.get(gid)
  if (cached && Date.now() - cached.at < 60_000) return cached.ok
  let ok = false
  try {
    const me = userInfo().username
    const lines = text => text.split('\n').map(l => l.split(':')).filter(f => f.length > 3 && Number(f[2]) === gid)
    const alone = groups => groups.length > 0 && groups.every(f => f[0] === me && f[3].split(',').map(x => x.trim()).filter(Boolean).every(m => m === me))
    const local = lines(readFileSync('/etc/group', 'utf8'))
    const passwd = readFileSync('/etc/passwd', 'utf8').split('\n').map(l => l.split(':'))
    const others = passwd.filter(f => f.length > 3 && Number(f[3]) === gid && f[0] !== me)
    if (passwd.some(f => f[0] === me)) ok = alone(local) && others.length === 0
    else if (gid === process.getuid() && others.length === 0 && local.every(f => f[0] === me)) {
      const getent = ['/usr/bin/getent', '/bin/getent'].find(f => existsSync(f))
      if (getent) ok = alone(lines(execFileSync(getent, ['group', String(gid)], { encoding: 'utf8', timeout: 5000 })))
    }
  } catch {}
  privateGroupCache.set(gid, { ok, at: Date.now() })
  return ok
}

// Whether an ACL lets someone other than this user write there. On Linux an
// ACL shows in the mode bits as group-write (its mask), so it is looked for
// only then; on macOS it never shows, so it is always looked for. Read with
// the system's ls; if that can't be done, assumed to.
const aclCache = new Map() // path -> { key, grants }
function aclGrantsWrite(path, st, { always = false } = {}) {
  const mac = platform() === 'darwin'
  if (!mac && !always && !(st.mode & 0o020)) return false
  if (platform() !== 'linux' && !mac) return false
  const key = `${st.ino}:${st.ctimeMs}:${always}`
  const c = aclCache.get(path)
  if (c && c.key === key) return c.grants
  let grants = true
  try {
    // (Where the system's ls is: NixOS and Guix keep it under /run/current-system.)
    const ls = ['/bin/ls', '/usr/bin/ls', '/run/current-system/sw/bin/ls', '/run/current-system/profile/bin/ls'].find(f => existsSync(f))
    const out = execFileSync(ls, mac ? ['-lde', '--', path] : ['-ld', '--', path], { encoding: 'utf8', timeout: 5000 })
    if (!mac) grants = out[10] === '+'
    else {
      const me = userInfo().username
      grants = out.split('\n').slice(1).some(l => {
        const m = /^\s*\d+:\s+(.+?)\s+(?:inherited\s+)?allow\s+(\S+)/.exec(l)
        return !!m && m[1] !== `user:${me}` && /(^|,)(write|append|add_file|add_subdirectory|delete_child|delete|writeattr|writeextattr|writesecurity|chown)(,|$)/.test(m[2])
      })
    }
  } catch {}
  if (aclCache.size > 1000) aclCache.clear()
  aclCache.set(path, { key, grants })
  return grants
}

// Programs (and PATH folders) are used by the path as written — version
// managers' shims and Homebrew's opt/ links keep working — but only when
// nobody else can change where that path leads: walking it from "/", every
// folder on the way and every symlink belongs to this user or root and
// nobody else can change it (writable only by this user's private group,
// root's, or macOS's "admin" — Homebrew, whose members can use sudo
// anyway); sticky folders on the way are fine (what is in them is checked),
// but not the folder that holds the program, nor the PATH folder itself.
const okGroup = gid => privateGroup(gid) || gid === 0 || (platform() === 'darwin' && gid === 80)
function entryProblem(path, st, strict) {
  const me = typeof process.getuid === 'function' ? process.getuid() : null
  if (me !== null && st.uid !== me && st.uid !== 0) return 'it belongs to another user'
  if ((st.mode & 0o002) && (strict || !(st.mode & 0o1000))) return 'anyone can change it'
  if ((st.mode & 0o020) && (strict || !(st.mode & 0o1000)) && !okGroup(st.gid)) return 'a group can change it'
  if (aclGrantsWrite(path, st)) return 'an ACL lets others change it'
  return null
}
function trustedChain(p, { dir = false } = {}) {
  const me = typeof process.getuid === 'function' ? process.getuid() : null
  const check = (path, strict) => {
    let st
    try { st = statSync(path) } catch { return `${path} cannot be checked` }
    const why = entryProblem(path, st, strict)
    return why ? `${path}: ${why}` : null
  }
  let why = check('/', false)
  if (why) return { why }
  const parts = String(p).split('/').filter(x => x && x !== '.')
  let cur = '/'
  let hops = 0
  while (parts.length) {
    const name = parts.shift()
    if (name === '..') { cur = dirname(cur); continue }
    const next = cur === '/' ? `/${name}` : `${cur}/${name}`
    let l
    try { l = lstatSync(next) } catch { return { why: `${next} cannot be checked` } }
    if (l.isSymbolicLink()) {
      if (++hops > 40) return { why: `${p}: too many symlinks` }
      if (me !== null && l.uid !== me && l.uid !== 0) return { why: `${next}: a symlink of another user` }
      let target
      try { target = readlinkSync(next) } catch { return { why: `${next} cannot be read` } }
      parts.unshift(...target.split('/').filter(x => x && x !== '.'))
      if (target.startsWith('/')) cur = '/'
      continue
    }
    why = check(next, false)
    if (why) return { why }
    cur = next
  }
  // Nobody else may add names where it ends: the PATH folder itself, or
  // the program and the folder holding it.
  why = check(cur, true) || (dir ? null : check(dirname(cur), true))
  return why ? { why } : { real: cur }
}
const untrustedFolder = dir => trustedChain(dir, { dir: true }).why ?? null

// The folders where sessions are opened, for "never a program or PATH
// folder from there" (a repository could bring its own). Not the home
// folder itself (allowed with --allow-home): what is installed in it
// (~/.local/bin, nvm's node, Claude Code) is the user's own. Project
// folders inside it, allowed on their own, still count.
function sessionRoots() {
  let folders = []
  try { folders = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).folders ?? [] } catch {}
  return (Array.isArray(folders) ? folders : []).filter(f => typeof f === 'string' && isAbsolute(f)).map(realOr).filter(r => !isHome(r))
}

// A program this machine runs: the path given (as written) is what runs,
// and nothing on the way to it can be changed by anyone else.
function untrustedExecutable(p) {
  const { real, why } = trustedChain(p)
  if (why) return why
  try { if (!statSync(real).isFile()) return 'it is not a file' } catch { return 'the program cannot be checked' }
  if (sessionRoots().some(r => within(real, r))) return 'it is inside a folder where sessions are opened'
  return null
}
// The PATH given to Claude Code and the sessions: only absolute folders that
// pass the same checks (Claude Code's "#!/usr/bin/env node" looks up node
// there, before any trust dialog), and none where sessions are opened.
let trustedPathCache = null
function trustedPath() {
  if (trustedPathCache && Date.now() - trustedPathCache.at < 10_000) return trustedPathCache.path
  const path = computeTrustedPath()
  trustedPathCache = { path, at: Date.now() }
  return path
}
// A program by name, from the trusted PATH folders, that passes the same
// checks as claude itself (not only its folder).
function findTrusted(name) {
  for (const dir of computeTrustedFolders().split(':')) {
    const p = join(dir, name)
    try { accessSync(p, FS.X_OK) } catch { continue }
    if (!untrustedExecutable(p)) return p
  }
  return null
}
const shimFailures = new Map() // shim path -> when resolving it last failed
function computeTrustedPath() {
  const dirs = computeTrustedFolders().split(':')
  // Claude Code installed with npm starts with "#!/usr/bin/env node": if the
  // first node on the PATH is a version manager's shim, the folder of the
  // node it picks from the home folder goes first (not the repository's).
  // If that can't be found, the shim's folder is left out: a shim that picks
  // by folder never comes first.
  // (If a real node comes later on the PATH, the shim's folder only moves
  // after it, keeping its other tools; the failure is remembered a minute.)
  const moved = []
  for (let k = 0; k < dirs.length; k++) {
    const p = join(dirs[k], 'node')
    try { accessSync(p, FS.X_OK) } catch { continue }
    if (!dispatcherOf(p)) {
      // The node Claude Code would start with passes the same checks as any
      // program run here (a link to someone else's file doesn't).
      if (!untrustedExecutable(p)) break
      moved.push(...dirs.splice(k, 1))
      k--
      continue
    }
    const failedAt = shimFailures.get(p) ?? 0
    if (Date.now() - failedAt > 60_000) {
      try { return [dirname(throughDispatcher(p, 'node')), ...dirs, ...moved].join(':') } catch {
        if (!shimFailures.has(p)) log(`${p} is a version manager's shim and the node it picks from your home folder couldn't be found: it isn't used first for sessions`)
        shimFailures.set(p, Date.now())
      }
    }
    moved.push(...dirs.splice(k, 1))
    k--
  }
  // A real node later on: the shim folders go after everything else.
  // None at all: they are left out (a shim that picks by folder never decides).
  const realNode = dirs.some(d => { const p = join(d, 'node'); try { accessSync(p, FS.X_OK) } catch { return false } return !dispatcherOf(p) && !untrustedExecutable(p) })
  return [...dirs, ...(realNode ? moved : [])].join(':') || '/usr/bin:/bin'
}
function computeTrustedFolders() {
  const roots = sessionRoots()
  // (As written: nothing on the way to each one can be changed by others.)
  const seen = new Set()
  return String(process.env.PATH ?? '').split(':').filter(d => {
    if (!isAbsolute(d) || seen.has(d)) return false
    seen.add(d)
    try { if (!statSync(d).isDirectory()) return false } catch { return false }
    const real = realOr(d)
    return !untrustedFolder(d) && !roots.some(r => within(real, r))
  }).join(':') || '/usr/bin:/bin'
}
const runClaude = (cmd, args, opts = {}) => run(cmd, args, { cwd: HOME, ...opts, env: { ...process.env, PATH: trustedPath() } })
const claudeOrNull = () => { try { return claudeBinary() } catch { return null } }

// --- tmux ---------------------------------------------------------------------------

// UTF-8 always: tmux runs with -u (without it "é" becomes "_" and folder
// names would no longer match).
const tmuxEnv = () => {
  const e = { ...process.env, PATH: trustedPath() }
  delete e.TMUX; delete e.TMUX_PANE
  // (tmux -u already handles UTF-8; a locale is only added when there is none at all, on Linux.)
  if (!e.LC_ALL && !e.LC_CTYPE && !e.LANG && platform() !== 'darwin') e.LC_CTYPE = 'C.UTF-8'
  return e
}
// tmux by absolute path (only absolute PATH entries), like claude.
let TMUX_BIN = null
function tmuxBin() {
  // Checked again on every use: a tmux replaced after startup isn't run.
  if (TMUX_BIN && !untrustedExecutable(TMUX_BIN)) return TMUX_BIN
  TMUX_BIN = null
  for (const dir of String(process.env.PATH ?? '').split(':')) {
    if (!isAbsolute(dir)) continue
    const p = join(dir, 'tmux')
    try { accessSync(p, FS.X_OK) } catch { continue }
    if (!untrustedExecutable(p)) return (TMUX_BIN = p)
  }
  return 'tmux-not-found'
}
// (30 s at most: a hung tmux can't block opening sessions for good.)
const tmux = (args, opts = {}) => run(tmuxBin(), ['-u', '-L', TMUX_SOCKET, '-f', '/dev/null', ...args], { env: tmuxEnv(), maxBuffer: 16 * 1024 * 1024, cwd: HOME, timeout: 30_000, ...opts })

async function tmuxVersion() {
  try {
    const { stdout } = await run(tmuxBin(), ['-V'])
    const m = /(\d+)\.(\d+)/.exec(stdout)
    return m ? { text: stdout.trim(), major: Number(m[1]), minor: Number(m[2]) } : { text: stdout.trim(), major: 0, minor: 0 }
  } catch { return null }
}

async function claudeVersion(cmd) {
  try {
    const { stdout } = await runClaude(cmd, ['--version'], { timeout: 10_000 })
    return stdout.trim().split('\n')[0].slice(0, 80)
  } catch { return null }
}

// Sessions this program opened: tmux sessions named sq-<name> carrying their
// spec in the @squadra option, so they are found again after a restart.
async function listTerminals() {
  let out
  try {
    // tmux prints control characters (tabs too) as "_": separate with spaces,
    // which neither the name nor the date have, and keep the spec last.
    ({ stdout: out } = await tmux(['list-sessions', '-F', '#{session_name} #{session_created} #{@squadra}']))
  } catch { return [] } // no tmux server: no sessions
  const list = []
  for (const line of out.split('\n')) {
    const m = /^(\S+) (\d+) ?(.*)$/.exec(line)
    if (!m) continue
    const [, tname, created, meta] = m
    if (!tname?.startsWith(PREFIX) || !NAME_RE.test(tname.slice(PREFIX.length))) continue
    let spec = {}
    try { spec = JSON.parse(meta || '{}') } catch {}
    list.push({
      id: tname.slice(PREFIX.length),
      name: tname.slice(PREFIX.length),
      role: spec.role ?? null,
      coordinator: spec.coordinator ?? null,
      folder: spec.folder ?? null,
      compact_window: spec.compact_window ?? null,
      created_at: Number(created) * 1000,
    })
  }
  return list
}

// --- validation of what the server asks for -------------------------------------------

function insideAllowed(real, folders) {
  for (const f of folders) {
    let root
    try { root = realpathSync.native(f) } catch { continue }
    if (within(real, root)) return true
  }
  return false
}

// The only thing a server can ask for. Anything unexpected is refused.
export function validateSpec(spec, settings, current) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('invalid request')
  const allowed = new Set(['name', 'role', 'coordinator', 'folder', 'compact_window', 'resume', 'identity'])
  for (const k of Object.keys(spec)) if (!allowed.has(k)) throw new Error(`unknown field "${plain(k).slice(0, 40)}"`)
  const name = String(spec.name ?? '')
  if (!NAME_RE.test(name)) throw new Error('name must match [A-Za-z0-9_-]{1,32}')
  const role = spec.role
  // (solo: a plain Claude Code session, outside any squad.)
  if (role !== 'coordinator' && role !== 'worker' && role !== 'solo') throw new Error('role must be coordinator, worker or solo')
  let coordinator = null
  if (role === 'worker') {
    coordinator = spec.coordinator == null || spec.coordinator === '' ? 'coord' : String(spec.coordinator)
    if (!NAME_RE.test(coordinator)) throw new Error('invalid coordinator name')
    if (coordinator === name) throw new Error('a worker cannot be its own coordinator')
    // The coordinator gives the worker its instructions: this machine may pin who that can be.
    if (settings.coordinators.length && !settings.coordinators.includes(coordinator)) {
      throw new Error(`this machine only accepts these coordinators: ${settings.coordinators.join(', ')}`)
    }
  } else if (spec.coordinator != null && spec.coordinator !== '') {
    throw new Error(`a ${role === 'solo' ? 'standalone session' : 'coordinator'} has no coordinator`)
  }
  let compact = null
  if (spec.compact_window != null && spec.compact_window !== '') {
    compact = Number(spec.compact_window)
    if (!Number.isInteger(compact) || compact < COMPACT_MIN || compact > COMPACT_MAX) {
      throw new Error(`compact_window must be a whole number of tokens between ${COMPACT_MIN} and ${COMPACT_MAX}`)
    }
  }
  if (spec.resume != null && typeof spec.resume !== 'boolean') throw new Error('resume must be true or false')
  // Continuing "the last conversation in that folder" could be one the user
  // had there by hand: only if this machine allows it.
  if (spec.resume === true && !settings.allow_resume) throw new Error('this machine does not allow continuing earlier conversations ("allow_resume": false in its settings.json)')
  // The session's identity secret, when the server reserved the name for this machine.
  if (spec.identity != null && !(typeof spec.identity === 'string' && /^sq_[A-Za-z0-9_-]{20,64}$/.test(spec.identity))) throw new Error('invalid identity')
  if (typeof spec.folder !== 'string' || !isAbsolute(spec.folder) || spec.folder.length > 4096) throw new Error('folder must be an absolute path')
  // Nothing outside the allowed folders is even looked at (no "exists / not
  // a folder" answers about the rest of the machine).
  const asWritten = resolve(spec.folder)
  if (!settings.folders.some(f => within(asWritten, resolve(f)) || within(asWritten, realOr(f)))) {
    throw new Error(`that folder is not inside the folders this machine allows (${settings.folders.join(', ') || 'none configured'})`)
  }
  // tmux expands #{…} and #(…) in some arguments and splits commands on ";":
  // such paths are refused outright.
  if (/[#;\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(spec.folder)) throw new Error('folder contains characters that are not allowed (#, ; or control characters)')
  // Where it really leads is checked against the allowed folders before
  // anything else is said about it: a symlink inside them (to "/") can't be
  // used to ask what exists elsewhere. One answer for missing, not a folder,
  // or outside.
  const notOpenable = () => new Error(`folder ${spec.folder} is not a folder inside the folders this machine allows (${settings.folders.join(', ') || 'none configured'})`)
  let real
  try { real = realpathSync.native(resolve(spec.folder)) } catch { throw notOpenable() }
  if (!insideAllowed(real, settings.folders)) throw notOpenable()
  try { if (!statSync(real).isDirectory()) throw notOpenable() } catch { throw notOpenable() }
  if (/[#;\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(real)) throw new Error('folder contains characters that are not allowed (#, ; or control characters)')
  const why = forbiddenFolder(real, { allowHome: settings.allow_home })
  if (why) throw new Error(`sessions cannot be opened in ${real}: it is ${why}`)
  if (current.some(t => t.name === name)) throw new Error(`a session named "${name}" is already open on this machine`)
  if (current.length >= settings.max_sessions) throw new Error(`this machine allows at most ${settings.max_sessions} sessions`)
  // Which folder exactly (device and inode), to check after the start that
  // the session is in this one and not in another put at the same path.
  const id = statSync(real)
  return { name, role, coordinator, folder: real, folderId: `${id.dev}:${id.ino}`, compact_window: compact, resume: spec.resume === true, identity: spec.identity ?? null, home: isHome(real) }
}

// --- the Squadra plugin on this machine ----------------------------------------------
//
// Sessions need the plugin installed in this machine's Claude Code. Where it
// comes from is fixed here on purpose: the server never decides what gets
// installed on this machine.

const PLUGIN_ID = 'squadra@squadra'
const PLUGIN_REPO = 'roke22/Squadra'
// The plugin version that goes with this program: a release tag, not whatever
// the default branch holds today.
const PLUGIN_MARKETPLACE = `${PLUGIN_REPO}#v${VERSION}`
const PLUGIN_COMMANDS = `claude plugin marketplace add ${PLUGIN_MARKETPLACE} && claude plugin install ${PLUGIN_ID}`

// The "squadra" marketplace, as Claude Code has it (or null).
// A marketplace called "squadra" that isn't this project's would be trusted
// blindly by "plugin install squadra@squadra": refuse it.
async function checkMarketplace(cmd) {
  let list = []
  try { list = JSON.parse((await runClaude(cmd, ['plugin', 'marketplace', 'list', '--json'], { timeout: 30_000, cwd: HOME })).stdout) } catch { return null }
  const m = Array.isArray(list) ? list.find(x => x?.name === 'squadra') : null
  if (m && String(m.repo ?? '').toLowerCase() !== PLUGIN_REPO.toLowerCase()) {
    throw new Error(`a different marketplace named "squadra" is installed (${plain(m.repo ?? m.source ?? 'unknown source')}). Remove it with: claude plugin marketplace remove squadra`)
  }
  return m ?? null
}

// A marketplace added without a version (or another one) follows whatever the
// repository holds: replace it with this program's release tag. Removing a
// marketplace uninstalls its plugins, so the plugin is installed again after.
async function pinMarketplace(cmd, opts) {
  const m = await checkMarketplace(cmd)
  // (Only an unpinned or older marketplace moves: a newer one is left alone.)
  const ref = String(m?.ref ?? '')
  // (A version tag in any spelling — v0.0.3, 0.0.3, V0.0.3-beta.1 — by its numbers.)
  const tag = /^v?(\d+(?:\.\d+)*)(?:-.*)?$/i.exec(ref)
  if (!m || ref === `v${VERSION}` || (tag && !olderVersion(tag[1], VERSION))) return false
  // Removing the marketplace uninstalls the plugin: first make sure the
  // release tag can be fetched, so a missing tag or no network changes nothing.
  // (SQUADRA_HOST_TEST_SKIP_TAG_CHECK=1: the test suite only.)
  if (process.env.SQUADRA_HOST_TEST_SKIP_TAG_CHECK !== '1') try {
    const git = findTrusted('git')
    if (!git) throw new Error('git was not found in a folder only you or root can change')
    const { stdout } = await run(git, ['ls-remote', '--tags', `https://github.com/${PLUGIN_REPO}.git`, `refs/tags/v${VERSION}`], { cwd: HOME, timeout: 30_000, env: { ...process.env, PATH: trustedPath(), GIT_TERMINAL_PROMPT: '0' } })
    if (!stdout.trim()) throw new Error(`the release tag v${VERSION} is not published`)
  } catch (err) {
    throw new Error(`cannot move the Squadra marketplace to v${VERSION} (${String(err.message).split('\n')[0]}): nothing was changed`)
  }
  await runClaude(cmd, ['plugin', 'marketplace', 'remove', 'squadra'], opts)
  try {
    await runClaude(cmd, ['plugin', 'marketplace', 'add', PLUGIN_MARKETPLACE], opts)
  } catch (err) {
    // (The one it had goes back, so the machine isn't left without the plugin.)
    const before = `${PLUGIN_REPO}${m.ref ? `#${m.ref}` : ''}`
    let restored = false
    try { await runClaude(cmd, ['plugin', 'marketplace', 'add', before], opts); await runClaude(cmd, ['plugin', 'install', PLUGIN_ID], opts); restored = true } catch {}
    throw new Error(`could not add ${PLUGIN_MARKETPLACE} (${err.message.split('\n')[0]}); ${restored ? `the marketplace was put back as ${before}` : `putting back ${before} failed too: run "claude plugin marketplace add ${before} && claude plugin install ${PLUGIN_ID}" once the network is back`}`)
  }
  await runClaude(cmd, ['plugin', 'install', PLUGIN_ID], opts)
  log(`Squadra marketplace pinned to v${VERSION} (it was ${m.ref ? `at ${plain(m.ref)}` : 'following the default branch'})`)
  return true
}
let PLUGIN = null // { installed, version, enabled }, or null when it can't be told
// "0.0.1" < "0.0.2" (numeric parts; anything unreadable is not "older").
function olderVersion(a, b) {
  const p = v => String(v).split('.').map(x => Number.parseInt(x, 10))
  const [x, y] = [p(a), p(b)]
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return false
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
}

async function pluginStatus(cmd = claudeOrNull()) {
  if (!cmd) return null
  try {
    const { stdout } = await runClaude(cmd, ['plugin', 'list', '--json'], { timeout: 30_000, cwd: HOME })
    const p = JSON.parse(stdout).find(x => x?.id === PLUGIN_ID)
    return p ? { installed: true, version: typeof p.version === 'string' ? p.version : null, enabled: p.enabled !== false } : { installed: false, version: null, enabled: false }
  } catch {
    return null // Claude Code missing, or too old to list plugins as JSON
  }
}

// Install the plugin if it's missing (or enable it), or update it if it's there.
async function ensurePlugin({ update = false } = {}) {
  const cmd = claudeBinary()
  const opts = { timeout: 180_000, cwd: HOME }
  let st = await pluginStatus(cmd)
  if (st === null) throw new Error(`cannot run "${cmd} plugin list": install Claude Code (or set claude_command in ${SETTINGS_FILE})`)
  if (await pinMarketplace(cmd, opts)) {
    st = await pluginStatus(cmd)
  } else if (!st.installed) {
    // "add" fails if the marketplace is already there: the install decides.
    try { await runClaude(cmd, ['plugin', 'marketplace', 'add', PLUGIN_MARKETPLACE], opts) } catch {}
    await runClaude(cmd, ['plugin', 'install', PLUGIN_ID], opts)
  } else if (update) {
    await runClaude(cmd, ['plugin', 'marketplace', 'update', 'squadra'], opts)
    await runClaude(cmd, ['plugin', 'update', PLUGIN_ID], opts)
  }
  st = await pluginStatus(cmd)
  if (st?.installed && !st.enabled) { await runClaude(cmd, ['plugin', 'enable', PLUGIN_ID], opts); st = await pluginStatus(cmd) }
  if (!st?.installed) throw new Error('the plugin did not install')
  PLUGIN = st
  return st
}

// Claude Code's config folder, as the plugin takes it: an empty or relative
// CLAUDE_CONFIG_DIR counts as unset.
const claudeHome = () => { const c = process.env.CLAUDE_CONFIG_DIR; return c && isAbsolute(c) ? c : join(HOME, '.claude') }

// The plugin's settings on this machine (its .env), read like the plugin does.
function pluginEnv() {
  const out = {}
  try {
    for (const line of readFileSync(join(claudeHome(), 'channels', 'squadra', '.env'), 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m) out[m[1].replace(/^SWARM_/, 'SQUADRA_')] = m[2]
    }
  } catch {}
  return out
}
const pluginServerUrl = () => { const u = pluginEnv().SQUADRA_URL; return u && /^https?:\/\/\S+$/.test(u) ? u.replace(/\/+$/, '') : null }
// The plugin's rule for its own folders (paths.js safeChain): the folder is
// this user's and nobody else can write to it (a private group is fine), and
// every folder above is this user's or root's and nobody else can rename what
// is in it (sticky is fine; a shared group isn't); no symlink on the way.
// Missing folders count by the nearest one above that exists.
function privateChain(path, upTo = path) {
  const me = typeof process.getuid === 'function' ? process.getuid() : null
  let below = true // (up to upTo, included: the strict rule)
  for (let d = resolve(path); ; d = dirname(d)) {
    let st = null
    try { st = lstatSync(d) } catch (err) { if (err.code !== 'ENOENT') return false }
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) return false
      const sticky = !!(st.mode & 0o1000)
      if (below) {
        if ((me !== null && st.uid !== me) || (st.mode & 0o002) || ((st.mode & 0o020) && !privateGroup(st.gid))) return false
      } else if ((me !== null && st.uid !== me && st.uid !== 0) || ((st.mode & 0o002) && !sticky) ||
        ((st.mode & 0o020) && !sticky && !privateGroup(st.gid) && st.gid !== 0 && !(platform() === 'darwin' && st.gid === 80))) return false
    }
    if (d === resolve(upTo)) below = false
    if (dirname(d) === d) return true
  }
}

function pluginStateDir(name) {
  // The same folder the plugin uses: one per name, also inside a custom state folder.
  // (The plugin only accepts a custom folder that is this user's and that
  // others can't write to: the same rule here, or the two would disagree.)
  let custom = pluginEnv().SQUADRA_STATE_DIR
  if (custom && isAbsolute(custom)) custom = privateChain(realOr(custom)) ? realOr(custom) : null
  else custom = null
  return join(custom ?? join(claudeHome(), 'channels', 'squadra'), name)
}

// A private file in a private folder, never through a symlink: written to a
// new temporary file, then renamed over the old one (a rename replaces a
// symlink itself, it doesn't write where it points).
function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain folder`)
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`)
}
// Images pasted in the dashboard's terminal: saved here (kept a day), and
// their path pasted into Claude Code, which attaches an image file whose
// path is pasted (as when one is dragged into a terminal).
const PASTE_DIR = join(CONFIG_DIR, 'pasted')
const IMAGE_TYPES = {
  'image/png': ['png', b => b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG'],
  'image/jpeg': ['jpg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  'image/gif': ['gif', b => b.toString('latin1', 0, 4) === 'GIF8'],
  'image/webp': ['webp', b => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
}
function savePastedImage(term, type, data) {
  const kind = typeof type === 'string' && Object.hasOwn(IMAGE_TYPES, type) ? IMAGE_TYPES[type] : null
  if (!kind || typeof data !== 'string' || data.length > 800_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null
  const buf = Buffer.from(data, 'base64')
  if (buf.length < 12 || buf.length > 600_000 || !kind[1](buf)) return null
  ensurePrivateDir(PASTE_DIR)
  try {
    for (const f of readdirSync(PASTE_DIR)) {
      const p = join(PASTE_DIR, f)
      try { const st = lstatSync(p); if (st.isFile() && Date.now() - st.mtimeMs > 86_400_000) rmSync(p, { force: true }) } catch {}
    }
  } catch {}
  const file = join(PASTE_DIR, `${term}-${Date.now()}-${randomBytes(4).toString('hex')}.${kind[0]}`)
  writeFileSync(file, buf, { mode: 0o600, flag: 'wx' })
  return file
}

function writePrivate(dir, file, data) {
  ensurePrivateDir(dir)
  const tmp = join(dir, `.${file}.${process.pid}.${Date.now()}`)
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(tmp, join(dir, file))
}

// One open at a time: the session limit is checked against what is running,
// so concurrent requests must not all pass the same check.
let openQueue = Promise.resolve()
let openPending = 0
function openTerminal(spec) {
  // At most a few waiting: a server can't pile up requests (and their specs) here.
  if (openPending >= 3) return Promise.reject(new Error('this machine is busy opening sessions; try again'))
  openPending++
  const run = openQueue.then(() => openTerminalNow(spec)).finally(() => { openPending-- })
  openQueue = run.catch(() => {})
  return run
}

async function openTerminalNow(spec) {
  const settings = loadSettings()
  const s = validateSpec(spec, settings, await listTerminals())
  const claude = claudeBinary(settings.claude_command)
  // Without the plugin the session would start, but never join Squadra.
  // Checked every time (opening a session is rare): it may have been removed.
  const st = await pluginStatus(claude)
  if (st) PLUGIN = st
  if (st && (!st.installed || !st.enabled)) {
    throw new Error(`the Squadra plugin is ${PLUGIN.installed ? 'disabled' : 'not installed'} in Claude Code on this machine. Run "squadra-host plugin" there, or: ${PLUGIN_COMMANDS}`)
  }
  // An older plugin can't talk to this server (it doesn't send its session id).
  if (st?.version && olderVersion(st.version, VERSION)) {
    throw new Error(`the Squadra plugin on this machine is ${plain(st.version)}, older than this squadra-host (${VERSION}): run "squadra-host plugin" there, then open the session again`)
  }
  // Where the plugin keeps this name's state: its launch file (role and
  // coordinator, read instead of environment variables) and, when the server
  // reserved the name for this machine, its identity.
  // The plugin ignores a CLAUDE_CONFIG_DIR inside the highest folder above the
  // session's folder that doesn't contain the home (a repository could plant
  // one): it would never find what is written here. Said now, not silently.
  if (process.env.CLAUDE_CONFIG_DIR && isAbsolute(process.env.CLAUDE_CONFIG_DIR)) {
    const cfg = realOr(process.env.CLAUDE_CONFIG_DIR)
    let top = null
    const home = realOr(HOME)
    for (let d = s.folder; !withinById(home, d) && !withinById(HOME, d); d = dirname(d)) { top = d; if (dirname(d) === d) break }
    if (top && withinById(cfg, top)) throw new Error(`CLAUDE_CONFIG_DIR (${cfg}) is inside ${top}, like the session's folder: the Squadra plugin would ignore it. Move it, or open sessions in folders elsewhere`)
    // Nor one that isn't private, it or a folder above it (the plugin
    // ignores that too: the same rule).
    if (!privateChain(join(cfg, 'channels', 'squadra'), cfg)) throw new Error(`CLAUDE_CONFIG_DIR (${cfg}) must be a folder of this user that others can't write to, inside folders nobody else can change`)
  }
  // The secret the server reserved goes only to that server: the plugin
  // here must be configured for it (same origin), or the session isn't opened.
  const origin = u => { try { return new URL(u).origin } catch { return null } }
  if (s.identity && CREDS_SERVER && origin(pluginServerUrl()) !== origin(CREDS_SERVER)) {
    throw new Error(`the Squadra plugin on this machine is configured for ${pluginServerUrl() ?? 'no server'}, but this machine belongs to ${CREDS_SERVER}: set SQUADRA_URL=${CREDS_SERVER} in ${join(claudeHome(), 'channels', 'squadra', '.env')}`)
  }
  const dir = pluginStateDir(s.name)
  // (A session in the home folder reaches everything of this user: its
  // permission prompts are answered only in its own terminal.)
  const relay = settings.permission_relay && !s.home && s.role !== 'solo'
  writePrivate(dir, 'launch.json', { name: s.name, role: s.role, coordinator: s.coordinator, ...(relay ? {} : { permission_relay: false }) })
  // If anything below fails, no ticket (launch.json) is left for a later start.
  try { return await startSession(s, settings, claude, dir) } catch (err) {
    rmSync(join(dir, 'launch.json'), { force: true })
    throw err
  }
}

async function startSession(s, settings, claude, dir) {
  if (s.identity) writePrivate(dir, 'identity.json', { name: s.name, secret: s.identity, server: pluginServerUrl() })
  const tname = PREFIX + s.name
  const env = { SQUADRA_NAME: s.name }
  if (s.compact_window) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(s.compact_window)
  if (!settings.permission_relay || s.home || s.role === 'solo') env.SQUADRA_PERMISSION_RELAY = 'off'
  // Fixed command. Two or more arguments make tmux exec it directly, no shell.
  // "env -u TMUX" hides the tmux server from the session: its tools can't
  // simply run "tmux send-keys" into another session. (They run as the same
  // user, so this is a speed bump, not a wall: see the README.)
  // Claude Code's config folder is this program's, not the one the tmux
  // server started with (it outlives restarts of this program).
  const cfg = process.env.CLAUDE_CONFIG_DIR
  if (cfg && isAbsolute(cfg)) env.CLAUDE_CONFIG_DIR = cfg
  // (A standalone session takes no messages: no development channel, and so
  // no dialog about it at every start. The plugin still reports its activity.)
  const argv = ['/usr/bin/env', '-u', 'TMUX', '-u', 'TMUX_PANE', ...(env.CLAUDE_CONFIG_DIR ? [] : ['-u', 'CLAUDE_CONFIG_DIR']), claude, ...(s.role === 'solo' ? [] : ['--dangerously-load-development-channels', 'plugin:squadra@squadra'])]
  if (s.resume) argv.push('--continue')
  const meta = JSON.stringify({ role: s.role, coordinator: s.coordinator, folder: s.folder, compact_window: s.compact_window })
  await tmux([
    'start-server', ';',
    'set-option', '-g', 'history-limit', '10000', ';',
    'set-option', '-g', 'exit-empty', 'off', ';',
    'new-session', '-d', '-s', tname, '-x', '120', '-y', '36', '-c', s.folder,
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...argv, ';',
    'set-option', '-t', `=${tname}:`, 'status', 'off', ';',
    'set-option', '-t', `=${tname}:`, '@squadra', meta,
  ])
  // The folder could have been swapped (e.g. for a symlink) between the check
  // and the start: make sure the session really is where it was allowed.
  // If that can't be checked, the session is closed too.
  // (Right after the start, until the command has really begun, tmux
  // reports its own folder: asked again for a few seconds.)
  let where = null, whereId = null
  for (let i = 0; i < 30; i++) {
    where = null; whereId = null
    try { where = realOr((await tmux(['display-message', '-p', '-t', `=${tname}:`, '#{pane_current_path}'])).stdout.replace(/\r?\n$/, '')) } catch {}
    try { const st = statSync(where); whereId = `${st.dev}:${st.ino}` } catch {}
    if (where === s.folder && whereId === s.folderId) break
    await new Promise(r => setTimeout(r, 100))
  }
  if (where !== s.folder || whereId !== s.folderId) {
    await tmux(['kill-session', '-t', `=${tname}`]).catch(() => {})
    rmSync(join(dir, 'launch.json'), { force: true }) // no ticket left for a later start
    throw new Error(where ? `the session started in ${where} instead of ${s.folder}; closed it` : 'could not check where the session started; closed it')
  }
  log(`opened "${plain(s.name)}" (${s.role}) in ${s.folder}`)
  return { id: s.name, name: s.name }
}

async function killTerminal(id) {
  if (!NAME_RE.test(String(id))) throw new Error('invalid session')
  const list = await listTerminals()
  if (!list.some(t => t.id === id)) throw new Error('no such session on this machine')
  await tmux(['kill-session', '-t', `=${PREFIX}${id}`]) // "=": exactly this name, never a prefix match
  try { rmSync(join(pluginStateDir(id), 'launch.json'), { force: true }) } catch {} // if it never got to use it
  log(`closed "${id}"`)
  return true
}

// --- live terminal: tmux control mode --------------------------------------------------
//
// While someone watches a session, a control-mode client is attached to it:
// tmux reports everything the pane prints (%output) and takes keys and size
// changes on stdin.

function decodeOutput(buf) {
  // Bytes below 0x20 and backslash come as \ooo (octal); everything else raw.
  const out = Buffer.alloc(buf.length)
  let n = 0
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    if (c === 0x5c && i + 3 < buf.length && buf[i + 1] >= 0x30 && buf[i + 1] <= 0x37) {
      out[n++] = ((buf[i + 1] - 48) << 6) | ((buf[i + 2] - 48) << 3) | (buf[i + 3] - 48)
      i += 3
    } else out[n++] = c
  }
  return out.subarray(0, n)
}

// The biggest piece of terminal output sent in one message (the server takes
// up to 8 MB per message; base64 adds a third).
const SCREEN_MAX_BYTES = 1024 * 1024

class Viewer {
  constructor(id, send, congested = () => false) {
    // congested(): the connection to the server isn't keeping up (it stopped
    // reading): output is dropped and a fresh screen sent once it drains.
    this.congested = congested
    this.id = id
    this.send = send
    this.tname = PREFIX + id
    this.ready = false
    this.held = [] // output that arrives while a screen snapshot is being taken
    this.cols = 120
    this.rows = 36
    // Read-only (-r) when this machine doesn't allow typing from the dashboard.
    // (A control-mode client can still send commands: what really stops
    // typing is the allow_input check on every message, in connect().)
    const ro = loadSettings().allow_input ? [] : ['-r']
    this.proc = spawn(tmuxBin(), ['-u', '-L', TMUX_SOCKET, '-f', '/dev/null', '-C', 'attach-session', ...ro, '-t', `=${this.tname}`], { env: tmuxEnv(), stdio: ['pipe', 'pipe', 'ignore'], cwd: HOME })
    this.proc.on('error', err => { log(`terminal of "${id}": ${err.message}`); this.closed = true; this.onExit?.() })
    this.proc.stdin.on('error', () => {})
    let pending = Buffer.alloc(0)
    this.proc.stdout.on('data', chunk => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      let i
      while ((i = pending.indexOf(0x0a)) >= 0) {
        const line = pending.subarray(0, i)
        pending = pending.subarray(i + 1)
        this.onLine(line)
      }
    })
    this.proc.on('exit', () => { this.closed = true; this.onExit?.() })
  }

  onLine(line) {
    if (line.subarray(0, 8).toString('latin1') === '%output ') {
      const sp = line.indexOf(0x20, 8)
      if (sp < 0) return
      const data = decodeOutput(line.subarray(sp + 1))
      if (!data.length) return
      if (!this.ready) {
        // Kept while a screen is captured: at most SCREEN_MAX_BYTES, the oldest goes first.
        this.held.push(data)
        this.heldBytes = (this.heldBytes ?? 0) + data.length
        while (this.heldBytes > SCREEN_MAX_BYTES && this.held.length > 1) this.heldBytes -= this.held.shift().length
        return
      }
      if (this.congested()) { this.stale = true; return }
      if (this.stale) { this.stale = false; void this.screen().catch(() => {}); return }
      this.send({ t: 'out', term: this.id, data: data.toString('base64') })
    } else if (line.subarray(0, 5).toString('latin1') === '%exit') {
      this.proc.stdin.end()
    }
  }

  command(cmd) {
    if (!this.closed) this.proc.stdin.write(cmd + '\n')
  }

  resize(cols, rows) {
    // Without typing allowed, the dashboard can't resize the session either
    // (it would shrink it for whoever uses it on this machine).
    if (!loadSettings().allow_input) return
    cols = Math.floor(Math.max(20, Math.min(Number(cols) || 120, 500)))
    rows = Math.floor(Math.max(5, Math.min(Number(rows) || 36, 200)))
    this.cols = cols; this.rows = rows
    this.command(`refresh-client -C ${cols}x${rows}`)
  }

  input(text) {
    const bytes = Buffer.from(String(text), 'utf8')
    for (let i = 0; i < bytes.length; i += 256) {
      const hex = [...bytes.subarray(i, i + 256)].map(b => b.toString(16).padStart(2, '0')).join(' ')
      this.command(`send-keys -t =${this.tname}: -H ${hex}`)
    }
  }

  // The current screen (plus some scrollback), redrawn from scratch.
  async screen() {
    // At most one capture a second per terminal (each one runs two tmux processes).
    const wait = 1000 - (Date.now() - (this.lastScreen ?? 0))
    if (wait > 0) {
      if (this.screenTimer) return
      this.screenTimer = setTimeout(() => { this.screenTimer = null; if (!this.closed) void this.screen().catch(() => {}) }, wait)
      this.screenTimer.unref?.()
      return
    }
    this.lastScreen = Date.now()
    this.ready = false
    await new Promise(r => setTimeout(r, 120)) // let the program redraw at the new size
    this.held = [] // what came before the capture is in it; what comes during it is sent after
    this.heldBytes = 0
    try {
      const { stdout: info } = await tmux(['display-message', '-p', '-t', `=${this.tname}:`, '#{history_size} #{pane_height} #{cursor_x} #{cursor_y}'])
      const [hist, height, cx, cy] = info.trim().split(' ').map(Number)
      const back = Math.min(hist, 1000)
      const { stdout } = await tmux(['capture-pane', '-p', '-e', '-t', `=${this.tname}:`, '-S', String(-back), '-E', String(height - 1)], { encoding: 'buffer' })
      let lines = stdout.toString('utf8').split('\n')
      if (lines.at(-1) === '') lines.pop()
      // At most SCREEN_MAX_BYTES (very colourful output can be huge): the
      // oldest scrollback lines go first.
      let size = lines.reduce((n, l) => n + Buffer.byteLength(l) + 6, 0)
      let start = 0
      while (size > SCREEN_MAX_BYTES && start < lines.length - 1) size -= Buffer.byteLength(lines[start++]) + 6
      lines = lines.slice(start).map(l => (Buffer.byteLength(l) > SCREEN_MAX_BYTES ? Buffer.from(l).subarray(0, SCREEN_MAX_BYTES).toString('utf8') : l))
      const data = '\x1b[0m\x1b[H\x1b[2J\x1b[3J' + lines.join('\x1b[0m\r\n') + `\x1b[${cy + 1};${cx + 1}H`
      if (this.congested()) this.stale = true
      else this.send({ t: 'screen', term: this.id, data: Buffer.from(data, 'utf8').toString('base64'), cols: this.cols, rows: this.rows })
    } finally {
      const held = Buffer.concat(this.held)
      this.held = []
      this.heldBytes = 0
      if (!this.stale) for (let i = 0; i < held.length; i += SCREEN_MAX_BYTES) this.send({ t: 'out', term: this.id, data: held.subarray(i, i + SCREEN_MAX_BYTES).toString('base64') })
      this.ready = true
    }
  }

  close() {
    if (this.closed) return
    this.command('detach-client')
    setTimeout(() => this.proc.kill(), 500).unref()
  }
}

// --- connection to the server ------------------------------------------------------------

function wsUrl(server) {
  const u = new URL(server)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = u.pathname.replace(/\/+$/, '') + '/host/connect'
  return u.toString()
}

async function hostInfo() {
  const settings = loadSettings()
  const tv = await tmuxVersion()
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    node: process.version,
    tmux: tv?.text ?? null,
    claude: CLAUDE_VERSION,
    plugin: PLUGIN,
    version: VERSION,
    folders: settings.folders,
    // Which of them is the home folder (allowed only with --allow-home), and
    // whether the dashboard may change them.
    home: settings.allow_home ? HOME : null,
    folders_from_dashboard: settings.folders_from_dashboard,
    max_sessions: settings.max_sessions,
    allow_input: settings.allow_input,
    terminals: await listTerminals(),
  }
}

let CLAUDE_VERSION = null

let CREDS_SERVER = null // the server this machine is enrolled with
async function connect(creds) {
  CREDS_SERVER = creds.server
  const viewers = new Map() // terminal id -> Viewer
  const reattaches = new Map() // terminal id -> recent automatic re-attaches
  let ws = null
  let backoff = 1000
  let connectedAt = 0
  let termMsgs = []
  const TERM_MSG_MAX = 300
  // The session list for a burst of attaches: one tmux call a second at most.
  let termCache = null
  const listTerminalsCached = async () => {
    if (!termCache || Date.now() - termCache.at > 1000) termCache = { at: Date.now(), list: listTerminals() }
    return termCache.list
  }
  let lastTerminals = ''

  // A server that stops reading can't make this program hold its replies
  // forever: past 16 MB waiting, the connection is dropped (and made again).
  const send = msg => {
    if (ws?.readyState !== 1) return
    if (ws.bufferedAmount > 16 * 1024 * 1024) return dropConnection('the server is not reading')
    ws.send(JSON.stringify(msg))
  }
  // Give up on this connection and reconnect: closed, and the loop moves on
  // even if the close never completes (a server that stopped reading).
  let settleNow = null
  let diagnosed = false // (reset once connected)
  let lastFromServer = Date.now()
  const dropConnection = reason => {
    try { ws?.close(4008, String(reason).slice(0, 100)) } catch {}
    const settle = settleNow
    setTimeout(() => settle?.({ code: 0, reason }), 2000).unref()
  }
  // The server answers every ping (25 s): nothing from it for 90 s means it
  // silently went away (network change, sleep, a stalled proxy).
  // And a handshake that gets no answer in 30 s is given up (the socket's
  // own wait is 300 s, one more left hanging per retry): its handlers go
  // first, so closing it can't fire them, and a late open just closes it.
  setInterval(() => {
    if (ws?.readyState === 1 && Date.now() - lastFromServer > 90_000) dropConnection('nothing from the server for 90 seconds')
    if (ws?.readyState === 0 && settleNow && Date.now() - lastFromServer > 30_000) {
      const sock = ws, settle = settleNow
      sock.onmessage = sock.onerror = sock.onclose = null
      sock.onopen = () => { try { sock.close(1000) } catch {} }
      try { sock.close() } catch {}
      settle({ code: 0, reason: 'the server did not answer the connection in 30 seconds' })
    }
  }, 15_000).unref()

  // One at a time: overlapping calls share the one running (plus one more
  // after it), so nothing can make it start many tmux processes at once.
  let infoRunning = null, infoAgain = false, infoForce = false
  const pushInfo = (force = false) => {
    infoForce ||= force
    if (infoRunning) { infoAgain = true; return infoRunning }
    infoRunning = (async () => {
      try {
        do { infoAgain = false; const f = infoForce; infoForce = false; await pushInfoNow(f) } while (infoAgain)
      } finally { infoRunning = null }
    })()
    return infoRunning
  }
  const pushInfoNow = async (force = false) => {
    const info = await hostInfo()
    const key = JSON.stringify(info)
    if (force || key !== lastTerminals) { lastTerminals = key; send({ t: 'info', info }) }
    // Viewers of sessions that ended.
    for (const [id, v] of viewers) if (!info.terminals.some(t => t.id === id)) { v.close(); viewers.delete(id); send({ t: 'exit', term: id }) }
  }

  const handlers = {
    // Push the info either way: a refusal may have found the plugin missing.
    async open(m) { try { return await openTerminal(m.spec) } finally { await pushInfo() } },
    async kill(m) { const r = await killTerminal(m.term); await pushInfo(); return r },
    // The dashboard adds or removes an allowed folder: the same checks as
    // here, unless this machine keeps its folders to itself.
    async folders(m) {
      if (!loadSettings().folders_from_dashboard) throw new Error(`this machine doesn't let the dashboard change its folders ("folders_from_dashboard": false): change them there with "squadra-host folders add <path>"`)
      const list = changeFolders(m.action, m.path)
      log(`folder ${m.action === 'add' ? 'allowed' : 'removed'} from the dashboard: ${plain(m.path)}`)
      await pushInfo()
      return { folders: list }
    },
  }

  async function onMessage(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return
    // Every message from the server counts (each one can start tmux):
    // at most TERM_MSG_MAX every 10 seconds, the rest is dropped.
    const now = Date.now()
    termMsgs = termMsgs.filter(t => now - t < 10_000)
    if (termMsgs.length >= TERM_MSG_MAX) return
    termMsgs.push(now)
    if (m.t === 'welcome') {
      diagnosed = false
      if (connectedAt) return // once per connection
      log(`connected to ${creds.server} as "${plain(m.host?.name).slice(0, 64)}"`); connectedAt = Date.now(); return pushInfo(true)
    }
    if (Object.hasOwn(handlers, m.t)) {
      if (!Number.isSafeInteger(m.req)) return // replies echo only a request number
      try { send({ t: 'reply', req: m.req, ok: true, result: await handlers[m.t](m) }) }
      catch (err) { send({ t: 'reply', req: m.req, ok: false, error: String(err.message).slice(0, 500) }) }
      return
    }
    const id = String(m.term ?? '')
    if (!NAME_RE.test(id)) return // session ids also end up in tmux commands
    if (m.t === 'attach') {
      let v = viewers.get(id)
      // Already watched: just a new size and a fresh screen (rate-limited).
      if (v) { v.resize(m.cols, m.rows); return v.screen().catch(() => {}) }
      if (!(await listTerminalsCached()).some(t => t.id === id)) return send({ t: 'exit', term: id })
      v = viewers.get(id)
      if (!v) {
        v = new Viewer(id, send, () => (ws?.bufferedAmount ?? 0) > 4 * 1024 * 1024)
        // tmux ends the control client when the session ends: tell the viewers.
        v.onExit = async () => {
          const ours = viewers.get(id) === v
          if (ours) viewers.delete(id)
          const alive = (await listTerminals()).some(t => t.id === id)
          if (!alive) send({ t: 'exit', term: id })
          // Its viewing client ended but the session didn't (detached on
          // the machine itself): watched again, a few times a minute at most.
          else if (ours && !v.unwanted) {
            const t = Date.now()
            reattaches.set(id, (reattaches.get(id) ?? []).filter(x => t - x < 60_000).concat(t))
            if (reattaches.get(id).length <= 3) void onMessage({ t: 'attach', term: id, cols: v.cols, rows: v.rows }).catch(() => {})
            else send({ t: 'notice', term: id, text: 'the terminal view stopped (the session was detached on the machine): open it again' })
          }
          void pushInfo()
        }
        viewers.set(id, v)
      }
      v.resize(m.cols, m.rows)
      return v.screen().catch(err => log(`screen of "${id}": ${err.message}`))
    }
    const v = viewers.get(id)
    if (!v) return
    if (m.t === 'detach') { v.unwanted = true; v.close(); viewers.delete(id); return }
    if (m.t === 'resize') { v.resize(m.cols, m.rows); return }
    if (m.t === 'refresh') return v.screen().catch(() => {})
    if (m.t === 'in') {
      if (!loadSettings().allow_input) return send({ t: 'notice', term: id, text: 'typing from the dashboard is turned off on this machine (allow_input: false)' })
      if (typeof m.data === 'string' && m.data.length <= 64 * 1024) v.input(m.data)
    }
    if (m.t === 'image') {
      if (!loadSettings().allow_input) return send({ t: 'notice', term: id, text: 'typing from the dashboard is turned off on this machine (allow_input: false)' })
      let file = null
      try { file = savePastedImage(id, m.type, m.data) } catch (err) { log(`pasted image for "${id}": ${err.message}`) }
      if (!file) return send({ t: 'notice', term: id, text: 'the pasted image could not be used (PNG, JPEG, GIF or WebP, up to 600 KB)' })
      // Pasted as tmux pastes (bracketed when the program asked for it), so
      // Claude Code sees a paste and attaches the image.
      await tmux(['set-buffer', '-b', 'squadra-image', file, ';', 'paste-buffer', '-p', '-d', '-b', 'squadra-image', '-t', `=${PREFIX}${id}:`]).catch(err => log(`pasting an image into "${id}": ${err.message}`))
    }
  }

  setInterval(() => { if (ws?.readyState === 1) void pushInfo().catch(() => {}) }, 3000).unref()
  setInterval(() => send({ t: 'ping' }), 25_000).unref()
  // Viewers that missed output while the connection was congested: a fresh
  // screen once it has drained.
  setInterval(() => {
    if ((ws?.bufferedAmount ?? 0) > 4 * 1024 * 1024) return
    for (const v of viewers.values()) if (v.stale) { v.stale = false; void v.screen().catch(() => {}) }
  }, 1000).unref()

  for (;;) {
    const closed = await new Promise(resolveOnce => {
      // Settled once, by whichever comes first: a failed handshake fires only
      // "error" (never "close") in Node 22's WebSocket, and nothing else would
      // keep this program alive — it would end quietly and never reconnect.
      let settled = false
      const resolveClose = r => { if (!settled) { settled = true; settleNow = null; resolveOnce(r) } }
      settleNow = resolveClose
      lastFromServer = Date.now()
      // The credential goes with the request (as a subprotocol): the server
      // accepts no socket it can't authenticate first.
      try { ws = new WebSocket(wsUrl(creds.server), ['squadra', `auth.${creds.secret}`]) } catch (err) { return resolveClose({ code: 0, reason: err.message }) }
      ws.onopen = async () => {
        // A server that doesn't speak this protocol (older than this program).
        if (ws.protocol !== 'squadra') { try { ws.close(1000) } catch {} ; return resolveClose({ code: 0, reason: 'the server is older than this squadra-host: update the server' }) }
        // A small hello: the full info follows the server's welcome.
        ws.send(JSON.stringify({ t: 'hello', id: creds.id }))
      }
      ws.onmessage = ev => {
        lastFromServer = Date.now()
        // Nothing the server legitimately sends is this big.
        if (typeof ev.data !== 'string' || ev.data.length > 1024 * 1024) { try { ws.close(4009, 'message too big') } catch {} ; return }
        let m
        try { m = JSON.parse(ev.data) } catch { return }
        onMessage(m).catch(err => log(`${plain(m?.t)}: ${err.message}`))
      }
      ws.onerror = ev => {
        const sock = ws
        sock.onerror = null // (closing it fires "error" again)
        const opened = sock.readyState === 1 || sock.readyState === 2
        const reason = ev?.message ?? ev?.error?.message ?? 'could not connect'
        try { sock.close() } catch {}
        // The handshake failed: WebSocket doesn't say why, so the server is
        // asked plainly once (per run of failures) to tell what's wrong.
        if (opened || diagnosed) return resolveClose({ code: 0, reason })
        diagnosed = true
        diagnose(creds.server).then(why => resolveClose({ code: 0, reason: why ?? reason }), () => resolveClose({ code: 0, reason }))
      }
      ws.onclose = ev => resolveClose({ code: ev.code, reason: ev.reason })
    })
    for (const v of viewers.values()) v.close()
    viewers.clear()
    // Exit 0: the service manager doesn't start it again (it would be refused forever).
    if (closed.code === 4001) die('the server no longer accepts this machine (it was disconnected from the dashboard). Enroll it again with a new command from the dashboard.', 0)
    // Back to a short wait only after a connection that lasted: a server
    // that drops (or crashes) this program right after it connects is retried
    // more and more slowly.
    if (connectedAt && Date.now() - connectedAt > 60_000) backoff = 1000
    connectedAt = 0
    log(`connection lost${closed.reason ? ` (${plain(closed.reason)})` : ''}; retrying in ${Math.round(backoff / 1000)} s`)
    await new Promise(r => setTimeout(r, backoff))
    backoff = Math.min(backoff * 2, 30_000)
  }
}

// Why a connection can't be made, in words: the server's own answer to a
// plain request (its version, or an HTTP status), or the network/TLS error.
async function diagnose(server) {
  try {
    const res = await fetch(`${String(server).replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(10_000), redirect: 'error' })
    if (!res.ok) return `the server answered HTTP ${res.status}`
    const j = await res.json().catch(() => null)
    const v = typeof j?.version === 'string' ? j.version : null
    if (v && olderVersion(v, VERSION)) return `the server is version ${plain(v)}, older than this squadra-host (${VERSION}): update the server`
    return `the server is up${v ? ` (version ${plain(v)})` : ''} but refused the connection (is this machine still enrolled there?)`
  } catch (err) {
    const c = err?.cause
    return `cannot reach the server: ${plain(c?.code ?? '')} ${plain(c?.message ?? err?.message ?? '')}`.trim()
  }
}

// --- commands ------------------------------------------------------------------------------

const USAGE = `Usage: squadra-host [command] [options]

  squadra-host                       Connect to the server (the service does this for you)
  squadra-host status                This machine's server, settings and sessions
  squadra-host folders               Folders where sessions may be opened (also from the dashboard)
  squadra-host folders add <path>    Allow one more (folders remove <path> to take one away)
  squadra-host update                Update squadra-host and the plugin to the server's version
  squadra-host plugin                Install or update the Squadra plugin in Claude Code
  squadra-host service               Run in the background and start with the computer
                                     (service remove: stop doing that; service print: show the file)
  squadra-host forget                Delete this machine's credential
  squadra-host enroll <server> <code>  Join a Squadra server: the dashboard gives you this
                                     command in Machines → + Add machine. It also installs the
                                     plugin, this command and the service

Options:
  --allow-home      allow your whole home folder for sessions (--no-allow-home to undo).
                    Sessions there reach all your files; their permission prompts are
                    answered only in their own terminal
  --insecure        (enroll) accept a plain http server, on a trusted private network only
  --no-plugin       (enroll) don't install the Squadra plugin
  --no-service      (enroll) don't install the service: run in this terminal

Settings: ${SETTINGS_FILE}
  folders                 sessions can only be opened inside these folders
  folders_from_dashboard  whether the dashboard may change them (default true)
  max_sessions            at most this many sessions at once (default 8)
  allow_input             whether the dashboard may type in the terminals (default true)
  allow_resume            whether a session may continue its folder's last conversation (default true)
  permission_relay        whether a worker's coordinator may answer its permission prompts
                          from another session (default: same as allow_input)
  coordinators            if set, the only coordinator names workers here may be given
  claude_command          the Claude Code executable (default "claude")
`

// Plain http only to this machine, or when asked for explicitly: otherwise
// anyone on the way could read the credentials or swap what the server says.
function checkScheme(server, insecure) {
  let u
  try { u = new URL(server) } catch { die(`invalid server URL: ${plain(server)}`, 2) }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') die('the server URL must start with https:// (or http:// on this machine)', 2)
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)
  if (u.protocol === 'http:' && !loopback && !insecure) {
    die(`refusing plain http to ${u.host}: credentials and terminals would travel unencrypted. Use https, or add --insecure if this is a trusted private network.`, 2)
  }
}

// Returns true when it left squadra-host running in the background (service).
async function enroll(server, code, { plugin = true, insecure = false, service = true } = {}) {
  if (!server || !code) die(`enroll needs the server URL and a code.\n\n${USAGE}`, 2)
  server = server.replace(/\/+$/, '')
  checkScheme(server, insecure)
  const info = await hostInfo()
  let res
  try {
    res = await fetch(`${server}/host/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim().toUpperCase(), info }),
      redirect: 'error',
    })
  } catch (err) { die(`cannot reach ${server}: ${err.cause?.message ?? err.message}`) }
  const j = await res.json().catch(() => ({}))
  if (!j.ok) die(`enrollment refused: ${plain(j.description ?? `HTTP ${res.status}`)}`)
  const r = j.result ?? {}
  if (typeof r.id !== 'string' || !/^h_[0-9a-f]{8,64}$/.test(r.id) || typeof r.secret !== 'string' || !/^sh_[A-Za-z0-9_-]{20,200}$/.test(r.secret)) {
    die('the server answered the enrollment with something unexpected')
  }
  writeJson(CREDENTIALS_FILE, { server, id: r.id, secret: r.secret, insecure })
  // No folder is allowed until the user says which (folders add): enrolling
  // from wherever the script was downloaded must not open that place up.
  if (!existsSync(SETTINGS_FILE)) writeJson(SETTINGS_FILE, { ...DEFAULT_SETTINGS, settings_version: SETTINGS_VERSION })
  // Keep a copy of this program next to its settings, for the service.
  const self = fileURLToPath(import.meta.url)
  if (resolve(self) !== resolve(INSTALLED_SCRIPT)) { try { copyFileSync(self, INSTALLED_SCRIPT) } catch {} }
  // Configure the Squadra plugin on this machine if it isn't yet.
  const pluginEnv = join(claudeHome(), 'channels', 'squadra', '.env')
  // Only a well-formed URL and token: anything else (a line break, say) could
  // add settings of its own to the plugin's .env.
  const pu = r.plugin?.url, pt = r.plugin?.token
  // Same server as the one enrolled with (no other origin, no http downgrade).
  const urlOk = typeof pu === 'string' && /^https?:\/\/[^\s]+$/.test(pu) && (() => { try { return new URL(pu).origin === new URL(server).origin } catch { return false } })()
  const tokenOk = pt == null || (typeof pt === 'string' && /^[\x21-\x7e]{16,256}$/.test(pt))
  if (r.plugin && (!urlOk || !tokenOk)) log('⚠️  the server sent an invalid plugin configuration: ignored')
  else if (r.plugin && pu && !existsSync(pluginEnv)) {
    // The server address always; the join token only if the dashboard
    // offered it (sessions opened from the dashboard don't need it).
    ensurePrivateDir(join(pluginEnv, '..'))
    writeFileSync(pluginEnv, `SQUADRA_URL=${pu}\n${pt ? `SQUADRA_SERVER_TOKEN=${pt}\n` : ''}`, { mode: 0o600, flag: 'wx' }) // never through a symlink
    log(`Squadra plugin configured for ${pu} (${pluginEnv})${pt ? '' : ', without a join token: only sessions opened from the dashboard can join'}`)
  }
  // Install the plugin itself, so sessions opened from the dashboard work unattended.
  if (plugin && info.claude) {
    try {
      const before = await pluginStatus()
      const st = await ensurePlugin()
      log(before?.installed && before.enabled ? `Squadra plugin ${st.version ?? ''} already installed in Claude Code` : `Squadra plugin ${st.version ?? ''} installed in Claude Code`)
    } catch (err) {
      log(`⚠️  could not install the Squadra plugin (${err.message.split('\n')[0]}). Install it with: ${PLUGIN_COMMANDS}`)
    }
  }
  // The "squadra-host" command and the service (not for a custom
  // SQUADRA_HOST_DIR: a second, separate setup, such as the tests').
  let launcher = null, svc = null
  if (process.env.SQUADRA_HOST_DIR) service = false
  else {
    try { launcher = installLauncher() } catch (err) { log(`⚠️  could not add the squadra-host command (${err.message})`) }
    if (service) { try { svc = await installService() } catch (err) { svc = { ok: false, why: err.message } } }
  }
  if (!info.tmux) log(`⚠️  tmux is not installed: install it (${TMUX_INSTALL}) before opening sessions.`)
  if (!info.claude) log(`⚠️  Claude Code was not found ("claude" is not on the PATH). Install it, then run: ${cli()} plugin`)
  if (svc && !svc.ok) log(`⚠️  could not leave it running in the background (${svc.why}): it runs here while this terminal stays open.`)
  process.stderr.write(`
squadra-host: this machine is now "${plain(r.name)}" on ${server}.
  ${svc?.ok ? `It runs in the background as ${svc.how}.` : 'It keeps running while this terminal stays open.'}
  Next, in the dashboard: Machines → this machine → + Folder, to choose where sessions may be opened.
  ${launcher?.onPath === false ? `The squadra-host command is in ${dirname(LAUNCHER)}: open a new terminal to use it (or add that folder to your PATH).` : launcher?.skipped ? `${LAUNCHER} already exists and isn't this program's: use node ${INSTALLED_SCRIPT}.` : 'Commands: squadra-host status · squadra-host help'}

`)
  return !!svc?.ok
}

// The settings file as written (for changing it), or an error if it can't be
// read: a settings file that can't be read is never rewritten from the
// defaults (that would turn typing and the relay back on).
function rawSettings() {
  let raw = {}
  try { raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read ${SETTINGS_FILE} (${err.message}): fix it by hand first`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${SETTINGS_FILE} must hold a JSON object: fix it by hand first`)
  const s = { ...DEFAULT_SETTINGS, ...raw }
  s.folders = Array.isArray(s.folders) ? s.folders.filter(f => typeof f === 'string') : []
  return s
}

// Add or remove an allowed folder (from this machine, or from the dashboard).
// "~" and "~/…" are the home folder. Returns the folders now allowed.
function changeFolders(action, path) {
  if (action !== 'add' && action !== 'remove') throw new Error('the action must be add or remove')
  if (typeof path !== 'string' || !path.trim() || path.length > 4096) throw new Error('a folder path is needed')
  path = path.trim()
  if (/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(path)) throw new Error('the path contains control characters')
  if (path === '~' || path.startsWith('~/')) path = join(HOME, path.slice(1))
  if (!isAbsolute(path)) throw new Error(`${plain(path)} is not an absolute path (start it with / or ~/)`)
  const s = rawSettings()
  const abs = resolve(path)
  if (action === 'add') {
    if (/[#;]/.test(abs)) throw new Error('folders with # or ; in their path cannot be used')
    let st = null
    try { st = statSync(abs) } catch {}
    if (!st) throw new Error(`${plain(abs)} does not exist on this machine`)
    if (!st.isDirectory()) throw new Error(`${plain(abs)} is not a folder`)
    const why = forbiddenFolder(realOr(abs), { allowHome: s.allow_home === true })
    if (why) throw new Error(`${plain(abs)} can't be allowed: it is ${why}`)
    if (!s.folders.includes(abs)) s.folders.push(abs)
  } else {
    const before = s.folders.length
    s.folders = s.folders.filter(f => f !== abs && resolve(f) !== abs)
    if (s.folders.length === before) throw new Error(`${plain(abs)} is not one of the allowed folders`)
  }
  writeJson(SETTINGS_FILE, s)
  return loadSettings().folders
}

function folders(action, path) {
  try {
    const list = action === 'add' || action === 'remove' ? changeFolders(action, path) : loadSettings().folders
    process.stdout.write((list.length ? list.join('\n') : '(no folders: no session can be opened)') + '\n')
  } catch (err) { die(err.message, 2) }
}

const TMUX_INSTALL = platform() === 'darwin' ? 'brew install tmux' : 'sudo apt install tmux (or your distribution\'s package)'

// systemd: a quoted word, with % (specifiers) escaped.
// Environment= is different: "$" means nothing there (only \\, " and % are special).
const sdEnv = v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
const sd = v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`
// PATH for the service, without relative entries.
const absolutePath = () => String(process.env.PATH ?? '').split(':').filter(d => isAbsolute(d)).join(':')
// And where this program and Claude Code keep their files, when they aren't
// the defaults (the service would otherwise look in the default places).
const serviceEnv = () => {
  const env = [['PATH', absolutePath()]]
  for (const k of ['SQUADRA_HOST_DIR', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR']) {
    const v = process.env[k]
    if (v && isAbsolute(v) && !/[\x00-\x1f\x7f]/.test(v)) env.push([k, v])
  }
  return env
}

// --- running in the background ----------------------------------------------------
//
// The enrollment installs and starts a service, so the machine keeps working
// after a restart with nothing else to do: a systemd user service on Linux
// (also WSL with systemd), a launchd agent on macOS.

// (Run as root — installed with --allow-root —: a system service, since root
// rarely has a systemd user session.)
const AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const SYSTEMD_UNIT = AS_ROOT ? '/etc/systemd/system/squadra-host.service' : join(process.env.XDG_CONFIG_HOME && isAbsolute(process.env.XDG_CONFIG_HOME) ? process.env.XDG_CONFIG_HOME : join(HOME, '.config'), 'systemd', 'user', 'squadra-host.service')
const userFlag = AS_ROOT ? [] : ['--user']
const LAUNCHD_PLIST = join(HOME, 'Library', 'LaunchAgents', 'com.squadra.host.plist')
// System tools only from the system's own folders.
const systemTool = name => ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map(d => join(d, name)).find(f => { try { accessSync(f, FS.X_OK); return true } catch { return false } }) ?? null

function serviceFile() {
  const node = process.execPath
  if (platform() === 'darwin') {
    const logFile = join(HOME, 'Library', 'Logs', 'squadra-host.log')
    const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return { path: LAUNCHD_PLIST, text: `<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by squadra-host. Log: ${x(logFile)} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.squadra.host</string>
  <key>ProgramArguments</key>
  <array><string>${x(node)}</string><string>${x(INSTALLED_SCRIPT)}</string></array>
  <key>EnvironmentVariables</key>
  <dict>${serviceEnv().map(([k, v]) => `<key>${x(k)}</key><string>${x(v)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardErrorPath</key><string>${x(logFile)}</string>
</dict>
</plist>
` }
  }
  return { path: SYSTEMD_UNIT, text: `# Written by squadra-host.
[Unit]
Description=Squadra host
After=network-online.target

[Service]
${AS_ROOT ? `User=root\nEnvironment=${sdEnv(`HOME=${HOME}`)}\n` : ''}ExecStart=${sd(node)} ${sd(INSTALLED_SCRIPT)}
Restart=on-failure
RestartSec=5
# (Stopping or restarting it leaves the sessions it opened running: tmux
# started from here would otherwise be stopped along with it.)
KillMode=process
# (2: not enrolled, or refused for good: starting it again won't help.)
RestartPreventExitStatus=2
${serviceEnv().map(([k, v]) => `Environment=${sdEnv(`${k}=${v}`)}`).join('\n')}

[Install]
WantedBy=${AS_ROOT ? 'multi-user.target' : 'default.target'}
` }
}

// Install (or update) the service and (re)start it. { ok, how } or { ok: false, why }.
async function installService() {
  const f = serviceFile()
  const write = () => {
    mkdirSync(dirname(f.path), { recursive: true })
    const tmp = `${f.path}.${process.pid}.tmp`
    writeFileSync(tmp, f.text, { mode: 0o644, flag: 'wx' })
    renameSync(tmp, f.path)
  }
  if (platform() === 'darwin') {
    const launchctl = systemTool('launchctl')
    if (!launchctl || typeof process.getuid !== 'function') return { ok: false, why: 'launchctl was not found' }
    write()
    const target = `gui/${process.getuid()}`
    await run(launchctl, ['bootout', target, f.path], { timeout: 30_000 }).catch(() => {}) // (an older copy, if loaded)
    try { await run(launchctl, ['bootstrap', target, f.path], { timeout: 30_000 }) } catch (err) { return { ok: false, why: `launchctl bootstrap failed (${String(err.stderr || err.message).trim().split('\n')[0]})` } }
    return { ok: true, how: `a launchd agent (${f.path}); it runs while you are logged in` }
  }
  const systemctl = systemTool('systemctl')
  if (!systemctl) return { ok: false, why: 'systemd was not found' }
  if (!AS_ROOT) {
    try { await run(systemctl, ['--user', 'show-environment'], { timeout: 15_000 }) } catch {
      return { ok: false, why: `there is no systemd user session here: run "sudo loginctl enable-linger ${userInfo().username}" and log in as this user directly (ssh), not with su (on WSL, enable systemd in /etc/wsl.conf)` }
    }
  }
  write()
  try {
    await run(systemctl, [...userFlag, 'daemon-reload'], { timeout: 30_000 })
    await run(systemctl, [...userFlag, 'enable', 'squadra-host'], { timeout: 30_000 })
    await run(systemctl, [...userFlag, 'restart', 'squadra-host'], { timeout: 30_000 })
  } catch (err) { return { ok: false, why: `systemctl failed (${String(err.stderr || err.message).trim().split('\n')[0]})` } }
  if (AS_ROOT) return { ok: true, how: `a system service (${f.path}); it starts with the machine` }
  // Running also while you are logged out (may need an administrator: optional).
  const loginctl = systemTool('loginctl')
  let linger = false
  if (loginctl) { try { await run(loginctl, ['enable-linger'], { timeout: 15_000 }); linger = true } catch {} }
  return { ok: true, how: `a systemd user service (${f.path})${linger ? '; it also runs while you are logged out' : '; it runs while you are logged in (for always: loginctl enable-linger $USER)'}` }
}

async function removeService() {
  if (platform() === 'darwin') {
    const launchctl = systemTool('launchctl')
    if (launchctl && typeof process.getuid === 'function') await run(launchctl, ['bootout', `gui/${process.getuid()}`, LAUNCHD_PLIST], { timeout: 30_000 }).catch(() => {})
    rmSync(LAUNCHD_PLIST, { force: true })
    return
  }
  const systemctl = systemTool('systemctl')
  if (systemctl) await run(systemctl, [...userFlag, 'disable', '--now', 'squadra-host'], { timeout: 30_000 }).catch(() => {})
  rmSync(SYSTEMD_UNIT, { force: true })
  if (systemctl) await run(systemctl, [...userFlag, 'daemon-reload'], { timeout: 30_000 }).catch(() => {})
}

async function service(action) {
  if (action === 'print') return process.stdout.write(serviceFile().text)
  if (action === 'remove') { await removeService(); return log('service removed: squadra-host no longer starts by itself (run it with: squadra-host)') }
  if (action && action !== 'install') die(`service ${plain(action)}: use "service", "service remove" or "service print"`, 2)
  const r = await installService()
  if (!r.ok) die(`could not install the service: ${r.why}. Run "squadra-host" in a terminal instead (it must stay open), or set it up by hand from "squadra-host service print".`)
  log(`running in the background as ${r.how}`)
}

// The "squadra-host" command: a small launcher in ~/.local/bin (in the PATH
// of most systems), so nobody has to type the path of this program.
const LAUNCHER = typeof process.getuid === 'function' && process.getuid() === 0 ? '/usr/local/bin/squadra-host' : join(HOME, '.local', 'bin', 'squadra-host')
const LAUNCHER_MARK = '# squadra-host launcher (written by squadra-host)'
const launcherOnPath = () => String(process.env.PATH ?? '').split(':').some(d => d && resolve(d) === dirname(LAUNCHER))
const cli = () => (existsSync(LAUNCHER) && launcherOnPath() ? 'squadra-host' : `node ${INSTALLED_SCRIPT}`)
function installLauncher() {
  const q = v => `'${String(v).replace(/'/g, `'\\''`)}'`
  try { if (!readFileSync(LAUNCHER, 'utf8').includes(LAUNCHER_MARK)) return { skipped: true } } catch {} // (someone else's: left alone)
  mkdirSync(dirname(LAUNCHER), { recursive: true, mode: 0o755 })
  const tmp = `${LAUNCHER}.${process.pid}.tmp`
  writeFileSync(tmp, `#!/bin/sh\n${LAUNCHER_MARK}\nN=${q(process.execPath)}\n[ -x "$N" ] || N=node\nexec "$N" ${q(INSTALLED_SCRIPT)} "$@"\n`, { mode: 0o755, flag: 'wx' })
  renameSync(tmp, LAUNCHER)
  return { onPath: launcherOnPath() }
}

// One squadra-host at a time per machine (two would keep replacing each
// other's connection): the one running says so in a pid file.
const PID_FILE = join(CONFIG_DIR, 'squadra-host.pid')
function runningInstance() {
  let pid
  try { pid = Number(readFileSync(PID_FILE, 'utf8').trim()) } catch { return null }
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return null
  try { process.kill(pid, 0) } catch (err) { if (err.code === 'ESRCH') return null }
  // (A pid reused by another program isn't this one.)
  let cmd = ''
  try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch {
    try { cmd = execFileSync(systemTool('ps') ?? '/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 }) } catch {}
  }
  return cmd.includes('squadra-host') ? pid : null
}
function claimInstance() {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(PID_FILE, `${process.pid}\n`, { mode: 0o600 })
  const release = () => { try { if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) rmSync(PID_FILE, { force: true }) } catch {} }
  process.on('exit', release)
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { release(); process.exit(0) })
}

// squadra-host update: this program as the server has it now, then the
// plugin that goes with it and the service restarted (the sessions stay).
async function update() {
  const creds = readJson(CREDENTIALS_FILE, null)
  if (!creds?.server) die('this machine is not enrolled: there is no server to update from', 2)
  checkScheme(creds.server, creds.insecure === true)
  let body
  try {
    const res = await fetch(`${creds.server}/host/squadra-host.mjs`, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    body = Buffer.from(await res.arrayBuffer())
  } catch (err) { die(`cannot download squadra-host from ${creds.server}: ${err.cause?.message ?? err.message}`) }
  const v = body.length < 4 * 1024 * 1024 ? /^const VERSION = '([0-9][0-9A-Za-z.-]{0,30})'$/m.exec(body.toString('utf8'))?.[1] : null
  if (!v) die('the server did not send squadra-host: nothing was changed')
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${INSTALLED_SCRIPT}.${process.pid}.tmp`
  writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' })
  renameSync(tmp, INSTALLED_SCRIPT)
  log(v === VERSION ? `squadra-host ${v} is the server's version` : `squadra-host updated: ${VERSION} → ${plain(v)}`)
  // (The new copy does the rest: its plugin version, its service file.)
  const again = args => { try { execFileSync(process.execPath, [INSTALLED_SCRIPT, ...args], { stdio: 'inherit', timeout: 600_000 }) } catch {} }
  again(['plugin'])
  if (existsSync(serviceFile().path)) again(['service'])
  else if (runningInstance()) log('restart squadra-host to use the new version')
  try { installLauncher() } catch {}
}

// settings.json written by an older version: what were only its defaults
// then become today's (once; "settings_version" says it was done). Up to
// 0.0.2 every file was written with "allow_resume": false, the old default.
const SETTINGS_VERSION = 3
function migrateSettings() {
  let raw
  try { raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) } catch { return }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Number.isInteger(raw.settings_version)) return
  if (raw.allow_resume === false) { delete raw.allow_resume; log('settings.json: continuing the last conversation is now allowed (the new default; set "allow_resume": false to turn it off)') }
  raw.settings_version = SETTINGS_VERSION
  try { writeJson(SETTINGS_FILE, raw) } catch {}
}

// --allow-home / --no-allow-home: the home folder itself as a place for
// sessions (kept in settings.json, so the service keeps it too).
function setAllowHome(on) {
  const s = rawSettings()
  s.allow_home = on
  s.folders = s.folders.filter(f => !isHome(realOr(f)))
  if (on) s.folders.push(HOME)
  writeJson(SETTINGS_FILE, s)
  if (on) log(`your home folder (${HOME}) is now allowed for sessions. Sessions opened there can reach all of this user's files; their permission prompts are answered only in their own terminal, never by a coordinator. To undo it: squadra-host --no-allow-home`)
  else log('your home folder is no longer allowed for sessions')
}

async function main() {
  if (platform() === 'win32') die('squadra-host does not run on native Windows (it needs tmux). Run it inside WSL, for example Ubuntu, together with Claude Code: see "Windows (WSL)" in docs/reference.md.')
  const argv = process.argv.slice(2)
  if (['-h', '--help', 'help'].includes(argv[0])) return process.stdout.write(USAGE)
  if (['-v', '--version', 'version'].includes(argv[0])) return process.stdout.write(`squadra-host ${VERSION}\n`)
  migrateSettings()
  const flags = new Set(argv.filter(a => a.startsWith('--')))
  const [cmd = 'run', ...rest] = argv.filter(a => !a.startsWith('--'))
  const known = ['--allow-home', '--no-allow-home', '--insecure', '--no-plugin', '--no-service']
  for (const f of flags) if (!known.includes(f)) die(`unknown option ${plain(f)}\n\n${USAGE}`, 2)
  if (flags.has('--allow-home') && flags.has('--no-allow-home')) die('--allow-home or --no-allow-home, not both', 2)
  if (flags.has('--allow-home') || flags.has('--no-allow-home')) {
    try { setAllowHome(flags.has('--allow-home')) } catch (err) { die(err.message, 2) }
    // Already running (as the service, say): it reads its settings as it goes.
    const other = runningInstance()
    if (cmd === 'run' && other) return log(`squadra-host is already running (pid ${other}): it uses this from now on`)
  }
  if (cmd === 'folders') return folders(rest[0], rest[1])
  if (cmd === 'service') return service(rest[0])
  if (cmd === 'update') return update()
  if (cmd === 'forget') { rmSync(CREDENTIALS_FILE, { force: true }); return log('credential deleted') }
  if (cmd === 'status') {
    const creds = readJson(CREDENTIALS_FILE, null)
    process.stdout.write(JSON.stringify({ server: creds?.server ?? null, running: runningInstance() ? { pid: runningInstance() } : false, service: existsSync(serviceFile().path) ? serviceFile().path : null, settings: loadSettings(), terminals: await listTerminals() }, null, 2) + '\n')
    return
  }
  if (typeof WebSocket !== 'function') die(`Node ${process.version} has no WebSocket: use Node 22 or newer`)
  const tv = await tmuxVersion()
  if (tv && (tv.major < 3 || (tv.major === 3 && tv.minor < 2))) die(`${tv.text} is too old: squadra-host needs tmux 3.2 or newer`)
  CLAUDE_VERSION = claudeOrNull() ? await claudeVersion(claudeOrNull()) : null
  if (cmd === 'plugin') {
    try { const st = await ensurePlugin({ update: true }); return log(`Squadra plugin ${st.version ?? ''} is installed and up to date. Restart open sessions to use a new version.`) }
    catch (err) { die(`${err.message.split('\n')[0]}\nInstall it by hand with: ${PLUGIN_COMMANDS}`) }
  }
  if (cmd === 'enroll') {
    // Enrolled and left running as a service: nothing more to do here.
    if (await enroll(rest[0], rest[1], { plugin: !flags.has('--no-plugin'), insecure: flags.has('--insecure'), service: !flags.has('--no-service') })) return
  }
  else if (cmd !== 'run') die(`unknown command "${plain(cmd)}"\n\n${USAGE}`, 2)
  {
    const other = runningInstance()
    if (other) die(`squadra-host is already running on this machine (pid ${other}${existsSync(serviceFile().path) ? ', as a service' : ''}): nothing to do. To stop the service: squadra-host service remove`)
    claimInstance()
  }
  const creds = readJson(CREDENTIALS_FILE, null)
  if (creds?.server) checkScheme(creds.server, creds.insecure === true)
  if (!creds?.server || !creds?.secret) die(`this machine is not enrolled yet. In the dashboard, open Machines → + Add machine and run the command it shows.\n\n${USAGE}`, 2)
  if (!tv) log(`⚠️  tmux is not installed: sessions cannot be opened until it is (${TMUX_INSTALL}).`)
  PLUGIN = await pluginStatus()
  if (PLUGIN && !PLUGIN.installed) log(`⚠️  the Squadra plugin is not installed in Claude Code: sessions cannot be opened until it is. Run: ${cli()} plugin`)
  // Keep what the dashboard shows about the plugin current (installed or updated by hand).
  setInterval(async () => { const st = await pluginStatus(); if (st) PLUGIN = st }, 5 * 60_000).unref()
  await connect(creds)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  // A bad message must never take the host down.
  process.on('unhandledRejection', err => log(`error: ${err?.message ?? err}`))
  process.on('uncaughtException', err => log(`error: ${err?.stack ?? err}`))
  main().catch(err => die(err.stack ?? err.message))
}
