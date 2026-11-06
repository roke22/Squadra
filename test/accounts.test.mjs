// Who can sign in and what each can do: passwords, codes, invitations, roles,
// and that losing access takes effect at once.
//
// Run: node --test test/accounts.test.mjs

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { totpCode, totpStep } from '../server/accounts/totp.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ADMIN = 'accounts-admin-token-0123456789'
const PORT = 26000 + Math.floor(Math.random() * 2000)
const URL_ = `http://127.0.0.1:${PORT}`
const ORIGIN = URL_
const dataDir = mkdtempSync(join(tmpdir(), 'squadra-accounts-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PASSWORD = 'correct horse battery'
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

// A browser, as far as the server can tell: a cookie it keeps, and an Origin.
let addresses = 0
function browser() {
  let cookie = ''
  // (Each from its own address, behind this test's "proxy": what is limited per
  // address has its own test.)
  const address = `10.0.${Math.floor(++addresses / 250)}.${addresses % 250 + 1}`
  const request = async (method, path, body, headers = {}) => {
    const r = await fetch(`${URL_}/${path}`, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), 'X-Forwarded-For': address, ...(method === 'POST' ? { 'Content-Type': 'application/json', Origin: ORIGIN } : {}), ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    })
    const set = r.headers.get('set-cookie')
    if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? '' : v; browser.lastSetCookie = set }
    return r.json()
  }
  return {
    post: (path, body, headers) => request('POST', path, body, headers),
    get: path => request('GET', path),
    get cookie() { return cookie },
  }
}
const ok = r => { assert.ok(r.ok, r.description); return r.result }
const bearer = (path, token, body) => fetch(`${URL_}/${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then(r => r.json())

// A code nobody has used yet: a code counts once, so the next one if need be.
const stepsUsed = new Map()
function nextCode(secret) {
  const step = Math.max(totpStep() - 1, (stepsUsed.get(secret) ?? 0) + 1)
  assert.ok(step <= totpStep() + 1, 'out of codes for now')
  stepsUsed.set(secret, step)
  return totpCode(secret, step)
}

async function setUpCodes(b) {
  const { secret, uri } = ok(await b.post('auth/totp/setup'))
  assert.match(uri, /^otpauth:\/\/totp\/Squadra%3A/)
  const done = ok(await b.post('auth/totp/enable', { code: nextCode(secret) }))
  assert.equal(done.stage, 'ok')
  return { secret, recovery: done.recovery_codes }
}

// A person invited to a company, with a finished sign-in.
async function member(by, companyPath, email, role) {
  const { link } = ok(await by.post(`${companyPath}/members/invite`, { email, role }))
  const token = link.split('/#/invite/')[1]
  const b = browser()
  const me = ok(await b.post('auth/invite/accept', { token, name: email.split('@')[0], password: PASSWORD }))
  let codes = null
  if (me.stage === 'totp_setup') codes = await setUpCodes(b)
  return { b, id: me.user.id, email, codes }
}

let owner, ownerCodes, ownerId

before(async () => {
  server = spawn(process.execPath, [join(ROOT, 'server/server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, SQUADRA_SERVER_TOKEN: ADMIN, TRUST_PROXY: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  server.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(d) })
  await waitFor(async () => { try { return (await fetch(`${URL_}/health`)).ok } catch { return false } }, { what: 'server' })
})
after(() => server?.kill('SIGTERM'))

test('the first owner comes from the server token; after that the token no longer opens the dashboard', async () => {
  assert.equal(ok(await browser().get('auth/status')).needs_owner, true)
  // Until then, as ever.
  ok(await bearer('api/state', ADMIN))

  const wrong = browser()
  assert.equal((await wrong.post('bootstrap', { email: 'o@x.co', name: 'O', password: PASSWORD }, { Authorization: 'Bearer nope' })).error_code, 401)
  assert.equal((await wrong.post('bootstrap', { email: 'o@x.co', name: 'O', password: 'short' }, { Authorization: `Bearer ${ADMIN}` })).error_code, 400)
  assert.equal(ok(await browser().get('auth/status')).needs_owner, true)

  owner = browser()
  const me = ok(await owner.post('bootstrap', { email: 'Owner@Example.com', name: 'The Owner', password: PASSWORD }, { Authorization: `Bearer ${ADMIN}` }))
  ownerId = me.user.id
  assert.equal(me.user.email, 'owner@example.com')
  assert.equal(me.user.is_platform_admin, true)
  assert.equal(me.stage, 'totp_setup')
  assert.equal(ok(await browser().get('auth/status')).needs_owner, false)

  // Password alone reaches nothing, until codes are set up.
  assert.equal((await owner.get('api/c/default/state')).error_code, 401)
  ownerCodes = await setUpCodes(owner)
  ok(await owner.get('api/c/default/state'))
  assert.deepEqual(ok(await owner.get('api/me')).companies.map(c => [c.id, c.role]), [['default', 'owner']])
  assert.equal(ownerCodes.recovery.length, 10)

  // The token: no dashboard, no terminals; /admin stays, and no second owner.
  assert.equal((await bearer('api/state', ADMIN)).error_code, 401)
  assert.equal((await bearer('api/c/default/state', ADMIN)).error_code, 401)
  assert.equal((await bearer('api/terminal/ticket', ADMIN, {})).error_code, 401)
  ok(await bearer('admin/listIdentities', ADMIN, {}))
  assert.equal((await browser().post('bootstrap', { email: 'o2@x.co', name: 'O', password: PASSWORD }, { Authorization: `Bearer ${ADMIN}` })).error_code, 409)
})

test('the session cookie can\'t be read by the page, sent by other sites, or kept in the clear', async () => {
  const b = browser()
  ok(await b.post('auth/login', { email: 'owner@example.com', password: PASSWORD }))
  assert.match(browser.lastSetCookie, /HttpOnly/)
  assert.match(browser.lastSetCookie, /SameSite=Strict/)
  const value = b.cookie.split('=')[1]
  const db = new DatabaseSync(join(dataDir, 'control.db'), { readOnly: true })
  const stored = JSON.stringify(db.prepare('SELECT * FROM login_sessions').all()) + JSON.stringify(db.prepare('SELECT * FROM users').all()) + JSON.stringify(db.prepare('SELECT * FROM recovery_codes').all())
  db.close()
  assert.ok(!stored.includes(value))
  assert.ok(!stored.includes(PASSWORD))
  assert.ok(!stored.includes(ownerCodes.secret), 'the TOTP secret is encrypted')
  assert.ok(!stored.includes(ownerCodes.recovery[0]))
  assert.ok(!readFileSync(join(dataDir, 'control.db')).includes(ownerCodes.secret))
})

test('signing in takes the password and the code, and neither can be tried for ever', async () => {
  const b = browser()
  assert.equal((await b.post('auth/login', { email: 'owner@example.com', password: 'wrong password' })).error_code, 401)
  assert.equal((await b.post('auth/login', { email: 'nobody@example.com', password: 'wrong password' })).description, 'Unauthorized: wrong email or password')
  const me = ok(await b.post('auth/login', { email: 'OWNER@example.com', password: PASSWORD }))
  assert.equal(me.stage, 'totp')
  assert.equal((await b.get('api/c/default/state')).error_code, 401)
  assert.equal((await b.post('auth/totp', { code: '000000' })).error_code, 401)
  const code = nextCode(ownerCodes.secret)
  assert.equal(ok(await b.post('auth/totp', { code })).stage, 'ok')
  ok(await b.get('api/c/default/state'))
  // The same code again counts for nothing.
  const again = browser()
  ok(await again.post('auth/login', { email: 'owner@example.com', password: PASSWORD }))
  assert.equal((await again.post('auth/totp', { code })).error_code, 401)
  // A recovery code works, once.
  ok(await again.post('auth/totp', { recovery: ownerCodes.recovery[0] }))
  ok(await again.get('api/c/default/state'))
  const third = browser()
  ok(await third.post('auth/login', { email: 'owner@example.com', password: PASSWORD }))
  assert.equal((await third.post('auth/totp', { recovery: ownerCodes.recovery[0] })).error_code, 401)
})

test('a request with the cookie from another site is refused', async () => {
  assert.equal((await owner.post('api/c/default/approve', { session: 'x' }, { Origin: 'https://evil.example' })).error_code, 403)
  assert.equal((await owner.post('auth/logout', {}, { Origin: 'https://evil.example' })).error_code, 403)
  ok(await owner.get('api/c/default/state'))
})

test('each role does what the table says, in its own company only', async () => {
  const co = ok(await owner.post('api/companies/create', { name: 'Roles & Co' }))
  const path = `api/c/${co.id}`
  // An administrator isn't in a company until joining it: and it is written down.
  assert.equal((await owner.get(`${path}/state`)).error_code, 404)
  ok(await owner.post('api/companies/join', { company: co.id }))
  ok(await owner.get(`${path}/state`))
  const db = new DatabaseSync(join(dataDir, 'control.db'), { readOnly: true })
  assert.ok(db.prepare("SELECT 1 FROM platform_audit WHERE action = 'admin-joined-company' AND target = ?").get(co.id))
  db.close()

  const observer = await member(owner, path, 'observer@example.com', 'observer')
  const operator = await member(owner, path, 'operator@example.com', 'operator')
  const manager = await member(owner, path, 'manager@example.com', 'manager')
  // Only who can write in terminals needs codes.
  assert.equal(observer.codes, null)
  assert.ok(operator.codes)

  const can = async (who, path_, body) => {
    const r = body === undefined ? await who.b.get(path_) : await who.b.post(path_, body)
    return r.error_code !== 403
  }
  // [what, body, least role]. (Some answer "not found" for the session in them: not a refusal.)
  const table = [
    ['state', undefined, 'observer'], ['timeline?session=x', undefined, 'observer'], ['events', undefined, 'observer'], ['messages', undefined, 'observer'], ['hosts', undefined, 'observer'],
    ['terminal/ticket', {}, 'operator'], ['terminals/open', { host: 'h', spec: { name: 'x' } }, 'operator'], ['terminals/kill', { host: 'h', term: 'x' }, 'operator'],
    ['kick', { session: 'x' }, 'operator'], ['clear', { session: 'x' }, 'operator'], ['archive', { session: 'x' }, 'operator'], ['unarchive', { session: 'x' }, 'operator'], ['hosts/personas', { host: 'h', folder: '/a' }, 'operator'],
    ['approve', { session: 'x' }, 'manager'], ['delete', { session: 'x' }, 'manager'],
    ['hosts/enroll', { name: 'm' }, 'manager'], ['hosts/rename', { host: 'h', name: 'n' }, 'manager'], ['hosts/remove', { host: 'h' }, 'manager'], ['hosts/folders', { host: 'h', action: 'add', path: '/a' }, 'manager'],
    ['templates/save', { name: '' }, 'manager'], ['templates/delete', { name: 'x' }, 'manager'], ['links/add', {}, 'manager'], ['links/delete', {}, 'manager'],
    ['org/squad', {}, 'manager'], ['org/positions', {}, 'manager'], ['org/describe', {}, 'manager'],
    ['members', undefined, 'manager'], ['members/invite', { email: 'bad' }, 'manager'], ['members/role', {}, 'manager'], ['members/remove', {}, 'manager'], ['join-token', undefined, 'manager'],
  ]
  const order = ['observer', 'operator', 'manager']
  const people = { observer, operator, manager }
  for (const [what, body, least] of table) {
    for (const role of order) {
      assert.equal(await can(people[role], `${path}/${what}`, body), order.indexOf(role) >= order.indexOf(least), `${role} on ${what}`)
    }
  }
  // Not in any other company, whatever their role here.
  assert.equal((await manager.b.get('api/c/default/state')).error_code, 404)
  assert.equal((await manager.b.post('api/c/default/hosts/enroll', { name: 'x' })).error_code, 404)
  assert.equal((await manager.b.get('api/c/nosuch00/state')).error_code, 404)
  // The companies they see are theirs, and the rest of the server is not for them.
  assert.deepEqual(ok(await manager.b.get('api/companies')).map(c => c.id), [co.id])
  assert.equal((await manager.b.get('api/users')).error_code, 403)
  assert.equal((await manager.b.post('api/companies/create', { name: 'Mine' })).error_code, 403)
  assert.equal((await manager.b.get('api/state')).error_code, 404)
  assert.equal(ok(await operator.b.get('api/me')).companies[0].role, 'operator')

  // A manager gives what it has, but can't touch or make owners.
  assert.equal((await manager.b.post(`${path}/members/invite`, { email: 'x@example.com', role: 'owner' })).error_code, 403)
  assert.equal((await manager.b.post(`${path}/members/role`, { user: ownerId, role: 'observer' })).error_code, 403)
  assert.equal((await manager.b.post(`${path}/members/remove`, { user: ownerId })).error_code, 403)
  ok(await manager.b.post(`${path}/members/role`, { user: observer.id, role: 'operator' }))
  ok(await manager.b.post(`${path}/members/role`, { user: observer.id, role: 'observer' }))
  // A company always has an owner.
  assert.equal((await owner.post(`${path}/members/role`, { user: ownerId, role: 'observer' })).error_code, 409)
  assert.equal((await owner.post(`${path}/members/remove`, { user: ownerId })).error_code, 409)
  // A member made operator has to set codes up before going on.
  ok(await owner.post(`${path}/members/role`, { user: observer.id, role: 'operator' }))
  assert.equal((await observer.b.get(`${path}/state`)).error_code, 401)
  assert.equal(ok(await observer.b.get('api/me')).stage, 'totp_setup')
  await setUpCodes(observer.b)
  ok(await observer.b.get(`${path}/state`))
})

test('losing access closes what is open, at once', async () => {
  const co = ok(await owner.post('api/companies/create', { name: 'Revoked' }))
  const path = `api/c/${co.id}`
  ok(await owner.post('api/companies/join', { company: co.id }))
  const op = await member(owner, path, 'gone@example.com', 'operator')

  const stream = async () => {
    const r = await fetch(`${URL_}/${path}/stream`, { headers: { Cookie: op.b.cookie } })
    assert.equal(r.status, 200)
    return { ended: (async () => { try { for await (const c of r.body) void c } catch {} return true })() }
  }
  const socket = async () => {
    const { ticket } = ok(await op.b.post(`${path}/terminal/ticket`))
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/terminal`, ['squadra', `auth.${ticket}`])
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('no socket')) })
    return { ended: new Promise(res => { ws.onclose = e => res(e.code) }) }
  }
  const closes = async (what, promise) => {
    const r = await Promise.race([promise, sleep(3000).then(() => 'still open')])
    assert.notEqual(r, 'still open', what)
  }

  // A role change.
  let [s, w] = [await stream(), await socket()]
  ok(await owner.post(`${path}/members/role`, { user: op.id, role: 'manager' }))
  await closes('stream, role changed', s.ended)
  await closes('terminal, role changed', w.ended)

  // Taken out of the company.
  ;[s, w] = [await stream(), await socket()]
  ok(await owner.post(`${path}/members/remove`, { user: op.id }))
  await closes('stream, removed', s.ended)
  await closes('terminal, removed', w.ended)
  assert.equal((await op.b.get(`${path}/state`)).error_code, 404)

  // Disabled: out of everything, and can't sign in.
  ok(await owner.post(`${path}/members/invite`, { email: 'gone@example.com', role: 'operator' }).then(async r => {
    const token = ok(r).link.split('/#/invite/')[1]
    return op.b.post('auth/invite/accept', { token, password: PASSWORD })
  }))
  const relogged = browser()
  ok(await relogged.post('auth/login', { email: 'gone@example.com', password: PASSWORD }))
  ok(await relogged.post('auth/totp', { code: nextCode(op.codes.secret) }))
  const r = await fetch(`${URL_}/${path}/stream`, { headers: { Cookie: relogged.cookie } })
  assert.equal(r.status, 200)
  const open = (async () => { try { for await (const c of r.body) void c } catch {} return true })()
  ok(await owner.post('api/users/disable', { user: op.id }))
  await closes('stream, disabled', open)
  assert.equal((await relogged.get(`${path}/state`)).error_code, 401)
  assert.equal((await browser().post('auth/login', { email: 'gone@example.com', password: PASSWORD })).error_code, 401)

  // The last administrator or owner can't go; nor can someone disable themselves.
  assert.equal((await owner.post('api/users/disable', { user: ownerId })).ok, false)
})

