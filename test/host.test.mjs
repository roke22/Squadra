// End-to-end tests for squadra-host: a real server, a real host process and a
// real tmux, with a fake "claude" that prints what it was started with and
// echoes what it reads. Needs tmux >= 3.0 on the PATH (skipped otherwise).
//
// Run: node --test test/host.test.mjs

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync, realpathSync, rmSync, symlinkSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { tmpdir, homedir, userInfo } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_TOKEN = 'test-server-token-host-0123456789'
const PORT = 19000 + Math.floor(Math.random() * 2000)
const URL_ = `http://127.0.0.1:${PORT}`
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const SOCKET = `squadra-test-${process.pid}`

const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true } catch { return false } })()
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitFor(fn, { timeout = 10000, interval = 50, what = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`)
    await sleep(interval)
  }
}

async function dash(path, body) {
  const res = await fetch(`${URL_}/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVER_TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

let serverProc, hostProc
let hostExit = null
const work = mkdtempSync(join(tmpdir(), 'squadra-host-test-'))
const dataDir = join(work, 'data')
const hostDir = join(work, 'host')
// Claude Code's config outside /tmp: the plugin (and so the host) ignores a
// CLAUDE_CONFIG_DIR in the same top-level folder as the sessions' folders.
const claudeDir = mkdtempSync(join(homedir(), '.squadra-host-test-claude-'))
const allowed = join(work, 'projects')
const outside = join(work, 'elsewhere')
const fakeClaude = join(work, 'fake-claude.sh')
const pluginState = join(work, 'plugin-installed')
const pluginCalls = join(work, 'plugin-calls')
const marketplaceFile = join(work, 'marketplace')
let hostStderr = ''

before(async () => {
  if (!hasTmux) return
  for (const d of [dataDir, hostDir, allowed, join(allowed, 'api'), outside, join(allowed, 'odd#dir')]) mkdirSync(d, { recursive: true })
  // It also plays "claude plugin …": list/install/enable, with the state in a file.
  writeFileSync(fakeClaude, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
if [ "$1" = "plugin" ]; then
  echo "$*" >> "${pluginCalls}"
  case "$2" in
    list) if [ -f "${pluginState}" ]; then echo '[{"id":"squadra@squadra","version":"${VERSION}","enabled":true}]'; else echo '[]'; fi ;;
    install) touch "${pluginState}" ;;
    marketplace)
      case "$3" in
        add) echo "$4" > "${marketplaceFile}" ;;
        remove) rm -f "${marketplaceFile}" "${pluginState}" ;;
        list)
          if [ -f "${marketplaceFile}" ]; then
            src=$(cat "${marketplaceFile}"); repo=\${src%%#*}; ref=""
            case "$src" in *#*) ref=\${src#*#} ;; esac
            printf '[{"name":"squadra","source":"github","repo":"%s","ref":"%s"}]' "$repo" "$ref"
          else echo '[]'; fi ;;
      esac ;;
  esac
  exit 0
fi
echo "ARGS: $*"
echo "ENV: $SQUADRA_NAME/$SQUADRA_ROLE/$SQUADRA_COORDINATOR/$CLAUDE_CODE_AUTO_COMPACT_WINDOW"
echo "START: $SQUADRA_LAUNCH_START"
echo "PWD: $(pwd)"
echo "TMUX=\${TMUX:-none}"
# FULLSCREEN: switches on what Claude Code's full-screen view does.
while IFS= read -r line; do
  if [ "$line" = FULLSCREEN ]; then printf '\\033[?1049h\\033[?1000h\\033[?1002h\\033[?1003h\\033[?1006h\\033[?1hFULL VIEW'; elif [ "$line" = DIALOG ]; then printf ' Do you want to proceed?\\n ❯ 1. Yes\\n   2. No\\n Esc to cancel\\n'; elif [ "$line" = NOECHO ]; then stty -echo; else echo "GOT:$line"; fi
done
`)
  chmodSync(fakeClaude, 0o755)
  // The machine's own rules, written before enrolling.
  writeFileSync(join(hostDir, 'settings.json'), JSON.stringify({ folders: [allowed], max_sessions: 2, allow_input: true, claude_command: fakeClaude }))
  serverProc = spawn(process.execPath, [join(ROOT, 'server/server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, SQUADRA_SERVER_TOKEN: SERVER_TOKEN },
    stdio: ['ignore', 'inherit', 'pipe'],
  })
  serverProc.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(d) })
  await waitFor(async () => { try { return (await fetch(`${URL_}/health`)).ok } catch { return false } }, { what: 'server' })
})

after(() => {
  hostProc?.kill('SIGTERM')
  serverProc?.kill('SIGTERM')
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }) } catch {}
  rmSync(claudeDir, { recursive: true, force: true })
})

// A dashboard tab's terminal connection (with a one-time ticket, as the dashboard does).
async function viewer(ticket) {
  ticket ??= (await dash('terminal/ticket', {})).result.ticket
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/terminal`, ['squadra', `auth.${ticket}`])
  const v = { ws, msgs: [], closed: null, text: '' }
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data)
    v.msgs.push(m)
    if (m.data) v.text += Buffer.from(m.data, 'base64').toString('utf8')
  }
  ws.onclose = ev => { v.closed = ev.code }
  v.open = () => new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  v.send = m => ws.send(JSON.stringify(m))
  return v
}

let hostId

