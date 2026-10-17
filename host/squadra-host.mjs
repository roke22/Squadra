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
 * Requirements: Node >= 22, tmux >= 3.0 and Claude Code. No npm dependencies.
 * Runs on Linux and macOS. On Windows, run it inside WSL (it needs tmux).
 */

import { execFile, spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, statSync, copyFileSync, rmSync, chmodSync, accessSync, constants as FS } from 'node:fs'
import { homedir, hostname, platform, arch } from 'node:os'
import { join, resolve, sep, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const VERSION = '0.0.1'
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
const DEFAULT_SETTINGS = { folders: [], max_sessions: 8, allow_input: true, claude_command: 'claude' }
const HOME = homedir()
// Never allowed as a place to open sessions, whatever settings.json says:
// a whole home or system folder, or a folder where credentials and this
// program's own configuration live.
const FORBIDDEN_ROOTS = ['/', HOME]
const FORBIDDEN_TREES = [
  '.claude', '.ssh', '.config', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.local/share/keyrings', 'Library/Keychains',
].map(d => join(HOME, d)).concat([CONFIG_DIR, '/etc', '/root', '/proc', '/sys', '/dev', '/boot', '/var/root', '/private/etc', '/System', '/Library'])
const realOr = p => { try { return realpathSync(p) } catch { return resolve(p) } }
const within = (path, dir) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)
function forbiddenFolder(real) {
  if (FORBIDDEN_ROOTS.map(realOr).includes(real)) return 'a whole home or system folder'
  if (FORBIDDEN_TREES.map(realOr).some(d => within(real, d))) return 'a folder with credentials or configuration'
  return null
}

// Text that came from the server, printed on this terminal: no control
// characters (no escape sequences).
const plain = v => String(v ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '?')

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
// the right folders) but never change them.
//   folders           where sessions may be opened (and anything inside)
//   max_sessions      at most this many at once
//   allow_input       whether the dashboard may type in the terminals
//   permission_relay  whether a session's coordinator may answer its permission
//                     prompts from another session (default: same as allow_input)
//   coordinators      if set, the only coordinator names a worker may be given
//   claude_command    the Claude Code executable
function loadSettings() {
  const raw = readJson(SETTINGS_FILE, {})
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) }
  s.folders = (Array.isArray(s.folders) ? s.folders : [])
    .filter(f => typeof f === 'string' && isAbsolute(f) && !FORBIDDEN_ROOTS.map(realOr).includes(realOr(f)))
  s.max_sessions = Number.isInteger(s.max_sessions) && s.max_sessions > 0 ? Math.min(s.max_sessions, 64) : DEFAULT_SETTINGS.max_sessions
  s.allow_input = s.allow_input !== false
  s.permission_relay = typeof s.permission_relay === 'boolean' ? s.permission_relay : s.allow_input
  s.coordinators = Array.isArray(s.coordinators) ? s.coordinators.filter(c => typeof c === 'string' && NAME_RE.test(c)) : []
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
    return cmd
  }
  for (const dir of String(process.env.PATH ?? '').split(':')) {
    if (!isAbsolute(dir)) continue
    const p = join(dir, cmd)
    if (ok(p)) return p
  }
  throw new Error(`"${cmd}" (Claude Code) was not found on the PATH`)
}
const claudeOrNull = () => { try { return claudeBinary() } catch { return null } }

// --- tmux ---------------------------------------------------------------------------

const tmuxEnv = () => { const e = { ...process.env }; delete e.TMUX; delete e.TMUX_PANE; return e }
const tmux = (args, opts = {}) => run('tmux', ['-L', TMUX_SOCKET, '-f', '/dev/null', ...args], { env: tmuxEnv(), maxBuffer: 16 * 1024 * 1024, ...opts })

async function tmuxVersion() {
  try {
    const { stdout } = await run('tmux', ['-V'])
    const m = /(\d+)\.(\d+)/.exec(stdout)
    return m ? { text: stdout.trim(), major: Number(m[1]), minor: Number(m[2]) } : { text: stdout.trim(), major: 0, minor: 0 }
  } catch { return null }
}

async function claudeVersion(cmd) {
  try {
    const { stdout } = await run(cmd, ['--version'], { timeout: 10_000 })
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
    try { root = realpathSync(f) } catch { continue }
    if (real === root || real.startsWith(root.endsWith(sep) ? root : root + sep)) return true
  }
  return false
}

