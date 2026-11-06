// Two companies on one server, both using the same names: nothing crosses from
// one to the other, whichever way it is asked for.
//
// Every test here starts by creating the companies, so what is under test is
// the isolation itself. Run: node --test test/companies.test.mjs

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { serverNoticeIsGood } from '../plugins/squadra/signing.js'
import { execFileSync } from 'node:child_process'

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
  const host = ok(await call('host/enroll', { code: en.code, company: a.id, info: { hostname: 'm1' } }))
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

test('text is charged as it lands on disk: bytes, and once per recipient', async () => {
  const a = ok(await call('admin/createCompany', { name: 'Bytes', limits: { stored_text_mb_hour: 1 } }, ADMIN))
  const [x, y, z] = [await register(a, 'x'), await register(a, 'y'), await register(a, 'z')]
  // Three bytes a character: 96 KB each, and 288 KB with the copies of the other two.
  const text = '語'.repeat(32_000)
  ok(await call('joinGroup', { chat_id: '#all' }, x))
  for (const [name, s] of [['y', y], ['z', z]]) {
    ok(await call('inviteToGroup', { chat_id: '#all', name }, x))
    ok(await call('joinGroup', { chat_id: '#all' }, s))
  }
  for (let i = 0; i < 3; i++) ok(await call('sendMessage', { chat_id: '#all', text }, x))
  const fourth = await call('sendMessage', { chat_id: '#all', text }, x)
  assert.equal(fourth.error_code, 429)
  assert.match(fourth.description, /stored-text/)
  // Someone else's budget is another.
  ok(await call('sendMessage', { chat_id: '#all', text: 'short' }, y))
  // The same text in ASCII costs a third.
  const b = ok(await call('admin/createCompany', { name: 'Ascii', limits: { stored_text_mb_hour: 1 } }, ADMIN))
  const [bx, by] = [await register(b, 'x'), await register(b, 'y')]
  void by
  for (let i = 0; i < 5; i++) ok(await call('sendMessage', { chat_id: 'y', text: 'n'.repeat(32_000) }, bx))
})

test('a company at its database limit takes nothing more from its sessions, and can still free room', async () => {
  const a = await newCompany('Full')
  const [x, y] = [await register(a, 'x'), await register(a, 'y')]
  ok(await call('sendMessage', { chat_id: 'y', text: 'before' }, x))
  const file = join(dataDir, 'companies', a.id, 'squadra.db')
  const direct = new DatabaseSync(file)
  direct.prepare('INSERT INTO events (session, ts, kind, data) VALUES (?, ?, ?, ?)').run('filler', Date.now(), 'status', 'x'.repeat(3 * 1024 * 1024))
  direct.close()
  ok(await call('admin/setCompanyLimits', { company: a.id, limits: { max_db_mb: 1 } }, ADMIN))
  assert.equal((await call('sendMessage', { chat_id: 'y', text: 'after' }, x)).error_code, 507)
  assert.equal((await call('observe', { events: [{ kind: 'status', status: 'x' }] }, x)).error_code, 507)
  const up = await fetch(`${URL_}/sendDocument?chat_id=y&filename=note.txt`, { method: 'POST', headers: { Authorization: `Bearer ${x}`, 'Content-Type': 'application/octet-stream' }, body: 'hello' })
  assert.equal(up.status, 507)
  // Another company doesn't notice.
  const b = await newCompany('Not full')
  const [bx, by] = [await register(b, 'x'), await register(b, 'y')]
  void by
  ok(await call('sendMessage', { chat_id: 'y', text: 'fine' }, bx))
  // Reading and deleting go on working.
  ok(await get('getMe', x))
  ok(await act(a, 'delete', { session: 'y' }))
  // And what was deleted makes room, though the file doesn't shrink.
  const again = new DatabaseSync(file)
  again.prepare("DELETE FROM events WHERE session = 'filler'").run()
  again.close()
  await sleep(5100)
  const z = await register(a, 'z')
  void z
  ok(await call('sendMessage', { chat_id: 'z', text: 'room again' }, x))
})