test('a machine enrolls with a one-time code and connects', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const unauth = await (await fetch(`${URL_}/api/hosts/enroll`, { method: 'POST', body: '{}' })).json()
  assert.equal(unauth.error_code, 401)

  // configure_plugin: also hand the machine the join token (off by default).
  const en = await dash('hosts/enroll', { name: 'test box', configure_plugin: true })
  assert.ok(en.ok, en.description)
  assert.match(en.result.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  assert.ok(en.result.command.includes(`'${URL_}/host/squadra-host.mjs'`))
  assert.ok(en.result.command.includes(`enroll '${URL_}' --code-file=code --server-key=${en.result.server_key}`))
  for (const system of ['linux', 'macos']) assert.ok(en.result.install[system].endsWith(`--server-key=${en.result.server_key}`))
  assert.ok(en.result.install.windows.includes(`$env:SQUADRA_ENROLL_CODE = '${en.result.code}'`))
  assert.match(en.result.install.windows, /Get-FileHash .* -Algorithm SHA256\)\.Hash -ne '[0-9a-f]{64}'/)
  assert.ok(en.result.install.windows.endsWith(`'${URL_}' --linux-sha256 ${en.result.install.linux.match(/echo '([0-9a-f]{64})  install\.sh'/)[1]} --sha256 ${en.result.sha256} --server-key ${en.result.server_key}`))

  // The program is served by the server, as the command expects, and the
  // command checks its sha256 before running it (a tampered copy fails).
  const js = await fetch(`${URL_}/host/squadra-host.mjs`)
  assert.equal(js.status, 200)
  const jsText = await js.text()
  assert.match(jsText, /squadra-host/)
  const verify = en.result.command.match(/ && (echo .*?\)) && printf /)[1]
  const dl = mkdtempSync(join(tmpdir(), 'squadra-dl-'))
  writeFileSync(join(dl, 'squadra-host.mjs'), jsText)
  execFileSync('sh', ['-c', verify], { cwd: dl, stdio: 'ignore' })
  writeFileSync(join(dl, 'squadra-host.mjs'), jsText + '\n// tampered')
  assert.throws(() => execFileSync('sh', ['-c', verify], { cwd: dl, stdio: 'ignore' }))

  // (The code in a file, which is gone once read; lowercase is the same code.)
  const codeFile = join(work, 'enroll-code')
  writeFileSync(codeFile, en.result.code.toLowerCase())
  hostProc = spawn(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'enroll', URL_, `--code-file=${codeFile}`], {
    env: { ...process.env, SQUADRA_HOST_DIR: hostDir, SQUADRA_TMUX_SOCKET: SOCKET, CLAUDE_CONFIG_DIR: claudeDir, SQUADRA_HOST_TEST_ALLOW_TMP: '1', SQUADRA_HOST_TEST_SKIP_TAG_CHECK: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd: work,
  })
  hostProc.stderr.on('data', d => { hostStderr += d; if (process.env.DEBUG) process.stderr.write(`[host] ${d}`) })
  hostProc.on('exit', code => { hostExit = code })

  const h = await waitFor(async () => (await dash('hosts')).result.find(x => x.online && x.info?.plugin), { what: 'host online with its info' })
  hostId = h.id
  assert.ok(!existsSync(codeFile))
  assert.equal(h.name, 'test box')
  assert.equal(h.info.claude, '9.9.9 (Claude Code)')
  assert.deepEqual(h.info.folders, [allowed])
  assert.equal(h.info.max_sessions, 2)

  // The Squadra plugin was installed in Claude Code, from its fixed marketplace.
  const calls = readFileSync(pluginCalls, 'utf8')
  assert.match(calls, /plugin marketplace add roke22\/Squadra/)
  assert.match(calls, /plugin install squadra@squadra/)
  assert.deepEqual(h.info.plugin, { installed: true, enabled: true, version: VERSION })
  // Pinned to this program's release tag.
  assert.equal(readFileSync(marketplaceFile, 'utf8').trim(), `roke22/Squadra#v${VERSION}`)

  // Credential saved with private permissions; the plugin configured.
  const creds = JSON.parse(readFileSync(join(hostDir, 'credentials.json'), 'utf8'))
  assert.equal(creds.server, URL_)
  assert.match(creds.secret, /^sh_/)
  // It remembers the server's key, and so does the plugin next to it.
  const { createHash } = await import('node:crypto')
  assert.equal(createHash('sha256').update(creds.server_key).digest('hex'), en.result.server_key)
  assert.equal(readFileSync(join(claudeDir, 'channels', 'squadra', '.server-keys', createHash('sha256').update(URL_).digest('hex').slice(0, 16)), 'utf8').trim(), creds.server_key)
  const env = readFileSync(join(claudeDir, 'channels', 'squadra', '.env'), 'utf8')
  assert.match(env, new RegExp(`SQUADRA_URL=${URL_}`))
  // The machine gets the join token (register new sessions only), never the admin token.
  const joinToken = readFileSync(join(dataDir, 'join-token'), 'utf8').trim()
  assert.match(env, new RegExp(`SQUADRA_SERVER_TOKEN=${joinToken}`))
  assert.ok(!env.includes(SERVER_TOKEN), 'admin token not handed to machines')

  // The code works only once.
  const again = await (await fetch(`${URL_}/host/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: en.result.code }) })).json()
  assert.equal(again.error_code, 403)
})

test('the host refuses anything but a valid session spec', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const open = spec => dash('terminals/open', { host: hostId, spec })
  const cases = [
    [{ name: 'w1', role: 'worker', folder: outside }, /not inside the folders/],
    [{ name: 'w1', role: 'worker', folder: join(allowed, '..', 'elsewhere') }, /not inside the folders/],
    [{ name: 'w1', role: 'worker', folder: join(allowed, 'odd#dir') }, /not allowed/],
    [{ name: 'w1', role: 'worker', folder: join(allowed, 'missing') }, /is not a folder inside the folders/],
    [{ name: 'w1', role: 'worker', folder: allowed, command: 'rm -rf /' }, /unknown field "command"/],
    [{ name: 'w1', role: 'worker', folder: allowed, args: ['--dangerously-skip-permissions'] }, /unknown field "args"/],
    [{ name: 'w 1', role: 'worker', folder: allowed }, /name must match/],
    [{ name: 'w1', role: 'admin', folder: allowed }, /role must be/],
    [{ name: 'w1', role: 'worker', folder: allowed, compact_window: '600000; rm -rf /' }, /compact_window/],
    [{ name: 'w1', role: 'worker', folder: allowed, compact_window: 5 }, /compact_window/],
    [{ name: 'w1', role: 'worker', folder: 'relative/path' }, /absolute path/],
  ]
  for (const [spec, re] of cases) {
    const r = await open(spec)
    assert.equal(r.ok, false, `accepted ${JSON.stringify(spec)}`)
    assert.match(r.description, re)
  }
  const h = (await dash('hosts')).result.find(x => x.id === hostId)
  assert.equal(h.info.terminals.length, 0)
})

test('opening a session runs the fixed command, and the web terminal sees and types', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const r = await dash('terminals/open', { host: hostId, spec: { name: 'w1', role: 'worker', coordinator: 'boss', folder: join(allowed, 'api'), compact_window: 600000 } })
  assert.ok(r.ok, r.description)
  const h = await waitFor(async () => (await dash('hosts')).result.find(x => x.id === hostId && x.info.terminals.length === 1), { what: 'terminal listed' })
  assert.equal(h.info.terminals[0].name, 'w1')
  assert.equal(h.info.terminals[0].role, 'worker')
  assert.equal(h.info.terminals[0].folder, realpathSync(join(allowed, 'api')))

  // The server reserved the name for this machine and handed it its identity.
  const ident = JSON.parse(readFileSync(join(claudeDir, 'channels', 'squadra', 'w1', 'identity.json'), 'utf8'))
  assert.match(ident.secret, /^sq_/)
  // A name someone else registered first (with the join token) is refused.
  const joinTok = readFileSync(join(dataDir, 'join-token'), 'utf8').trim()
  await fetch(`${URL_}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${joinTok}` }, body: JSON.stringify({ name: 'squat1' }) })
  const squat = await dash('terminals/open', { host: hostId, spec: { name: 'squat1', role: 'worker', folder: allowed } })
  assert.equal(squat.ok, false)
  assert.match(squat.description, /already registered by another session/)

  // Same name twice on the machine: refused.
  const dup = await dash('terminals/open', { host: hostId, spec: { name: 'w1', role: 'worker', folder: allowed } })
  assert.equal(dup.ok, false)
  assert.match(dup.description, /already open/)

  // Without a valid ticket, the terminal socket is never accepted.
  const bad = await viewer('nope')
  await assert.rejects(bad.open())

  const v = await viewer()
  await v.open()
  await waitFor(() => v.msgs.some(m => m.t === 'ready'), { what: 'ready' })
  v.send({ t: 'attach', host: hostId, term: 'w1', cols: 100, rows: 30 })
  await waitFor(() => v.msgs.some(m => m.t === 'screen'), { what: 'screen' })
  await waitFor(() => v.text.includes('ARGS: --dangerously-load-development-channels plugin:squadra@squadra'), { what: 'fixed command in the screen' })
  // Only the name in the environment; role and coordinator in launch.json.
  assert.ok(v.text.includes('ENV: w1///600000'), v.text)
  const launch = JSON.parse(readFileSync(join(claudeDir, 'channels', 'squadra', 'w1', 'launch.json'), 'utf8'))
  // (With the random value only this start is given.)
  assert.match(launch.start, /^[0-9a-f]{32}$/)
  assert.ok(v.text.includes(`START: ${launch.start}`), v.text)
  assert.deepEqual({ ...launch, start: 0 }, { name: 'w1', role: 'worker', coordinator: 'boss', start: 0 })
  assert.ok(v.text.includes(`PWD: ${realpathSync(join(allowed, 'api'))}`), v.text)
  // The session doesn't see the tmux server it runs in (no "tmux send-keys" into others).
  assert.ok(v.text.includes('TMUX=none'), v.text)

  v.send({ t: 'in', host: hostId, term: 'w1', data: 'hello squadra\r' })
  await waitFor(() => v.text.includes('GOT:hello squadra'), { what: 'typed text echoed' })

  // An image pasted in the dashboard: saved on the machine and its path
  // pasted into the session (Claude Code attaches it). Anything that isn't
  // an image is refused.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  v.send({ t: 'image', host: hostId, term: 'w1', type: 'image/png', data: png.toString('base64') })
  const pasteDir = join(hostDir, 'pasted')
  await waitFor(() => existsSync(pasteDir) && readdirSync(pasteDir).length === 1, { what: 'image saved' })
  const saved = join(pasteDir, readdirSync(pasteDir)[0])
  assert.deepEqual(readFileSync(saved), png)
  v.send({ t: 'in', host: hostId, term: 'w1', data: '\r' })
  await waitFor(() => v.text.replace(/\s+/g, '').includes(`GOT:${saved}`), { what: 'image path pasted' })
  v.send({ t: 'image', host: hostId, term: 'w1', type: 'image/png', data: Buffer.from('#!/bin/sh\necho not an image').toString('base64') })
  await waitFor(() => v.msgs.some(m => m.t === 'notice' && /could not be used/.test(m.text)), { what: 'non-image refused' })
  assert.equal(readdirSync(pasteDir).length, 1)

  // A second viewer gets the current screen too.
  const v2 = await viewer()
  await v2.open()
  await waitFor(() => v2.msgs.some(m => m.t === 'ready'), { what: 'ready 2' })
  v2.send({ t: 'attach', host: hostId, term: 'w1', cols: 100, rows: 30 })
  await waitFor(() => v2.text.includes('GOT:hello squadra'), { what: 'second viewer screen' })
  v2.ws.close()
  const first = Buffer.from(v.msgs.find(m => m.t === 'screen').data, 'base64').toString('utf8')
  assert.ok(!first.includes('\x1b[?1049h') && !first.includes('\x1b[?1000h'), JSON.stringify(first.slice(0, 40)))

  // A viewer arriving at a full-screen program gets its modes too (they go
  // when the dashboard resets its terminal): its mouse wheel goes to it, and
  // pastes are bracketed.
  v.send({ t: 'in', host: hostId, term: 'w1', data: 'FULLSCREEN\r' })
  await waitFor(() => v.text.includes('FULL VIEW'), { what: 'full view' })
  const v3 = await viewer()
  await v3.open()
  await waitFor(() => v3.msgs.some(m => m.t === 'ready'), { what: 'ready 3' })
  v3.send({ t: 'attach', host: hostId, term: 'w1', cols: 100, rows: 30 })
  await waitFor(() => v3.text.includes('FULL VIEW'), { what: 'full view screen' })
  const full = Buffer.from(v3.msgs.find(m => m.t === 'screen').data, 'base64').toString('utf8')
  assert.ok(full.startsWith('\x1b[?1049h'), JSON.stringify(full.slice(0, 40)))
  assert.ok(full.endsWith('\x1b[?1003h\x1b[?1006h\x1b[?1h\x1b[?2004h'), JSON.stringify(full.slice(-60)))
  v3.ws.close()

  // Closing the session from the dashboard ends it and tells the viewer.
  const k = await dash('terminals/kill', { host: hostId, term: 'w1' })
  assert.ok(k.ok, k.description)
  await waitFor(() => v.msgs.some(m => m.t === 'exit'), { what: 'exit' })
  await waitFor(async () => (await dash('hosts')).result.find(x => x.id === hostId).info.terminals.length === 0, { what: 'terminal gone' })
  v.ws.close()
})

test('the machine limit and typing switch are the machine\'s own', { skip: !hasTmux && 'tmux not installed' }, async () => {
  for (const name of ['a1', 'a2']) {
    const r = await dash('terminals/open', { host: hostId, spec: { name, role: 'worker', folder: allowed } })
    assert.ok(r.ok, r.description)
  }
  const third = await dash('terminals/open', { host: hostId, spec: { name: 'a3', role: 'worker', folder: allowed } })
  assert.equal(third.ok, false)
  assert.match(third.description, /at most 2 sessions/)

  // Typing turned off on the machine: input is dropped there, whatever the server sends.
  const settings = JSON.parse(readFileSync(join(hostDir, 'settings.json'), 'utf8'))
  writeFileSync(join(hostDir, 'settings.json'), JSON.stringify({ ...settings, allow_input: false }))
  const v = await viewer()
  await v.open()
  await waitFor(() => v.msgs.some(m => m.t === 'ready'), { what: 'ready' })
  v.send({ t: 'attach', host: hostId, term: 'a1', cols: 80, rows: 24 })
  await waitFor(() => v.msgs.some(m => m.t === 'screen'), { what: 'screen' })
  v.send({ t: 'in', host: hostId, term: 'a1', data: 'should not arrive\r' })
  await waitFor(() => v.msgs.some(m => m.t === 'notice'), { what: 'notice' })
  await sleep(300)
  assert.ok(!v.text.includes('GOT:should not arrive'))
  await waitFor(async () => (await dash('hosts')).result.find(x => x.id === hostId).info.allow_input === false, { what: 'allow_input reported' })
  v.ws.close()
  writeFileSync(join(hostDir, 'settings.json'), JSON.stringify(settings))
  for (const name of ['a1', 'a2']) await dash('terminals/kill', { host: hostId, term: name })
})

test('without the Squadra plugin, the machine refuses to open sessions', { skip: !hasTmux && 'tmux not installed' }, async () => {
  rmSync(pluginState)
  const r = await dash('terminals/open', { host: hostId, spec: { name: 'np1', role: 'worker', folder: allowed } })
  assert.equal(r.ok, false)
  assert.match(r.description, /Squadra plugin is not installed/)
  await waitFor(async () => (await dash('hosts')).result.find(x => x.id === hostId).info.plugin?.installed === false, { what: 'plugin reported missing' })
  writeFileSync(pluginState, '')
  const ok = await dash('terminals/open', { host: hostId, spec: { name: 'np1', role: 'worker', folder: allowed } })
  assert.ok(ok.ok, ok.description)
  await dash('terminals/kill', { host: hostId, term: 'np1' })
})

test('squadra-host plugin re-pins a marketplace that follows the default branch', { skip: !hasTmux && 'tmux not installed' }, async () => {
  // As if the user had added it by hand, without a version.
  writeFileSync(marketplaceFile, 'roke22/Squadra\n')
  writeFileSync(pluginState, '')
  writeFileSync(pluginCalls, '')
  execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'plugin'], {
    env: { ...process.env, SQUADRA_HOST_DIR: hostDir, SQUADRA_TMUX_SOCKET: SOCKET, CLAUDE_CONFIG_DIR: claudeDir, SQUADRA_HOST_TEST_ALLOW_TMP: '1', SQUADRA_HOST_TEST_SKIP_TAG_CHECK: '1' },
    stdio: 'ignore',
  })
  const calls = readFileSync(pluginCalls, 'utf8')
  assert.match(calls, /plugin marketplace remove squadra/)
  assert.ok(calls.includes(`plugin marketplace add roke22/Squadra#v${VERSION}`), calls)
  assert.match(calls, /plugin install squadra@squadra/)
  assert.equal(readFileSync(marketplaceFile, 'utf8').trim(), `roke22/Squadra#v${VERSION}`)
  assert.ok(existsSync(pluginState), 'plugin installed again')
  // Already pinned: nothing is removed the next time.
  writeFileSync(pluginCalls, '')
  execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'plugin'], {
    env: { ...process.env, SQUADRA_HOST_DIR: hostDir, SQUADRA_TMUX_SOCKET: SOCKET, CLAUDE_CONFIG_DIR: claudeDir, SQUADRA_HOST_TEST_ALLOW_TMP: '1', SQUADRA_HOST_TEST_SKIP_TAG_CHECK: '1' },
    stdio: 'ignore',
  })
  assert.doesNotMatch(readFileSync(pluginCalls, 'utf8'), /marketplace remove/)
})