// The only thing a server can ask for. Anything unexpected is refused.
export function validateSpec(spec, settings, current) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('invalid request')
  const allowed = new Set(['name', 'role', 'coordinator', 'folder', 'compact_window', 'resume', 'identity'])
  for (const k of Object.keys(spec)) if (!allowed.has(k)) throw new Error(`unknown field "${k}"`)
  const name = String(spec.name ?? '')
  if (!NAME_RE.test(name)) throw new Error('name must match [A-Za-z0-9_-]{1,32}')
  const role = spec.role
  if (role !== 'coordinator' && role !== 'worker') throw new Error('role must be coordinator or worker')
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
    throw new Error('a coordinator has no coordinator')
  }
  let compact = null
  if (spec.compact_window != null && spec.compact_window !== '') {
    compact = Number(spec.compact_window)
    if (!Number.isInteger(compact) || compact < COMPACT_MIN || compact > COMPACT_MAX) {
      throw new Error(`compact_window must be a whole number of tokens between ${COMPACT_MIN} and ${COMPACT_MAX}`)
    }
  }
  if (spec.resume != null && typeof spec.resume !== 'boolean') throw new Error('resume must be true or false')
  // The session's identity secret, when the server reserved the name for this machine.
  if (spec.identity != null && !(typeof spec.identity === 'string' && /^sq_[A-Za-z0-9_-]{20,64}$/.test(spec.identity))) throw new Error('invalid identity')
  if (typeof spec.folder !== 'string' || !isAbsolute(spec.folder)) throw new Error('folder must be an absolute path')
  // tmux expands #{…} and #(…) in some arguments and splits commands on ";":
  // such paths are refused outright.
  if (/[#;\x00-\x1f\x7f]/.test(spec.folder)) throw new Error('folder contains characters that are not allowed (#, ; or control characters)')
  let real
  try { real = realpathSync(resolve(spec.folder)) } catch { throw new Error(`folder ${spec.folder} does not exist on this machine`) }
  if (!statSync(real).isDirectory()) throw new Error(`${spec.folder} is not a folder`)
  if (/[#;\x00-\x1f\x7f]/.test(real)) throw new Error('folder contains characters that are not allowed (#, ; or control characters)')
  const why = forbiddenFolder(real)
  if (why) throw new Error(`sessions cannot be opened in ${real}: it is ${why}`)
  if (!insideAllowed(real, settings.folders)) throw new Error(`folder ${spec.folder} is not inside the folders this machine allows (${settings.folders.join(', ') || 'none configured'})`)
  if (current.some(t => t.name === name)) throw new Error(`a session named "${name}" is already open on this machine`)
  if (current.length >= settings.max_sessions) throw new Error(`this machine allows at most ${settings.max_sessions} sessions`)
  return { name, role, coordinator, folder: real, compact_window: compact, resume: spec.resume === true, identity: spec.identity ?? null }
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

// A marketplace called "squadra" that isn't this project's would be trusted
// blindly by "plugin install squadra@squadra": refuse it.
async function checkMarketplace(cmd) {
  let list = []
  try { list = JSON.parse((await run(cmd, ['plugin', 'marketplace', 'list', '--json'], { timeout: 30_000 })).stdout) } catch { return }
  const m = Array.isArray(list) ? list.find(x => x?.name === 'squadra') : null
  if (m && String(m.repo ?? '').toLowerCase() !== PLUGIN_REPO.toLowerCase()) {
    throw new Error(`a different marketplace named "squadra" is installed (${plain(m.repo ?? m.source ?? 'unknown source')}). Remove it with: claude plugin marketplace remove squadra`)
  }
}
let PLUGIN = null // { installed, version, enabled }, or null when it can't be told

async function pluginStatus(cmd = claudeOrNull()) {
  if (!cmd) return null
  try {
    const { stdout } = await run(cmd, ['plugin', 'list', '--json'], { timeout: 30_000 })
    const p = JSON.parse(stdout).find(x => x?.id === PLUGIN_ID)
    return p ? { installed: true, version: typeof p.version === 'string' ? p.version : null, enabled: p.enabled !== false } : { installed: false, version: null, enabled: false }
  } catch {
    return null // Claude Code missing, or too old to list plugins as JSON
  }
}

// Install the plugin if it's missing (or enable it), or update it if it's there.
async function ensurePlugin({ update = false } = {}) {
  const cmd = claudeBinary()
  const opts = { timeout: 180_000 }
  let st = await pluginStatus(cmd)
  if (st === null) throw new Error(`cannot run "${cmd} plugin list": install Claude Code (or set claude_command in ${SETTINGS_FILE})`)
  await checkMarketplace(cmd)
  if (!st.installed) {
    // "add" fails if the marketplace is already there: the install decides.
    try { await run(cmd, ['plugin', 'marketplace', 'add', PLUGIN_MARKETPLACE], opts) } catch {}
    await run(cmd, ['plugin', 'install', PLUGIN_ID], opts)
  } else if (update) {
    await run(cmd, ['plugin', 'marketplace', 'update', 'squadra'], opts)
    await run(cmd, ['plugin', 'update', PLUGIN_ID], opts)
  }
  st = await pluginStatus(cmd)
  if (st?.installed && !st.enabled) { await run(cmd, ['plugin', 'enable', PLUGIN_ID], opts); st = await pluginStatus(cmd) }
  if (!st?.installed) throw new Error('the plugin did not install')
  PLUGIN = st
  return st
}

// One open at a time: the session limit is checked against what is running,
// so concurrent requests must not all pass the same check.
let openQueue = Promise.resolve()
function openTerminal(spec) {
  const run = openQueue.then(() => openTerminalNow(spec))
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
    throw new Error(`the Squadra plugin is ${PLUGIN.installed ? 'disabled' : 'not installed'} in Claude Code on this machine. Run "node ${INSTALLED_SCRIPT} plugin" there, or: ${PLUGIN_COMMANDS}`)
  }
  // The identity the server registered for this name: where the plugin looks for it.
  if (s.identity) {
    const dir = join(process.env.CLAUDE_CONFIG_DIR ?? join(HOME, '.claude'), 'channels', 'squadra', s.name)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'identity.json'), JSON.stringify({ name: s.name, secret: s.identity }, null, 2) + '\n', { mode: 0o600 })
    chmodSync(join(dir, 'identity.json'), 0o600)
  }
  const tname = PREFIX + s.name
  const env = { SQUADRA_NAME: s.name, SQUADRA_ROLE: s.role }
  if (s.coordinator) env.SQUADRA_COORDINATOR = s.coordinator
  if (s.compact_window) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(s.compact_window)
  if (!settings.permission_relay) env.SQUADRA_PERMISSION_RELAY = 'off'
  // Fixed command. Two or more arguments make tmux exec it directly, no shell.
  // "env -u TMUX" hides the tmux server from the session: its tools can't
  // simply run "tmux send-keys" into another session. (They run as the same
  // user, so this is a speed bump, not a wall: see the README.)
  const argv = ['/usr/bin/env', '-u', 'TMUX', '-u', 'TMUX_PANE', claude, '--dangerously-load-development-channels', 'plugin:squadra@squadra']
  if (s.resume) argv.push('--continue')
  const meta = JSON.stringify({ role: s.role, coordinator: s.coordinator, folder: s.folder, compact_window: s.compact_window })
  await tmux([
    'start-server', ';',
    'set-option', '-g', 'history-limit', '10000', ';',
    'set-option', '-g', 'exit-empty', 'off', ';',
    'new-session', '-d', '-s', tname, '-x', '120', '-y', '36', '-c', s.folder,
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...argv, ';',
    'set-option', '-t', tname, 'status', 'off', ';',
    'set-option', '-t', tname, '@squadra', meta,
  ])
  // The folder could have been swapped (e.g. for a symlink) between the check
  // and the start: make sure the session really is where it was allowed.
  try {
    const { stdout } = await tmux(['display-message', '-p', '-t', tname, '#{pane_current_path}'])
    const where = realOr(stdout.trim())
    if (where !== s.folder) {
      await tmux(['kill-session', '-t', tname]).catch(() => {})
      throw new Error(`the session started in ${where} instead of ${s.folder}; closed it`)
    }
  } catch (err) {
    if (/instead of/.test(err.message)) throw err
  }
  log(`opened "${plain(s.name)}" (${s.role}) in ${s.folder}`)
  return { id: s.name, name: s.name }
}

async function killTerminal(id) {
  if (!NAME_RE.test(String(id))) throw new Error('invalid session')
  const list = await listTerminals()
  if (!list.some(t => t.id === id)) throw new Error('no such session on this machine')
  await tmux(['kill-session', '-t', PREFIX + id])
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

class Viewer {
  constructor(id, send) {
    this.id = id
    this.send = send
    this.tname = PREFIX + id
    this.ready = false
    this.held = [] // output that arrives while a screen snapshot is being taken
    this.cols = 120
    this.rows = 36
    this.proc = spawn('tmux', ['-L', TMUX_SOCKET, '-f', '/dev/null', '-C', 'attach-session', '-t', this.tname], { env: tmuxEnv(), stdio: ['pipe', 'pipe', 'ignore'] })
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
      if (!this.ready) { this.held.push(data); return }
      this.send({ t: 'out', term: this.id, data: data.toString('base64') })
    } else if (line.subarray(0, 5).toString('latin1') === '%exit') {
      this.proc.stdin.end()
    }
  }

  command(cmd) {
    if (!this.closed) this.proc.stdin.write(cmd + '\n')
  }

  resize(cols, rows) {
    cols = Math.floor(Math.max(20, Math.min(Number(cols) || 120, 500)))
    rows = Math.floor(Math.max(5, Math.min(Number(rows) || 36, 200)))
    this.cols = cols; this.rows = rows
    this.command(`refresh-client -C ${cols}x${rows}`)
  }

  input(text) {
    const bytes = Buffer.from(String(text), 'utf8')
    for (let i = 0; i < bytes.length; i += 256) {
      const hex = [...bytes.subarray(i, i + 256)].map(b => b.toString(16).padStart(2, '0')).join(' ')
      this.command(`send-keys -t ${this.tname} -H ${hex}`)
    }
  }

  // The current screen (plus some scrollback), redrawn from scratch.
  async screen() {
    this.ready = false
    await new Promise(r => setTimeout(r, 120)) // let the program redraw at the new size
    this.held = [] // what came before the capture is in it; what comes during it is sent after
    try {
      const { stdout: info } = await tmux(['display-message', '-p', '-t', this.tname, '#{history_size} #{pane_height} #{cursor_x} #{cursor_y}'])
      const [hist, height, cx, cy] = info.trim().split(' ').map(Number)
      const back = Math.min(hist, 1000)
      const { stdout } = await tmux(['capture-pane', '-p', '-e', '-t', this.tname, '-S', String(-back), '-E', String(height - 1)], { encoding: 'buffer' })
      let lines = stdout.toString('utf8').split('\n')
      if (lines.at(-1) === '') lines.pop()
      const data = '\x1b[0m\x1b[H\x1b[2J\x1b[3J' + lines.join('\x1b[0m\r\n') + `\x1b[${cy + 1};${cx + 1}H`
      this.send({ t: 'screen', term: this.id, data: Buffer.from(data, 'utf8').toString('base64'), cols: this.cols, rows: this.rows })
    } finally {
      const held = Buffer.concat(this.held)
      this.held = []
      if (held.length) this.send({ t: 'out', term: this.id, data: held.toString('base64') })
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
    max_sessions: settings.max_sessions,
    allow_input: settings.allow_input,
    terminals: await listTerminals(),
  }
}

let CLAUDE_VERSION = null

async function connect(creds) {
  const viewers = new Map() // terminal id -> Viewer
  let ws = null
  let backoff = 1000
  let lastTerminals = ''

  const send = msg => { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)) }

  const pushInfo = async (force = false) => {
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
  }

  async function onMessage(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return
    if (m.t === 'welcome') { log(`connected to ${creds.server} as "${plain(m.host?.name)}"`); backoff = 1000; return pushInfo(true) }
    if (Object.hasOwn(handlers, m.t)) {
      try { send({ t: 'reply', req: m.req, ok: true, result: await handlers[m.t](m) }) }
      catch (err) { send({ t: 'reply', req: m.req, ok: false, error: err.message }) }
      return
    }
    const id = String(m.term ?? '')
    if (!NAME_RE.test(id)) return // session ids also end up in tmux commands
    if (m.t === 'attach') {
      if (!(await listTerminals()).some(t => t.id === id)) return send({ t: 'exit', term: id })
      let v = viewers.get(id)
      if (!v) {
        v = new Viewer(id, send)
        // tmux ends the control client when the session ends: tell the viewers.
        v.onExit = async () => {
          if (viewers.get(id) === v) viewers.delete(id)
          if (!(await listTerminals()).some(t => t.id === id)) send({ t: 'exit', term: id })
          void pushInfo()
        }
        viewers.set(id, v)
      }
      v.resize(m.cols, m.rows)
      return v.screen().catch(err => log(`screen of "${id}": ${err.message}`))
    }
    const v = viewers.get(id)
    if (!v) return
    if (m.t === 'detach') { v.close(); viewers.delete(id); return }
    if (m.t === 'resize') { v.resize(m.cols, m.rows); return }
    if (m.t === 'refresh') return v.screen().catch(() => {})
    if (m.t === 'in') {
      if (!loadSettings().allow_input) return send({ t: 'notice', term: id, text: 'typing from the dashboard is turned off on this machine (allow_input: false)' })
      if (typeof m.data === 'string' && m.data.length <= 64 * 1024) v.input(m.data)
    }
  }

  setInterval(() => { if (ws?.readyState === 1) void pushInfo().catch(() => {}) }, 3000).unref()
  setInterval(() => send({ t: 'ping' }), 25_000).unref()

  for (;;) {
    const closed = await new Promise(resolveClose => {
      try { ws = new WebSocket(wsUrl(creds.server)) } catch (err) { return resolveClose({ code: 0, reason: err.message }) }
      ws.onopen = async () => {
        ws.send(JSON.stringify({ t: 'hello', id: creds.id, secret: creds.secret, info: await hostInfo() }))
      }
      ws.onmessage = ev => {
        let m
        try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : '') } catch { return }
        onMessage(m).catch(err => log(`${plain(m?.t)}: ${err.message}`))
      }
      ws.onerror = () => {}
      ws.onclose = ev => resolveClose({ code: ev.code, reason: ev.reason })
    })
    for (const v of viewers.values()) v.close()
    viewers.clear()
    if (closed.code === 4001) die('the server no longer accepts this machine (it was disconnected from the dashboard). Enroll it again with a new command from the dashboard.')
    log(`connection lost${closed.reason ? ` (${plain(closed.reason)})` : ''}; retrying in ${Math.round(backoff / 1000)} s`)
    await new Promise(r => setTimeout(r, backoff))
    backoff = Math.min(backoff * 2, 30_000)
  }
}

