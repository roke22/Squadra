// End-to-end tests for squadra-host: a real server, a real host process and a
// real tmux, with a fake "claude" that prints what it was started with and
// echoes what it reads. Needs tmux >= 3.0 on the PATH (skipped otherwise).
//
// Run: node --test test/host.test.mjs

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_TOKEN = 'test-server-token-host-0123456789'
const PORT = 19000 + Math.floor(Math.random() * 2000)
const URL_ = `http://127.0.0.1:${PORT}`
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
const claudeDir = join(work, 'claude')
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
    list) if [ -f "${pluginState}" ]; then echo '[{"id":"squadra@squadra","version":"0.0.1","enabled":true}]'; else echo '[]'; fi ;;
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
echo "PWD: $(pwd)"
echo "TMUX=\${TMUX:-none}"
while IFS= read -r line; do echo "GOT:$line"; done
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
})

// A dashboard tab's terminal connection.
function viewer() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/terminal`)
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

  const en = await dash('hosts/enroll', { name: 'test box' })
  assert.ok(en.ok, en.description)
  assert.match(en.result.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  assert.ok(en.result.command.includes(`'${URL_}/host/squadra-host.mjs'`))
  assert.ok(en.result.command.includes(`enroll '${URL_}' ${en.result.code}`))

  // The program is served by the server, as the command expects, and the
  // command checks its sha256 before running it (a tampered copy fails).
  const js = await fetch(`${URL_}/host/squadra-host.mjs`)
  assert.equal(js.status, 200)
  const jsText = await js.text()
  assert.match(jsText, /squadra-host/)
  const verify = en.result.command.match(/ && (echo .*?\)) && node /)[1]
  const dl = mkdtempSync(join(tmpdir(), 'squadra-dl-'))
  writeFileSync(join(dl, 'squadra-host.mjs'), jsText)
  execFileSync('sh', ['-c', verify], { cwd: dl, stdio: 'ignore' })
  writeFileSync(join(dl, 'squadra-host.mjs'), jsText + '\n// tampered')
  assert.throws(() => execFileSync('sh', ['-c', verify], { cwd: dl, stdio: 'ignore' }))

  hostProc = spawn(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'enroll', URL_, en.result.code.toLowerCase()], {
    env: { ...process.env, SQUADRA_HOST_DIR: hostDir, SQUADRA_TMUX_SOCKET: SOCKET, CLAUDE_CONFIG_DIR: claudeDir },
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd: work,
  })
  hostProc.stderr.on('data', d => { hostStderr += d; if (process.env.DEBUG) process.stderr.write(`[host] ${d}`) })
  hostProc.on('exit', code => { hostExit = code })

  const h = await waitFor(async () => (await dash('hosts')).result.find(x => x.online), { what: 'host online' })
  hostId = h.id
  assert.equal(h.name, 'test box')
  assert.equal(h.info.claude, '9.9.9 (Claude Code)')
  assert.deepEqual(h.info.folders, [allowed])
  assert.equal(h.info.max_sessions, 2)

  // The Squadra plugin was installed in Claude Code, from its fixed marketplace.
  const calls = readFileSync(pluginCalls, 'utf8')
  assert.match(calls, /plugin marketplace add roke22\/Squadra/)
  assert.match(calls, /plugin install squadra@squadra/)
  assert.deepEqual(h.info.plugin, { installed: true, enabled: true, version: '0.0.1' })
  // Pinned to this program's release tag.
  assert.equal(readFileSync(marketplaceFile, 'utf8').trim(), 'roke22/Squadra#v0.0.1')

  // Credential saved with private permissions; the plugin configured.
  const creds = JSON.parse(readFileSync(join(hostDir, 'credentials.json'), 'utf8'))
  assert.equal(creds.server, URL_)
  assert.match(creds.secret, /^sh_/)
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
    [{ name: 'w1', role: 'worker', folder: join(allowed, 'missing') }, /does not exist/],
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

  // Without the token, the terminal socket closes.
  const bad = viewer()
  await bad.open()
  bad.send({ t: 'auth', token: 'nope' })
  await waitFor(() => bad.closed, { what: 'unauthorized close' })
  assert.equal(bad.closed, 4001)

  const v = viewer()
  await v.open()
  v.send({ t: 'auth', token: SERVER_TOKEN })
  await waitFor(() => v.msgs.some(m => m.t === 'ready'), { what: 'ready' })
  v.send({ t: 'attach', host: hostId, term: 'w1', cols: 100, rows: 30 })
  await waitFor(() => v.msgs.some(m => m.t === 'screen'), { what: 'screen' })
  await waitFor(() => v.text.includes('ARGS: --dangerously-load-development-channels plugin:squadra@squadra'), { what: 'fixed command in the screen' })
  assert.ok(v.text.includes('ENV: w1/worker/boss/600000'), v.text)
  assert.ok(v.text.includes(`PWD: ${realpathSync(join(allowed, 'api'))}`), v.text)
  // The session doesn't see the tmux server it runs in (no "tmux send-keys" into others).
  assert.ok(v.text.includes('TMUX=none'), v.text)

  v.send({ t: 'in', host: hostId, term: 'w1', data: 'hello squadra\r' })
  await waitFor(() => v.text.includes('GOT:hello squadra'), { what: 'typed text echoed' })

  // A second viewer gets the current screen too.
  const v2 = viewer()
  await v2.open()
  v2.send({ t: 'auth', token: SERVER_TOKEN })
  await waitFor(() => v2.msgs.some(m => m.t === 'ready'), { what: 'ready 2' })
  v2.send({ t: 'attach', host: hostId, term: 'w1', cols: 100, rows: 30 })
  await waitFor(() => v2.text.includes('GOT:hello squadra'), { what: 'second viewer screen' })
  v2.ws.close()

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
  const v = viewer()
  await v.open()
  v.send({ t: 'auth', token: SERVER_TOKEN })
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
    env: { ...process.env, SQUADRA_HOST_DIR: hostDir, SQUADRA_TMUX_SOCKET: SOCKET, CLAUDE_CONFIG_DIR: claudeDir },
    stdio: 'ignore',
  })
  const calls = readFileSync(pluginCalls, 'utf8')
  assert.match(calls, /plugin marketplace remove squadra/)
  assert.match(calls, /plugin marketplace add roke22\/Squadra#v0\.0\.1/)
  assert.match(calls, /plugin install squadra@squadra/)
  assert.equal(readFileSync(marketplaceFile, 'utf8').trim(), 'roke22/Squadra#v0.0.1')
  assert.ok(existsSync(pluginState), 'plugin installed again')
  // Already pinned: nothing is removed the next time.
  writeFileSync(pluginCalls, '')
  execFileSync(process.execPath, [join(ROOT, 'host/squadra-host.mjs'), 'plugin'], {
    env: { ...process.env, SQUADRA_HOST_DIR: hostDir, SQUADRA_TMUX_SOCKET: SOCKET, CLAUDE_CONFIG_DIR: claudeDir },
    stdio: 'ignore',
  })
  assert.doesNotMatch(readFileSync(pluginCalls, 'utf8'), /marketplace remove/)
})

test('disconnecting a machine revokes it and stops squadra-host there', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const r = await dash('hosts/remove', { host: hostId })
  assert.ok(r.ok, r.description)
  await waitFor(() => hostExit !== null, { what: 'host exit' })
  assert.equal(hostExit, 1)
  assert.match(hostStderr, /no longer accepts this machine/)
  assert.equal((await dash('hosts')).result.length, 0)
  const open = await dash('terminals/open', { host: hostId, spec: { name: 'x', role: 'worker', folder: allowed } })
  assert.equal(open.ok, false)
  assert.ok(existsSync(join(hostDir, 'credentials.json')))
})
