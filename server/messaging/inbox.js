import { now, cleanText, bad, ApiError } from '../platform/index.js'

// What a coordinator says is for the person: a decision only they can take, or
// something they will want to know when they are back. Squadra doesn't read it
// or know what it is about: it keeps it where they can see it, until they say.
const MAX_TEXT = 2000
const MAX_OPTION = 200
const MAX_OPTIONS = 6
const MAX_REF = 500
const MAX_KEPT = 200
const PER_HOUR = 30

export function createInbox(platform, { sessions }) {
  const { db, broadcast, allow, rateLimit, spendStorage, ensureRoom } = platform
  const { roleOf } = sessions

  const view = r => ({
    id: r.id, session: r.session, kind: r.kind, text: r.text, options: r.options ? JSON.parse(r.options) : [],
    recommended: r.recommended, ref: r.ref, created_at: r.created_at, resolved_at: r.resolved_at,
  })
  // What is open, and the last ones done.
  function list() {
    return db.prepare('SELECT * FROM inbox ORDER BY resolved_at IS NOT NULL, COALESCE(resolved_at, -id) DESC, id DESC LIMIT ?').all(MAX_KEPT).map(view)
  }

  const short = (value, max, what) => {
    const text = cleanText(String(value ?? '')).trim()
    if (text.length > max) throw bad(`${what} is too long (max ${max} chars)`)
    return text
  }

  function add(name, kind, p) {
    rateLimit(name)
    // Only who leads a squad, and has been approved to: nobody else speaks for it.
    const row = db.prepare('SELECT role, needs_approval FROM identities WHERE name = ?').get(name)
    if (roleOf(name) !== 'coordinator' || row?.needs_approval) throw new ApiError(403, 'Forbidden: only an approved coordinator writes to the user\'s inbox')
    ensureRoom()
    if (String(p.text ?? '').length > MAX_TEXT * 2) throw bad(`text is too long (max ${MAX_TEXT} chars)`)
    const text = short(p.text, MAX_TEXT, 'text')
    if (!text) throw bad('text is required')
    const options = (Array.isArray(p.options) ? p.options : []).map(o => short(o, MAX_OPTION, 'an option')).filter(Boolean)
    if (options.length > MAX_OPTIONS) throw bad(`at most ${MAX_OPTIONS} options`)
    const recommended = short(p.recommended, MAX_OPTION, 'recommended') || null
    const ref = short(p.ref, MAX_REF, 'ref') || null
    if (!allow('inbox', name, PER_HOUR, 3600_000)) throw new ApiError(429, `Too Many Requests: at most ${PER_HOUR} an hour: put together what belongs together`)
    spendStorage('text', name, text.length + options.join('').length)
    const info = db.prepare('INSERT INTO inbox (session, kind, text, options, recommended, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, kind, text, options.length ? JSON.stringify(options) : null, recommended, ref, now())
    broadcast('inbox', list())
    return { id: Number(info.lastInsertRowid) }
  }

  function resolve(id) {
    if (!Number.isSafeInteger(id)) throw bad('id is required')
    if (!db.prepare('UPDATE inbox SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(now(), id).changes) throw bad('nothing open with that id')
    broadcast('inbox', list())
    return { id, resolved: true }
  }

  function cleanupInbox() {
    db.prepare('DELETE FROM inbox WHERE resolved_at < ?').run(now() - 30 * 24 * 3600_000)
    db.prepare('DELETE FROM inbox WHERE resolved_at IS NOT NULL AND id <= (SELECT id FROM inbox WHERE resolved_at IS NOT NULL ORDER BY id DESC LIMIT 1 OFFSET ?)').run(MAX_KEPT)
  }

  const inboxMethods = {
    askUser: (name, p) => add(name, 'ask', p),
    tellUser: (name, p) => add(name, 'tell', { text: p.text, ref: p.ref }),
  }
  return { inboxMethods, list, resolve, cleanupInbox }
}
