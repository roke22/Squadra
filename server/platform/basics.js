import { createHash } from 'node:crypto'

export const sha256 = s => createHash('sha256').update(s).digest('hex')
export const now = () => Date.now()
export const unix = ms => Math.floor(ms / 1000)
// A path without the slashes at its end. (A loop: a regular expression takes
// time quadratic in a run of slashes, and this runs before any check.)
export function trimSlashes(path) {
  let end = path.length
  while (end > 0 && path.charCodeAt(end - 1) === 47) end--
  return path.slice(0, end)
}
// (As it came: a URL parser takes a path starting with // for a host.)
export const pathTooLong = rawUrl => { const q = String(rawUrl ?? '').indexOf('?'); return (q < 0 ? String(rawUrl ?? '').length : q) > 2048 }