test('third audit: shared or containing folders, symlinked identity files and resume are refused', { skip: !hasTmux && 'tmux not installed' }, async () => {
  // Without the test switch, a temporary folder can't be allowed.
  let code = 0
  try {
    execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'folders', 'add', tmpdir()], { env: { ...process.env, SQUADRA_HOST_DIR: join(work, 'other-host') }, stdio: 'ignore' })
  } catch (err) { code = err.status }
  assert.equal(code, 2)
  // "/" contains everything: refused even if listed.
  const settings = JSON.parse(readFileSync(join(hostDir, 'settings.json'), 'utf8'))
  writeFileSync(join(hostDir, 'settings.json'), JSON.stringify({ ...settings, folders: [...settings.folders, '/'] }))
  const root = await dash('terminals/open', { host: hostId, spec: { name: 'r1', role: 'worker', folder: '/' } })
  assert.equal(root.ok, false)
  // Continuing an earlier conversation: allowed unless the machine says "allow_resume": false.
  writeFileSync(join(hostDir, 'settings.json'), JSON.stringify({ ...settings, allow_resume: false }))
  const resume = await dash('terminals/open', { host: hostId, spec: { name: 'r2', role: 'worker', folder: allowed, resume: true } })
  assert.equal(resume.ok, false)
  assert.match(resume.description, /allow_resume/)
  writeFileSync(join(hostDir, 'settings.json'), JSON.stringify(settings))
  // identity.json behind a symlink: the symlink is replaced, its target untouched.
  const dir = join(claudeDir, 'channels', 'squadra', 'sym1')
  mkdirSync(dir, { recursive: true })
  const target = join(work, 'precious.txt')
  writeFileSync(target, 'keep me')
  symlinkSync(target, join(dir, 'identity.json'))
  const r = await dash('terminals/open', { host: hostId, spec: { name: 'sym1', role: 'worker', folder: allowed } })
  assert.ok(r.ok, r.description)
  assert.equal(readFileSync(target, 'utf8'), 'keep me')
  assert.ok(!lstatSync(join(dir, 'identity.json')).isSymbolicLink())
  await dash('terminals/kill', { host: hostId, term: 'sym1' })
})

test('folders from the dashboard, and the home folder only with --allow-home', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const hostEnv = { ...process.env, SQUADRA_HOST_DIR: hostDir, SQUADRA_TMUX_SOCKET: SOCKET, CLAUDE_CONFIG_DIR: claudeDir, SQUADRA_HOST_TEST_ALLOW_TMP: '1', SQUADRA_HOST_TEST_SKIP_TAG_CHECK: '1' }
  const shown = () => dash('hosts').then(r => r.result.find(h => h.id === hostId)?.info ?? {})
  const extra = join(work, 'more')
  mkdirSync(extra, { recursive: true })
  const add = await dash('hosts/folders', { host: hostId, action: 'add', path: extra })
  assert.ok(add.ok, add.description)
  assert.ok(add.result.folders.includes(extra))
  await waitFor(async () => (await shown()).folders?.includes(extra), { what: 'folder shown' })
  assert.equal((await shown()).folders_from_dashboard, true)
  // The machine checks it: a missing folder, and the home folder without --allow-home.
  const missing = await dash('hosts/folders', { host: hostId, action: 'add', path: join(work, 'nope') })
  assert.equal(missing.ok, false)
  // (Without saying which: whoever controls the server can't probe what exists here.)
  assert.match(missing.description, /can't be allowed on this machine/)
  assert.doesNotMatch(missing.description, /does not exist|nope/)
  const home = await dash('hosts/folders', { host: hostId, action: 'add', path: '~' })
  assert.equal(home.ok, false)
  assert.match(home.description, /--allow-home/)
  assert.ok((await dash('hosts/folders', { host: hostId, action: 'remove', path: extra })).ok)
  await waitFor(async () => !(await shown()).folders?.includes(extra), { what: 'folder gone' })
  // A machine can keep its folders to itself.
  const settings = JSON.parse(readFileSync(join(hostDir, 'settings.json'), 'utf8'))
  writeFileSync(join(hostDir, 'settings.json'), JSON.stringify({ ...settings, folders_from_dashboard: false }))
  const locked = await dash('hosts/folders', { host: hostId, action: 'add', path: extra })
  assert.equal(locked.ok, false)
  assert.match(locked.description, /folders_from_dashboard/)
  writeFileSync(join(hostDir, 'settings.json'), JSON.stringify(settings))

  // --allow-home: the home folder is allowed, and a session there never has
  // its permission prompts answered remotely.
  const myHome = userInfo().homedir
  execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), '--allow-home', 'folders'], { env: hostEnv, stdio: 'ignore' })
  await waitFor(async () => (await shown()).home === myHome && (await shown()).folders?.includes(myHome), { what: 'home allowed' })
  // Claude Code installed in the home folder (~/.local/bin, as its installer
  // does) is still used: the home folder itself isn't a project folder.
  const homeBin = join(myHome, '.sq-test-bin')
  mkdirSync(homeBin, { recursive: true, mode: 0o755 })
  writeFileSync(join(homeBin, 'claude'), readFileSync(fakeClaude), { mode: 0o755 })
  const withHome = JSON.parse(readFileSync(join(hostDir, 'settings.json'), 'utf8'))
  writeFileSync(join(hostDir, 'settings.json'), JSON.stringify({ ...withHome, claude_command: join(homeBin, 'claude') }))
  const r = await dash('terminals/open', { host: hostId, spec: { name: 'hm1', role: 'worker', coordinator: 'boss', folder: myHome } })
  assert.ok(r.ok, r.description)
  const launch = JSON.parse(readFileSync(join(claudeDir, 'channels', 'squadra', 'hm1', 'launch.json'), 'utf8'))
  assert.equal(launch.permission_relay, false)
  // (Its credentials folders still can't be a session's folder.)
  mkdirSync(join(myHome, '.ssh'), { recursive: true, mode: 0o700 })
  const ssh = await dash('terminals/open', { host: hostId, spec: { name: 'hm2', role: 'worker', coordinator: 'boss', folder: join(myHome, '.ssh') } })
  assert.equal(ssh.ok, false)
  assert.ok((await dash('terminals/kill', { host: hostId, term: 'hm1' })).ok)
  writeFileSync(join(hostDir, 'settings.json'), JSON.stringify(withHome))
  rmSync(homeBin, { recursive: true, force: true })
  execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), '--no-allow-home', 'folders'], { env: hostEnv, stdio: 'ignore' })
  await waitFor(async () => !(await shown()).home && !(await shown()).folders?.includes(myHome), { what: 'home no longer allowed' })

  // Settings are replaced whole: no temporary file left, and still private.
  assert.deepEqual(readdirSync(hostDir).filter(f => f.endsWith('.tmp')), [])
  assert.equal(statSync(join(hostDir, 'settings.json')).mode & 0o777, 0o600)
  // One squadra-host at a time: a second one (by hand, next to the service) says so and stops.
  let second = null
  try { execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs')], { env: hostEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (err) { second = err }
  assert.ok(second, 'a second squadra-host must not run')
  assert.match(second.stderr, /already running/)
  assert.equal(second.status, 2, 'its service does not start it again and again')
  // Started by its service, it waits its turn instead: one started by hand may
  // end, and nothing would start it after that.
  {
    const waiting = spawn(process.execPath, [join(ROOT, 'host/squadra-host.mjs')], { env: { ...hostEnv, SQUADRA_SERVICE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    let said = ''
    waiting.stderr.on('data', d => { said += d })
    await waitFor(() => /waiting for it to end/.test(said), { what: 'waiting its turn' })
    assert.equal(waiting.exitCode, null)
    waiting.kill('SIGKILL')
    await new Promise(r => waiting.once('close', r))
  }
  assert.match(execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'service', 'print'], { env: hostEnv, encoding: 'utf8' }), /SQUADRA_SERVICE/)
  // A pid that is another program with the name in its arguments isn't another
  // squadra-host (an editor on the file, a tail of its log).
  {
    const dir = join(work, 'name-in-args')
    mkdirSync(dir, { recursive: true })
    const other = spawn('sh', ['-c', 'sleep 30', 'squadra-host.mjs'], { stdio: 'ignore' })
    writeFileSync(join(dir, 'squadra-host.pid'), `${other.pid}\n`)
    let out = null
    try { execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs')], { env: { ...hostEnv, SQUADRA_HOST_DIR: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (err) { out = err }
    other.kill()
    assert.match(out.stderr, /not enrolled/)
    assert.equal(out.status, 2)
  }
  // Credentials that can't be read just now aren't "not enrolled": it can start again later.
  {
    const dir = join(work, 'broken-creds')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'credentials.json'), '{ half a fil')
    let out = null
    try { execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs')], { env: { ...hostEnv, SQUADRA_HOST_DIR: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (err) { out = err }
    assert.equal(out.status, 1, out.stderr)
    assert.match(out.stderr, /cannot read/)
  }
  // A pid file left behind that names a thread (Linux: it answers as a process,
  // with the program's command line) isn't another squadra-host.
  if (process.platform === 'linux') {
    const thread = readdirSync(`/proc/${hostProc.pid}/task`).map(Number).find(t => t !== hostProc.pid)
    const otherDir = join(work, 'stale-pid-host')
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(join(otherDir, 'squadra-host.pid'), `${thread}\n`)
    let stale = null
    try { execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs')], { env: { ...hostEnv, SQUADRA_HOST_DIR: otherDir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (err) { stale = err }
    assert.ok(stale, 'it stops: this machine is not enrolled')
    assert.doesNotMatch(stale.stderr, /already running/)
    assert.match(stale.stderr, /not enrolled/)
  }
  // The service leaves the sessions running when it stops or restarts
  // (systemd on Linux, launchd on macOS).
  const unit = execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'service', 'print'], { env: hostEnv, encoding: 'utf8' })
  if (process.platform === 'darwin') assert.match(unit, /<key>AbandonProcessGroup<\/key><true\/>/)
  else {
    assert.match(unit, /^KillMode=process$/m)
    assert.match(unit, /^RestartPreventExitStatus=2$/m)
  }
})

test('a standalone session starts plain Claude Code: no development channel, no permission relay, no coordinator', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const bad = await dash('terminals/open', { host: hostId, spec: { name: 'solo2', role: 'solo', coordinator: 'boss', folder: allowed } })
  assert.equal(bad.ok, false)
  assert.match(bad.description, /standalone session has no coordinator/)
  const r = await dash('terminals/open', { host: hostId, spec: { name: 'solo1', role: 'solo', folder: allowed } })
  assert.ok(r.ok, r.description)
  const launch = JSON.parse(readFileSync(join(claudeDir, 'channels', 'squadra', 'solo1', 'launch.json'), 'utf8'))
  assert.equal(launch.role, 'solo')
  assert.equal(launch.permission_relay, false)
  const screen = await waitFor(() => {
    const out = execFileSync('tmux', ['-L', SOCKET, 'capture-pane', '-p', '-t', '=sq-solo1:'], { encoding: 'utf8' })
    return out.includes('ARGS:') ? out : null
  }, { what: 'solo1 started' })
  assert.ok(!screen.includes('--dangerously-load-development-channels'), screen)
  await waitFor(async () => (await dash('hosts')).result.find(h => h.id === hostId)?.info?.terminals?.some(t => t.id === 'solo1' && t.role === 'solo'), { what: 'listed as solo' })
  assert.ok((await dash('terminals/kill', { host: hostId, term: 'solo1' })).ok)
})

