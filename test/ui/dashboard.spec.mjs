// The dashboard's main paths, in a browser. Selectors use what the page gives
// each thing (ids, data attributes, session names), not its layout: moving code
// around must not change these tests.

import { test as base, expect } from '@playwright/test'
import { OWNER, SERVER_TOKEN, startMachine, startServer, startSession } from './harness.mjs'
import { totpCode, totpStep } from '../../server/accounts/totp.js'

// Any error in the page fails the test, a script the Content-Security-Policy
// blocked included. (A wrong token is answered with a 401, which the browser
// reports too.)
const test = base.extend({
  page: async ({ page }, use) => {
    const errors = []
    page.on('pageerror', err => errors.push(err.message))
    page.on('console', m => { if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(m.text()) })
    await use(page)
    // (A test that causes one on purpose says which, in page.expectedErrors.)
    expect(errors.filter(e => !(page.expectedErrors ?? []).some(re => re.test(e)))).toEqual([])
  },
})

let server, coord, machine

test.beforeAll(async () => {
  server = await startServer()
  coord = await startSession(server, 'coord', 'coordinator')
  const worker = await startSession(server, 'worker1', 'worker', 'coord')
  await coord.send(worker.name, 'first task for the worker')
  machine = await startMachine(server, 'machine1', { id: 'worker1', role: 'worker', coordinator: 'coord' })
})

test.afterAll(async () => { await server?.stop() })

async function signIn(page, hash = '') {
  const [name, value] = (await server.ownerCookie()).split('=')
  await page.context().addCookies([{ name, value, url: server.url }])
  await page.goto(`${server.url}/?company=default${hash}`)
  await expect(page.locator('#app')).toBeVisible()
}

test('the first owner: made with the token, with codes, and it stays until signing out', async ({ page }) => {
  const own = await startServer({ tokenApi: false })
  try {
    await page.goto(own.url)
    const form = page.locator('#loginForm')
    await form.locator('[name=token]').fill('not-the-token')
    await form.locator('[name=name]').fill(OWNER.name)
    await form.locator('[name=email]').fill(OWNER.email)
    await form.locator('[name=password]').fill(OWNER.password)
    await page.locator('#loginBtn').click()
    await expect(page.locator('#loginErr')).not.toBeEmpty()
    await expect(page.locator('#app')).toBeHidden()

    await form.locator('[name=token]').fill(SERVER_TOKEN)
    await page.locator('#loginBtn').click()
    const secret = await page.locator('.secret code').textContent()
    await expect(page.locator('#loginForm svg.qr')).toBeVisible()
    await form.locator('[name=code]').fill(totpCode(secret, totpStep()))
    await page.locator('#loginBtn').click()
    await expect(page.locator('.codes')).toContainText(/[0-9a-f]{20}/)
    await page.locator('#loginBtn').click()
    await expect(page.locator('#app')).toBeVisible()
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(SERVER_TOKEN)

    await page.reload()
    await expect(page.locator('#app')).toBeVisible()
    expect(await page.evaluate(() => document.cookie)).toBe('') // (not for the page to read)

    await page.locator('#logoutBtn').click()
    await expect(page.locator('#login')).toBeVisible()
    await page.reload()
    await expect(page.locator('#loginForm [name=email]')).toBeVisible()

    // Signing in again: password, then the next code.
    await form.locator('[name=email]').fill(OWNER.email)
    await form.locator('[name=password]').fill('the wrong password')
    await page.locator('#loginBtn').click()
    await expect(page.locator('#loginErr')).toHaveText('wrong email or password')
    await form.locator('[name=password]').fill(OWNER.password)
    await page.locator('#loginBtn').click()
    await form.locator('[name=code]').fill(totpCode(secret, totpStep() + 1))
    await page.locator('#loginBtn').click()
    await expect(page.locator('#app')).toBeVisible()
  } finally { await own.stop() }
})

test('companies: two show apart, each with its own sessions; the selector changes between them', async ({ page }) => {
  await signIn(page)
  await expect(page.locator('#companySelect')).toBeHidden()
  const other = await server.call('admin/createCompany', { name: 'Otra Compañía' })
  await page.locator('#peopleBtn').click()
  await page.locator('[data-tab=companies]').click()
  await expect(page.locator('.modal')).toContainText('Otra Compañía')
  await page.locator(`[data-join="${other.id}"]`).click()
  await expect(page.locator(`.modal a[href="?company=${other.id}"]`)).toBeVisible()
  await page.goto(`${server.url}/?company=${other.id}`)
  await expect(page.locator('#companySelect')).toBeVisible()
  await expect(page.locator('#companySelect')).toHaveValue(other.id)
  await expect(page.locator('#nav')).toContainText('0 of 0')
  // A company this user isn't in: the page loads again for one they are in, on this site.
  await page.goto(`${server.url}/?company=zzz`)
  await expect(page).toHaveURL(new RegExp(`^${server.url}/\\?company=(default|${other.id})`))
  await page.goto(`${server.url}/?company=${other.id}`)
  await expect(page.locator('#companySelect')).toHaveValue(other.id)
  await page.locator('#companySelect').selectOption('default')
  await expect(page.locator('#nav')).toContainText('worker1')
  await expect(page).toHaveURL(/company=default/)
})