// --- commands ------------------------------------------------------------------------------

const USAGE = `Usage:
  node squadra-host.mjs enroll <server-url> <code>   Join this machine to a Squadra server and start
                                                     (the dashboard shows this command in Hosts → Add).
                                                     Also installs the Squadra plugin in Claude Code if
                                                     it's missing (--no-plugin to skip). Needs https,
                                                     unless --insecure (trusted private network only)
  node squadra-host.mjs [run]                        Connect with the saved credential
  node squadra-host.mjs folders [add|remove <path>]  Folders where sessions may be opened
  node squadra-host.mjs status                       Show this machine's settings and sessions
  node squadra-host.mjs plugin                       Install the Squadra plugin in Claude Code, or update it
  node squadra-host.mjs service                      Print a service to keep it running (systemd on Linux, launchd on macOS)
  node squadra-host.mjs forget                       Delete the saved credential

Settings: ${SETTINGS_FILE}
  folders        sessions can only be opened inside these folders
  max_sessions   at most this many sessions at once (default 8)
  allow_input    whether the dashboard may type in the terminals (default true)
  claude_command the Claude Code executable (default "claude")
  permission_relay whether a worker's coordinator may answer its permission prompts
                 from another session (default: same as allow_input)
  coordinators   if set, the only coordinator names workers here may be given
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

async function enroll(server, code, { plugin = true, insecure = false } = {}) {
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
    })
  } catch (err) { die(`cannot reach ${server}: ${err.cause?.message ?? err.message}`) }
  const j = await res.json().catch(() => ({}))
  if (!j.ok) die(`enrollment refused: ${plain(j.description ?? `HTTP ${res.status}`)}`)
  const r = j.result ?? {}
  if (typeof r.id !== 'string' || !/^h_[0-9a-f]{8,64}$/.test(r.id) || typeof r.secret !== 'string' || !/^sh_[A-Za-z0-9_-]{20,200}$/.test(r.secret)) {
    die('the server answered the enrollment with something unexpected')
  }
  writeJson(CREDENTIALS_FILE, { server, id: r.id, secret: r.secret, insecure })
  // First enrollment: allow the current folder, so there is somewhere to start
  // (not a whole home or system folder, nor a credentials one).
  if (!existsSync(SETTINGS_FILE)) {
    const here = realOr(process.cwd())
    const why = forbiddenFolder(here)
    writeJson(SETTINGS_FILE, { ...DEFAULT_SETTINGS, folders: why ? [] : [here] })
    if (why) log(`no folder allowed yet: ${here} is ${why}. Add one with: node ${INSTALLED_SCRIPT} folders add <path>`)
  }
  // Keep a copy of this program next to its settings, for the service.
  const self = fileURLToPath(import.meta.url)
  if (resolve(self) !== resolve(INSTALLED_SCRIPT)) { try { copyFileSync(self, INSTALLED_SCRIPT) } catch {} }
  // Configure the Squadra plugin on this machine if it isn't yet.
  const pluginEnv = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'squadra', '.env')
  // Only a well-formed URL and token: anything else (a line break, say) could
  // add settings of its own to the plugin's .env.
  const pu = r.plugin?.url, pt = r.plugin?.token
  const urlOk = typeof pu === 'string' && /^https?:\/\/[^\s]+$/.test(pu) && (() => { try { return !!new URL(pu) } catch { return false } })()
  const tokenOk = typeof pt === 'string' && /^[\x21-\x7e]{16,256}$/.test(pt)
  if (r.plugin && (!urlOk || !tokenOk)) log('⚠️  the server sent an invalid plugin configuration: ignored')
  else if (r.plugin && !existsSync(pluginEnv)) {
    mkdirSync(join(pluginEnv, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(pluginEnv, `SQUADRA_URL=${pu}\nSQUADRA_SERVER_TOKEN=${pt}\n`, { mode: 0o600 })
    log(`Squadra plugin configured for ${pu} (${pluginEnv})`)
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
  const s = loadSettings()
  process.stderr.write(`\nsquadra-host: this machine is now "${plain(r.name)}" on ${server}.
  Sessions may be opened in: ${s.folders.join(', ') || '(none)'}
  Change it with: node ${INSTALLED_SCRIPT} folders add <path>
  Keep it running in the background: node ${INSTALLED_SCRIPT} service