test('continuing: a session takes up its own conversation, never the folder\'s last one', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const id = '11111111-2222-4333-8444-555555555555'
  const transcript = join(work, `${id}.jsonl`)
  writeFileSync(transcript, '')
  const argsOf = async (name, noted) => {
    const dir = join(claudeDir, 'channels', 'squadra', name)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (noted) writeFileSync(join(dir, 'conversation.json'), JSON.stringify(noted))
    const r = await dash('terminals/open', { host: hostId, spec: { name, role: 'solo', folder: allowed, resume: true } })
    assert.ok(r.ok, r.description)
    const args = await waitFor(() => {
      const s = execFileSync('tmux', ['-L', SOCKET, 'capture-pane', '-p', '-t', `sq-${name}`], { encoding: 'utf8' })
      return s.includes('ARGS:') ? s.match(/ARGS:.*/)[0] : null
    }, { what: `${name} started` })
    assert.ok((await dash('terminals/kill', { host: hostId, term: name })).ok)
    assert.doesNotMatch(args, /--continue/)
    return args
  }
  const folder = realpathSync(allowed)
  assert.match(await argsOf('cont1', { id, transcript, folder }), new RegExp(`--resume ${id}`))
  // Nothing to take up: a new conversation.
  assert.doesNotMatch(await argsOf('cont2'), /--resume/)
  assert.doesNotMatch(await argsOf('cont3', { id, transcript, folder: outside }), /--resume/)
  assert.doesNotMatch(await argsOf('cont4', { id, transcript: join(work, 'gone.jsonl'), folder }), /--resume/)
  assert.doesNotMatch(await argsOf('cont5', { id: '--dangerously-skip-permissions', transcript, folder }), /--resume|--dangerously-skip/)
  assert.doesNotMatch(await argsOf('cont6', { id, transcript: join(work, 'another.jsonl'), folder }), /--resume/)
  assert.doesNotMatch(await argsOf('cont7', { id: [id], transcript, folder }), /--resume/)
  // A session can write in that folder: a pipe (or a device) must not stop the
  // machine, and a link isn't its note.
  const stateOf = name => { const dir = join(claudeDir, 'channels', 'squadra', name); mkdirSync(dir, { recursive: true, mode: 0o700 }); return join(dir, 'conversation.json') }
  execFileSync('mkfifo', [stateOf('cont8')])
  assert.doesNotMatch(await argsOf('cont8'), /--resume/)
  const note = join(work, 'a-note.json')
  writeFileSync(note, JSON.stringify({ id, transcript, folder }))
  symlinkSync(note, stateOf('cont9'))
  assert.doesNotMatch(await argsOf('cont9'), /--resume/)
})

test('personas: the machine lists a folder\'s skills and agents, and opens a session with the one picked by id', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const proj = join(allowed, 'team')
  mkdirSync(join(proj, '.claude', 'skills', 'design'), { recursive: true })
  mkdirSync(join(proj, '.claude', 'skills', 'leak'), { recursive: true })
  mkdirSync(join(proj, '.claude', 'agents'), { recursive: true })
  mkdirSync(join(claudeDir, 'skills', 'marketing'), { recursive: true })
  mkdirSync(join(claudeDir, 'agents'), { recursive: true })
  writeFileSync(join(proj, '.claude', 'skills', 'design', 'SKILL.md'), '---\nname: design\ndescription: >\n  Designs interfaces\n  with care\n---\nFollow the style guide in references/style.md.\n')
  writeFileSync(join(proj, '.claude', 'agents', 'hr.md'), '---\nname: hr\ndescription: "Human resources"\ntools: Read, Grep\n---\nYou work in HR.\n')
  writeFileSync(join(claudeDir, 'agents', 'dev.md'), '---\nname: dev\ndescription: Developer\n---\nYou write code.\n')
  // (The project's agent wins over the user's with the same name, as in Claude Code.)
  writeFileSync(join(claudeDir, 'agents', 'hr.md'), '---\nname: hr\ndescription: never used\n---\nx\n')
  writeFileSync(join(claudeDir, 'skills', 'marketing', 'SKILL.md'), 'Write like marketing.\n')
  // A skill that is a link out of the project is never read (nor listed).
  writeFileSync(join(outside, 'secret.md'), '---\nname: leak\ndescription: secret\n---\nsecret\n')
  symlinkSync(join(outside, 'secret.md'), join(proj, '.claude', 'skills', 'leak', 'SKILL.md'))

  // An agent named like an option of Claude Code's isn't offered, nor can it be asked for.
  writeFileSync(join(proj, '.claude', 'agents', 'flag.md'), '---\nname: --dangerously-skip-permissions\ndescription: looks harmless\n---\nx\n')
  const flagged = await dash('terminals/open', { host: hostId, spec: { name: 'flagged', role: 'worker', coordinator: 'boss', folder: proj, persona: 'agent:project:--dangerously-skip-permissions' } })
  assert.equal(flagged.ok, false)
  assert.match(flagged.description, /persona/)

  const list = await dash('hosts/personas', { host: hostId, folder: proj })
  assert.ok(list.ok, list.description)
  assert.deepEqual(list.result.personas.map(p => p.id), ['skill:project:design', 'agent:project:hr', 'skill:user:marketing', 'agent:user:dev'])
  assert.equal(list.result.personas[0].description, 'Designs interfaces with care')
  assert.equal(list.result.personas[1].description, 'Human resources')
  assert.equal(list.result.personas[1].no_squadra_tools, true)
  assert.equal(list.result.personas[3].no_squadra_tools, false)
  assert.ok(!JSON.stringify(list.result).includes(claudeDir), 'no paths for the dashboard')
  // Only in the folders this machine allows.
  const out = await dash('hosts/personas', { host: hostId, folder: outside })
  assert.equal(out.ok, false)
  assert.match(out.description, /not inside the folders this machine allows/)

  const screenOf = name => waitFor(() => {
    const s = execFileSync('tmux', ['-L', SOCKET, 'capture-pane', '-p', '-J', '-t', `=sq-${name}:`], { encoding: 'utf8' })
    return s.includes('ARGS:') ? s : null
  }, { what: `${name} started` })

  // A skill: its text goes into the system prompt, from a private copy.
  const r = await dash('terminals/open', { host: hostId, spec: { name: 'des1', role: 'worker', coordinator: 'boss', folder: proj, persona: 'skill:project:design' } })
  assert.ok(r.ok, r.description)
  const promptFile = join(claudeDir, 'channels', 'squadra', 'des1', 'persona.md')
  assert.ok((await screenOf('des1')).includes(`--append-system-prompt-file ${promptFile}`))
  const prompt = readFileSync(promptFile, 'utf8')
  assert.match(prompt, /Persona of this session: the "design" skill/)
  assert.match(prompt, /Follow the style guide in references\/style\.md\./)
  assert.ok(prompt.includes(realpathSync(join(proj, '.claude', 'skills', 'design'))), 'where its files are')
  assert.doesNotMatch(prompt, /description: >/)
  assert.equal(lstatSync(promptFile).mode & 0o777, 0o600)
  const launch = JSON.parse(readFileSync(join(claudeDir, 'channels', 'squadra', 'des1', 'launch.json'), 'utf8'))
  assert.deepEqual(launch.persona, { kind: 'skill', name: 'design', description: 'Designs interfaces with care' })
  await waitFor(async () => (await dash('hosts')).result.find(h => h.id === hostId)?.info?.terminals?.some(t => t.id === 'des1' && t.persona?.id === 'skill:project:design' && t.persona.name === 'design'), { what: 'listed with its persona' })
  // The dashboard remembers it, to open the session again the same way.
  assert.equal((await dash('state')).result.sessions.find(s => s.name === 'des1')?.opened_persona, 'skill:project:design')
  assert.ok((await dash('terminals/kill', { host: hostId, term: 'des1' })).ok)

  // An agent: by its name, and no copy of a skill left from before.
  mkdirSync(join(claudeDir, 'channels', 'squadra', 'dev1'), { recursive: true })
  writeFileSync(join(claudeDir, 'channels', 'squadra', 'dev1', 'persona.md'), 'stale')
  const a = await dash('terminals/open', { host: hostId, spec: { name: 'dev1', role: 'worker', coordinator: 'boss', folder: proj, persona: 'agent:user:dev' } })
  assert.ok(a.ok, a.description)
  assert.ok((await screenOf('dev1')).includes('--agent dev'))
  assert.ok(!existsSync(join(claudeDir, 'channels', 'squadra', 'dev1', 'persona.md')))
  assert.ok((await dash('terminals/kill', { host: hostId, term: 'dev1' })).ok)

  // An agent whose tools leave out Squadra's can't message its squad: refused
  // for a worker; a persona not there (any more), or not an id, too.
  for (const [persona, re] of [['agent:project:hr', /none of them Squadra's/], ['skill:project:nope', /is not in/], ['skill:project:leak', /is not in/], ['../../etc/passwd', /invalid persona/]]) {
    const x = await dash('terminals/open', { host: hostId, spec: { name: 'px1', role: 'worker', coordinator: 'boss', folder: proj, persona } })
    assert.equal(x.ok, false, persona)
    assert.match(x.description, re)
  }
})

test('links between squads: a coordinator opens with the ones the dashboard set, and they change while it runs', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const linksOf = name => JSON.parse(readFileSync(join(claudeDir, 'channels', 'squadra', name, 'links.json'), 'utf8'))
  // What the page sends is ignored: the server's links are the ones that count.
  for (const name of ['lk1', 'lk2']) {
    const r = await dash('terminals/open', { host: hostId, spec: { name, role: 'coordinator', folder: allowed, links: ['evil'] } })
    assert.ok(r.ok, r.description)
    assert.deepEqual(linksOf(name), { name, coordinators: [] })
  }
  await waitFor(async () => (await dash('hosts')).result.find(h => h.id === hostId)?.info?.terminals?.filter(t => t.id.startsWith('lk')).length === 2, { what: 'both listed' })
  const l = await dash('links/add', { a: 'lk1', b: 'lk2' })
  assert.ok(l.ok, l.description)
  assert.deepEqual(l.result.warnings, [])
  assert.deepEqual(linksOf('lk1'), { name: 'lk1', coordinators: ['lk2'] })
  assert.deepEqual(linksOf('lk2'), { name: 'lk2', coordinators: ['lk1'] })
  assert.equal(lstatSync(join(claudeDir, 'channels', 'squadra', 'lk1', 'links.json')).mode & 0o777, 0o600)
  // Opened again: with its links.
  assert.ok((await dash('terminals/kill', { host: hostId, term: 'lk1' })).ok)
  assert.ok(!existsSync(join(claudeDir, 'channels', 'squadra', 'lk1', 'links.json')))
  assert.ok((await dash('terminals/open', { host: hostId, spec: { name: 'lk1', role: 'coordinator', folder: allowed } })).ok)
  assert.deepEqual(linksOf('lk1'), { name: 'lk1', coordinators: ['lk2'] })
  // A machine that pins its coordinators accepts links only with those.
  const settings = JSON.parse(readFileSync(join(hostDir, 'settings.json'), 'utf8'))
  writeFileSync(join(hostDir, 'settings.json'), JSON.stringify({ ...settings, coordinators: ['lk1'] }))
  const u = await dash('links/delete', { a: 'lk1', b: 'lk2' })
  assert.ok(u.ok, u.description)
  assert.deepEqual(linksOf('lk1'), { name: 'lk1', coordinators: [] })
  const again = await dash('links/add', { a: 'lk1', b: 'lk2' })
  assert.ok(again.ok, again.description)
  assert.equal(again.result.warnings.length, 1)
  assert.match(again.result.warnings[0], /^lk1: this machine only accepts these coordinators: lk1 \(not "lk2"\)/)
  assert.ok((await dash('terminals/kill', { host: hostId, term: 'lk1' })).ok)
  const refused = await dash('terminals/open', { host: hostId, spec: { name: 'lk1', role: 'coordinator', folder: allowed } })
  assert.equal(refused.ok, false)
  assert.match(refused.description, /only accepts these coordinators/)
  writeFileSync(join(hostDir, 'settings.json'), JSON.stringify(settings))
  assert.ok((await dash('links/delete', { a: 'lk1', b: 'lk2' })).ok)
  assert.ok((await dash('terminals/kill', { host: hostId, term: 'lk2' })).ok)
})