test('an invitation: a link of one use brings someone in, with only their role', async ({ page, browser }) => {
  await signIn(page)
  await page.locator('#peopleBtn').click()
  await page.locator('[data-tab=members]').click()
  const invite = page.locator('[data-invite]')
  await invite.locator('[name=email]').fill('ana@example.com')
  await invite.locator('[name=role]').selectOption('observer')
  await invite.locator('button').click()
  const link = await page.locator('[data-link] .cmd').textContent()
  expect(link).toContain('/#/invite/')

  const ctx = await browser.newContext()
  const guest = await ctx.newPage()
  await guest.goto(link)
  await expect(guest.locator('#loginIntro')).toContainText('ana@example.com')
  await guest.locator('[name=name]').fill('Ana')
  await guest.locator('[name=password]').fill('another long password')
  await guest.locator('#loginBtn').click()
  await expect(guest.locator('#app')).toBeVisible()
  await expect(guest).not.toHaveURL(/invite/)
  // An observer: no adding machines, and the chat rather than a terminal.
  await expect(guest.locator('#addHostBtn')).toBeHidden()
  await expect(guest.locator('#nav')).toContainText('coord')
  // What it can't do isn't offered: anywhere it goes, and nothing asks the server for it.
  await guest.goto(`${server.url}/#/q/coord`)
  await expect(guest.locator('#colsSeg')).toBeVisible()
  await expect(guest.locator('[data-addworker], [data-links], [data-savetpl], #modeSeg')).toHaveCount(0)
  await guest.goto(`${server.url}/#/s/worker1/chat`)
  await expect(guest.locator('#topRight [data-go]')).toBeVisible()
  await expect(guest.locator('[data-act]')).toHaveCount(0)
  await guest.goto(`${server.url}/#/hosts`)
  await expect(guest.locator('.host').first()).toBeVisible()
  await expect(guest.locator('[data-hact], [data-hmenu]')).toHaveCount(0)
  await guest.goto(`${server.url}/#/org`)
  await expect(guest.locator('.org-card').first()).toBeVisible()
  await expect(guest.locator('[data-orgact], [data-orghandle]')).toHaveCount(0)
  await guest.locator('#peopleBtn').click()
  await expect(guest.locator('[data-tab]')).toHaveText(['My account'])
  await ctx.close()
})

test('the sessions: they are listed with their squad', async ({ page }) => {
  await signIn(page)
  await expect(page.locator('#nav')).toContainText('coord')
  await page.goto(`${server.url}/#/c`)
  await expect(page.locator('#mosaic')).toContainText('coord')
})

test('the org chart: a squad shows its coordinator and its worker', async ({ page }) => {
  await signIn(page, '#/org')
  const card = page.locator('.org-card[data-squad="coord"]')
  await expect(card).toBeVisible()
  await expect(card).toContainText('worker1')
})

test('a chat: it shows the history, and a new message without reloading', async ({ page }) => {
  await signIn(page, '#/s/worker1/chat')
  const session = page.locator('#session')
  await expect(session).toContainText('first task for the worker')
  await coord.send('worker1', 'second task, sent while watching')
  await expect(session).toContainText('second task, sent while watching')
})

test('the machines: a connected one is listed with its terminal', async ({ page }) => {
  await signIn(page, '#/hosts')
  const hosts = page.locator('#hosts')
  await expect(hosts.locator('.host-head')).toContainText('machine1')
  await expect(hosts.locator('.host-head .dot.ok')).toBeVisible()
  await expect(hosts.locator('.term-row')).toContainText('worker1')
})

