// What the dashboard's tests run against: a real server, sessions that keep
// polling it as a plugin does, and a machine that answers like squadra-host.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))

export const SERVER_TOKEN = 'dashboard-test-server-token'

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer()
  s.on('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

export async function startServer() {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const dataDir = mkdtempSync(join(tmpdir(), 'squadra-ui-'))
  let log = ''
  const proc = spawn(process.execPath, [join(ROOT, 'server/server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SQUADRA_SERVER_TOKEN: SERVER_TOKEN },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  proc.stderr.on('data', d => { log += d })
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/health`)).ok) break } catch {}
    if (i > 200) throw new Error(`the server did not start:\n${log}`)
    await sleep(50)
  }
  const closers = []
  return {
    url,
    async call(path, params = {}, { auth = SERVER_TOKEN, instance } = {}) {
      const res = await fetch(`${url}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}`, ...(instance ? { 'X-Squadra-Instance': instance } : {}) },
        body: JSON.stringify(params),
      })
      const body = await res.json()
      if (!body.ok) throw new Error(`${path}: ${body.description}`)
      return body.result
    },
    onClose(fn) { closers.push(fn) },
    async stop() {
      for (const fn of closers) await fn()
      proc.kill('SIGTERM')
      await new Promise(r => proc.once('exit', r))
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

// A session as a plugin keeps it: logged in, long polling.
export async function startSession(server, name, role, coordinator) {
  const { secret } = await server.call('register', { name })
  const instance = `inst-${name}-0001`
  const opts = { auth: secret, instance }
  await server.call('claimSession', { instance, role, coordinator }, opts)
  let stopped = false
  const stop = new AbortController()
  const polling = (async () => {
    let offset = 0
    while (!stopped) {
      try {
        const res = await fetch(`${server.url}/getUpdates`, {
          method: 'POST',
          signal: stop.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, 'X-Squadra-Instance': instance },
          body: JSON.stringify({ instance, offset, timeout: 5 }),
        })
        const { result } = await res.json()
        for (const u of result ?? []) offset = u.update_id + 1
      } catch { if (!stopped) await sleep(100) }
    }
  })()
  server.onClose(async () => { stopped = true; stop.abort(); await polling })
  return { name, send: (to, text) => server.call('sendMessage', { chat_id: to, text }, opts) }
}

// A machine that shows one terminal, and answers what is typed in it the way
// a program in a terminal would: by writing it back.
export async function startMachine(server, name, terminal) {
  const { code } = await server.call('api/hosts/enroll', { name })
  const { id, secret } = await server.call('host/enroll', { code, info: { hostname: name } })
  const typed = []
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/host/connect`, ['squadra', `auth.${secret}`])
  const send = m => ws.send(JSON.stringify(m))
  const b64 = text => Buffer.from(text).toString('base64')
  await new Promise((resolve, reject) => {
    ws.onerror = () => reject(new Error('the machine could not connect'))
    ws.onopen = () => {
      send({ t: 'hello', info: {
        hostname: name, platform: 'linux', arch: 'x64', version: '0.0.7', folders: ['/srv/squad'], allow_input: true, max_sessions: 8,
        terminals: [{ id: terminal.id, role: terminal.role, coordinator: terminal.coordinator, folder: '/srv/squad', created_at: Date.now() }],
      } })
    }
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.t === 'welcome') resolve()
      if (m.t === 'attach') send({ t: 'screen', term: m.term, data: b64('screen from the machine\r\n'), cols: m.cols, rows: m.rows })
      if (m.t === 'in') { typed.push(m.data); send({ t: 'out', term: m.term, data: b64(m.data) }) }
    }
  })
  server.onClose(() => ws.close())
  return { id, typed }
}