test('fresh start: a coordinator has its idle worker\'s context cleared before a new task', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const api = async (method, params, auth, inst) => (await fetch(`${URL_}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}`, ...(inst ? { 'X-Squadra-Instance': inst } : {}) },
    body: JSON.stringify(params),
  })).json()
  const session = async (name, role, coordinator, secret) => {
    secret ??= (await api('register', { name }, SERVER_TOKEN)).result.secret
    const call = (m, p) => api(m, p, secret, `inst-${name}-000001`)
    await call('claimSession', { instance: `inst-${name}-000001`, role, ...(coordinator ? { coordinator } : {}) })
    return call
  }
  const screen = name => execFileSync('tmux', ['-L', SOCKET, 'capture-pane', '-p', '-J', '-t', `=sq-${name}:`], { encoding: 'utf8' })
  const C = await session('fc', 'coordinator')
  for (const name of ['fw1', 'fw2']) {
    const r = await dash('terminals/open', { host: hostId, spec: { name, role: 'worker', coordinator: 'fc', folder: allowed } })
    assert.ok(r.ok, r.description)
  }
  // Each worker's plugin, played here with the identity the machine gave it.
  const secretOf = name => JSON.parse(readFileSync(join(claudeDir, 'channels', 'squadra', name, 'identity.json'), 'utf8')).secret
  const W1 = await session('fw1', 'worker', 'fc', secretOf('fw1'))
  const W2 = await session('fw2', 'worker', 'fc', secretOf('fw2'))
  const ev = (kind, extra = {}) => ({ kind, ts: Date.now(), ...extra })
  await W1('observe', { events: [ev('observe_start', { level: 'activity' }), ev('prompt', { text: 'the login screen' })] })

  // In the middle of a turn: not cleared.
  let f = (await C('freshStart', { chat_id: 'fw1' })).result
  assert.deepEqual([f.cleared, f.reason], [false, 'busy'])
  // Idle: its machine types /clear in its terminal, and its plugin confirms it.
  await W1('observe', { events: [ev('stop')] })
  const pending = C('freshStart', { chat_id: 'fw1' })
  await waitFor(() => screen('fw1').includes('GOT:/clear'), { what: '/clear typed' })
  await W1('observe', { events: [ev('session_start', { source: 'clear' })] })
  assert.deepEqual((await pending).result, { cleared: true })
  // At most once a minute.
  assert.equal((await C('freshStart', { chat_id: 'fw1' })).result.reason, 'too_soon')
  // Only its own coordinator.
  const other = await session('fc2', 'coordinator')
  assert.equal((await other('freshStart', { chat_id: 'fw2' })).result.reason, 'not_your_worker')
  // And only if the machine allows it.
  await W2('observe', { events: [ev('observe_start', { level: 'activity' })] })
  const settings = JSON.parse(readFileSync(join(hostDir, 'settings.json'), 'utf8'))
  writeFileSync(join(hostDir, 'settings.json'), JSON.stringify({ ...settings, allow_clear: false }))
  f = (await C('freshStart', { chat_id: 'fw2' })).result
  assert.equal(f.reason, 'machine_refused')
  assert.match(f.text, /"allow_clear": false/)
  assert.ok(!screen('fw2').includes('GOT:/clear'))
  writeFileSync(join(hostDir, 'settings.json'), JSON.stringify(settings))
  for (const name of ['fw1', 'fw2']) assert.ok((await dash('terminals/kill', { host: hostId, term: name })).ok)
  // What the hooks say isn't all: Enter on a question would answer it, and only
  // what reached the input is sent.
  for (const [name, type, why] of [['fw3', 'DIALOG', /waiting for an answer/], ['fw4', 'NOECHO', /didn't reach its input/]]) {
    assert.ok((await dash('terminals/open', { host: hostId, spec: { name, role: 'worker', coordinator: 'fc', folder: allowed } })).ok)
    await waitFor(() => screen(name).includes('TMUX='), { what: 'it started' })
    const W = await session(name, 'worker', 'fc', secretOf(name))
    await W('observe', { events: [ev('observe_start', { level: 'activity' }), ev('stop')] })
    execFileSync('tmux', ['-L', SOCKET, 'send-keys', '-t', `=sq-${name}:`, '-l', type])
    execFileSync('tmux', ['-L', SOCKET, 'send-keys', '-t', `=sq-${name}:`, 'Enter'])
    await sleep(300)
    f = (await C('freshStart', { chat_id: name })).result
    assert.equal(f.reason, 'machine_refused', JSON.stringify(f))
    assert.match(f.text, why)
    assert.ok(!screen(name).includes('GOT:/clear'), screen(name))
    assert.ok((await dash('terminals/kill', { host: hostId, term: name })).ok)
  }
})

test('a worker opened with no coordinator named follows the default from the start: a new "coord" gives it no orders', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const opened = await dash('terminals/open', { host: hostId, spec: { name: 'nocoord1', role: 'worker', folder: allowed } })
  assert.ok(opened.ok, opened.description)
  const joinTok = readFileSync(join(dataDir, 'join-token'), 'utf8').trim()
  const post = async (path, body, auth) => (await fetch(`${URL_}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, body: JSON.stringify(body) })).json()
  // (The name, if nobody had it: otherwise the same goes for another worker it might follow.)
  const taken = await post('register', { name: 'coord' }, joinTok)
  assert.ok(taken.ok, taken.description)
  const said = await post('sendMessage', { chat_id: 'nocoord1', text: 'an order' }, taken.result.secret)
  assert.equal(said.error_code, 403)
  assert.match(said.description, /has not been approved as a coordinator/)
  assert.ok((await dash('terminals/kill', { host: hostId, term: 'nocoord1' })).ok)
})

test('disconnecting a machine revokes it and stops squadra-host there', { skip: !hasTmux && 'tmux not installed' }, async () => {
  // With its sessions, if asked: what it held of them stops working.
  assert.ok((await dash('terminals/open', { host: hostId, spec: { name: 'gone1', role: 'worker', coordinator: 'boss', folder: allowed } })).ok)
  const { secret } = JSON.parse(readFileSync(join(claudeDir, 'channels', 'squadra', 'gone1', 'identity.json'), 'utf8'))
  assert.ok((await dash('terminals/kill', { host: hostId, term: 'gone1' })).ok)
  const asIt = () => fetch(`${URL_}/getMe`, { headers: { Authorization: `Bearer ${secret}` } }).then(x => x.status)
  assert.equal(await asIt(), 200)
  const r = await dash('hosts/remove', { host: hostId, disconnect_sessions: true })
  assert.ok(r.ok, r.description)
  assert.ok(r.result.disconnected.includes('gone1'))
  assert.equal(await asIt(), 401)
  await waitFor(() => hostExit !== null, { what: 'host exit' })
  assert.equal(hostExit, 0, "exit 0: the service manager must not start it again")
  assert.match(hostStderr, /no longer accepts this machine/)
  assert.equal((await dash('hosts')).result.length, 0)
  const open = await dash('terminals/open', { host: hostId, spec: { name: 'x', role: 'worker', folder: allowed } })
  assert.equal(open.ok, false)
  assert.ok(existsSync(join(hostDir, 'credentials.json')))
})

test('a machine that only watches takes no folders and continues no conversation, unless it says so', () => {
  const dir = join(work, 'watch-host')
  mkdirSync(dir, { recursive: true })
  const settingsWith = extra => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ settings_version: 4, allow_input: false, ...extra }))
    return JSON.parse(execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'status'], { env: { ...process.env, SQUADRA_HOST_DIR: dir }, encoding: 'utf8' })).settings
  }
  const watching = settingsWith({})
  assert.equal(watching.folders_from_dashboard, false)
  assert.equal(watching.allow_resume, false)
  const chosen = settingsWith({ folders_from_dashboard: true, allow_resume: true })
  assert.equal(chosen.folders_from_dashboard, true)
  assert.equal(chosen.allow_resume, true)
})

test('fourth audit: a settings.json that cannot be read means the strictest settings', () => {
  const dir = join(work, 'broken-host')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), '{ "allow_input": false, oops')
  const out = execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'status'], { env: { ...process.env, SQUADRA_HOST_DIR: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const st = JSON.parse(out).settings
  assert.equal(st.allow_input, false)
  assert.equal(st.permission_relay, false)
  assert.deepEqual(st.folders, [])
})

test('a settings.json from 0.0.2 gets the new defaults once (continuing a conversation allowed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'squadra-host-mig-'))
  const env = { ...process.env, SQUADRA_HOST_DIR: dir }
  const run = () => execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'folders'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  // What 0.0.2 wrote at enrollment: its defaults, allow_resume false among them.
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ folders: [], max_sessions: 8, allow_input: true, allow_resume: false, claude_command: 'claude' }))
  run()
  const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  assert.equal(s.allow_resume, undefined)
  assert.equal(s.settings_version, 4)
  // Turned off again by hand afterwards: that choice stays.
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...s, allow_resume: false }))
  run()
  assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).allow_resume, false)
  // What up to 0.0.7 wrote at enrollment: true, which now follows allow_input.
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ folders: [], allow_input: false, allow_resume: true, settings_version: 3 }))
  run()
  const later = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  assert.equal(later.allow_resume, undefined)
  assert.equal(later.settings_version, 4)
  // Chosen again afterwards: it stays.
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...later, allow_resume: true }))
  run()
  assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).allow_resume, true)
})

// --- squadra-host update ---------------------------------------------------------------

test('squadra-host runs when it is reached through a link', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'squadra-link-')))
  mkdirSync(join(dir, 'real'))
  writeFileSync(join(dir, 'real', 'program.mjs'), readFileSync(join(ROOT, 'host/squadra-host.mjs')))
  symlinkSync(join(dir, 'real'), join(dir, 'link'))
  const out = execFileSync(process.execPath, [join(dir, 'link', 'program.mjs'), 'help'], { env: { ...process.env, SQUADRA_HOST_DIR: join(dir, 'home') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.match(out, /squadra-host/)
  rmSync(dir, { recursive: true, force: true })
})

test('update: only a signed release, and not an older one', async t => {
  const { generateKeyPairSync, createPublicKey, sign } = await import('node:crypto')
  const { createServer } = await import('node:http')
  const { promisify } = await import('node:util')
  const { execFile } = await import('node:child_process')
  const { privateKey } = generateKeyPairSync('ed25519')
  const dir = mkdtempSync(join(tmpdir(), 'squadra-update-'))
  // A copy of the program with a key to check with (and no launcher in the real home).
  const publicB64 = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url')
  const real = readFileSync(join(ROOT, 'host/squadra-host.mjs'), 'utf8')
  const copyWith = key => real.replace(/^const RELEASE_PUBLIC_KEY = '.*'$/m, `const RELEASE_PUBLIC_KEY = '${key}'`).replace('try { installLauncher() } catch {}', '')
  const program = join(dir, 'program.mjs')
  writeFileSync(program, copyWith(publicB64))
  const release = v => Buffer.from(`const VERSION = '${v}'\nprocess.exit(0)\n`)
  const signed = b => sign(null, b, privateKey).toString('base64url')
  const served = { body: null, sig: null }
  const srv = createServer((req, res) => {
    const r = req.url.endsWith('.sig') ? served.sig : served.body
    res.writeHead(r == null ? 404 : 200)
    res.end(r ?? 'not found')
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  t.after(() => { srv.closeAllConnections(); srv.close() })
  const hostHome = join(dir, 'host')
  mkdirSync(hostHome, { recursive: true, mode: 0o700 })
  writeFileSync(join(hostHome, 'credentials.json'), JSON.stringify({ server: `http://127.0.0.1:${srv.address().port}`, id: 'h', secret: 's' }))
  const installed = join(hostHome, 'squadra-host.mjs')
  const update = async (...flags) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [program, 'update', ...flags], { env: { ...process.env, SQUADRA_HOST_DIR: hostHome }, encoding: 'utf8' })
      return { ok: true, text: stdout + stderr }
    } catch (err) { return { ok: false, text: err.stdout + err.stderr } }
  }
  const has = v => existsSync(installed) && readFileSync(installed, 'utf8').includes(`'${v}'`)
  const newer = release('9.9.9')

  // No signature, or one that doesn't match: refused, nothing installed.
  served.body = newer; served.sig = null
  let r = await update()
  assert.equal(r.ok, false); assert.match(r.text, /no signature/); assert.ok(!existsSync(installed))
  served.sig = signed(release('9.9.8'))
  r = await update()
  assert.equal(r.ok, false); assert.match(r.text, /does not match/); assert.ok(!existsSync(installed))
  // Signed by someone else.
  served.sig = sign(null, newer, generateKeyPairSync('ed25519').privateKey).toString('base64url')
  r = await update()
  assert.equal(r.ok, false); assert.match(r.text, /does not match/); assert.ok(!existsSync(installed))
  // Signed, but older than this program.
  served.body = release('0.0.1'); served.sig = signed(served.body)
  r = await update()
  assert.equal(r.ok, false); assert.match(r.text, /older than this one/); assert.ok(!existsSync(installed))
  // A real release.
  served.body = newer; served.sig = signed(newer)
  r = await update()
  assert.equal(r.ok, true, r.text); assert.ok(has('9.9.9'))
  // While a new key takes over there are two signatures, and one is ours.
  const otherKey = generateKeyPairSync('ed25519').privateKey
  served.body = release('9.9.9'); served.sig = `${sign(null, served.body, otherKey).toString('base64url')}\n${signed(served.body)}\n`
  r = await update()
  assert.equal(r.ok, true, r.text)
  served.sig = `${sign(null, served.body, otherKey).toString('base64url')}\n${signed(release('9.9.8'))}\n`
  r = await update()
  assert.equal(r.ok, false); assert.match(r.text, /does not match/)
  // Only by asking for it, with a warning.
  served.body = release('9.9.10'); served.sig = null
  r = await update('--allow-unsigned')
  assert.equal(r.ok, true, r.text); assert.match(r.text, /unsigned/); assert.ok(has('9.9.10'))
  served.body = release('0.0.2'); served.sig = signed(served.body)
  r = await update('--allow-downgrade')
  assert.equal(r.ok, true, r.text); assert.ok(has('0.0.2'))
  // The copy it replaced stays next to it.
  assert.ok(readFileSync(`${installed}.bak`, 'utf8').includes(`'9.9.10'`))
  // Signed, but it can't run: nothing changes, and nothing is left behind.
  served.body = Buffer.from(`const VERSION = '9.9.11'\nnot a program (\n`); served.sig = signed(served.body)
  r = await update()
  assert.equal(r.ok, false); assert.match(r.text, /not a program that can run/); assert.ok(has('0.0.2'))
  assert.deepEqual(readdirSync(hostHome).filter(f => f.includes('.tmp')), [])
  // A step after it fails: said, and the update doesn't pass for finished.
  served.body = Buffer.from(`const VERSION = '9.9.12'\nprocess.exit(3)\n`); served.sig = signed(served.body)
  r = await update()
  assert.equal(r.ok, false); assert.match(r.text, /this step failed: plugin/); assert.ok(has('9.9.12'))
  // A copy with no key has nothing to check with.
  writeFileSync(program, copyWith(''))
  served.body = newer; served.sig = signed(newer)
  r = await update()
  assert.equal(r.ok, false); assert.match(r.text, /no release key/)
})

