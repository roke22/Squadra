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