test('the inbox: what a coordinator left is there, with what it wrote kept as text, and it can be marked done', async ({ page }) => {
  const c = await startSession(server, 'inboxc', 'coordinator')
  await c.call('askUser', { text: 'Migrate the <b>column</b>?', options: ['Migrate', 'Keep'], recommended: 'Migrate first', ref: 'https://example.com/issues/421' })
  await c.call('tellUser', { text: 'The cart is done', ref: 'javascript:alert(1)' })
  await signIn(page, '#/inbox')
  const box = page.locator('#inbox')
  await expect(page.locator('#nav [data-go="#/inbox"] .badge')).toHaveText('2')
  await expect(box).toContainText('Migrate the <b>column</b>?')
  await expect(box.locator('a[href="https://example.com/issues/421"]')).toBeVisible()
  await expect(box.locator('a[href^="javascript"]')).toHaveCount(0)
  await box.locator('[data-resolve]').first().click()
  await expect(page.locator('#nav [data-go="#/inbox"] .badge')).toHaveText('1')
  await box.locator('[data-resolve]').first().click()
  await expect(box).toContainText('Nothing is waiting for you')
})

test('the inbox: a question opened from the dashboard is answered there, and one changed meanwhile is read again first', async ({ page }) => {
  await server.call('api/terminals/open', { host: machine.id, spec: { name: 'inboxm', role: 'coordinator' } })
  const c = await startSession(server, 'inboxm', 'coordinator', undefined, machine.identities.get('inboxm'))
  const { id } = await c.call('askUser', { text: 'Stack the discounts?', options: ['Stack', 'Biggest'], recommended: 'Stack, capped' })
  const { id: id2 } = await c.call('askUser', { text: 'Drop the column?', options: ['Drop', 'Keep'] })
  await signIn(page, '#/inbox')
  const box = page.locator('#inbox')
  await expect(box.locator('.squad-row')).toContainText('inboxm')
  // An option, with the detail typed next to it.
  const one = box.locator(`[data-inbox="${id}"]`)
  await one.locator('input[name=answer]').fill('cap it at 25 %')
  await one.locator('[data-option="0"]').click()
  await expect.poll(() => machine.answers.map(a => a.text).join('\n')).toContain(`Inbox #${id} ("Stack the discounts?"), the user answers: Stack. cap it at 25 %`)
  await expect(box.locator(`[data-inbox="${id}"]`)).toContainText('answered: Stack. cap it at 25 %')
  await expect(box.locator('.squad-row')).toContainText('1 open')
  // Changed by its coordinator while open here: refused once, and it says so.
  page.expectedErrors = [/status of 409/]
  await c.call('editInbox', { id: String(id2), text: 'Drop the column? It holds data in all 1240 rows' })
  const two = box.locator(`[data-inbox="${id2}"]`)
  await expect(two).toContainText('1240 rows')
  await expect(two.locator('[data-changed]')).toBeVisible()
  await two.locator('input[name=answer]').fill('Keep it')
  await two.locator('button.primary').click()
  await expect(page.locator('.modal')).toContainText('read it again')
  await page.locator('.modal .actions .btn').first().click()
  expect(machine.answers.some(a => a.text.includes(`#${id2}`))).toBe(false)
  await expect(two.locator('input[name=answer]')).toHaveValue('Keep it')
  await two.locator('button.primary').click()
  await expect.poll(() => machine.answers.map(a => a.text).join('\n')).toContain(`Inbox #${id2} ("Drop the column? It holds data in all 1240 rows"), the user answers: Keep it`)
})

test('disconnecting a machine: it offers to end the sessions opened there, ticked', async ({ page }) => {
  await signIn(page, '#/hosts')
  await page.locator('#hosts .host-head [data-hmenu]').first().click()
  await page.locator('.menu [data-a=disconnect]').click()
  const option = page.locator('.modal [data-option]')
  await expect(option).toBeChecked()
  await expect(page.locator('.modal .check')).toContainText('sessions')
  await page.locator('.modal [data-cancel]').click()
  await expect(page.locator('.modal')).toHaveCount(0)
})

test('adding a machine: the dialog gives a command to run', async ({ page }) => {
  await signIn(page, '#/hosts')
  await page.locator('#addHostBtn').click()
  await expect(page.locator('.modal-bg')).toBeVisible()
})

