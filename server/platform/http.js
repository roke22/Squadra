import { openSync, closeSync, rmSync, writeSync } from 'node:fs'
import { PUBLIC_URL, TRUST_PROXY, TLS, PORT, MAX_JSON_BODY } from './config.js'
import { allow } from './limits.js'
import { ApiError, bad } from './errors.js'

// The address hosts and plugins use: PUBLIC_URL, or what the browser used.
export function serverBaseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL
  const fwd = h => (TRUST_PROXY ? String(req.headers[h] ?? '').split(',')[0].trim() : '')
  let proto = fwd('x-forwarded-proto') || (TLS ? 'https' : 'http')
  if (proto !== 'http' && proto !== 'https') proto = TLS ? 'https' : 'http'
  let host = String(req.headers.host ?? '') // never X-Forwarded-Host: set PUBLIC_URL behind a proxy
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host)) host = `127.0.0.1:${PORT}`
  return `${proto}://${host}`
}

// Host side: trade the code for a permanent secret. Public, rate-limited.
// The client's address. Behind a reverse proxy every request comes from the
// proxy, so with --trust-proxy the last X-Forwarded-For entry (the one the
// proxy itself added) is used.
export function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map(x => x.trim()).filter(Boolean)
    if (xff.length) return xff[xff.length - 1].slice(0, 64)
  }
  return req.socket.remoteAddress ?? '?'
}

// A refused upgrade (or bad request) is answered and then closed for good:
// end() alone leaves the socket half open as long as the client wants.
export function refuseSocket(socket, status) {
  try { socket.end(`HTTP/1.1 ${status}\r\n\r\n`) } catch {}
  setTimeout(() => { try { socket.destroy() } catch {} }, 1000).unref()
}

export function sendJson(res, status, body) {
  if (res.writableEnded) return
  const data = JSON.stringify(body)
  // (Never cached: answers carry messages and session state.)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(data)
}

// Error lines in the log: at most 60 a minute in all (a client that keeps
// causing them can't fill the disk), and how many were left out.
let errorsDropped = 0
export function logError(text) {
  if (!allow('error-log', 'all', 60)) { errorsDropped++; return }
  if (errorsDropped) { process.stderr.write(`squadra-server: (${errorsDropped} more errors not logged)\n`); errorsDropped = 0 }
  process.stderr.write(`squadra-server: ${text}\n`)
}
export function sendError(res, err) {
  if (err instanceof ApiError) {
    sendJson(res, err.code, { ok: false, error_code: err.code, description: err.message, ...(err.extra ?? {}) })
  } else if (err instanceof RangeError || err instanceof URIError || err?.code === 'ERR_INVALID_URL' ||
    (err instanceof TypeError && /primitive value|toPrimitive/.test(err.message))) {
    // A parameter that can't even be read (nested a thousand times, an object
    // where text was expected…): the client's mistake, not worth a stack trace.
    sendJson(res, 400, { ok: false, error_code: 400, description: 'Bad Request: invalid parameters' })
  } else {
    logError(`internal error: ${err?.stack ?? err}`)
    sendJson(res, 500, { ok: false, error_code: 500, description: 'Internal Server Error' })
  }
}

// Request body, up to `max` bytes. A client that stops sending for 30 s is
// cut off (requests have no overall timeout, for long polls and uploads).
const BODY_IDLE_MS = 30_000

// Bodies are held in memory while they arrive: a whole body within a
// deadline (a minute; uploads: one per 64 KB/s, at least a minute), and
// what goes past each body's first 64 KB at most BODY_BYTES_IN_FLIGHT across
// the server, so slow senders can't pile up — while small bodies (every
// poll, every message) never wait on big ones. Requests anyone can send
// (enrollment, registration) have their own small pool and a short deadline.
const BODY_BYTES_IN_FLIGHT = 256 * 1024 * 1024
const bodyPools = {
  main: { bytes: 0, cap: BODY_BYTES_IN_FLIGHT, free: 64 * 1024 },
  // (A registration's body, at most 4 KB, never counts: enrollments can't block it.)
  public: { bytes: 0, cap: 4 * 1024 * 1024, free: 4096, deadline: 10_000 },
}