test('folders: at most 50, and a name with a space at its end can be managed', () => {
  const dir = join(work, 'many-folders')
  mkdirSync(dir, { recursive: true })
  const base = join(work, 'many')
  mkdirSync(base, { recursive: true })
  const list = Array.from({ length: 50 }, (_, i) => { const d = join(base, `f${i}`); mkdirSync(d, { recursive: true }); return d })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ settings_version: 4, folders: list }))
  const env = { ...process.env, SQUADRA_HOST_DIR: dir, SQUADRA_HOST_TEST_ALLOW_TMP: '1' }
  const run = (...args) => { try { return { ok: true, out: execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'folders', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } } catch (err) { return { ok: false, out: err.stderr } } }
  const extra = join(base, 'one more ')
  mkdirSync(extra, { recursive: true })
  const fiftyFirst = join(base, 'f50')
  mkdirSync(fiftyFirst, { recursive: true })
  const full = run('add', fiftyFirst)
  assert.equal(full.ok, false)
  assert.match(full.out, /at most 50/)
  assert.equal(run().out.trim().split('\n').length, 50)
  assert.ok(run('remove', list[0]).ok)
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ settings_version: 4, folders: [extra] }))
  assert.ok(run('remove', extra).ok, 'the space is part of its name')
})

test('settings: a file locked by hand stays locked, and a link stays a link', { skip: process.getuid?.() === 0 && 'root writes anywhere' }, () => {
  const dir = join(work, 'locked-settings')
  mkdirSync(dir, { recursive: true })
  const folder = join(work, 'locked-folder')
  mkdirSync(folder, { recursive: true })
  const env = { ...process.env, SQUADRA_HOST_DIR: dir, SQUADRA_HOST_TEST_ALLOW_TMP: '1' }
  const add = () => { try { execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'folders', 'add', folder], { env, stdio: ['ignore', 'pipe', 'pipe'] }); return true } catch { return false } }
  const file = join(dir, 'settings.json')
  writeFileSync(file, JSON.stringify({ settings_version: 4, folders: [] }))
  chmodSync(file, 0o444)
  assert.equal(add(), false)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).folders, [])
  rmSync(file, { force: true })
  const real = join(dir, 'real-settings.json')
  writeFileSync(real, JSON.stringify({ settings_version: 4, folders: [] }))
  symlinkSync(real, file)
  assert.equal(add(), true)
  assert.ok(lstatSync(file).isSymbolicLink())
  assert.equal(JSON.parse(readFileSync(real, 'utf8')).folders.length, 1)
})

test('the service of another configuration folder is left alone', { skip: (process.platform !== 'linux' || process.getuid() === 0) && 'a user service on Linux' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'squadra-service-'))
  const unit = join(dir, 'xdg', 'systemd', 'user', 'squadra-host.service')
  mkdirSync(dirname(unit), { recursive: true })
  writeFileSync(unit, 'ExecStart=/usr/bin/node /elsewhere/squadra-host.mjs\n')
  const env = { ...process.env, SQUADRA_HOST_DIR: join(dir, 'host'), XDG_CONFIG_HOME: join(dir, 'xdg') }
  for (const args of [['service'], ['service', 'remove']]) {
    let failed = null
    try { execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (err) { failed = err }
    assert.equal(failed?.status, 2, args.join(' '))
    assert.match(failed.stderr, /runs another squadra-host/)
    assert.equal(readFileSync(unit, 'utf8'), 'ExecStart=/usr/bin/node /elsewhere/squadra-host.mjs\n')
  }
})

test('preparing a release: the version everywhere, signed, or nothing changes', async () => {
  const { createPublicKey, verify } = await import('node:crypto')
  const { cpSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'squadra-release-'))
  const files = ['scripts', 'package.json', 'package-lock.json', 'server/package.json', 'plugins/squadra/package.json', 'plugins/squadra/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'host/squadra-host.mjs', '.github/ISSUE_TEMPLATE/bug_report.yml', 'README.md', 'README-es.md']
  for (const f of files) cpSync(join(ROOT, f), join(dir, f), { recursive: true })
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs/reference.md'), `· v${VERSION}</p>\n`); writeFileSync(join(dir, 'docs/referencia.md'), `· v${VERSION}</p>\n`)
  const at = f => join(dir, f)
  const text = f => readFileSync(at(f), 'utf8')
  const edit = (f, change) => writeFileSync(at(f), change(text(f)))
  const run = (script, ...args) => {
    try {
      return { ok: true, text: execFileSync(process.execPath, [at(`scripts/${script}.mjs`), ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
    } catch (err) { return { ok: false, text: `${err.stdout}${err.stderr}` } }
  }
  const setKey = out => {
    const key = /RELEASE_PUBLIC_KEY in host\/squadra-host\.mjs:\n(\S+)/.exec(out.text)[1]
    edit('host/squadra-host.mjs', s => s.replace(/^const RELEASE_PUBLIC_KEY = '.*'$/m, `const RELEASE_PUBLIC_KEY = '${key}'`))
    return key
  }
  edit('package.json', s => s.replace(/"test": ".*"/, '"test": "node -e 0"'))
  const keyFile = at('key.pem'); const oldKeyFile = at('old-key.pem')
  const firstPublic = setKey(run('release-sign', 'keygen', oldKeyFile))
  rmSync(at('host/squadra-host.mjs.sig'), { force: true })
  assert.equal(run('release', 'check').ok, false)

  // Refused before anything changes: a key that isn't ours, a lower version, no upgrade notes.
  const unrelated = at('unrelated.pem')
  run('release-sign', 'keygen', unrelated)
  const before = () => text('host/squadra-host.mjs') + text('package.json')
  const start = before()
  let r = run('release', '99.0.0', oldKeyFile)
  assert.equal(r.ok, false); assert.match(r.text, /write what someone updating/); assert.equal(before(), start)
  edit('docs/reference.md', s => `${s}**From ${VERSION}:** nothing\n`)
  edit('docs/referencia.md', s => `${s}**Desde ${VERSION}:** nada\n`)
  r = run('release', '99.0.0', unrelated)
  assert.equal(r.ok, false); assert.match(r.text, /not the one/); assert.equal(before(), start)
  r = run('release', '0.0.0', oldKeyFile)
  assert.equal(r.ok, false); assert.match(r.text, /older than/); assert.equal(before(), start)

  // A release: said everywhere (the real files), and signed.
  r = run('release', '99.0.0', oldKeyFile)
  assert.equal(r.ok, true, r.text); assert.match(r.text, /git tag -s v99\.0\.0/)
  assert.ok(!files.slice(1).some(f => text(f).includes(`"version": "${VERSION}"`) || text(f).includes(`v${VERSION}`) || text(f).includes(`'${VERSION}'`)))
  assert.equal(run('release', 'check').ok, true)
  assert.equal(run('release', 'check', 'v99.0.0').ok, true)
  assert.equal(run('release', 'check', 'v99.0.1').ok, false)
  // A place left behind, or a change after signing.
  const readme = text('README.md')
  edit('README.md', s => s.replace('v99.0.0', 'v98.0.0'))
  r = run('release', 'check')
  assert.equal(r.ok, false); assert.match(r.text, /README\.md/)
  writeFileSync(at('README.md'), readme)
  const program = text('host/squadra-host.mjs')
  edit('host/squadra-host.mjs', s => `${s}\n// changed`)
  assert.equal(run('release', 'check').ok, false)
  writeFileSync(at('host/squadra-host.mjs'), program)

  // Tests that fail are said, and the same version can be run again.
  edit('package.json', s => s.replace('"node -e 0"', '"node -e process.exit(1)"'))
  r = run('release', '99.0.0', oldKeyFile)
  assert.equal(r.ok, false); assert.match(r.text, /tests failed/)
  edit('package.json', s => s.replace('"node -e process.exit(1)"', '"node -e 0"'))
  assert.equal(run('release', '99.0.0', oldKeyFile).ok, true)

  // A tag already there.
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: dir, stdio: 'ignore' })
  git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'x'); git('tag', 'v99.0.0')
  r = run('release', '99.0.0', oldKeyFile)
  assert.equal(r.ok, false); assert.match(r.text, /already exists/)
  rmSync(at('.git'), { recursive: true })

  // A new key: both sign, so a machine with either accepts it. The old one alone won't do.
  const newPublic = setKey(run('release-sign', 'keygen', keyFile))
  assert.equal(run('release-sign', 'sign', oldKeyFile).ok, false)
  assert.equal(run('release-sign', 'sign', keyFile, keyFile).ok, false)
  r = run('release', '99.0.0', keyFile, oldKeyFile)
  assert.equal(r.ok, true, r.text)
  const signatures = text('host/squadra-host.mjs.sig').trim().split('\n')
  assert.equal(signatures.length, 2)
  for (const key of [firstPublic, newPublic]) {
    const publicKey = createPublicKey({ key: Buffer.from(key, 'base64url'), format: 'der', type: 'spki' })
    assert.ok(signatures.some(s => verify(null, readFileSync(at('host/squadra-host.mjs')), publicKey, Buffer.from(s, 'base64url'))), 'each machine can check it')
  }
})