test('adding a machine for a company: its command says which, and it can have its own system user', async ({ page }) => {
  await signIn(page)
  const other = await server.call('admin/createCompany', { name: 'Machine Co' })
  const cookie = await server.ownerCookie()
  await fetch(`${server.url}/api/companies/join`, { method: 'POST', headers: { Cookie: cookie, Origin: server.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ company: other.id }) })
  await page.goto(`${server.url}/?company=${other.id}#/hosts`)
  await page.locator('#addHostBtn').click()
  await page.locator('[data-gen]').click()
  await page.locator('[data-os=linux]').click()
  const cmd = page.locator('.steps .cmd').first()
  await expect(cmd).toContainText(`--company=${other.id}`)
  await expect(cmd).not.toContainText('sudo')
  await page.locator('[data-osuser]').fill('empresa-1')
  await page.locator('[data-osuser]').blur()
  await expect(cmd).toContainText('&& sudo bash install.sh')
  await expect(cmd).toContainText('--os-user=empresa-1')
  // A name that can't be one is not put in a command.
  await page.locator('[data-osuser]').fill('x; rm -rf /')
  await page.locator('[data-osuser]').blur()
  await expect(cmd).not.toContainText('--os-user')
  await page.keyboard.press('Escape')
  await page.locator('#peopleBtn').click()
  await page.locator('[data-tab=machines]').click()
  await expect(page.locator('.modal')).toContainText('machine1')
})

test('a company: its activity, what it keeps, its export; deleted, and brought back', async ({ page }) => {
  await signIn(page)
  const co = await server.call('admin/createCompany', { name: 'To Delete' })
  const cookie = await server.ownerCookie()
  await fetch(`${server.url}/api/companies/join`, { method: 'POST', headers: { Cookie: cookie, Origin: server.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ company: co.id }) })
  await page.goto(`${server.url}/?company=${co.id}`)
  await page.locator('#peopleBtn').click()
  await page.locator('[data-tab=company]').click()
  const form = page.locator('[data-retention]')
  await form.locator('[name=retention_days]').fill('30')
  await form.locator('button').click()
  await expect(page.locator('[data-saved]')).toHaveText('Saved.')
  await page.locator('[data-tab=members]').click()
  await page.locator('[data-tab=company]').click()
  await expect(page.locator('.audit')).toContainText('company/retention/set')
  await expect(page.locator('[name=retention_days]')).toHaveValue('30')
  const download = page.waitForEvent('download')
  await page.locator('a[href$="/company/export"]').click()
  expect((await download).suggestedFilename()).toContain(`squadra-${co.id}-`)
  const del = page.locator('[data-delete-company]')
  await del.locator('[name=confirm]').fill('not the name')
  await del.locator('button').click()
  await expect(page.locator('.modal .err')).not.toBeEmpty()
  await del.locator('[name=confirm]').fill('To Delete')
  await del.locator('button').click()
  await expect(page).not.toHaveURL(new RegExp(co.id))
  await page.locator('#peopleBtn').click()
  await page.locator('[data-tab=companies]').click()
  await page.locator(`[data-restore="${co.id}"]`).click()
  await expect(page).toHaveURL(new RegExp(co.id))
  await expect(page.locator('#app')).toBeVisible()
})

test('a terminal: it shows the screen, and what is typed reaches the machine', async ({ page }) => {
  await signIn(page, `#/t/${machine.id}/worker1`)
  const screen = page.locator('#terminal .xterm-rows')
  await expect(screen).toContainText('screen from the machine')
  await page.locator('#terminal .xterm').click()
  await page.keyboard.type('hello')
  await expect(screen).toContainText('hello')
  expect(machine.typed.join('')).toContain('hello')
})

test('the chat: what is opened stays open when more arrives, and text being selected is not redrawn away', async ({ page }) => {
  const s = await startSession(server, 'keep1', 'worker', 'coord')
  const t0 = Date.now()
  await s.observe([
    { kind: 'tool_start', id: 'k1', tool: 'Bash', ts: t0, summary: 'kept-tool', detail: 'kept input' },
    { kind: 'tool_end', id: 'k1', tool: 'Bash', ts: t0 + 1, ok: true, detail: 'kept output' },
    { kind: 'text', text: 'selectable words here', ts: t0 + 2 },
  ])
  await signIn(page, '#/s/keep1/chat')
  const group = page.locator('#session .chat details.tools').first()
  await group.locator('summary').first().click()
  const input = group.locator('details[data-d^="i"]').first()
  await input.locator('summary').click()
  await expect(input).toHaveAttribute('open', '')
  await s.observe([{ kind: 'text', text: 'one more line', ts: Date.now() }])
  await expect(page.locator('#session .chat')).toContainText('one more line')
  await expect(page.locator('#session .chat details[data-d^="i"]').first()).toHaveAttribute('open', '')
  // Selecting: nothing is redrawn until it ends.
  await page.evaluate(() => { const p = [...document.querySelectorAll('#session .assistant')].find(x => x.textContent.includes('selectable')); getSelection().selectAllChildren(p) })
  await s.observe([{ kind: 'text', text: 'arrived while selecting', ts: Date.now() }])
  await page.waitForTimeout(400)
  expect(await page.evaluate(() => getSelection().toString())).toContain('selectable words')
  await expect(page.locator('#session .chat')).not.toContainText('arrived while selecting')
  await page.evaluate(() => getSelection().removeAllRanges())
  await expect(page.locator('#session .chat')).toContainText('arrived while selecting')
  // Left selected, it doesn't hide what arrives for ever (it waits 20 s, real ones).
  test.setTimeout(60_000)
  await page.evaluate(() => { const p = [...document.querySelectorAll('#session .assistant')].find(x => x.textContent.includes('selectable')); getSelection().selectAllChildren(p) })
  await s.observe([{ kind: 'text', text: 'arrived and left selected', ts: Date.now() }])
  await page.waitForTimeout(1000)
  await expect(page.locator('#session .chat')).not.toContainText('arrived and left selected')
  await expect(page.locator('#session .chat')).toContainText('arrived and left selected', { timeout: 25_000 })
  await expect(page.locator('#session .chat .older')).not.toContainText(/Loading/)
})

