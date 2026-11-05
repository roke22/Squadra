import { statSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { TLS, PUBLIC_URL } from './config.js'

// Public files (the page, xterm.js, squadra-host) are read once and kept:
// every answer shares the same bytes, so requests piled up on a connection
// that doesn't read can't make the server copy a file for each. Read again
// only when the file changes on disk.
const fileCache = new Map() // path -> { body, mtimeMs, size, ...extra }
export function cachedFile(file, extra = () => ({})) {
  let st
  try { st = statSync(file) } catch { return null }
  if (!st.isFile()) return null
  const key = String(file)
  const c = fileCache.get(key)
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c
  const body = readFileSync(file)
  const entry = { body, mtimeMs: st.mtimeMs, size: st.size, ...extra(body) }
  fileCache.set(key, entry)
  return entry
}

// The dashboard page: a strict Content-Security-Policy (only its own inline
// script, by hash, and scripts from this server), and no framing.
export function pageHeaders(html) {
  const text = html.toString('utf8')
  const hashes = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`)
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src 'self' ${hashes.join(' ')}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin', // a page that opened the dashboard can't steer it
    // (Also behind a TLS proxy, which doesn't add it by itself. A browser
    // ignores this header over plain http, so a local visit isn't affected.)
    ...(TLS || PUBLIC_URL.startsWith('https://') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  }
}
