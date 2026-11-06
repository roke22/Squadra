import { createReadStream, lstatSync, readdirSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Worker } from 'node:worker_threads'
import { createGzip } from 'node:zlib'

// A company as a .tar.gz: its database and its attachments, and what it is.
// Only those: its join token and the server's keys aren't its data.
const BLOCK = 512

function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(BLOCK)
  const octal = (value, at, length) => h.write(`${Math.floor(value).toString(8).padStart(length - 1, '0')}\0`, at, length, 'latin1')
  h.write(name, 0, 100, 'utf8')
  octal(0o600, 100, 8)
  octal(0, 108, 8)
  octal(0, 116, 8)
  octal(size, 124, 12)
  octal(mtime / 1000, 136, 12)
  h.write('        ', 148, 8, 'latin1') // (counted as spaces, until it is known)
  h.write('0', 156, 1, 'latin1')
  h.write('ustar\0' + '00', 257, 8, 'latin1')
  let sum = 0
  for (const b of h) sum += b
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
  return h
}
const padding = size => Buffer.alloc((BLOCK - size % BLOCK) % BLOCK)

async function* tarOf(entries) {
  for (const { name, path, text } of entries) {
    if (text != null) {
      const body = Buffer.from(text)
      yield tarHeader(name, body.length, Date.now())
      yield body
      yield padding(body.length)
      continue
    }
    const st = lstatSync(path)
    yield tarHeader(name, st.size, st.mtimeMs)
    // (What was read so far is what the header says: a file that changed is cut or filled.)
    let sent = 0
    for await (const chunk of createReadStream(path, { end: Math.max(0, st.size - 1), ...(st.size ? {} : { start: 0, end: -1 }) })) { sent += chunk.length; yield chunk }
    if (sent < st.size) yield Buffer.alloc(st.size - sent)
    yield padding(st.size)
  }
  yield Buffer.alloc(BLOCK * 2)
}

// The copy in a thread of its own, with its own connection: on the one that
// answers every company, nobody would get an answer until it ended.
const COPY_DATABASE = `
  const { workerData } = require('node:worker_threads')
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(workerData.file, { readOnly: true })
  db.prepare('VACUUM INTO ?').run(workerData.copy)
  db.close()`
function copyDatabase(file, copy) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(COPY_DATABASE, { eval: true, workerData: { file, copy }, execArgv: ['--no-warnings'] })
    worker.once('error', reject)
    worker.once('exit', code => (code === 0 ? resolve() : reject(new Error(`copying the database ended with ${code}`))))
    worker.unref()
  })
}

export async function streamExport(company, about, res) {
  const { dataDir } = company.platform
  const copy = join(dataDir, `export-${randomBytes(8).toString('hex')}.db`)
  try {
    await copyDatabase(join(dataDir, 'squadra.db'), copy)
    const files = []
    for (const f of readdirSync(join(dataDir, 'files'))) {
      const path = join(dataDir, 'files', f)
      if (lstatSync(path).isFile() && lstatSync(path).size) files.push({ name: `files/${f}`, path })
    }
    const date = new Date().toISOString().slice(0, 10)
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="squadra-${company.id}-${date}.tar.gz"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    const entries = [
      { name: 'company.json', text: `${JSON.stringify({ ...about, exported_at: new Date().toISOString() }, null, 2)}\n` },
      { name: 'squadra.db', path: copy },
      ...files,
    ]
    await pipeline(Readable.from(tarOf(entries)), createGzip(), res)
  } finally {
    rmSync(copy, { force: true })
  }
}

// What an export that didn't end left behind.
export function cleanExports(dir) {
  try { for (const f of readdirSync(dir)) if (/^export-[0-9a-f]{16}\.db$/.test(f)) rmSync(join(dir, f), { force: true }) } catch {}
}
