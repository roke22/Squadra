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
const EDITS_PER_HOUR = 60
const MAX_ANSWER = 2000

// Lines that start "1) …", "2. …": a list. Without options, a question like
// that is several decisions in one, or one whose choices aren't in options.
const NUMBERED_RE = /^\s*\d{1,2}\s*[.)]\s+\S/gm

export function createInbox(platform, { sessions }) {
  const { db, broadcast, allow, rateLimit, spendStorage, ensureRoom } = platform
  const { roleOf } = sessions

  const view = r => ({
    id: r.id, session: r.session, kind: r.kind, text: r.text, options: r.options ? JSON.parse(r.options) : [],
    recommended: r.recommended, ref: r.ref, created_at: r.created_at, resolved_at: r.resolved_at,
    version: r.version, updated_at: r.updated_at, answer: r.answer, answered_by: r.answered_by, closed_reason: r.closed_reason,
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

  // Only who leads a squad, and has been approved to: nobody else speaks for it.
  function checkWriter(name) {
    const row = db.prepare('SELECT role, needs_approval FROM identities WHERE name = ?').get(name)
    if (roleOf(name) !== 'coordinator' || row?.needs_approval) throw new ApiError(403, 'Forbidden: only an approved coordinator writes to the user\'s inbox')
  }

  // What a question says, checked the same way when it is written and changed.
  function fields(p, kind) {
    if (String(p.text ?? '').length > MAX_TEXT * 2) throw bad(`text is too long (max ${MAX_TEXT} chars)`)
    const text = short(p.text, MAX_TEXT, 'text')
    if (!text) throw bad('text is required')
    const options = kind === 'ask' ? (Array.isArray(p.options) ? p.options : []).map(o => short(o, MAX_OPTION, 'an option')).filter(Boolean) : []
    if (options.length > MAX_OPTIONS) throw bad(`at most ${MAX_OPTIONS} options`)
    const numbered = text.match(NUMBERED_RE)?.length ?? 0
    if (kind === 'ask' && !options.length && numbered >= 2) {
      throw bad(`NOT SAVED: this reads like ${numbered} decisions in one (a numbered list). Ask once per decision, each with its own options and recommended, so the user can answer each on its own; put two together only when the answer to one changes the other. If they are the choices of a single decision, put them in options.`)
    }
    const recommended = kind === 'ask' ? short(p.recommended, MAX_OPTION, 'recommended') || null : null
    const ref = short(p.ref, MAX_REF, 'ref') || null
    return { text, options, recommended, ref }
  }

  function add(name, kind, p) {
    rateLimit(name)
    checkWriter(name)
    ensureRoom()
    const f = fields(p, kind)
    if (!allow('inbox', name, PER_HOUR, 3600_000)) throw new ApiError(429, `Too Many Requests: at most ${PER_HOUR} an hour`)
    spendStorage('text', name, f.text.length + f.options.join('').length)
    const info = db.prepare('INSERT INTO inbox (session, kind, text, options, recommended, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, kind, f.text, f.options.length ? JSON.stringify(f.options) : null, f.recommended, f.ref, now())
    broadcast('inbox', list())
    return { id: Number(info.lastInsertRowid) }
  }

  // Its coordinator learned something that changes it: the user should never
  // decide on what it no longer thinks. Or it no longer applies: closed, with why.
  function edit(name, p) {
    rateLimit(name)
    checkWriter(name)
    const id = Number(p.id)
    const row = Number.isSafeInteger(id) ? db.prepare('SELECT * FROM inbox WHERE id = ? AND session = ?').get(id, name) : null
    if (!row) throw bad(`nothing of yours in the user's inbox with id ${p.id}`)
    if (row.resolved_at) throw bad(`#${id} is no longer open (${row.answer != null ? 'the user answered it' : 'it was closed'}): if you still need something, ask again`)
    if (!allow('inbox-edit', name, EDITS_PER_HOUR, 3600_000)) throw new ApiError(429, `Too Many Requests: at most ${EDITS_PER_HOUR} changes an hour`)
    if (p.close != null) {
      const reason = short(p.close, MAX_OPTION, 'close')
      if (!reason) throw bad('close needs the reason it no longer applies')
      db.prepare('UPDATE inbox SET resolved_at = ?, closed_reason = ? WHERE id = ?').run(now(), reason, id)
      broadcast('inbox', list())
      return { id, closed: true }
    }
    const old = view(row)
    const f = fields({
      text: p.text ?? old.text,
      options: p.options ?? old.options,
      recommended: p.recommended ?? old.recommended,
      ref: p.ref ?? old.ref,
    }, row.kind)
    spendStorage('text', name, f.text.length + f.options.join('').length)
    db.prepare('UPDATE inbox SET text = ?, options = ?, recommended = ?, ref = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(f.text, f.options.length ? JSON.stringify(f.options) : null, f.recommended, f.ref, now(), id)
    broadcast('inbox', list())
    return { id, version: row.version + 1 }
  }

  function resolve(id) {
    if (!Number.isSafeInteger(id)) throw bad('id is required')
    if (!db.prepare('UPDATE inbox SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(now(), id).changes) throw bad('nothing open with that id')
    broadcast('inbox', list())
    return { id, resolved: true }
  }

  // The user answers a question from the dashboard, as they read it: if its
  // coordinator changed it since, they read it again first. Taken before it is
  // typed in the coordinator's terminal (nothing changes it meanwhile), and
  // given back if that fails.
  function takeAnswer(p, by) {
    const id = Number(p.id)
    const row = Number.isSafeInteger(id) ? db.prepare('SELECT * FROM inbox WHERE id = ?').get(id) : null
    if (!row || row.kind !== 'ask') throw bad('no question with that id')
    if (row.resolved_at) throw new ApiError(409, 'Conflict: it is no longer open', { parameters: { reason: 'closed' } })
    if (Number(p.version) !== row.version) throw new ApiError(409, 'Conflict: its coordinator changed it after you read it: read it again before answering', { parameters: { reason: 'changed', version: row.version } })
    const answer = short(p.answer, MAX_ANSWER, 'the answer')
    if (!answer) throw bad('the answer is empty')
    if (!db.prepare('UPDATE inbox SET resolved_at = ?, answer = ?, answered_by = ? WHERE id = ? AND resolved_at IS NULL AND version = ?').run(now(), answer, by, id, row.version).changes) {
      throw new ApiError(409, 'Conflict: it changed while answering: read it again', { parameters: { reason: 'changed' } })
    }
    broadcast('inbox', list())
    return { id, session: row.session, text: row.text, answer }
  }
  function giveBack(id) {
    db.prepare('UPDATE inbox SET resolved_at = NULL, answer = NULL, answered_by = NULL WHERE id = ?').run(id)
    broadcast('inbox', list())
  }

  function cleanupInbox() {
    db.prepare('DELETE FROM inbox WHERE resolved_at < ?').run(now() - 30 * 24 * 3600_000)
    db.prepare('DELETE FROM inbox WHERE resolved_at IS NOT NULL AND id <= (SELECT id FROM inbox WHERE resolved_at IS NOT NULL ORDER BY id DESC LIMIT 1 OFFSET ?)').run(MAX_KEPT)
  }

  const inboxMethods = {
    askUser: (name, p) => add(name, 'ask', p),
    tellUser: (name, p) => add(name, 'tell', { text: p.text, ref: p.ref }),
    editInbox: (name, p) => edit(name, p),
  }
  return { inboxMethods, list, resolve, takeAnswer, giveBack, cleanupInbox }
}