test('on a disk about to fill up, sessions can add nothing, and can still be deleted', async () => {
  const port = PORT + 1
  const dir = mkdtempSync(join(tmpdir(), 'squadra-companies-disk-'))
  const low = spawn(process.execPath, [join(ROOT, 'server/server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, SQUADRA_SERVER_TOKEN: ADMIN, SQUADRA_MIN_FREE_MB: '999999999999' },
    stdio: 'ignore',
  })
  const on = (path, body, auth = ADMIN) => fetch(`http://127.0.0.1:${port}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, body: JSON.stringify(body) }).then(r => r.json())
  try {
    await waitFor(() => fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false), { what: 'the server' })
    const x = ok(await on('register', { name: 'x' })).secret
    const y = ok(await on('register', { name: 'y' })).secret
    void y
    assert.equal((await on('sendMessage', { chat_id: 'y', text: 'no' }, x)).error_code, 507)
    assert.equal((await on('observe', { events: [{ kind: 'status', status: 'x' }] }, x)).error_code, 507)
    ok(await on('api/delete', { session: 'y' }))
  } finally {
    low.kill()
    await new Promise(r => low.once('exit', r))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exports: the copy is not made on the thread that answers everyone, and one runs at a time in the server', async () => {
  assert.doesNotMatch(readFileSync(join(ROOT, 'server/company-export.js'), 'utf8').split('const COPY_DATABASE')[0], /VACUUM/)
  const [a, b] = [await newCompany('Export one'), await newCompany('Export two')]
  // Enough that the answer doesn't fit in what the sockets hold while nobody reads it.
  const direct = new DatabaseSync(join(dataDir, 'companies', a.id, 'squadra.db'))
  direct.prepare('INSERT INTO events (session, ts, kind, data) VALUES (?, ?, ?, ?)').run('filler', Date.now(), 'status', randomBytes(15 * 1024 * 1024).toString('hex'))
  direct.close()
  const open = c => fetch(`${URL_}/${api(c, 'company/export')}`, { headers: { Authorization: `Bearer ${ADMIN}` } })
  const first = await open(a)
  assert.equal(first.status, 200)
  // Other companies go on being answered, and a second export waits for its turn.
  await read(b, 'state')
  const second = await open(b)
  assert.equal(second.status, 409)
  await second.text()
  assert.ok((await first.arrayBuffer()).byteLength > 1024 * 1024)
  const again = await waitFor(async () => { const r = await open(b); if (r.status === 200) return r; await r.text(); return false }, { what: 'its turn' })
  assert.ok((await again.arrayBuffer()).byteLength > 0)
  assert.deepEqual(readdirSync(join(dataDir, 'companies', a.id)).filter(f => f.startsWith('export-')), [])
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

// A machine of this company, played here, connected.
async function machineOf(company, name) {
  const en = ok(await act(company, 'hosts/enroll', { name }))
  const host = ok(await call('host/enroll', { code: en.code, company: company.id, info: { hostname: name } }))
  return { host, connect: async terminals => {
    const machine = await socket('/host/connect', ok(await call('host/ticket', {}, host.secret)).ticket)
    machine.ws.send(JSON.stringify({ t: 'hello', info: { hostname: name, terminals } }))
    await waitFor(() => machine.inbox.some(m => m.t === 'welcome'), { what: 'the welcome' })
    return machine
  } }
}

test('after a session ends, a dashboard socket types into no later one of that name without a new attach, written down', async () => {
  const a = await newCompany('Typing')
  const { host, connect } = await machineOf(a, 'typing-box')
  const machine = await connect([])
  const viewer = await socket('/api/terminal', ok(await act(a, 'terminal/ticket', {})).ticket)
  const sends = m => viewer.ws.send(JSON.stringify({ host: host.id, term: 'w1', ...m }))
  const typed = () => machine.inbox.filter(m => m.t === 'in')
  const written = async () => (await read(a, 'company/audit')).filter(e => e.action === 'terminal-type').length
  sends({ t: 'attach', cols: 80, rows: 24 })
  await waitFor(() => machine.inbox.some(m => m.t === 'attach'), { what: 'attach' })
  sends({ t: 'in', data: 'one' })
  await waitFor(() => typed().length === 1, { what: 'first input' })
  assert.equal(await written(), 1)
  // It ends. Whoever was on it has to come back to the next one.
  machine.ws.send(JSON.stringify({ t: 'exit', term: 'w1' }))
  await waitFor(() => viewer.inbox.some(m => m.t === 'exit'), { what: 'exit' })
  sends({ t: 'in', data: 'into the next one' })
  await sleep(300)
  assert.equal(typed().length, 1, 'nothing reached the machine')
  sends({ t: 'attach', cols: 80, rows: 24 })
  await waitFor(() => machine.inbox.filter(m => m.t === 'attach').length === 2, { what: 'second attach' })
  sends({ t: 'in', data: 'two' })
  await waitFor(() => typed().length === 2, { what: 'second input' })
  assert.equal(await written(), 2)
  // Detached, typing counts as new when it comes back; an image counts as typing.
  sends({ t: 'detach' })
  await sleep(100)
  sends({ t: 'attach', cols: 80, rows: 24 })
  await waitFor(() => machine.inbox.filter(m => m.t === 'attach').length === 3, { what: 'third attach' })
  sends({ t: 'image', type: 'image/png', data: 'AAAA' })
  await waitFor(() => machine.inbox.some(m => m.t === 'image'), { what: 'the image' })
  assert.equal(await written(), 3)
  viewer.ws.close(); machine.ws.close()
})

test('links changed while a machine is away: the dashboard says so, and the machine hears when it connects', async () => {
  const a = await newCompany('Away')
  const { host, connect } = await machineOf(a, 'away-box')
  const [lead, peer] = [await register(a, 'lead'), await register(a, 'peer')]
  for (const [secret, instance] of [[lead, 'inst-lead-0001'], [peer, 'inst-peer-0001']]) ok(await call('claimSession', { instance, role: 'coordinator' }, secret))
  const direct = new DatabaseSync(join(dataDir, 'companies', a.id, 'squadra.db'))
  direct.prepare('UPDATE identities SET host_id = ? WHERE name = ?').run(host.id, 'lead')
  direct.close()
  const added = ok(await act(a, 'links/add', { a: 'lead', b: 'peer' }))
  assert.match(added.warnings.join(), /lead: its machine isn't connected/)
  const terminals = [{ id: 'lead', role: 'coordinator' }]
  let machine = await connect(terminals)
  const told = m => m.inbox.find(x => x.t === 'links' && x.name === 'lead')
  await waitFor(() => told(machine), { what: 'the links' })
  assert.deepEqual(told(machine).coordinators, ['peer'])
  machine.ws.close()
  await waitFor(async () => !(await read(a, 'hosts'))[0].online, { what: 'it left' })
  const removed = ok(await act(a, 'links/delete', { a: 'lead', b: 'peer' }))
  assert.match(removed.warnings.join(), /lead: its machine isn't connected/)
  machine = await connect(terminals)
  await waitFor(() => told(machine), { what: 'the unlink' })
  assert.deepEqual(told(machine).coordinators, [])
  machine.ws.close()
})

test('a machine belongs to its company, and a terminal ticket only reaches that company\'s machines', async () => {
  const [a, b] = [await newCompany('Term A'), await newCompany('Term B')]
  const en = ok(await act(a, 'hosts/enroll', { name: 'shared-name' }))
  const host = ok(await call('host/enroll', { code: en.code, company: a.id, info: { hostname: 'shared-name' } }))
  // A code only in its company, and only once.
  assert.deepEqual((await read(b, 'hosts')), [])
  assert.equal((await read(a, 'hosts')).length, 1)
  assert.equal((await call('host/enroll', { code: en.code, company: a.id, info: {} })).ok, false)

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

test('after a restart every company is back, with its sessions, machines and limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'squadra-companies-restart-'))
  const port = PORT + 3100
  const start = async () => {
    const proc = spawn(process.execPath, [join(ROOT, 'server/server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, SQUADRA_SERVER_TOKEN: ADMIN }, stdio: 'ignore' })
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch { return false } }, { what: 'server' })
    return proc
  }
  const stop = proc => new Promise(r => { proc.on('exit', r); proc.kill('SIGTERM') })
  const on = (path, body, auth = ADMIN) => fetch(`http://127.0.0.1:${port}/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(r => r.json())

  let proc = await start()
  let company, secret, host
  try {
    company = ok(await on('admin/createCompany', { name: 'Stays', limits: { max_sessions: 7 } }))
    secret = ok(await on('register', { name: 'stays' }, company.join_token)).secret
    const en = ok(await on(`api/c/${company.id}/hosts/enroll`, { name: 'm' }))
    host = ok(await on('host/enroll', { code: en.code, company: company.id, info: { hostname: 'm' } }))
    // A code still waiting when the server stops goes on working after it.
    company.code = ok(await on(`api/c/${company.id}/hosts/enroll`, { name: 'later' })).code
  } finally { await stop(proc) }

  proc = await start()
  try {
    const listed = ok(await on('api/companies')).find(c => c.id === company.id)
    assert.deepEqual([listed.name, listed.limits], ['Stays', { max_sessions: 7 }])
    assert.equal(ok(await on('getMe', {}, secret)).id, 'stays')
    assert.ok(ok(await on('host/ticket', {}, host.secret)).ticket)
    ok(await on('register', { name: 'again' }, company.join_token))
    assert.equal(ok(await on('host/enroll', { code: company.code, company: company.id, info: { hostname: 'later' } })).name, 'later')
    assert.equal(ok(await on(`api/c/${company.id}/hosts`)).length, 2)
    assert.deepEqual(ok(await on('api/state')).sessions, [])
  } finally { await stop(proc) }
})

test('what is done in a company is written down in it: who, what and about what, never its content', async () => {
  const [a, b] = [await newCompany('Audit A'), await newCompany('Audit B')]
  await register(a, 'x')
  ok(await call('sendMessage', { chat_id: 'x', text: 'never in the audit' }, await register(a, 'y')))
  ok(await act(a, 'archive', { session: 'x' }))
  ok(await act(a, 'unarchive', { session: 'x' }))
  ok(await call('claimSession', { instance: 'instance-audit-1', role: 'coordinator' }, await register(a, 'lead')))
  ok(await act(a, 'org/positions', { positions: [{ coordinator: 'lead', x: 1, y: 1 }] }))
  const log = await read(a, 'company/audit')
  assert.deepEqual(log.map(e => e.action).slice(0, 2), ['unarchive', 'archive'])
  assert.equal(log[0].target, 'x')
  assert.equal(log[0].who, 'server token')
  assert.ok(!log.some(e => e.action === 'org/positions'))
  assert.doesNotMatch(JSON.stringify(log), /never in the audit/)
  assert.deepEqual(await read(b, 'company/audit'), [])
  // A refusal isn't something done.
  assert.equal((await act(a, 'archive', { session: 'nobody' })).ok, false)
  assert.equal((await read(a, 'company/audit')).length, log.length)
})

test('retention: a company keeps messages and activity for as long as it says', async () => {
  const [a, b] = [await newCompany('Keep A'), await newCompany('Keep B')]
  assert.deepEqual(await read(a, 'company/retention'), { retention_days: 7, event_hours: 24 })
  assert.deepEqual(ok(await act(a, 'company/retention/set', { retention_days: 30 })).retention_days, 30)
  assert.equal((await read(a, 'company/retention')).retention_days, 30)
  assert.equal((await read(b, 'company/retention')).retention_days, 7)
  for (const bad of [{ retention_days: 0 }, { retention_days: 4000 }, { event_hours: 'x' }]) {
    assert.equal((await act(a, 'company/retention/set', bad)).error_code, 400)
  }
})

test('exporting a company: its database and attachments, in a file anyone can open, and nothing of another', async () => {
  const [a, b] = [await newCompany('Export A'), await newCompany('Export B')]
  const [x, y] = [await register(a, 'x'), await register(a, 'y')]
  void y
  ok(await call('sendMessage', { chat_id: 'y', text: 'kept in the export' }, x))
  await register(b, 'z')
  ok(await call('sendMessage', { chat_id: 'z', text: 'of the other company' }, await register(b, 'w')))
  ok(await (await fetch(`${URL_}/sendDocument?chat_id=y&filename=note.txt`, { method: 'POST', headers: { Authorization: `Bearer ${x}`, 'Content-Type': 'text/plain' }, body: 'attached text' })).json())

  const res = await fetch(`${URL_}/${api(a, 'company/export')}`, { headers: { Authorization: `Bearer ${ADMIN}` } })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-disposition'), new RegExp(`squadra-${a.id}-`))
  const dir = mkdtempSync(join(tmpdir(), 'squadra-export-'))
  writeFileSync(join(dir, 'out.tar.gz'), Buffer.from(await res.arrayBuffer()))
  execFileSync('tar', ['-xzf', 'out.tar.gz'], { cwd: dir })
  const about = JSON.parse(readFileSync(join(dir, 'company.json'), 'utf8'))
  assert.equal(about.id, a.id)
  const db = new DatabaseSync(join(dir, 'squadra.db'), { readOnly: true })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE text = 'kept in the export'").get().n, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE text = 'of the other company'").get().n, 0)
  db.close()
  const files = readdirSync(join(dir, 'files'))
  assert.equal(files.length, 1)
  assert.equal(readFileSync(join(dir, 'files', files[0]), 'utf8'), 'attached text')
  // Not its join token, nor anything of the server's; and nothing left behind.
  assert.deepEqual(readdirSync(dir).sort(), ['company.json', 'files', 'out.tar.gz', 'squadra.db'])
  assert.ok(!readdirSync(join(dataDir, 'companies', a.id)).some(f => f.startsWith('export-')))
  assert.ok((await read(a, 'company/audit')).some(e => e.action === 'company/export'))
})