`)
  if (!info.tmux) log(`⚠️  tmux is not installed: install it (${TMUX_INSTALL}) before opening sessions.`)
  if (!info.claude) log(`⚠️  Claude Code was not found ("claude" is not on the PATH). Install it, then run: node ${INSTALLED_SCRIPT} plugin`)
}

function folders(action, path) {
  const s = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) }
  s.folders = Array.isArray(s.folders) ? s.folders : []
  if (action === 'add' || action === 'remove') {
    if (!path) die(`folders ${action} needs a path`, 2)
    const abs = resolve(path)
    if (action === 'add') {
      if (!existsSync(abs) || !statSync(abs).isDirectory()) die(`${abs} is not a folder`, 2)
      const why = forbiddenFolder(realOr(abs))
      if (why) die(`${abs} can't be allowed: it is ${why}. Allow a project folder (or a folder of projects) instead.`, 2)
      if (!s.folders.includes(abs)) s.folders.push(abs)
    } else s.folders = s.folders.filter(f => f !== abs)
    writeJson(SETTINGS_FILE, s)
  }
  process.stdout.write((s.folders.length ? s.folders.join('\n') : '(no folders: no session can be opened)') + '\n')
}

const TMUX_INSTALL = platform() === 'darwin' ? 'brew install tmux' : 'sudo apt install tmux (or your distribution\'s package)'