// An upload, straight to its file: the same limits as readBody (size, idle
// time, overall deadline), without holding it in memory. Returns its size.
export function readBodyToFile(req, max, path) {
  return new Promise((resolve, reject) => {
    let fd
    try { fd = openSync(path, 'wx', 0o600) } catch (err) { reject(err); return }
    let size = 0
    let done = false
    let idle = null
    const finish = ok => {
      if (done) return false
      done = true
      clearTimeout(idle); clearTimeout(deadline)
      try { closeSync(fd) } catch {}
      if (!ok) rmSync(path, { force: true })
      return true
    }
    const fail = err => { if (finish(false)) { reject(err); req.destroy() } }
    const deadline = setTimeout(() => fail(new ApiError(408, 'Request Timeout')), Math.max(60_000, Math.ceil(max / 65_536) * 1000))
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => fail(new ApiError(408, 'Request Timeout')), BODY_IDLE_MS) }
    arm()
    req.on('data', c => {
      if (done) return
      arm()
      size += c.length
      if (size > max) return fail(new ApiError(413, `Request Entity Too Large (max ${max} bytes)`))
      try { writeSync(fd, c) } catch (err) { fail(err) }
    })
    req.on('end', () => { if (finish(true)) resolve(size) })
    req.on('error', () => { if (finish(false)) reject(new ApiError(400, 'Bad Request: connection closed')) })
    req.on('close', () => { if (finish(false)) reject(new ApiError(400, 'Bad Request: connection closed')) })
  })
}
function readBody(req, max, { pool: poolName = 'main' } = {}) {
  const pool = bodyPools[poolName]
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > max) {
      reject(new ApiError(413, `Request Entity Too Large (max ${max} bytes)`))
      req.destroy()
      return
    }
    const chunks = []
    let size = 0
    let idle = null
    let done = false
    let counted = 0
    const finish = () => { if (done) return false; done = true; clearTimeout(idle); clearTimeout(deadline); pool.bytes -= counted; return true }
    const fail = err => { if (finish()) { reject(err); req.destroy() } }
    const deadline = setTimeout(() => fail(new ApiError(408, 'Request Timeout')), pool.deadline ?? Math.max(60_000, Math.ceil(max / 65_536) * 1000))
    const arm = () => {
      clearTimeout(idle)
      idle = setTimeout(() => fail(new ApiError(408, 'Request Timeout')), BODY_IDLE_MS)
    }
    arm()
    req.on('data', c => {
      if (done) return
      arm()
      size += c.length
      const count = Math.max(0, size - pool.free) - counted
      counted += count
      pool.bytes += count
      if (size > max) return fail(new ApiError(413, `Request Entity Too Large (max ${max} bytes)`))
      if (pool.bytes > pool.cap) return fail(new ApiError(503, 'Service Unavailable: the server is busy receiving other requests; retry'))
      chunks.push(c)
    })
    req.on('end', () => { if (finish()) resolve(Buffer.concat(chunks)) })
    // (A client that drops the connection mid-body is its own business, not an internal error.)
    req.on('error', () => { if (finish()) reject(new ApiError(400, 'Bad Request: connection closed')) })
    req.on('close', () => { if (finish()) reject(new ApiError(400, 'Bad Request: connection closed')) })
  })
}

// A session's requests still sending their body: at most 8 at a time. While
// a session holds the name, requests without its session id (a copy of the
// secret) have their own 2, so they can never use up the holder's.
export const bodiesInFlight = new Map()

// Request parameters: query string plus a JSON object body. A plain object
// with no prototype, and only the body's own keys: "__proto__" and friends
// can't make a parameter appear that wasn't sent.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
export async function readParams(req, url, max = MAX_JSON_BODY, opts) {
  const params = Object.create(null)
  for (const [k, v] of url.searchParams) if (!RESERVED_KEYS.has(k)) params[k] = v
  if (req.method === 'POST') {
    const buf = await readBody(req, max, opts)
    if (buf.length) {
      let body
      try { body = JSON.parse(buf.toString('utf8')) } catch { throw bad('body is not valid JSON') }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be a JSON object')
      for (const k of Object.keys(body)) if (!RESERVED_KEYS.has(k)) params[k] = body[k]
    }
  }
  return params
}

export const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined)

export function bearer(req) {
  const h = req.headers.authorization ?? ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

// Every request: at most 32 answers waiting on one connection (requests
// piled up without reading the answers), and a connection whose request
// body never finishes arriving is closed shortly after it was answered
// (an early refusal doesn't read it; trickled bytes would keep it open).
const inFlightBySocket = new WeakMap()
export function guardRequest(req, res) {
  const sock = req.socket
  const n = (inFlightBySocket.get(sock) ?? 0) + 1
  inFlightBySocket.set(sock, n)
  res.once('close', () => inFlightBySocket.set(sock, (inFlightBySocket.get(sock) ?? 1) - 1))
  if (n > 32) { sock.destroy(); return false }
  res.once('finish', () => {
    if (req.complete) return
    const t = setTimeout(() => { if (!req.complete) sock.destroy() }, 2000)
    t.unref?.()
    req.once('end', () => clearTimeout(t))
  })
  return true
}