test('squadra-host keeps its secret out of the WebSocket headers, and stops only when the server says so', async t => {
  const { createServer } = await import('node:http')
  const { generateKeyPairSync, sign } = await import('node:crypto')
  const seen = { ticketAuth: null, protocols: [], answer: 200, proves: null }
  const srv = createServer((req, res) => {
    if (req.url.startsWith('/server-identity')) {
      // (A server older than this program has no key to prove.)
      if (!seen.proves) { res.writeHead(seen.answer === 401 ? 401 : 404); return res.end('{}') }
      const nonce = new URL(req.url, 'http://x').searchParams.get('nonce')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, result: { key: seen.proves.public, challenge: 'c', sig: sign(null, Buffer.from(JSON.stringify(['squadra-server-identity-1', nonce, 'c'])), seen.proves.privateKey).toString('base64url') } }))
    }
    if (req.url === '/host/ticket') {
      seen.ticketAuth = req.headers.authorization
      if (seen.answer !== 200) { res.writeHead(seen.answer); return res.end('{}') }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, result: { ticket: 'ht_a_ticket_for_this_test' } }))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, version: VERSION }))
  })
  srv.on('upgrade', (req, socket) => { seen.protocols.push(String(req.headers['sec-websocket-protocol'])); socket.destroy() })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  t.after(() => { srv.closeAllConnections(); srv.close() })
  const dir = mkdtempSync(join(tmpdir(), 'squadra-ticket-'))
  const secret = 'sh_the_real_secret_of_this_machine'
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ server: `http://127.0.0.1:${srv.address().port}`, id: 'h', secret }), { mode: 0o600 })
  const run = () => spawn(process.execPath, [join(ROOT, 'host/squadra-host.mjs')], { env: { ...process.env, SQUADRA_HOST_DIR: dir, SQUADRA_TMUX_SOCKET: `${SOCKET}-ticket`, PATH: dirname(process.execPath) + ':/usr/bin:/bin' }, stdio: 'ignore' })
  const a = run()
  try {
    await waitFor(() => seen.protocols.length > 0, { timeout: 20_000, what: 'the WebSocket request' })
    assert.equal(seen.ticketAuth, `Bearer ${secret}`)
    assert.ok(seen.protocols.every(p => p.includes('auth.ht_a_ticket_for_this_test') && !p.includes(secret)), seen.protocols.join())
  } finally { a.kill('SIGKILL') }
  // A server without tickets (older than this program) still gets the secret,
  // whichever way it refuses the ticket: for one of them, a machine's secret is
  // just a session it doesn't know.
  for (const answer of [404, 401]) {
    seen.protocols = []
    seen.answer = answer
    const b = run()
    try {
      await waitFor(() => seen.protocols.length > 0, { timeout: 20_000, what: 'the WebSocket request' })
      assert.ok(seen.protocols[0].includes(`auth.${secret}`))
    } finally { b.kill('SIGKILL') }
  }
  // Told by a server that proves its key that it is unknown: it stops, with
  // exit 0, and the service isn't restarted.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  seen.proves = { privateKey, public: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') }
  seen.answer = 401
  const c = run()
  const code = await new Promise(resolve => { c.on('close', resolve); setTimeout(() => { c.kill('SIGKILL'); resolve('still running') }, 20_000) })
  assert.equal(code, 0)
})