test('dialogs: Escape closes the one on top', async ({ page }) => {
  await signIn(page, `#/h/${machine.id}`)
  await page.locator('#topRight [data-hact="new"]').click()
  const dialogs = page.locator('.modal-bg')
  await expect(dialogs).toHaveCount(1)
  // The new session dialog is for the machine on screen.
  await expect(dialogs.first().locator('select').first()).toHaveValue(machine.id)
  await page.evaluate(() => { const bg = document.createElement('div'); bg.className = 'modal-bg'; bg.innerHTML = '<button data-cancel>x</button>'; bg.querySelector('button').onclick = () => bg.remove(); document.body.appendChild(bg) })
  await expect(dialogs).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(dialogs).toHaveCount(1)
})

test('the chat: a link whose host is written with % shows the real host', async ({ page }) => {
  const s = await startSession(server, 'links1', 'worker', 'coord')
  const url = 'https://github.com%2Eevil.example/x'
  await s.observe([{ kind: 'text', text: `[${url}](${url})`, ts: Date.now() }])
  await signIn(page, '#/s/links1/chat')
  await expect(page.locator('#session .chat a[href*="evil.example"] + .dim-note')).toHaveText('(github.com.evil.example)')
})

test('the chat: a tool shows its end across messages, and none runs after its turn', async ({ page }) => {
  const s = await startSession(server, 'tools1', 'worker', 'coord')
  const t0 = Date.now()
  const tool = (kind, id, ts, extra) => ({ kind, id, tool: 'Bash', ts: t0 + ts, ...extra })
  await s.observe([
    tool('tool_start', 'crossed', 0, { summary: 'crossed-tool' }),
    { kind: 'text', text: 'a message in between', ts: t0 + 1 },
    tool('tool_end', 'crossed', 2, { ok: true }),
    tool('tool_start', 'denied', 3, { summary: 'denied-tool' }),
    { kind: 'stop', ts: t0 + 4 },
    tool('tool_start', 'running', 5, { summary: 'running-tool' }),
  ])
  await signIn(page, '#/s/tools1/chat')
  const row = name => page.locator('#session .chat .tool', { hasText: name }).locator('.res')
  const groups = page.locator('#session .chat details.tools')
  for (let i = 0; i < 3; i++) await groups.nth(i).evaluate(d => { d.open = true })
  await expect(row('crossed-tool')).toHaveClass(/\bok\b/)
  await expect(row('denied-tool')).toHaveText('no result')
  await expect(row('running-tool')).toHaveClass(/\brun\b/)
  // Its end doesn't appear again on its own: one group each, nothing else running.
  await expect(groups).toHaveCount(3)
  await expect(page.locator('#session .chat .res.run')).toHaveCount(2) // the tool, and its group
})

// (Last: it adds a terminal to the machine, which the tests above count.)
test('the Chat button: from a terminal and from the machines, it opens the chat', async ({ page }) => {
  await server.call('api/terminals/open', { host: machine.id, spec: { name: 'worker2', role: 'worker', coordinator: 'coord' } })
  const chatOpens = async button => {
    await button.click()
    await expect(page).toHaveURL(/#\/s\/worker2\/chat$/)
    await expect(page.locator('#session .chat')).toBeVisible()
  }
  await signIn(page, `#/t/${machine.id}/worker2`)
  await chatOpens(page.locator('#topRight').getByRole('button', { name: 'Chat', exact: true }))
  await page.goto(`${server.url}/#/hosts`)
  await chatOpens(page.locator('#hosts .term-row', { hasText: 'worker2' }).getByRole('button', { name: 'Chat', exact: true }))
})