test('logging out ends the session there, and a stream with it', async () => {
  const b = browser()
  ok(await b.post('auth/login', { email: 'owner@example.com', password: PASSWORD }))
  ok(await b.post('auth/totp', { code: nextCode(ownerCodes.secret) }))
  const cookie = b.cookie
  const r = await fetch(`${URL_}/api/c/default/stream`, { headers: { Cookie: cookie } })
  const open = (async () => { try { for await (const c of r.body) void c } catch {} return true })()
  ok(await b.post('auth/logout'))
  assert.notEqual(await Promise.race([open, sleep(3000).then(() => 'still open')]), 'still open')
  const old = await fetch(`${URL_}/api/c/default/state`, { headers: { Cookie: cookie } }).then(x => x.json())
  assert.equal(old.error_code, 401)
  // Others keep going.
  ok(await owner.get('api/c/default/state'))
})

test('an invitation works once, for its address, and only for a while', async () => {
  const { link } = ok(await owner.post('api/c/default/members/invite', { email: 'once@example.com', role: 'observer' }))
  const token = link.split('/#/invite/')[1]
  assert.match(link, /\/#\/invite\//)
  const info = ok(await browser().post('auth/invite/info', { token }))
  assert.equal(info.email, 'once@example.com')
  assert.equal((await browser().post('auth/invite/accept', { token, name: 'One', password: 'short' })).error_code, 400)
  const b = browser()
  const me = ok(await b.post('auth/invite/accept', { token, name: 'One', password: PASSWORD, email: 'other@example.com' }))
  assert.equal(me.user.email, 'once@example.com')
  assert.equal((await browser().post('auth/invite/accept', { token, name: 'Two', password: PASSWORD })).error_code, 404)
  assert.equal((await browser().post('auth/invite/info', { token: 'nothing' })).error_code, 404)
  // Someone with an account: needs its own password to join another company.
  const co = ok(await owner.post('api/companies/create', { name: 'Second home' }))
  ok(await owner.post('api/companies/join', { company: co.id }))
  const second = ok(await owner.post(`api/c/${co.id}/members/invite`, { email: 'once@example.com', role: 'observer' })).link.split('/#/invite/')[1]
  assert.equal((await browser().post('auth/invite/accept', { token: second, password: 'not the password!' })).error_code, 401)
  ok(await browser().post('auth/invite/accept', { token: second, password: PASSWORD }))
  assert.equal(ok(await b.get('api/me')).companies.length, 2)
})

test('a new password ends every session; the server token can get someone back in', async () => {
  const { link } = ok(await owner.post('api/c/default/members/invite', { email: 'lost@example.com', role: 'manager' }))
  const b = browser()
  const me = ok(await b.post('auth/invite/accept', { token: link.split('/#/invite/')[1], name: 'Lost', password: PASSWORD }))
  await setUpCodes(b)
  // By an administrator.
  const reset = ok(await owner.post('api/users/reset', { user: me.user.id })).link.split('/#/reset/')[1]
  assert.equal((await browser().post('auth/reset', { token: reset, password: 'short' })).error_code, 400)
  ok(await browser().post('auth/reset', { token: reset, password: 'a brand new password' }))
  assert.equal((await b.get('api/c/default/state')).error_code, 401)
  assert.equal((await browser().post('auth/reset', { token: reset, password: 'another new password' })).error_code, 404)
  assert.equal((await browser().post('auth/login', { email: 'lost@example.com', password: PASSWORD })).error_code, 401)
  const still = browser()
  assert.equal(ok(await still.post('auth/login', { email: 'lost@example.com', password: 'a brand new password' })).stage, 'totp')
  // Lost the codes too: only with the server token.
  const back = ok(await bearer('admin/recoverAccess', ADMIN, { email: 'lost@example.com' })).link.split('/#/reset/')[1]
  ok(await browser().post('auth/reset', { token: back, password: 'yet another password' }))
  const again = browser()
  assert.equal(ok(await again.post('auth/login', { email: 'lost@example.com', password: 'yet another password' })).stage, 'totp_setup')
  // Changing it from inside asks for the current one, and ends the others.
  await setUpCodes(again)
  assert.equal((await again.post('auth/password', { current: 'nope', password: 'and one password more' })).error_code, 401)
  ok(await again.post('auth/password', { current: 'yet another password', password: 'and one password more' }))
  ok(await again.get('api/c/default/state'))
})

test('a terminal ticket says who asked for it, and only reaches that company', async () => {
  const log = []
  server.stderr.on('data', d => log.push(String(d)))
  const co = ok(await owner.post('api/companies/create', { name: 'Who typed' }))
  ok(await owner.post('api/companies/join', { company: co.id }))
  const en = ok(await owner.post(`api/c/${co.id}/hosts/enroll`, { name: 'm' }))
  const host = ok(await fetch(`${URL_}/host/enroll`, { method: 'POST', body: JSON.stringify({ code: en.code, company: co.id, info: { hostname: 'm' } }) }).then(r => r.json()))
  const hostTicket = ok(await bearer('host/ticket', host.secret, {})).ticket
  const machine = new WebSocket(`ws://127.0.0.1:${PORT}/host/connect`, ['squadra', `auth.${hostTicket}`])
  await new Promise(res => { machine.onopen = res })
  machine.send(JSON.stringify({ t: 'hello', info: { hostname: 'm', terminals: [] } }))
  await sleep(100)
  const { ticket } = ok(await owner.post(`api/c/${co.id}/terminal/ticket`))
  const viewer = new WebSocket(`ws://127.0.0.1:${PORT}/api/terminal`, ['squadra', `auth.${ticket}`])
  await new Promise(res => { viewer.onopen = res })
  viewer.send(JSON.stringify({ t: 'attach', host: host.id, term: 'someone', cols: 80, rows: 24 }))
  await sleep(100)
  viewer.send(JSON.stringify({ t: 'in', host: host.id, term: 'someone', data: 'ls\r' }))
  await waitFor(() => log.join('').includes(`[${co.id}] owner@example.com is typing in "someone"`), { what: 'the log line' })
  viewer.close(); machine.close()
})

test('wrong codes run out, for that person, however many sessions try; right ones don\'t count', async () => {
  const { codes, email } = await member(owner, 'api/c/default', 'tries@example.com', 'operator')
  for (let i = 0; i < 4; i++) {
    const b = browser()
    ok(await b.post('auth/login', { email, password: PASSWORD }))
    if (i === 3) continue
    ok(await b.post('auth/totp', i === 0 ? { code: nextCode(codes.secret) } : { recovery: codes.recovery[i] }))
  }
  const b = browser()
  ok(await b.post('auth/login', { email, password: PASSWORD }))
  let refused = 0
  for (let i = 0; i < 7; i++) if ((await b.post('auth/totp', { code: '000000' })).error_code === 429) refused++
  assert.equal(refused, 2)
  assert.equal((await b.post('auth/totp', { code: nextCode(codes.secret) })).error_code, 429)
  // Others aren't touched.
  ok(await owner.get('api/c/default/state'))
})

test('signing in is limited per address and per email, also for an email nobody has', async () => {
  const one = browser()
  let refused = 0
  for (let i = 0; i < 32; i++) if ((await one.post('auth/login', { email: `nobody${i}@example.com`, password: 'wrong password' })).error_code === 429) refused++
  assert.equal(refused, 2)
  // Wrong passwords for one account, from one address.
  const guesser = browser()
  let forEmail = 0
  for (let i = 0; i < 11; i++) if ((await guesser.post('auth/login', { email: 'owner@example.com', password: 'wrong password' })).error_code === 429) forEmail++
  assert.equal(forEmail, 1)
  // That doesn't lock out its owner, who is elsewhere.
  assert.equal(ok(await browser().post('auth/login', { email: 'owner@example.com', password: PASSWORD })).stage, 'totp')
})

test('the server token stays on /api only if the server was started to keep it', async () => {
  const port = PORT + 3000
  const proc = spawn(process.execPath, [join(ROOT, 'server/server.js'), '--allow-token-api'], {
    env: { ...process.env, PORT: String(port), DATA_DIR: mkdtempSync(join(tmpdir(), 'squadra-accounts-')), SQUADRA_SERVER_TOKEN: ADMIN }, stdio: 'ignore',
  })
  try {
    const at = `http://127.0.0.1:${port}`
    await waitFor(async () => { try { return (await fetch(`${at}/health`)).ok } catch { return false } }, { what: 'server' })
    const made = await fetch(`${at}/bootstrap`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'o@example.com', name: 'O', password: PASSWORD }) }).then(r => r.json())
    ok(made)
    ok(await fetch(`${at}/api/state`, { headers: { Authorization: `Bearer ${ADMIN}` } }).then(r => r.json()))
  } finally { proc.kill('SIGTERM') }
})

