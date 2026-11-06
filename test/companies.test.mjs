// Two companies on one server, both using the same names: nothing crosses from
// one to the other, whichever way it is asked for.
//
// Every test here starts by creating the companies, so what is under test is
// the isolation itself. Run: node --test test/companies.test.mjs

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { serverNoticeIsGood } from '../plugins/squadra/signing.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ADMIN = 'companies-admin-token-0123456789'
const PORT = 24000 + Math.floor(Math.random() * 2000)
const URL_ = `http://127.0.0.1:${PORT}`
const dataDir = mkdtempSync(join(tmpdir(), 'squadra-companies-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let server

async function waitFor(fn, { timeout = 8000, what = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`)
    await sleep(50)
  }
}

async function call(path, body, auth, instance) {
  if (path === 'claimSession' && instance === undefined && body && typeof body === 'object') instance = body.instance
  const r = await fetch(`${URL_}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(instance ? { 'X-Squadra-Instance': instance } : {}) },
    body: JSON.stringify(body ?? {}),
  })
  return r.json()
}
const get = (path, auth) => fetch(`${URL_}/${path}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} }).then(r => r.json())
const ok = r => { assert.ok(r.ok, r.description); return r.result }

const newCompany = async name => ok(await call('admin/createCompany', { name }, ADMIN))
// (With the server token: the join token is 10 names a minute per address.)
const register = async (company, name) => ok(await call('register', { name, company: company.id }, ADMIN)).secret
const api = (company, what) => `api/c/${company.id}/${what}`
const read = async (company, what) => ok(await get(api(company, what), ADMIN))
const act = (company, what, body) => call(api(company, what), body, ADMIN)

// A session that reads what reaches it.
const inbox = async secret => ok(await get('getUpdates?timeout=0', secret))

before(async () => {
  server = spawn(process.execPath, [join(ROOT, 'server/server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, SQUADRA_SERVER_TOKEN: ADMIN },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  server.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(d) })
  await waitFor(async () => { try { return (await fetch(`${URL_}/health`)).ok } catch { return false } }, { what: 'server' })
})
after(() => server?.kill('SIGTERM'))

test('a company has its own folder, and its credentials say whose they are', async () => {
  const a = await newCompany('Acme')
  assert.match(a.id, /^[a-z0-9]{8}$/)
  assert.match(a.join_token, new RegExp(`^sj_${a.id}_`))
  assert.ok(existsSync(join(dataDir, 'companies', a.id, 'squadra.db')))
  assert.match(await register(a, 'prefixed'), new RegExp(`^sq_${a.id}_`))
  const en = ok(await act(a, 'hosts/enroll', { name: 'm1' }))
  const host = ok(await call('host/enroll', { code: en.code, info: { hostname: 'm1' } }))
  assert.match(host.secret, new RegExp(`^sh_${a.id}_`))
  // What the machine and its plugin check, as they do today.
  assert.match(host.secret, /^sh_[A-Za-z0-9_-]{20,200}$/)
  assert.match(await register(a, 'prefixed2'), /^sq_[A-Za-z0-9_-]{20,64}$/)
})

test('the same name in two companies is two sessions', async () => {
  const [a, b] = [await newCompany('Same A'), await newCompany('Same B')]
  const [coordA, coordB] = [await register(a, 'coord'), await register(b, 'coord')]
  const [anaA, anaB] = [await register(a, 'ana'), await register(b, 'ana')]
  assert.notEqual(coordA, coordB)

  ok(await call('sendMessage', { chat_id: 'ana', text: 'for acme only' }, coordA))
  assert.equal((await inbox(anaA)).length, 1)
  assert.deepEqual(await inbox(anaB), [])
  // Each one sees itself, not the other.
  assert.deepEqual((await read(a, 'state')).sessions.map(s => s.name).sort(), ['ana', 'coord'])
  ok(await call('sendMessage', { chat_id: 'ana', text: 'for b only' }, coordB))
  const onlyB = await read(b, 'messages')
  assert.deepEqual(onlyB.map(m => m.text), ['for b only'])
})

test('a session cannot reach or discover a name of another company', async () => {
  const [a, b] = [await newCompany('Reach A'), await newCompany('Reach B')]
  const alone = await register(a, 'alone')
  await register(b, 'only-in-b')
  const sent = await call('sendMessage', { chat_id: 'only-in-b', text: 'hello?' }, alone)
  assert.equal(sent.ok, false)
  const chat = await call('getChat', { chat_id: 'only-in-b' }, alone)
  assert.equal(chat.ok, false)
  // And the answer is the one for a name that doesn't exist anywhere.
  const nowhere = await call('getChat', { chat_id: 'no-such-name' }, alone)
  assert.equal(chat.description, nowhere.description.replaceAll('no-such-name', 'only-in-b'))
})

test('a join token only opens its own company', async () => {
  const [a, b] = [await newCompany('Join A'), await newCompany('Join B')]
  const secret = await register(a, 'joined')
  assert.ok((await read(a, 'state')).sessions.some(s => s.name === 'joined'))
  assert.ok(!(await read(b, 'state')).sessions.some(s => s.name === 'joined'))
  // Rotating one leaves the other, and the sessions, as they were.
  const rotated = ok(await call('admin/rotateJoinToken', { company: a.id }, ADMIN))
  assert.notEqual(rotated.join_token, a.join_token)
  assert.equal((await call('register', { name: 'late' }, a.join_token)).error_code, 401)
  ok(await call('register', { name: 'late' }, rotated.join_token))
  ok(await call('register', { name: 'late' }, b.join_token))
  ok(await get('getMe', secret))
})

test('a secret of one company does nothing with the id of another', async () => {
  const [a, b] = [await newCompany('Secret A'), await newCompany('Secret B')]
  const secret = await register(a, 'mine')
  // The same random part, under the other company's prefix.
  const forged = secret.replace(a.id, b.id)
  assert.equal((await get('getMe', forged)).error_code, 401)
  assert.equal((await call('register', { name: 'x' }, a.join_token.replace(a.id, b.id))).error_code, 401)
})

test('credentials without a company, or of one that does not exist, are the first company\'s', async () => {
  const JOIN = readFileSync(join(dataDir, 'join-token'), 'utf8').trim()
  assert.match(JOIN, /^sj_[0-9a-f]+$/)
  const plain = ok(await call('register', { name: 'old-style' }, JOIN)).secret
  assert.match(plain, /^sq_[A-Za-z0-9_-]+$/)
  assert.doesNotMatch(plain, /^sq_[a-z0-9]{8}_/)
  ok(await get('getMe', plain))
  ok(await get('api/state', ADMIN))
  assert.ok((await get('api/state', ADMIN)).result.sessions.some(s => s.name === 'old-style'))
  // An old secret is random, and may look like it has a prefix by chance.
  assert.equal((await get('getMe', 'sq_abcdefgh_nothingofthekind000000000')).error_code, 401)
})

test('reads of a company show only that company', async () => {
  const [a, b] = [await newCompany('Reads A'), await newCompany('Reads B')]
  const [x, y] = [await register(a, 'x'), await register(a, 'y')]
  const instance = 'instance-reads-1'
  ok(await call('claimSession', { instance }, x))
  ok(await call('sendMessage', { chat_id: 'y', text: 'private to a' }, x, instance))
  ok(await call('observe', { events: [{ kind: 'prompt', ts: Date.now(), text: 'event of a' }] }, x, instance))
  await inbox(y)
  for (const what of ['timeline?session=x', 'events', 'messages', 'hosts', 'state']) {
    const here = JSON.stringify(await read(a, what)), there = JSON.stringify(await read(b, what))
    assert.doesNotMatch(there, /private to a|event of a/, what)
    if (what === 'messages') assert.match(here, /private to a/)
    if (what === 'events') assert.match(here, /event of a/)
  }
  assert.deepEqual((await read(b, 'state')).sessions, [])
})

test('actions of a company change only that company', async () => {
  const [a, b] = [await newCompany('Acts A'), await newCompany('Acts B')]
  await register(a, 'lead')
  await register(b, 'lead')
  ok(await call('claimSession', { instance: 'instance-boss-1', role: 'coordinator' }, await register(a, 'boss')))
  ok(await act(a, 'org/squad', { coordinator: 'boss', title: 'Acme squad' }))
  assert.equal((await read(a, 'state')).squads.length, 1)
  assert.deepEqual((await read(b, 'state')).squads, [])
  ok(await act(a, 'templates/save', { name: 'tpl', coordinator: { name: 'c1', folder: '/tmp/c1' }, workers: [{ name: 'w1', folder: '/tmp/w1' }] }))
  assert.equal((await read(a, 'state')).templates.length, 1)
  assert.deepEqual((await read(b, 'state')).templates, [])
  ok(await act(a, 'delete', { session: 'lead' }))
  assert.ok(!(await read(a, 'state')).sessions.some(s => s.name === 'lead'))
  assert.ok((await read(b, 'state')).sessions.some(s => s.name === 'lead'))
  // A session of another company is not found, whatever is asked of it.
  await register(b, 'b-only')
  for (const action of ['kick', 'approve', 'clear', 'delete', 'archive', 'unarchive']) {
    assert.equal((await act(a, action, { session: 'b-only' })).ok, false, action)
  }
  assert.ok((await read(b, 'state')).sessions.some(s => s.name === 'b-only'))
})

test('the stream of a company carries only that company', async () => {
  const [a, b] = [await newCompany('Stream A'), await newCompany('Stream B')]
  const [x, y] = [await register(a, 'x'), await register(a, 'y')]
  await register(b, 'watcher')
  const abort = new AbortController()
  const res = await fetch(`${URL_}/${api(b, 'stream')}`, { headers: { Authorization: `Bearer ${ADMIN}` }, signal: abort.signal })
  assert.equal(res.status, 200)
  let got = ''
  const reading = (async () => { try { for await (const c of res.body) got += Buffer.from(c).toString() } catch {} })()
  await waitFor(() => got.includes('event: hello'), { what: 'the first state' })
  ok(await call('sendMessage', { chat_id: 'y', text: 'secret of a' }, x))
  await inbox(y)
  await sleep(2500) // (presence is watched every 2 s)
  abort.abort()
  await reading
  assert.doesNotMatch(got, /secret of a/)
  assert.doesNotMatch(got, /"name":"x"|"name":"y"/)
  assert.match(got, /"name":"watcher"/)
})

test('an attachment is in its company\'s folder and only opens there', async () => {
  const [a, b] = [await newCompany('Files A'), await newCompany('Files B')]
  const [x, y] = [await register(a, 'x'), await register(a, 'y')]
  const other = await register(b, 'y')
  const up = await fetch(`${URL_}/sendDocument?chat_id=y&filename=note.txt`, { method: 'POST', headers: { Authorization: `Bearer ${x}`, 'Content-Type': 'text/plain' }, body: 'in acme' })
  const sent = ok(await up.json())
  const fileId = sent.document.file_id
  assert.equal(readdirSync(join(dataDir, 'companies', a.id, 'files')).length, 1)
  assert.equal(readdirSync(join(dataDir, 'companies', b.id, 'files')).length, 0)
  const path = ok(await call('getFile', { file_id: fileId }, y)).file_path
  assert.equal(await (await fetch(`${URL_}/file/${path}`, { headers: { Authorization: `Bearer ${y}` } })).text(), 'in acme')
  // The same name, in the other company: neither the id nor the path.
  assert.equal((await call('getFile', { file_id: fileId }, other)).ok, false)
  assert.equal((await fetch(`${URL_}/file/${path}`, { headers: { Authorization: `Bearer ${other}` } })).status, 404)
})

test('budgets are per company: one using up its own leaves the same name elsewhere alone', async () => {
  const [a, b] = [await newCompany('Budget A'), await newCompany('Budget B')]
  const [x, y] = [await register(a, 'x'), await register(a, 'y')]
  const [bx, by] = [await register(b, 'x'), await register(b, 'y')]
  void y
  let limited = false
  for (let i = 0; i < 200 && !limited; i++) limited = (await call('sendMessage', { chat_id: 'y', text: 'n' }, x)).error_code === 429
  assert.ok(limited, 'the budget ran out')
  ok(await call('sendMessage', { chat_id: 'y', text: 'still mine' }, bx))
  void by
})

// A machine's end of the terminal link, and a dashboard's.
function socket(path, cred) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, ['squadra', `auth.${cred}`])
    const inbox = []
    ws.onmessage = e => inbox.push(JSON.parse(e.data))
    ws.onopen = () => resolve({ ws, inbox })
    ws.onerror = () => reject(new Error(`could not open ${path}`))
  })
}

test('a machine belongs to its company, and a terminal ticket only reaches that company\'s machines', async () => {
  const [a, b] = [await newCompany('Term A'), await newCompany('Term B')]
  const en = ok(await act(a, 'hosts/enroll', { name: 'shared-name' }))
  const host = ok(await call('host/enroll', { code: en.code, info: { hostname: 'shared-name' } }))
  // A code only in its company, and only once.
  assert.deepEqual((await read(b, 'hosts')), [])
  assert.equal((await read(a, 'hosts')).length, 1)
  assert.equal((await call('host/enroll', { code: en.code, info: {} })).ok, false)

  const ticket = ok(await call('host/ticket', {}, host.secret)).ticket
  const machine = await socket('/host/connect', ticket)
  machine.ws.send(JSON.stringify({ t: 'hello', info: { hostname: 'shared-name', terminals: [] } }))
  await waitFor(() => machine.inbox.some(m => m.t === 'welcome'), { what: 'the welcome' })
  assert.equal((await read(a, 'hosts'))[0].online, true)

  const theirs = ok(await act(b, 'terminal/ticket', {})).ticket
  const viewer = await socket('/api/terminal', theirs)
  viewer.ws.send(JSON.stringify({ t: 'attach', host: host.id, term: 'anything', cols: 80, rows: 24 }))
  await waitFor(() => viewer.inbox.some(m => m.t === 'host_down'), { what: 'the refusal' })
  await sleep(200)
  assert.ok(!machine.inbox.some(m => m.t === 'attach'), 'the machine was asked to attach')
  // Nor can the other company open, close or ask anything of it.
  for (const [action, body] of [['terminals/open', { host: host.id, spec: { name: 'w' } }], ['terminals/kill', { host: host.id, term: 'w' }], ['hosts/remove', { host: host.id }], ['hosts/rename', { host: host.id, name: 'n' }]]) {
    assert.equal((await act(b, action, body)).ok, false, action)
  }
  assert.equal((await read(a, 'hosts')).length, 1)

  // Its own ticket does reach it.
  const own = await socket('/api/terminal', ok(await act(a, 'terminal/ticket', {})).ticket)
  own.ws.send(JSON.stringify({ t: 'attach', host: host.id, term: 'anything', cols: 80, rows: 24 }))
  await waitFor(() => machine.inbox.some(m => m.t === 'attach'), { what: 'the attach' })
  for (const s of [machine, viewer, own]) s.ws.close()
})

test('a company that does not exist is not found, and an id cannot leave the companies folder', async () => {
  for (const id of ['nosuch00', 'ABCDEFGH', 'a', '__proto__', 'constructor', '.hidden']) {
    const r = await get(`api/c/${id}/state`, ADMIN)
    assert.equal(r.error_code, 404, id)
  }
})

test('the server token is what opens a company, for now; a join token or a session never does', async () => {
  const a = await newCompany('Auth A')
  const secret = await register(a, 'x')
  for (const cred of [undefined, 'wrong', a.join_token, secret]) {
    assert.equal((await get(api(a, 'state'), cred)).error_code, 401)
    assert.equal((await call(api(a, 'delete'), { session: 'x' }, cred)).error_code, 401)
    assert.equal((await call('admin/createCompany', { name: 'nope' }, cred)).error_code, 401)
  }
})

test('the first company is the data of a server upgraded, untouched', async () => {
  assert.ok(existsSync(join(dataDir, 'squadra.db')))
  const list = ok(await get('api/companies', ADMIN))
  const first = list.find(c => c.id === 'default')
  assert.ok(first, 'the first company is listed')
  assert.ok(existsSync(join(dataDir, 'control.db')))
  // /api/<what> keeps acting on it.
  assert.deepEqual(ok(await get('api/state', ADMIN)).sessions, ok(await get('api/c/default/state', ADMIN)).sessions)
})

test('a server notice names its company: it can\'t be replayed in another', async () => {
  const a = await newCompany('Notice A')
  const coord = await register(a, 'coord')
  const worker = await register(a, 'worker')
  ok(await call('claimSession', { instance: 'instance-coord-1', role: 'coordinator' }, coord))
  ok(await call('claimSession', { instance: 'instance-worker-1', role: 'worker', coordinator: 'coord' }, worker))
  // (Notices only reach a coordinator that has written to that worker.)
  ok(await call('sendMessage', { chat_id: 'worker', text: 'a task' }, coord, 'instance-coord-1'))
  ok(await call('releaseSession', { instance: 'instance-worker-1', reason: 'logout' }, worker, 'instance-worker-1'))
  const res = await fetch(`${URL_}/getUpdates?timeout=0&instance=instance-coord-1`, { headers: { Authorization: `Bearer ${coord}`, 'X-Squadra-Instance': 'instance-coord-1' } })
  const notice = ok(await res.json()).find(u => u.message?.squadra_notice)?.message
  assert.ok(notice, 'the notice arrived')
  assert.equal(notice.squadra_company, a.id)
  const { key } = ok(await get('server-identity?nonce=0123456789abcdef'))
  const fields = { from: 'worker', to: 'coord', id: notice.message_id, date: notice.date, text: notice.text }
  assert.ok(serverNoticeIsGood(key, notice.squadra_server_sig, { ...fields, company: a.id }))
  // A session of another company, or of a server without them, doesn't take it.
  assert.ok(!serverNoticeIsGood(key, notice.squadra_server_sig, { ...fields, company: 'otherco0' }))
  assert.ok(!serverNoticeIsGood(key, notice.squadra_server_sig, fields))
})

test('a server with data keeps it as the first company, with its machines and sessions, and a copy from before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'squadra-companies-up-'))
  const port = PORT + 3000
  const start = async () => {
    const proc = spawn(process.execPath, [join(ROOT, 'server/server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, SQUADRA_SERVER_TOKEN: ADMIN }, stdio: 'ignore' })
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch { return false } }, { what: 'server' })
    return proc
  }
  const stop = proc => new Promise(r => { proc.on('exit', r); proc.kill('SIGTERM') })
  const on = (path, init) => fetch(`http://127.0.0.1:${port}/${path}`, init).then(r => r.json())
  const admin = body => ({ method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })

  // What a server looks like before companies: its data, and no control.db.
  let proc = await start()
  const secret = ok(await on('register', admin({ name: 'veteran' }))).secret
  const en = ok(await on('api/hosts/enroll', admin({ name: 'old-machine' })))
  const host = ok(await on('host/enroll', { method: 'POST', body: JSON.stringify({ code: en.code, info: { hostname: 'old-machine' } }) }))
  const join_ = readFileSync(join(dir, 'join-token'), 'utf8')
  await stop(proc)
  for (const f of ['control.db', 'control.db-wal', 'control.db-shm']) rmSync(join(dir, f), { force: true })

  proc = await start()
  try {
    assert.equal(readFileSync(join(dir, 'join-token'), 'utf8'), join_)
    const me = ok(await on('getMe', { headers: { Authorization: `Bearer ${secret}` } }))
    assert.equal(me.id, 'veteran')
    assert.ok(ok(await on('host/ticket', { method: 'POST', headers: { Authorization: `Bearer ${host.secret}` }, body: '{}' })).ticket)
    const copy = new DatabaseSync(join(dir, 'squadra-before-companies.db'), { readOnly: true })
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM identities WHERE name = 'veteran'").get().n, 1)
    copy.close()
    assert.equal(statSync(join(dir, 'squadra-before-companies.db')).mode & 0o077, 0)
  } finally { await stop(proc) }
})

test('limits are per company, can be changed, and bad ones are refused', async () => {
  const a = ok(await call('admin/createCompany', { name: 'Quota A', limits: { max_sessions: 1 } }, ADMIN))
  const b = await newCompany('Quota B')
  ok(await call('register', { name: 'one' }, a.join_token))
  assert.equal((await call('register', { name: 'two' }, a.join_token)).error_code, 403)
  ok(await call('register', { name: 'two' }, b.join_token))
  ok(await call('admin/setCompanyLimits', { company: a.id, limits: { max_sessions: 2 } }, ADMIN))
  ok(await call('register', { name: 'two' }, a.join_token))
  for (const limits of [{ max_sessions: 0 }, { max_sessions: 'x' }, { other: 1 }]) {
    assert.equal((await call('admin/setCompanyLimits', { company: a.id, limits }, ADMIN)).error_code, 400)
  }
  assert.equal((await call('admin/createCompany', { name: 'Quota A' }, ADMIN)).error_code, 409)
  assert.equal((await call('admin/createCompany', { name: '<b>' }, ADMIN)).error_code, 400)
})
