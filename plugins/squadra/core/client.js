// The squadra-server client (a tiny Bot API client), and what a session keeps on
// disk to use it: its identity, its inbox, its pid file.

import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { sealMessage } from '../signing.js'
import { SERVER_URL, NAME_RE, MAX_ATTACHMENT_BYTES, SERVER_TOKEN, log, PS_BIN } from './settings.js'
import { S } from './session.js'
import { writePrivateFile } from './access.js'

export class ApiError extends Error {
  constructor(code, description, reason) {
    super(description)
    this.code = code
    this.reason = reason
  }
}

// Headers for the server: the identity secret, and this session's instance id
// (kept only in memory) — while it is connected, the server takes requests
// for this name only from this instance.
const authHeaders = (s, auth) => ({
  Authorization: `Bearer ${auth ?? s?.secret ?? ''}`,
  ...(s?.instance ? { 'X-Squadra-Instance': s.instance } : {}),
})

// A JSON answer, read with a size cap (a broken or hostile server can't make
// this process buffer gigabytes).
export async function readJson(res, max = 8 * 1024 * 1024) {
  if (Number(res.headers.get('content-length') ?? 0) > max) throw new ApiError(res.status, 'server answer too large')
  const chunks = []
  let size = 0
  for await (const c of res.body ?? []) {
    size += c.length
    if (size > max) throw new ApiError(res.status, 'server answer too large')
    chunks.push(c)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function call(method, params = {}, { signal, auth, s = S, timeoutMs = 60_000 } = {}) {
  if (s?.signingKey && (method === 'sendMessage' || method === 'editMessageText')) params = signedParams(s, method, params)
  const timeout = AbortSignal.timeout(timeoutMs)
  const res = await fetch(`${SERVER_URL}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(s, auth) },
    body: JSON.stringify(params),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'error',
  })
  let body
  try { body = await readJson(res) } catch { throw new ApiError(res.status, `HTTP ${res.status}`) }
  if (!body.ok) throw new ApiError(body.error_code ?? res.status, serverSaid(body.description ?? `HTTP ${res.status}`), body.parameters?.reason)
  return body.result
}

// Everything this session writes goes signed, whichever part of it writes it.
function signedParams(s, method, params) {
  return {
    ...params,
    squadra_sig: sealMessage(s.signingKey, {
      from: s.name, to: params.chat_id, text: params.text,
      fyi: params.squadra_fyi, report: params.squadra_report,
      editId: method === 'editMessageText' ? params.message_id : null,
    }),
  }
}

// The server's words end up in tool results: one short line, no control,
// direction or invisible characters.
const serverSaid = v => String(v ?? '').replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ').slice(0, 300)

// A session name from the server, shown only if it is one.
export const nameOrQ = v => (NAME_RE.test(String(v)) ? String(v) : '?')

export async function uploadFile(chat_id, file, { replyTo, photo } = {}) {
  const q = new URLSearchParams({ chat_id, filename: basename(file.real) })
  if (replyTo != null) q.set('reply_to_message_id', String(replyTo))
  // (Before the upload, so what a recipient downloads is what was sent.)
  if (S?.signingKey) q.set('squadra_sig', sealMessage(S.signingKey, { from: S.name, to: chat_id, text: '', file: createHash('sha256').update(file.data).digest('hex') }))
  const res = await fetch(`${SERVER_URL}/${photo ? 'sendPhoto' : 'sendDocument'}?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...authHeaders(S) },
    body: file.data,
    signal: AbortSignal.timeout(300_000),
    redirect: 'error',
  })
  const body = await readJson(res).catch(() => ({ ok: false, description: `HTTP ${res.status}` }))
  if (!body.ok) throw new ApiError(body.error_code ?? res.status, serverSaid(body.description))
  return body.result
}

// Attachments are kept for a week in the inbox, and it holds at most
// INBOX_MAX_BYTES: other sessions can't fill the disk by sending files.
const INBOX_MAX_BYTES = 1024 * 1024 * 1024
function pruneInbox(s) {
  let total = 0
  try {
    // (Only the real inbox: through a symlink put in its place, this would
    // delete someone's files.)
    const dir = lstatSync(s.inboxDir)
    if (!dir.isDirectory() || dir.isSymbolicLink()) return 0
    for (const f of readdirSync(s.inboxDir)) {
      const p = join(s.inboxDir, f)
      const st = lstatSync(p)
      if (!st.isFile() && !st.isSymbolicLink()) continue
      if (Date.now() - st.mtimeMs > 7 * 24 * 3600_000) rmSync(p, { force: true })
      else total += st.size
    }
  } catch {}
  return total
}

