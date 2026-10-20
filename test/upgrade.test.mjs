// Upgrading a server that ran 0.0.1: it starts on the old data, and the
// one-time cleaning of what the old version stored goes through every row
// (more than one batch), also when it was interrupted halfway.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ADMIN = 'upgrade-admin-token-0123456789'
const sleep = ms => new Promise(r => setTimeout(r, ms))

let oldServerDir = null
try {
  oldServerDir = mkdtempSync(join(tmpdir(), 'squadra-old-'))
  execFileSync('sh', ['-c', `git -C "${ROOT}" archive v0.0.1 server | tar -x -C "${oldServerDir}"`], { stdio: 'ignore' })
  // (Without the tag — a shallow clone, as in CI — nothing is extracted; macOS's
  // tar doesn't fail on the empty input.)
  if (!existsSync(join(oldServerDir, 'server', 'server.js'))) oldServerDir = null
} catch { oldServerDir = null }

async function run(script, dataDir, port) {
  const proc = spawn(process.execPath, [script], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SQUADRA_SERVER_TOKEN: ADMIN },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  proc.stderr.on('data', d => { err += d })
  const exited = new Promise(r => proc.on('exit', code => r(code)))
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { proc, exited } } catch {}
    if (proc.exitCode !== null) throw new Error(`server exited ${proc.exitCode}: ${err.slice(-2000)}`)
    await sleep(50)
  }
  throw new Error(`server did not start: ${err.slice(-2000)}`)
}
const stop = async s => { s.proc.kill('SIGTERM'); await s.exited }

test('a 0.0.1 database: the new server starts and cleans every old row', { skip: !oldServerDir && 'the v0.0.1 tag is not available' }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'squadra-up-'))
  mkdirSync(dataDir, { recursive: true })
  const port = 23000 + Math.floor(Math.random() * 2000)

  // The old server creates its database.
  const old = await run(join(oldServerDir, 'server/server.js'), dataDir, port)
  for (const name of ['alice', 'bob']) {
    const r = await fetch(`http://127.0.0.1:${port}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ name }) }).then(x => x.json())
    assert.ok(r.ok, r.description)
  }
  await stop(old)

  // What 0.0.1 could leave behind: more than one batch of uncleaned rows,
  // fractional event times.
  const db = new DatabaseSync(join(dataDir, 'squadra.db'))
  const t = Date.now()
  const ev = db.prepare('INSERT INTO events (session, ts, kind, data) VALUES (?, ?, ?, ?)')
  const msg = db.prepare('INSERT INTO messages (from_name, target, text, created_at) VALUES (?, ?, ?, ?)')
  db.exec('BEGIN')
  for (let i = 0; i < 2500; i++) ev.run('alice', t - 60_000 + i + 0.5, 'text', JSON.stringify({ text: `step ${i} ‮evil` }))
  for (let i = 0; i < 1500; i++) msg.run('alice', 'bob', `hello ${i} ‮deploy`, t - 60_000 + i)
  db.exec('COMMIT')
  db.close()

  // The new server starts on it.
  const now = await run(join(ROOT, 'server/server.js'), dataDir, port)
  await stop(now)

  const after = new DatabaseSync(join(dataDir, 'squadra.db'))
  assert.equal(after.prepare("SELECT COUNT(*) AS n FROM events WHERE data LIKE '%' || char(8238) || '%'").get().n, 0, 'every event cleaned')
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM events WHERE ts != CAST(ts AS INTEGER)').get().n, 0, 'whole-millisecond times')
  assert.equal(after.prepare("SELECT COUNT(*) AS n FROM messages WHERE text LIKE '%' || char(8238) || '%'").get().n, 0, 'every message cleaned')
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2500)
  after.close()

  // And it starts again (nothing left half done).
  await stop(await run(join(ROOT, 'server/server.js'), dataDir, port))
})