test('the server keeps its key: made once, the same after a restart, and never replaced by itself', async () => {
  const { randomBytes } = await import('node:crypto')
  const dir = mkdtempSync(join(tmpdir(), 'squadra-server-key-'))
  const port = 21500 + Math.floor(Math.random() * 500)
  const start = () => spawn(process.execPath, [join(ROOT, 'server/server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, SQUADRA_SERVER_TOKEN: SERVER_TOKEN }, stdio: ['ignore', 'ignore', 'pipe'] })
  const up = async () => {
    const p = start()
    p.log = ''
    p.stderr.on('data', d => { p.log += d })
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch { return false } }, { what: 'server' })
    return p
  }
  const stop = p => new Promise(r => { p.on('close', r); p.kill('SIGTERM') })
  const key = async () => (await (await fetch(`http://127.0.0.1:${port}/server-identity?nonce=${randomBytes(18).toString('base64url')}`)).json()).result.key
  let p = await up()
  const first = await key()
  const file = join(dir, 'server-key')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  await waitFor(() => p.log.includes('Server key:'), { what: 'the banner' })
  assert.ok(!p.log.includes(readFileSync(file, 'utf8').split('\n')[1]), 'the private key is not in the log')
  await stop(p)
  p = await up()
  assert.equal(await key(), first)
  await stop(p)
  // A damaged key isn't replaced: that would make it look like an impostor to everyone.
  writeFileSync(file, 'not a key\n')
  p = start()
  const code = await new Promise(r => p.on('close', r))
  assert.equal(code, 1)
  assert.equal(readFileSync(file, 'utf8'), 'not a key\n')
})

test('a machine and its server prove who they are, and their link is theirs alone', { skip: !hasTmux && 'tmux not installed' }, async t => {
  const { createServer: createTcp, connect } = await import('node:net')
  const { createServer } = await import('node:http')
  const { generateKeyPairSync, sign } = await import('node:crypto')
  // Everything goes through this: it sees all the bytes, and can change them.
  const relay = { target: PORT, toHost: [], toServer: [], flipToHost: false, flipToServer: false, sockets: new Set() }
  const flip = d => { const b = Buffer.from(d); b[b.length - 5] ^= 1; return b }
  const tcp = createTcp(client => {
    const up = connect(relay.target, '127.0.0.1')
    relay.sockets.add(client).add(up)
    client.on('data', d => { relay.toServer.push(d); if (relay.flipToServer && d.length > 40) { relay.flipToServer = false; d = flip(d) } up.write(d) })
    up.on('data', d => { relay.toHost.push(d); if (relay.flipToHost && d.length > 40) { relay.flipToHost = false; d = flip(d) } client.write(d) })
    for (const s of [client, up]) { s.on('error', () => {}); s.on('close', () => { client.destroy(); up.destroy() }) }
  })
  await new Promise(r => tcp.listen(0, '127.0.0.1', r))
  relay.cut = () => { for (const s of relay.sockets) s.destroy(); relay.sockets.clear() }
  const through = `http://127.0.0.1:${tcp.address().port}`
  let host
  const hostDir2 = join(work, 'host-link')
  mkdirSync(hostDir2, { recursive: true, mode: 0o700 })
  writeFileSync(join(hostDir2, 'settings.json'), JSON.stringify({ folders: [allowed], max_sessions: 1, allow_input: true, claude_command: fakeClaude }))
  const env = { ...process.env, SQUADRA_HOST_DIR: hostDir2, SQUADRA_TMUX_SOCKET: `${SOCKET}-link`, CLAUDE_CONFIG_DIR: claudeDir, SQUADRA_HOST_TEST_ALLOW_TMP: '1', PATH: `${dirname(fakeClaude)}:${process.env.PATH}` }
  t.after(() => { host?.kill('SIGKILL'); relay.cut(); tcp.close() })

  const en = await dash('hosts/enroll', { name: 'link box' })
  // A command for another server: nothing is sent, and the code isn't used up.
  const wrong = await new Promise(resolve => {
    const p = spawn(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'enroll', through, en.result.code, '--no-service', '--no-plugin', `--server-key=${'0'.repeat(64)}`], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: work })
    let log = ''
    p.stderr.on('data', d => { log += d })
    p.on('close', code => resolve({ code, log }))
  })
  assert.notEqual(wrong.code, 0); assert.match(wrong.log, /not the server the dashboard/)
  assert.ok(!existsSync(join(hostDir2, 'credentials.json')))

  let log = ''
  host = spawn(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'enroll', through, en.result.code, '--no-service', '--no-plugin', `--server-key=${en.result.server_key}`], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: work })
  host.stderr.on('data', d => { log += d })
  const online = () => waitFor(async () => (await dash('hosts')).result.find(x => x.name === 'link box' && x.online), { what: 'the machine online', timeout: 45_000 })
  const { id } = await online()
  const creds = JSON.parse(readFileSync(join(hostDir2, 'credentials.json'), 'utf8'))
  assert.ok(creds.server_key)
  assert.equal(statSync(join(hostDir2, 'host-key.json')).mode & 0o777, 0o600)

  // Nothing on the link can be read on the way…
  const roundTrip = async () => {
    const r = await dash('hosts/folders', { host: id, action: 'add', path: join(work, 'nope') })
    assert.equal(r.ok, false); assert.doesNotMatch(r.description, /not connected|timed? ?out|disconnected/i)
  }
  await roundTrip()
  // (What the server sends isn't masked: this is the only thing hiding it.)
  const upToServer = Buffer.concat(relay.toServer).toString('latin1')
  assert.match(upToServer, /auth\.ht_/)
  assert.ok(!upToServer.includes(`auth.${creds.secret}`))
  const fromServer = Buffer.concat(relay.toHost).toString('latin1')
  const onLink = fromServer.slice(fromServer.lastIndexOf('101 Switching Protocols'))
  assert.ok(onLink.length > 100, 'something was sent on the link')
  assert.doesNotMatch(onLink, /"t":|link box|nope/)

  // …and whoever has its secret alone gets nothing.
  const ticket = await fetch(`${URL_}/host/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${creds.secret}` } })
  assert.equal(ticket.status, 403)
  const closed = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/host/connect`, ['squadra', `auth.${creds.secret}`])
    ws.onclose = ev => resolve(ev.code)
  })
  assert.equal(closed, 4003)
  // Nor with a good proof of another key.
  const { randomBytes } = await import('node:crypto')
  const nonce = randomBytes(18).toString('base64url')
  const { key: serverKey, challenge } = (await (await fetch(`${URL_}/server-identity?nonce=${nonce}`)).json()).result
  const other = generateKeyPairSync('ed25519')
  const eph = generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  const otherTicket = await fetch(`${URL_}/host/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), challenge, eph,
      proof: sign(null, Buffer.from(JSON.stringify(['squadra-client-proof-1', serverKey, 'host-ticket', id, challenge, eph])), other.privateKey).toString('base64url'),
    }),
  })
  assert.equal(otherTicket.status, 403)
  assert.match((await otherTicket.json()).description, /different key/)

  // A byte changed, either way: noticed, and the machine connects again.
  relay.flipToHost = true
  await dash('hosts/folders', { host: id, action: 'add', path: join(work, 'nope') }).catch(() => {})
  await waitFor(() => log.includes('does not check'), { what: 'the machine to notice' })
  await online()
  await waitFor(async () => { try { await roundTrip(); return true } catch { return false } }, { what: 'the link back' })
  const mark = log.length
  relay.flipToServer = true
  await dash('hosts/folders', { host: id, action: 'add', path: join(work, 'nope') }).catch(() => {})
  await waitFor(() => log.slice(mark).includes('connection lost'), { what: 'the server to drop it' })
  await online()
  await waitFor(async () => { try { await roundTrip(); return true } catch { return false } }, { what: 'the link back' })

  // Something else at that address, with its own key.
  const impostor = generateKeyPairSync('ed25519')
  const pub = impostor.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  const fake = { auth: [], upgrades: 0, mode: 'own key' }
  const answerJson = (res, result, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: status === 200, result })) }
  const fakeServer = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    if (req.headers.authorization) fake.auth.push(req.headers.authorization)
    const body = Buffer.concat(chunks).toString('utf8')
    if (fake.mode === 'own key') {
      const nonce = new URL(req.url, 'http://x').searchParams.get('nonce')
      return answerJson(res, { key: pub, challenge: 'c', sig: sign(null, Buffer.from(JSON.stringify(['squadra-server-identity-1', nonce, 'c'])), impostor.privateKey).toString('base64url') })
    }
    if (fake.mode === 'no key') return answerJson(res, undefined, 404)
    // In the middle, passing on what each says with a certificate for the name:
    // it can swap the keys of the exchange, but it can't sign them.
    const swapped = generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
    const sent = fake.mode === 'swap ours' && req.url === '/host/ticket' ? JSON.stringify({ ...JSON.parse(body), eph: swapped }) : body
    const up = await fetch(`${URL_}${req.url}`, { method: req.method, headers: { ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}), 'Content-Type': 'application/json' }, ...(req.method === 'POST' ? { body: sent } : {}) })
    const j = await up.json()
    if (fake.mode === 'swap theirs' && req.url === '/host/ticket' && j.ok) j.result.eph = swapped
    res.writeHead(up.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(j))
  })
  fakeServer.on('upgrade', (req, socket) => { fake.upgrades++; socket.destroy() })
  await new Promise(r => fakeServer.listen(0, '127.0.0.1', r))
  t.after(() => { fakeServer.closeAllConnections(); fakeServer.close() })
  const pointAt = port => { relay.target = port; relay.cut() }
  let at = log.length
  pointAt(fakeServer.address().port)
  await waitFor(() => /not the server this machine knows/.test(log.slice(at)), { what: 'an impostor noticed', timeout: 45_000 })
  assert.deepEqual(fake.auth, [], 'its secret was not sent')
  at = log.length
  fake.mode = 'no key'
  relay.cut()
  await waitFor(() => /one proves none/.test(log.slice(at)), { what: 'a server with no key noticed', timeout: 45_000 })
  assert.deepEqual(fake.auth, [])
  assert.equal(fake.upgrades, 0)

  at = log.length
  fake.mode = 'swap theirs'
  relay.cut()
  await waitFor(() => /not from this server/.test(log.slice(at)), { what: 'a swapped answer noticed', timeout: 45_000 })
  at = log.length
  fake.mode = 'swap ours'
  relay.cut()
  await waitFor(() => /does not prove/.test(log.slice(at)), { what: 'a swapped request refused', timeout: 45_000 })
  assert.equal(fake.upgrades, 0, 'no link was opened through it')

  // The real one again.
  pointAt(PORT)
  await online()
  await roundTrip()

  // A machine enrolled before it remembered keys takes this one, the first time.
  host.kill('SIGKILL')
  await waitFor(async () => !(await dash('hosts')).result.find(x => x.id === id).online, { what: 'the machine offline', timeout: 45_000 })
  const { server_key: known, ...older } = JSON.parse(readFileSync(join(hostDir2, 'credentials.json'), 'utf8'))
  writeFileSync(join(hostDir2, 'credentials.json'), JSON.stringify(older))
  host = spawn(process.execPath, [join(ROOT, 'host/squadra-host.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: work })
  await online()
  assert.equal(JSON.parse(readFileSync(join(hostDir2, 'credentials.json'), 'utf8')).server_key, known)
})

test('the server hands out the release signature next to the program', async () => {
  const r = await fetch(`${URL_}/host/squadra-host.mjs.sig`)
  assert.equal(r.status, existsSync(join(ROOT, 'host/squadra-host.mjs.sig')) ? 200 : 404)
})

test('one machine, two companies, the same session name: two separate copies of everything', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const xdg = mkdtempSync(join(homedir(), '.squadra-host-test-xdg-'))
  const project = name => { const d = join(allowed, name); mkdirSync(d, { recursive: true }); return d }
  const company = async name => (await (await fetch(`${URL_}/admin/createCompany`, { method: 'POST', headers: { Authorization: `Bearer ${SERVER_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json()).result
  const [a, b] = [await company('Shared A'), await company('Shared B')]
  const inDash = async (co, what, body) => (await fetch(`${URL_}/api/c/${co.id}/${what}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${SERVER_TOKEN}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json()
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, SQUADRA_HOST_TEST_ALLOW_TMP: '1' }
  for (const k of ['SQUADRA_HOST_DIR', 'SQUADRA_TMUX_SOCKET', 'CLAUDE_CONFIG_DIR', 'SQUADRA_COMPANY']) delete env[k]
  const hosts = []
  const host = (co, args) => execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), `--company=${co.id}`, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const settingsOf = co => join(xdg, 'squadra-host', 'companies', co.id, 'settings.json')
  try {
    // A code, its command, and a copy of squadra-host for the right company only.
    const en = (await inDash(a, 'hosts/enroll', { name: 'box' })).result
    for (const c of [en.command, en.install.linux, en.install.macos]) assert.match(c, new RegExp(`--company=${a.id}`))
    assert.match(en.install.windows, new RegExp(`--company ${a.id}`))
    const refused = spawnSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), `--company=${b.id}`, 'enroll', URL_, en.code, '--no-service', '--no-plugin'], { env, encoding: 'utf8', timeout: 20_000 })
    assert.match(refused.stderr, /for another company/)

    const start = async (co, code) => {
      mkdirSync(dirname(settingsOf(co)), { recursive: true })
      writeFileSync(settingsOf(co), JSON.stringify({ folders: [], max_sessions: 2, allow_input: true, claude_command: fakeClaude }))
      const p = spawn(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), `--company=${co.id}`, 'enroll', URL_, code, '--no-service', '--no-plugin'], { env, stdio: 'ignore' })
      hosts.push(p)
      return waitFor(async () => (await inDash(co, 'hosts')).result[0]?.online && (await inDash(co, 'hosts')).result[0], { what: `the machine of ${co.name}` })
    }
    const hostA = await start(a, en.code)
    const hostB = await start(b, (await inDash(b, 'hosts/enroll', { name: 'box' })).result.code)

    // Each has its own folder, Claude Code folder and credential.
    const creds = co => JSON.parse(readFileSync(join(xdg, 'squadra-host', 'companies', co.id, 'credentials.json'), 'utf8'))
    assert.match(creds(a).secret, new RegExp(`^sh_${a.id}_`))
    assert.match(creds(b).secret, new RegExp(`^sh_${b.id}_`))
    assert.ok(existsSync(join(xdg, 'squadra-host', 'companies', a.id, 'claude')))

    // They say they share a user; and the matrix shows them on one machine.
    await waitFor(async () => (await inDash(a, 'hosts')).result[0].info.shares_user, { what: 'the warning', timeout: 40_000 })
    const matrix = (await (await fetch(`${URL_}/api/machines`, { headers: { Authorization: `Bearer ${SERVER_TOKEN}` } })).json()).result
    const here = matrix.find(m => m.instances.some(i => i.host === hostA.id))
    assert.ok([a.id, b.id].every(id => here.instances.some(i => i.company === id && i.os_user === userInfo().username)))
    assert.equal(here.isolation, 'same-user')

    // A folder belongs to one company.
    const shared = project('shared-a')
    assert.deepEqual((await inDash(a, 'hosts/folders', { host: hostA.id, action: 'add', path: shared })).result.folders, [shared])
    const clash = await inDash(b, 'hosts/folders', { host: hostB.id, action: 'add', path: shared })
    assert.equal(clash.ok, false)
    const inside = project('shared-a/sub')
    assert.equal((await inDash(b, 'hosts/folders', { host: hostB.id, action: 'add', path: inside })).ok, false)
    assert.throws(() => host(b, ['folders', 'add', shared]), /belongs to another company/)
    // Written by hand in its settings too: it isn't opened there.
    const written = JSON.parse(readFileSync(settingsOf(b), 'utf8'))
    writeFileSync(settingsOf(b), JSON.stringify({ ...written, folders: [...written.folders, shared] }))
    const handAdded = await inDash(b, 'terminals/open', { host: hostB.id, spec: { name: 'sneaky', role: 'solo', folder: shared } })
    assert.equal(handAdded.ok, false)
    writeFileSync(settingsOf(b), JSON.stringify(written))
    // Settings of the other that can't be read don't open the way.
    const elsewhere = project('shared-c')
    const good = readFileSync(settingsOf(a), 'utf8')
    writeFileSync(settingsOf(a), '{ broken')
    assert.throws(() => host(b, ['folders', 'add', elsewhere]), /belongs to another company/)
    writeFileSync(settingsOf(a), good)
    // Nor can its home be allowed, with the other's folders in it.
    if (!shared.startsWith(realpathSync(homedir()))) writeFileSync(settingsOf(a), JSON.stringify({ ...JSON.parse(good), folders: [join(homedir(), 'a-project-of-a')] }))
    assert.throws(() => host(b, ['--allow-home', 'folders']), /holds a folder of another company/)
    writeFileSync(settingsOf(a), good)
    const own = project('shared-b')
    assert.ok((await inDash(b, 'hosts/folders', { host: hostB.id, action: 'add', path: own })).ok)

    // The same session name in both: two sessions, each in its own tmux.
    for (const [co, h, folder] of [[a, hostA, shared], [b, hostB, own]]) {
      const r = await inDash(co, 'terminals/open', { host: h.id, spec: { name: 'same', role: 'solo', folder } })
      assert.ok(r.ok, r.description)
    }
    const panes = co => execFileSync('tmux', ['-L', `squadra-${co.id}`, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).trim()
    assert.equal(panes(a), 'sq-same')
    assert.equal(panes(b), 'sq-same')
    const opened = async co => (await inDash(co, 'hosts')).result[0].info.terminals.find(t => t.id === 'same')
    await waitFor(async () => (await opened(a)) && (await opened(b)), { what: 'their terminals' })
    assert.equal((await opened(a)).folder, realpathSync(shared))
    assert.equal((await opened(b)).folder, realpathSync(own))
    // Closing one leaves the other.
    assert.ok((await inDash(a, 'terminals/kill', { host: hostA.id, term: 'same' })).ok)
    assert.equal(panes(b), 'sq-same')

    // A machine of another server is not taken over by accident.
    const moved = spawnSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), `--company=${a.id}`, 'enroll', 'http://127.0.0.1:9', 'ABCD-EFGH', '--no-service', '--no-plugin', '--insecure'], { env, encoding: 'utf8', timeout: 20_000 })
    assert.match(moved.stderr, /already belongs to/)

    // A copy without a company holding a company's secret (an older version's
    // doing) takes no other company: the sessions it lists would cross.
    const plainDir = join(xdg, 'squadra-host')
    writeFileSync(join(plainDir, 'credentials.json'), JSON.stringify({ server: URL_, id: 'h_00000000', secret: `sh_${b.id}_nothingofthekind000000000000` }))
    const crossed = spawnSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'enroll', URL_, 'ABCD-EFGH', '--no-service', '--no-plugin'], { env, encoding: 'utf8', timeout: 20_000 })
    assert.match(crossed.stderr, /belongs to another company/)
    rmSync(join(plainDir, 'credentials.json'))
    // Nor does a host that says nothing get a company's code: an older program,
    // with no copy of its own for it.
    const code = (await inDash(b, 'hosts/enroll', { name: 'old' })).result.code
    const old = await (await fetch(`${URL_}/host/enroll`, { method: 'POST', body: JSON.stringify({ code, info: {} }) })).json()
    assert.equal(old.error_code, 403)

    // Run from inside another company's session, or with another's setting
    // around, each copy still uses its own.
    const leaked = { ...env, CLAUDE_CONFIG_DIR: join(xdg, 'squadra-host', 'companies', a.id, 'claude'), SQUADRA_COMPANY: a.id, TMUX: 'a-session' }
    const ownUnit = execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), `--company=${b.id}`, 'service', 'print'], { env: leaked, encoding: 'utf8' })
    assert.ok(ownUnit.includes(`${xdg}/squadra-host/companies/${b.id}/claude`), ownUnit)
    assert.ok(!ownUnit.includes(`companies/${a.id}/`), ownUnit)
    const plainUnit = execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'service', 'print'], { env: leaked, encoding: 'utf8' })
    assert.doesNotMatch(plainUnit, /companies/)

    // What the launcher runs: --company in front of anything.
    assert.match(host(a, ['help']), /Usage: squadra-host/)
    assert.match(host(a, ['--version']), /squadra-host \d/)
    // Tests leave nothing in the real home.
    assert.ok(!existsSync(join(homedir(), '.local', 'bin', `squadra-host-${a.id}`)))

    // And the service of each is its own.
    // (A systemd unit on Linux, a launchd agent on macOS: the same things in it.)
    const unit = host(a, ['service', 'print'])
    assert.ok(unit.includes('SQUADRA_COMPANY'), unit)
    assert.match(unit, new RegExp(`companies/${a.id}/squadra-host\\.mjs`))
  } finally {
    for (const p of hosts) p.kill('SIGTERM')
    for (const co of [a, b]) { try { execFileSync('tmux', ['-L', `squadra-${co.id}`, 'kill-server'], { stdio: 'ignore' }) } catch {} }
    rmSync(xdg, { recursive: true, force: true })
  }
})