export async function downloadFile(file_id, s = S, signal = null) {
  const file = await call('getFile', { file_id }, { s })
  if (!file.file_path) throw new Error('server returned no file_path — file may have expired')
  const res = await fetch(`${SERVER_URL}/file/${encodeURIComponent(file.file_path)}`, {
    headers: authHeaders(s),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
    redirect: 'error',
  })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  if (Number(res.headers.get('content-length') ?? 0) > MAX_ATTACHMENT_BYTES) throw new Error('attachment too large (max 50MB)')
  const parts = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.length
    if (size > MAX_ATTACHMENT_BYTES) throw new Error('attachment too large (max 50MB)')
    parts.push(chunk)
  }
  const buf = Buffer.concat(parts)
  // Only what its sender signed.
  const want = s.fileHashes.get(file_id)
  if (want === undefined) throw new Error('this attachment arrived before Squadra restarted in this session, so it can\'t be checked: ask for it to be sent again')
  if (want !== null && createHash('sha256').update(buf).digest('hex') !== want) throw new Error('this attachment is not what its sender signed (something changed it on the way): not saved. Tell the user')
  mkdirSync(s.inboxDir, { recursive: true, mode: 0o700 })
  // Only into the real inbox folder (never through a symlink put in its place).
  const st = lstatSync(s.inboxDir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`the inbox ${s.inboxDir} is not a plain folder: not downloading into it`)
  if (pruneInbox(s) + buf.length > INBOX_MAX_BYTES) throw new Error('the inbox is full (1 GB): the user can clear it before downloading more')
  const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop() : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
  const path = join(s.inboxDir, `${Date.now()}-${uniqueId}.${ext}`)
  writeFileSync(path, buf, { mode: 0o600, flag: 'wx' })
  return path
}

// Identity: the secret is issued once by the server and stored locally.
export async function loadIdentity(s) {
  let saved = null
  try { saved = JSON.parse(readFileSync(s.identityFile, 'utf8')) } catch {}
  if (saved?.name === s.name && saved.secret) {
    // The secret only ever goes to the server it was issued by.
    if (saved.server && saved.server !== SERVER_URL) {
      throw new Error(`the identity "${s.name}" belongs to ${saved.server}, but this machine is now configured for ${SERVER_URL}. Its secret will not be sent elsewhere: log in with another name, or delete ${s.identityFile} if you really moved servers`)
    }
    if (!saved.server) {
      try { writePrivateFile(s.identityFile, JSON.stringify({ ...saved, server: SERVER_URL }, null, 2) + '\n') } catch {}
    }
    return saved.secret
  }
  if (!SERVER_TOKEN) {
    throw new Error(`there is no identity for "${s.name}" and the server token is missing: run /squadra:configure <url> <token>`)
  }
  let r
  try {
    r = await call('register', { name: s.name }, { auth: SERVER_TOKEN })
  } catch (err) {
    if (err instanceof ApiError && err.code === 409) {
      throw new ApiError(409, `the name "${s.name}" is already registered on the server (by another machine or an earlier install, or it was disconnected from the dashboard). Pick another name, or free it: delete the session in the dashboard (or open it again from there, on its machine)`)
    }
    if (err instanceof ApiError && err.code === 401) throw new ApiError(401, 'the server rejects the token: check /squadra:configure')
    throw err
  }
  mkdirSync(s.stateDir, { recursive: true, mode: 0o700 })
  writePrivateFile(s.identityFile, JSON.stringify({ name: r.name, secret: r.secret, server: SERVER_URL }, null, 2) + '\n')
  log(`registered identity "${s.name}"`)
  return r.secret
}

// If a previous session crashed (SIGKILL, terminal closed) its server.js can
// survive as an orphan and keep holding the name. Kill the previous holder of
// this name on this machine ONLY if it's orphaned (its Claude Code is gone):
// a live session keeps its name, and the server refuses the newcomer.
export function claimPidFile(s) {
  mkdirSync(s.stateDir, { recursive: true, mode: 0o700 })
  try {
    const stale = parseInt(readFileSync(s.pidFile, 'utf8'), 10)
    if (stale > 1 && stale !== process.pid) {
      process.kill(stale, 0)
      // PID files race with OS PID recycling — verify the holder is actually our
      // server.js before SIGTERM.
      const out = execFileSync(PS_BIN, ['-p', String(stale), '-o', 'ppid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      const m = out.match(/^(\d+)\s+(.*)$/s)
      if (m && m[2].includes('squadra') && m[2].includes('server.js') && isOrphan(Number(m[1]))) {
        log(`killing orphaned poller pid=${stale}`)
        process.kill(stale, 'SIGTERM')
      }
    }
  } catch {}
  writePrivateFile(s.pidFile, String(process.pid))
}

function isOrphan(ppid) {
  if (ppid <= 1) return true // reparented to init
  try { process.kill(ppid, 0); return false } catch { return true }
}

export function releasePidFile(s) {
  try {
    if (parseInt(readFileSync(s.pidFile, 'utf8'), 10) === process.pid) rmSync(s.pidFile)
  } catch {}
}
