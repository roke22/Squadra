import { cutText, cleanText, now, ApiError, bad } from '../platform/index.js'

export function createObservation(platform) {
  const { db, inTx, bus, broadcast, spendStorage, quota } = platform

  const MAX_EVENTS = Number(process.env.SQUADRA_MAX_EVENTS ?? 1_000_000)       // observation events kept, in all
  const EVENT_TTL_MS = Number(process.env.OBSERVE_TTL_HOURS ?? 24) * 60 * 60 * 1000 // live-observation events

  // Each session's plugin posts what it's doing (hook events + transcript). The
  // server keeps 24h of events, derives a current state per session, and pushes
  // everything to dashboard clients as it happens.
  const EVENT_KINDS = new Set([
    'observe_start', 'session_start', 'prompt', 'tool_start', 'tool_end', 'text', 'usage',
    'notification', 'subagent_start', 'subagent_stop', 'stop', 'compact', 'compacted', 'session_end',
  ])
  const MAX_EVENT_JSON = 20_000
  const activity = new Map() // name -> derived state

  // An event as seen by the dashboard. The plugin's own "id" (tool use id or
  // subagent id) is exposed as "ref"; "id" is always the event's row id.
  // What each kind of event may carry, and of which type. Anything else is
  // dropped — the dashboard renders these fields, so nothing a session sends
  // reaches it untyped (and no event can pass itself off as a message).
  // (Cut before cleaning too: cleaning costs the whole text.)
  const STR = max => v => (typeof v === 'string' ? cutText(cleanText(v.slice(0, max * 2)), max) : undefined)
  const INT = v => (Number.isSafeInteger(v) && v >= 0 ? v : undefined)
  const PCT = v => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : undefined)
  const BOOL = v => (typeof v === 'boolean' ? v : undefined)
  const EVENT_COMMON = { cwd: STR(1000), agent: STR(100) }
  const EVENT_SCHEMA = {
    observe_start: { level: STR(20) },
    session_start: { source: STR(40), model: STR(100) },
    prompt: { text: STR(20_000), channel: BOOL },
    tool_start: { id: STR(100), tool: STR(200), summary: STR(2000), detail: STR(20_000) },
    tool_end: { id: STR(100), tool: STR(200), ok: BOOL, interrupted: BOOL, summary: STR(2000), duration_ms: INT, detail: STR(20_000) },
    text: { text: STR(20_000) },
    usage: { context_tokens: INT, model: STR(100), context_window: INT, compact_at: INT, context_pct: PCT },
    notification: { type: STR(60), text: STR(1000) },
    subagent_start: { id: STR(100) },
    subagent_stop: { id: STR(100), text: STR(20_000) },
    stop: { background_tasks: INT },
    compact: { trigger: STR(20) },
    compacted: { trigger: STR(20), summary: STR(20_000) },
    session_end: { reason: STR(100) },
  }
  function cleanEvent(kind, data) {
    const out = {}
    const schema = { ...EVENT_COMMON, ...(EVENT_SCHEMA[kind] ?? {}) }
    if (!data || typeof data !== 'object') return out
    for (const [k, check] of Object.entries(schema)) {
      if (!Object.hasOwn(data, k)) continue
      const v = check(data[k])
      if (v !== undefined) out[k] = v
    }
    return out
  }

  // (Stored events were cleaned when they came in: read back as they are,
  // never cleaned again — that would cost the whole text on every read.)
  function eventView(rowId, session, ts, kind, data, { stored = false } = {}) {
    const { id: ref, ...rest } = stored ? (data && typeof data === 'object' ? data : {}) : cleanEvent(kind, data)
    return { ...rest, ...(ref != null ? { ref } : {}), id: rowId, session, ts, kind }
  }

  function activityOf(name) {
    if (!activity.has(name)) activity.set(name, { state: 'unknown', since: null, last_event_at: null })
    return activity.get(name)
  }

  function applyEvent(name, ev) {
    const a = activityOf(name)
    const set = state => { if (a.state !== state) { a.state = state; a.since = ev.ts } }
    a.last_event_at = Math.max(a.last_event_at ?? 0, ev.ts)
    if (typeof ev.cwd === 'string') a.cwd = ev.cwd
    switch (ev.kind) {
      case 'observe_start': a.observe = ev.level; if (ev.cwd) a.cwd = ev.cwd; if (a.state === 'unknown' || a.state === 'ended') set('idle'); break
      case 'session_start':
        if (ev.cwd) a.cwd = ev.cwd
        if (ev.model) a.model = ev.model
        // (Cleared: a fresh context, its size unknown until the next response.)
        if (ev.source === 'clear') { a.context_tokens = null; a.context_pct = null; a.context_warned = false }
        set('idle')
        break
      case 'prompt': set('working'); break
      case 'tool_start':
        if (ev.agent) break // tools run by subagents: the main session is inside its Task/Agent tool
        a.tool = { id: ev.ref, name: ev.tool, summary: ev.summary, since: ev.ts }
        set('tool')
        break
      case 'tool_end':
        if (ev.agent) break
        if (!a.tool || !ev.ref || a.tool.id === ev.ref) { a.tool = null; set('working') }
        break
      // (Claude's text is read from its transcript, so the last one of a turn
      // can arrive after the turn ended: one written before that end doesn't
      // make the session "working" again.)
      case 'text': if (a.state !== 'waiting' && !(a.state === 'idle' && a.stopped_at && ev.ts <= a.stopped_at)) set('working'); break
      case 'usage':
        a.context_tokens = ev.context_tokens
        if (ev.model) a.model = ev.model
        if (ev.compact_at) { a.compact_at = ev.compact_at; a.context_window = ev.context_window; a.context_pct = ev.context_pct }
        break
      case 'notification':
        if (['permission_prompt', 'elicitation_dialog', 'agent_needs_input', 'elicitation_url_dialog'].includes(ev.type)) { a.waiting = ev.text; set('waiting') }
        else if (ev.type === 'idle_prompt') set('idle')
        break
      case 'stop': a.tool = null; a.stopped_at = ev.ts; set('idle'); break
      case 'compact': set('compacting'); break
      case 'compacted':
        // Fresh context: the size is unknown until the next model response.
        a.context_tokens = null; a.context_pct = null; a.context_warned = false
        if (a.state === 'compacting') set('working')
        break
      case 'session_end': a.tool = null; set('ended'); break
    }
    if (a.state !== 'waiting') a.waiting = null
  }

  // Per identity: at most 120 observe calls and 3000 events a minute.
  const observeLog = new Map() // name -> [{ t, n }]

  function observeBudget(name, n) {
    // And at most 30 000 events an hour per session: the events kept in all are
    // capped, and one session must not push everybody else's out.
    // (The per-minute limit first: a call it refuses doesn't use up the hour's.)
    const t = now()
    const recent = (observeLog.get(name) ?? []).filter(x => t - x.t < 60_000)
    const events = recent.reduce((sum, x) => sum + x.n, 0)
    if (recent.length >= 120 || events + n > 3000) throw new ApiError(429, 'Too Many Requests: observation rate limit', { parameters: { retry_after: 10 } })
    spendStorage('eventcount', name, n, 30_000)
    recent.push({ t, n })
    observeLog.set(name, recent)
  }

  function observe(name, p) {
    const events = Array.isArray(p.events) ? p.events : null
    if (!events || events.length > 200) throw bad('events must be an array of at most 200 items')
    observeBudget(name, events.length)
    const insert = db.prepare('INSERT INTO events (session, ts, kind, data) VALUES (?, ?, ?, ?)')
    // The whole batch is checked first, then stored at once: all of it or none
    // (a refusal halfway would store part of it and the retry would repeat it).
    const batch = []
    for (const ev of events) {
      if (!ev || typeof ev !== 'object' || !EVENT_KINDS.has(ev.kind)) continue
      // Whole milliseconds within the events' lifetime: the history cursor relies on it.
      const ts = Number.isSafeInteger(ev.ts) ? Math.max(now() - EVENT_TTL_MS, Math.min(ev.ts, now() + 5000)) : now()
      const kind = ev.kind
      const rest = cleanEvent(kind, ev)
      const data = JSON.stringify(rest)
      if (data.length > MAX_EVENT_JSON) continue
      batch.push({ ts, kind, rest, data })
    }
    // Charged on what was sent, not on what is kept: text cleaned away (it
    // cost the cleaning all the same) counts too.
    spendStorage('events', name, Math.max(batch.reduce((n, e) => n + e.data.length, 0), Math.min(JSON.stringify(events).length, 1_048_576)))
    let stored = 0
    inTx(() => { for (const { ts, kind, rest, data } of batch) {
      const info = insert.run(name, ts, kind, data)
      const view = eventView(Number(info.lastInsertRowid), name, ts, kind, rest, { stored: true })
      const before = activityOf(name)
      const wasWarned = !!before.context_warned
      applyEvent(name, view)
      contextNotices(name, view, wasWarned)
      if (kind === 'session_start' && rest.source === 'clear') bus.emit('context-cleared', name)
      broadcast('event', view)
      stored++
    } })
    if (stored) bus.emit('session-changed', name)
    return { stored }
  }

  // Tell a worker's coordinator when its context is nearly full (once per fill-up)
  // and when it compacts. Only live events, never the startup replay.
  const CONTEXT_WARN_PCT = 80
  const NOTICE_COOLDOWN_MS = Number(process.env.SQUADRA_NOTICE_COOLDOWN_MS ?? 5 * 60_000) // per worker, per kind
  function contextNotices(name, ev, wasWarned) {
    const a = activityOf(name)
    if (ev.kind === 'usage' && ev.context_pct != null && ev.context_pct >= CONTEXT_WARN_PCT && !wasWarned) {
      a.context_warned = true
      // Its own cooldown too: compaction events reset the flag.
      if (now() - (a.context_notice_at ?? 0) < NOTICE_COOLDOWN_MS) return
      a.context_notice_at = now()
      bus.emit('notice', name, `📈 ${name} has used ${ev.context_pct}% of its context; it will auto-compact soon. Avoid giving it a large new task now, or prefer a worker with more room.`)
    }
    if (ev.kind === 'compacted') {
      // At most one compaction notice every 5 minutes per worker: alternating
      // usage/compacted events must not flood the coordinator.
      if (now() - (a.compact_notice_at ?? 0) < NOTICE_COOLDOWN_MS) return
      a.compact_notice_at = now()
      bus.emit('notice', name, `🗜️ ${name} compacted its context (${ev.trigger === 'manual' ? 'manual' : 'automatic'}). Its Squadra role and the latest messages it received were restored; if its task depends on details only you know, send them to it again.`)
    }
  }

  const observationMethods = {
    observe,
  }

  function cleanupEvents() {
    const t = now()
    db.prepare('DELETE FROM events WHERE ts < ?').run(t - EVENT_TTL_MS)
    // Over the cap: the oldest go first.
    db.prepare('DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)').run(quota('max_events', MAX_EVENTS))
    for (const [k, v] of observeLog) if (!v.some(x => t - x.t < 60_000)) observeLog.delete(k)
  }

  // Rebuild each session's derived state from the stored events (last 24h).
  function restoreActivity() {
    for (const r of db.prepare('SELECT * FROM events ORDER BY id').iterate()) {
      applyEvent(r.session, eventView(r.id, r.session, r.ts, r.kind, JSON.parse(r.data), { stored: true }))
    }
  }

  return { observationMethods, cleanupEvents, restoreActivity, cleanEvent, activityOf, activity, eventView }
}