test('deleting a company: stopped at once, back if asked for, and gone when its time is up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'squadra-companies-del-'))
  const port = PORT + 3200
  const start = async grace => {
    const proc = spawn(process.execPath, [join(ROOT, 'server/server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, SQUADRA_SERVER_TOKEN: ADMIN, SQUADRA_COMPANY_GRACE_MS: String(grace) }, stdio: 'ignore' })
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch { return false } }, { what: 'server' })
    return proc
  }
  const stop = proc => new Promise(r => { proc.on('exit', r); proc.kill('SIGTERM') })
  const on = (path, body, auth = ADMIN) => fetch(`http://127.0.0.1:${port}/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(r => r.json())

  let proc = await start(3600_000)
  try {
    const a = ok(await on('admin/createCompany', { name: 'Goes away' }))
    const secret = ok(await on('register', { name: 'x' }, a.join_token)).secret
    const stayed = ok(await on('register', { name: 'x' }))
    // Not by mistake, and never the first one.
    assert.equal((await on(`api/c/${a.id}/company/delete`, { confirm: 'wrong name' })).error_code, 400)
    assert.equal((await on('api/c/default/company/delete', { confirm: 'Default' })).error_code, 409)
    const done = ok(await on(`api/c/${a.id}/company/delete`, { confirm: 'Goes away' }))
    assert.ok(done.delete_after > Date.now())

    // Stopped: its sessions and its dashboard are out; its data, still there.
    assert.equal((await on('getMe', {}, secret)).error_code, 503)
    assert.equal((await on(`api/c/${a.id}/state`)).error_code, 404)
    assert.ok(existsSync(join(dir, 'companies', a.id, 'squadra.db')))
    ok(await on('getMe', {}, stayed.secret))
    assert.equal(ok(await on('api/companies')).find(c => c.id === a.id).status, 'deleting')

    // Also after a restart; and it comes back whole.
    await stop(proc)
    proc = await start(3600_000)
    assert.equal((await on('getMe', {}, secret)).error_code, 503)
    assert.equal(ok(await on('api/companies/restore', { company: a.id })).status, 'active')
    assert.equal(ok(await on('getMe', {}, secret)).id, 'x')
    assert.equal((await on('api/companies/restore', { company: a.id })).error_code, 404)

    // Its time up: gone, folder and all.
    ok(await on(`api/c/${a.id}/company/delete`, { confirm: 'Goes away' }))
    await stop(proc)
    const control = new DatabaseSync(join(dir, 'control.db'))
    control.prepare('UPDATE companies SET delete_after = 1 WHERE id = ?').run(a.id)
    control.close()
    proc = await start(0)
    assert.ok(!existsSync(join(dir, 'companies', a.id)))
    assert.ok(!ok(await on('api/companies')).some(c => c.id === a.id))
    assert.equal((await on('getMe', {}, secret)).error_code, 401)
  } finally { await stop(proc) }
})