// systemd: a quoted word, with % (specifiers) escaped.
const sd = v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
// PATH for the service, without relative entries.
const absolutePath = () => String(process.env.PATH ?? '').split(':').filter(d => isAbsolute(d)).join(':')

function service() {
  const node = process.execPath
  if (platform() === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.squadra.host.plist')
    const logFile = join(homedir(), 'Library', 'Logs', 'squadra-host.log')
    const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    process.stdout.write(`<?xml version="1.0" encoding="UTF-8"?>
<!-- Save as ${plist}, then:
       launchctl bootstrap gui/$(id -u) ${plist}
     To stop it: launchctl bootout gui/$(id -u) ${plist}
     It runs while you are logged in (Claude Code keeps its login in your Keychain).
     Log: ${logFile} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.squadra.host</string>
  <key>ProgramArguments</key>
  <array><string>${x(node)}</string><string>${x(INSTALLED_SCRIPT)}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${x(absolutePath())}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${x(logFile)}</string>
</dict>
</plist>
`)
    return
  }
  process.stdout.write(`# Save as ~/.config/systemd/user/squadra-host.service, then:
#   systemctl --user daemon-reload && systemctl --user enable --now squadra-host
#   loginctl enable-linger $USER     # keep it running when you are logged out
[Unit]
Description=Squadra host
After=network-online.target

[Service]
ExecStart=${sd(node)} ${sd(INSTALLED_SCRIPT)}
Restart=always
RestartSec=5
Environment=${sd(`PATH=${absolutePath()}`)}

[Install]
WantedBy=default.target
`)
}