test('nobody keeps a way back: tickets and invitations made before losing access are worth nothing', async () => {
  const co = ok(await owner.post('api/companies/create', { name: 'No way back' }))
  const path = `api/c/${co.id}`
  ok(await owner.post('api/companies/join', { company: co.id }))
  const manager = await member(owner, path, 'leaver@example.com', 'manager')
  const socketOpens = ticket => new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/terminal`, ['squadra', `auth.${ticket}`])
    ws.onopen = () => { ws.close(); res(true) }
    ws.onerror = () => res(false)
  })

  // Links to itself and to a spare address, and a ticket, before being demoted.
  const invite = async (email, role) => ok(await manager.b.post(`${path}/members/invite`, { email, role })).link.split('/#/invite/')[1]
  const own = await invite('leaver@example.com', 'manager')
  const spare = await invite('spare@example.com', 'manager')
  const ticket = ok(await manager.b.post(`${path}/terminal/ticket`)).ticket
  const unused = ok(await manager.b.post(`${path}/hosts/enroll`, { name: 'later' })).code
  ok(await owner.post(`${path}/members/role`, { user: manager.id, role: 'observer' }))
  assert.equal(await socketOpens(ticket), false, 'the ticket')
  assert.equal((await browser().post('auth/invite/accept', { token: own, password: PASSWORD })).error_code, 404)
  assert.equal((await browser().post('auth/invite/accept', { token: spare, name: 'Spare', password: PASSWORD })).error_code, 404)
  assert.equal((await browser().post('auth/invite/info', { token: spare })).error_code, 404)
  assert.equal(ok(await manager.b.get('api/me')).companies[0].role, 'observer')
  assert.equal((await fetch(`${URL_}/host/enroll`, { method: 'POST', body: JSON.stringify({ code: unused, company: co.id, info: {} }) }).then(r => r.json())).ok, false, 'the code')

  // Removed, with what it had made while it could: the same.
  ok(await owner.post(`${path}/members/role`, { user: manager.id, role: 'manager' }))
  const later = await invite('spare@example.com', 'operator')
  const removed = ok(await owner.post(`${path}/members/remove`, { user: manager.id }))
  assert.equal(removed.rotate_join_token, true)
  assert.equal((await browser().post('auth/invite/accept', { token: later, name: 'Spare', password: PASSWORD })).error_code, 404)

  // A logout takes a ticket as well.
  const b = browser()
  ok(await b.post('auth/login', { email: 'owner@example.com', password: PASSWORD }))
  ok(await b.post('auth/totp', { recovery: ownerCodes.recovery[1] }))
  const last = ok(await b.post(`${path}/terminal/ticket`)).ticket
  ok(await b.post('auth/logout'))
  assert.equal(await socketOpens(last), false, 'the ticket after logging out')
})

test('an invitation never lowers anyone: not the last owner, not anybody', async () => {
  const co = ok(await owner.post('api/companies/create', { name: 'Keep the owner' }))
  const path = `api/c/${co.id}`
  ok(await owner.post('api/companies/join', { company: co.id }))
  const manager = await member(owner, path, 'schemer@example.com', 'manager')
  const token = ok(await manager.b.post(`${path}/members/invite`, { email: 'owner@example.com', role: 'observer' })).link.split('/#/invite/')[1]
  const b = browser()
  ok(await b.post('auth/invite/accept', { token, password: PASSWORD }))
  assert.equal((await owner.get(`${path}/members`)).result.find(m => m.id === ownerId).role, 'owner')
  // And joining again with less doesn't either.
  assert.equal(ok(await owner.post('api/companies/join', { company: co.id, role: 'observer' })).role, 'owner')
})

test('invitations can be seen and cancelled; the list holds nothing that works as the link', async () => {
  const { link } = ok(await owner.post('api/c/default/members/invite', { email: 'cancelled@example.com', role: 'observer' }))
  const token = link.split('/#/invite/')[1]
  const list = ok(await owner.get('api/c/default/invitations'))
  const entry = list.find(i => i.email === 'cancelled@example.com')
  assert.ok(entry)
  assert.ok(!JSON.stringify(list).includes(token))
  assert.equal((await browser().post('auth/invite/info', { token: entry.id })).error_code, 404)
  ok(await owner.post('api/c/default/invitations/cancel', { id: entry.id }))
  assert.equal((await browser().post('auth/invite/info', { token })).error_code, 404)
})

test('a sign-in not finished says nothing of the companies; a wrong password on an invitation has the same limit', async () => {
  const b = browser()
  const me = ok(await b.post('auth/login', { email: 'owner@example.com', password: PASSWORD }))
  assert.equal(me.stage, 'totp')
  assert.deepEqual(me.companies, [])
  assert.deepEqual(ok(await b.get('api/me')).companies, [])

  const token = ok(await owner.post('api/c/default/members/invite', { email: 'owner@example.com', role: 'observer' })).link.split('/#/invite/')[1]
  const guesser = browser()
  let refused = 0
  for (let i = 0; i < 12; i++) if ((await guesser.post('auth/invite/accept', { token, password: 'not the password' })).error_code === 429) refused++
  assert.equal(refused, 2)
})

test('what is done with the server token on /admin is written down', async () => {
  ok(await bearer('admin/listIdentities', ADMIN, {}))
  const db = new DatabaseSync(join(dataDir, 'control.db'), { readOnly: true })
  assert.ok(db.prepare("SELECT 1 FROM platform_audit WHERE action = 'admin-listIdentities' AND user_id = 'server-token'").get())
  db.close()
})

test('the QR code for an authenticator app stays what a decoder read', async () => {
  // (This one was checked once with an independent decoder, jsQR, like other
  // lengths and versions. A change here needs that check again.)
  const { qrSvg } = await import('../server/ui/qr.js')
  const uri = 'otpauth://totp/Squadra%3Aowner%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Squadra&algorithm=SHA1&digits=6&period=30'
  // (The modules themselves, whatever else the image says of itself.)
  assert.equal(createHash('sha256').update(/ d="([^"]+)"/.exec(qrSvg(uri))[1]).digest('hex'), '3296ecfd6a02d8f1ff238e603e9f4eecbcd8c02d2d24510e14912b4e28946625')
  assert.equal(qrSvg('x'.repeat(2000)), null)
})
