import { now } from './basics.js'
import { ApiError } from './errors.js'

// Storage limits, so no session (or set of sessions) can fill the disk:
const STORED_BYTES_PER_HOUR = 30 * 1024 * 1024 // per identity: observation events, and message text, each
const RATE_LIMIT_PER_MIN = 120             // messages per sender per minute

const sendLog = new Map() // name -> timestamps (ms) of recent sends (messages, edits, reactions, groups)

// A sliding-window counter: at most `max` hits per `windowMs` for a key.
const windows = new Map() // bucket -> Map(key -> timestamps)
export function allow(bucket, key, max, windowMs = 60_000) {
  const t = now()
  if (!windows.has(bucket)) windows.set(bucket, new Map())
  const m = windows.get(bucket)
  const recent = (m.get(key) ?? []).filter(x => t - x < windowMs)
  if (recent.length >= max) { m.set(key, recent); return false }
  recent.push(t)
  m.set(key, recent)
  return true
}
setInterval(() => {
  const t = now()
  for (const m of windows.values()) for (const [k, v] of m) if (!v.some(x => t - x < 3600_000)) m.delete(k)
}, 10 * 60_000).unref()

// IPv6 clients are counted per /64 (one machine usually has a whole /64).
export function ipKey(ip) {
  const raw = String(ip ?? '?')
  // IPv4 (also as ::ffff:a.b.c.d) as it is; IPv6 by its /64, written out in
  // full first ("2600:3c03::1" and "2600:3c03:0:0::2" are the same network).
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw)
  if (v4) return v4[1]
  if (!raw.includes(':')) return raw
  const a = raw.replace(/%.*$/, '').toLowerCase()
  const [head, tail] = a.includes('::') ? a.split('::') : [a, null]
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = tail === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64'
}

// Reads (getMe, getChat, getFile, chat actions, polls that don't wait): a
// generous budget, so one session can't keep the server busy with them.
export function readLimit(name, bucket = 'read') {
  if (!allow(bucket, name, 600)) throw new ApiError(429, 'Too Many Requests: retry in a minute', { parameters: { retry_after: 60 } })
}

// Joining and inviting: 60 a minute per session, apart from the sending
// budget (a plugin retrying invites to names that don't exist yet must not
// keep its session from sending).
export function groupLimit(name) {
  if (!allow('group-ops', name, 60)) throw new ApiError(429, 'Too Many Requests: retry in a minute', { parameters: { retry_after: 60 } })
}
export function rateLimit(name) {
  const t = now()
  const recent = (sendLog.get(name) ?? []).filter(x => t - x < 60_000)
  if (recent.length >= RATE_LIMIT_PER_MIN) {
    const retry = Math.ceil((60_000 - (t - recent[0])) / 1000)
    throw new ApiError(429, `Too Many Requests: retry after ${retry}`, { parameters: { retry_after: retry } })
  }
  recent.push(t)
  sendLog.set(name, recent)
}

// Bytes stored per identity in the last hour, per kind (events, text).
const storedLog = new Map() // `${kind}:${name}` -> [{ t, bytes }]

// Kept per minute (at most 60 buckets per key), so checking costs the same
// however much a session sends.
export function spendStorage(kind, name, bytes, max = STORED_BYTES_PER_HOUR) {
  const t = now()
  const minute = Math.floor(t / 60_000)
  const key = `${kind}:${name}`
  const buckets = (storedLog.get(key) ?? []).filter(b => minute - b.m < 60)
  const used = buckets.reduce((s, b) => s + b.bytes, 0)
  if (used + bytes > max) throw new ApiError(429, `Too Many Requests: storage budget for this hour used up (${kind})`, { parameters: { retry_after: 600 } })
  const last = buckets[buckets.length - 1]
  if (last && last.m === minute) last.bytes += bytes
  else buckets.push({ m: minute, bytes })
  storedLog.set(key, buckets)
}

export function cleanupLimits() {
  const t = now()
  for (const [k, v] of storedLog) if (!v.some(b => Math.floor(t / 60_000) - b.m < 60)) storedLog.delete(k)
  for (const [k, v] of sendLog) if (!v.some(x => t - x < 60_000)) sendLog.delete(k)
}
