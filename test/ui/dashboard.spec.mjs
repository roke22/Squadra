// The dashboard's main paths, in a browser. Selectors use what the page gives
// each thing (ids, data attributes, session names), not its layout: moving code
// around must not change these tests.

import { test as base, expect } from '@playwright/test'
import { SERVER_TOKEN, startMachine, startServer, startSession } from './harness.mjs'

// Any error in the page fails the test, a script the Content-Security-Policy
// blocked included. (A wrong token is answered with a 401, which the browser
// reports too.)
const test = base.extend({
  page: async ({ page }, use) => {
    const errors = []
    page.on('pageerror', err => errors.push(err.message))
    page.on('console', m => { if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(m.text()) })
    await use(page)
    expect(errors).toEqual([])
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
  await page.goto(`${server.url}/${hash}`)
  await page.locator('#tokenInput').fill(SERVER_TOKEN)
  await page.locator('#loginBtn').click()
  await expect(page.locator('#app')).toBeVisible()
}

test('signing in: a wrong token is refused, the right one stays until signing out', async ({ page }) => {
  await page.goto(server.url)
  await page.locator('#tokenInput').fill('not-the-token')
  await page.locator('#loginBtn').click()
  await expect(page.locator('#loginErr')).toHaveText('Wrong token.')
  await expect(page.locator('#app')).toBeHidden()

  await page.locator('#tokenInput').fill(SERVER_TOKEN)
  await page.locator('#loginBtn').click()
  await expect(page.locator('#app')).toBeVisible()

  await page.reload()
  await expect(page.locator('#app')).toBeVisible()

  await page.locator('#logoutBtn').click()
  await expect(page.locator('#login')).toBeVisible()
  await page.reload()
  await expect(page.locator('#login')).toBeVisible()
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

test('adding a machine: the dialog gives a command to run', async ({ page }) => {
  await signIn(page, '#/hosts')
  await page.locator('#addHostBtn').click()
  await expect(page.locator('.modal-bg')).toBeVisible()
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

test('the chat: a link whose host is written with % shows the real host', async ({ page }) => {
  const s = await startSession(server, 'links1', 'worker', 'coord')
  const url = 'https://github.com%2Eevil.example/x'
  await s.observe([{ kind: 'text', text: `[${url}](${url})`, ts: Date.now() }])
  await signIn(page, '#/s/links1/chat')
  await expect(page.locator('#session .chat a[href*="evil.example"] + .more')).toHaveText('(github.com.evil.example)')
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