async function main() {
  if (platform() === 'win32') die('squadra-host does not run on native Windows (it needs tmux). Run it inside WSL, for example Ubuntu, together with Claude Code: see "Windows (WSL)" in the README.')
  const [cmd = 'run', ...rest] = process.argv.slice(2)
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') return process.stdout.write(USAGE)
  if (cmd === '--version' || cmd === 'version') return process.stdout.write(`squadra-host ${VERSION}\n`)
  if (cmd === 'folders') return folders(rest[0], rest[1])
  if (cmd === 'service') return service()
  if (cmd === 'forget') { rmSync(CREDENTIALS_FILE, { force: true }); return log('credential deleted') }
  if (cmd === 'status') {
    const creds = readJson(CREDENTIALS_FILE, null)
    process.stdout.write(JSON.stringify({ server: creds?.server ?? null, settings: loadSettings(), terminals: await listTerminals() }, null, 2) + '\n')
    return
  }
  if (typeof WebSocket !== 'function') die(`Node ${process.version} has no WebSocket: use Node 22 or newer`)
  const tv = await tmuxVersion()
  if (tv && tv.major < 3) die(`${tv.text} is too old: squadra-host needs tmux 3.0 or newer`)
  CLAUDE_VERSION = claudeOrNull() ? await claudeVersion(claudeOrNull()) : null
  if (cmd === 'plugin') {
    try { const st = await ensurePlugin({ update: true }); return log(`Squadra plugin ${st.version ?? ''} is installed and up to date. Restart open sessions to use a new version.`) }
    catch (err) { die(`${err.message.split('\n')[0]}\nInstall it by hand with: ${PLUGIN_COMMANDS}`) }
  }
  if (cmd === 'enroll') {
    const args = rest.filter(a => !a.startsWith('--'))
    await enroll(args[0], args[1], { plugin: !rest.includes('--no-plugin'), insecure: rest.includes('--insecure') })
  }
  else if (cmd !== 'run') die(`unknown command "${cmd}"\n\n${USAGE}`, 2)
  const creds = readJson(CREDENTIALS_FILE, null)
  if (creds?.server) checkScheme(creds.server, creds.insecure === true)
  if (!creds?.server || !creds?.secret) die(`this machine is not enrolled yet. In the dashboard, open Hosts → Add and run the command it shows.\n\n${USAGE}`, 2)
  if (!tv) log(`⚠️  tmux is not installed: sessions cannot be opened until it is (${TMUX_INSTALL}).`)
  PLUGIN = await pluginStatus()
  if (PLUGIN && !PLUGIN.installed) log(`⚠️  the Squadra plugin is not installed in Claude Code: sessions cannot be opened until it is. Run: node ${INSTALLED_SCRIPT} plugin`)
  // Keep what the dashboard shows about the plugin current (installed or updated by hand).
  setInterval(async () => { const st = await pluginStatus(); if (st) PLUGIN = st }, 5 * 60_000).unref()
  await connect(creds)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  // A bad message must never take the host down.
  process.on('unhandledRejection', err => log(`error: ${err?.message ?? err}`))
  main().catch(err => die(err.stack ?? err.message))
}
