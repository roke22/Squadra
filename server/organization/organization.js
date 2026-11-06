import { bad, unix, now, cleanText, oneLine } from '../platform/index.js'

export function createOrganization(platform, { sessions, messaging, observation, machines }) {
  const { db, broadcast, inTx, bus, readLimit, log } = platform
  const {
    roleOf, isOnline, presenceOf, personaView, NAME_RE, linkKey, linked, linksOf, identityExists,
  } = sessions
  const { related } = messaging
  const { activity } = observation
  const { PERSONA_ID_RE, hostRow, hostLinks, askHost } = machines

  const organizationMethods = {
    // A coordinator's own squad, as the user described it in the dashboard:
    // its name and goal, and what the coordinator itself is for. Nothing for
    // workers: their coordinator gives them the context each task needs.
    // (With how many of its workers are connected: with none, it does its
    // squad's work itself.)
    squadBrief(name) {
      readLimit(name, 'brief')
      if (roleOf(name) !== 'coordinator') return null
      const sq = squadInfo(name)
      const description = db.prepare('SELECT description FROM identities WHERE name = ?').get(name)?.description || null
      const workers = db.prepare("SELECT name FROM identities WHERE role = 'worker' AND coordinator = ?").all(name).filter(r => isOnline(r.name)).length
      return { title: sq?.title ?? null, goal: sq?.goal ?? null, description, workers_online: workers }
    },

    // A session sees who exists (and when it was registered, for the
    // coordinator pin), but presence, queue and context only of sessions it
    // talks to: messages both ways, or a group they share.
    getChat(name, p) {
      readLimit(name, 'chat') // its own budget: other reads can't use it up
      const id = String(p.chat_id ?? '')
      if (id.startsWith('#')) {
        const members = db.prepare('SELECT name FROM group_members WHERE group_id = ?').all(id).map(r => r.name)
        if (!members.includes(name)) throw bad('chat not found')
        return { id, type: 'group', title: id, members }
      }
      const ident = db.prepare('SELECT created_at, epoch FROM identities WHERE name = ?').get(id)
      if (!ident) throw bad('chat not found')
      // Writing to a session isn't enough (anyone can): it has to have written back.
      // (Only messages since both current identities exist: a name deleted and
      // registered again starts with no relations.)
      if (!related(name, id)) return { id, type: 'private', username: id, created_at: unix(ident.created_at), squadra_identity: ident.epoch, presence_hidden: true }
      const a = activity.get(id)
      return {
        id, type: 'private', username: id, created_at: unix(ident.created_at), squadra_identity: ident.epoch, ...presenceOf(id),
        context: a?.context_pct != null ? { pct: a.context_pct, tokens: a.context_tokens, compact_at: a.compact_at } : null,
        persona: personaView(id),
        // What the dashboard says it is for, and of its squad when it leads
        // one: for coordinators only (workers get their context from theirs).
        ...(roleOf(name) === 'coordinator' ? {
          // (Busy or free: whether to give it work now.)
          state: ['idle', 'working', 'tool', 'waiting', 'compacting', 'ended'].includes(a?.state) ? a.state : null,
          description: db.prepare('SELECT description FROM identities WHERE name = ?').get(id)?.description || null,
          squad: roleOf(id) === 'coordinator' ? squadInfo(id) : null,
        } : {}),
      }
    },
  }

  // Squad templates: a coordinator and its workers (name, folder, persona,
  // compact window each), saved to open them all again in one go. Only what
  // the dashboard asks a machine for anyway, one session at a time: each
  // machine still checks every session against its own rules.
  const TEMPLATE_NAME_RE = /^[\p{L}\p{N} ._-]{1,40}$/u
  const TEMPLATES_MAX = 50
  function templateMember(m, role) {
    if (!m || typeof m !== 'object') throw bad('each member of a template needs a name and a folder')
    const name = String(m.name ?? '')
    if (!NAME_RE.test(name)) throw bad(`invalid session name "${cleanText(name.slice(0, 40))}" in the template`)
    const folder = typeof m.folder === 'string' ? m.folder.trim() : ''
    if (!folder.startsWith('/') || folder.length > 4096 || /[\x00-\x1f\x7f]/.test(folder)) throw bad(`"${name}" needs an absolute folder`)
    const persona = m.persona == null || m.persona === '' ? null : String(m.persona)
    if (persona && !PERSONA_ID_RE.test(persona)) throw bad(`invalid persona for "${name}"`)
    const compact = m.compact_window == null || m.compact_window === '' ? null : Number(m.compact_window)
    if (compact !== null && !(Number.isInteger(compact) && compact >= 50_000 && compact <= 1_000_000)) throw bad(`invalid compact window for "${name}"`)
    return { name, role, folder, persona, compact_window: compact }
  }
  function saveTemplate(p) {
    const name = String(p.name ?? '').trim()
    if (!TEMPLATE_NAME_RE.test(name)) throw bad('the template name may have letters, digits, spaces, dots, dashes and underscores (max 40)')
    const host = p.host == null || p.host === '' ? null : String(p.host)
    if (host && !hostRow(host)) throw bad('host not found')
    const coordinator = templateMember(p.coordinator, 'coordinator')
    const workers = (Array.isArray(p.workers) ? p.workers : []).map(w => templateMember(w, 'worker'))
    if (workers.length > 30) throw bad('a template has at most 30 workers')
    const names = [coordinator.name, ...workers.map(w => w.name)]
    if (new Set(names).size !== names.length) throw bad('every session in a template needs its own name')
    const exists = db.prepare('SELECT 1 FROM squad_templates WHERE name = ?').get(name)
    if (!exists && db.prepare('SELECT COUNT(*) AS n FROM squad_templates').get().n >= TEMPLATES_MAX) throw bad(`at most ${TEMPLATES_MAX} templates`)
    const spec = { host, coordinator, workers }
    db.prepare('INSERT INTO squad_templates (name, spec, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET spec = excluded.spec').run(name, JSON.stringify(spec), now())
    broadcast('templates', listTemplates())
    return { name, ...spec }
  }
  function deleteTemplate(name) {
    if (!db.prepare('DELETE FROM squad_templates WHERE name = ?').run(name).changes) throw bad('template not found')
    broadcast('templates', listTemplates())
    return { name, deleted: true }
  }
  function listTemplates() {
    return db.prepare('SELECT name, spec, created_at FROM squad_templates ORDER BY name').all().map(r => {
      let spec = {}
      try { spec = JSON.parse(r.spec) } catch {}
      return { name: r.name, created_at: r.created_at, host: spec.host ?? null, coordinator: spec.coordinator ?? null, workers: Array.isArray(spec.workers) ? spec.workers : [] }
    })
  }

  // Links between squads: two coordinators that may message each other. Set
  // here; each coordinator's machine is told (its plugin lets the other one in
  // while the session runs) and checks it against its own rules.
  const LINKS_MAX = 100
  const LINKS_PER_COORDINATOR = 20
  const isCoordinator = name => {
    const r = db.prepare('SELECT role, opened_role FROM identities WHERE name = ?').get(name)
    return !!r && (r.role === 'coordinator' || (r.role == null && r.opened_role === 'coordinator'))
  }
  function listLinks() {
    // (With when they last wrote to each other, within the hour: the org chart
    // shows how busy each link is, next to the cap.)
    const since = now() - 3600_000
    const recent = db.prepare('SELECT created_at FROM messages WHERE ((from_name = ? AND target = ?) OR (from_name = ? AND target = ?)) AND system = 0 AND auto = 0 AND created_at >= ? ORDER BY created_at DESC LIMIT 100')
    return db.prepare('SELECT a, b, created_at FROM squad_links ORDER BY a, b').all()
      .map(l => ({ ...l, recent: recent.all(l.a, l.b, l.b, l.a, since).map(r => r.created_at) }))
  }
  async function changeLink(p, add) {
    const x = String(p.a ?? ''), y = String(p.b ?? '')
    if (!NAME_RE.test(x) || !NAME_RE.test(y)) throw bad('two session names are needed')
    if (x === y) throw bad('a coordinator is not linked with itself')
    const [a, b] = linkKey(x, y)
    if (add) {
      for (const n of [a, b]) if (!isCoordinator(n)) throw bad(`"${n}" is not a coordinator`)
      if (linked(a, b)) throw bad(`"${a}" and "${b}" are already linked`)
      if (db.prepare('SELECT COUNT(*) AS n FROM squad_links').get().n >= LINKS_MAX) throw bad(`at most ${LINKS_MAX} links`)
      for (const n of [a, b]) if (linksOf(n).length >= LINKS_PER_COORDINATOR) throw bad(`"${n}" already has ${LINKS_PER_COORDINATOR} links`)
      db.prepare('INSERT INTO squad_links (a, b, created_at) VALUES (?, ?, ?)').run(a, b, now())
    } else if (!db.prepare('DELETE FROM squad_links WHERE a = ? AND b = ?').run(a, b).changes) {
      throw bad('those two are not linked')
    }
    broadcast('links', listLinks())
    log(`${add ? 'linked' : 'unlinked'} coordinators "${a}" and "${b}"`)
    // (A machine that refuses, or isn't connected: said, the link stays.)
    const warnings = (await Promise.all([a, b].map(pushLinks))).filter(Boolean)
    return { a, b, linked: add, warnings }
  }

  // Tell the machine running this coordinator what it is linked with now.
  // Returns a warning, or null.
  bus.on('machine-listed', (hostId, info) => {
    for (const t of info?.terminals ?? []) if (t.role === 'coordinator') void pushLinks(t.id)
  })
  async function pushLinks(name) {
    const host = db.prepare('SELECT host_id FROM identities WHERE name = ?').get(name)?.host_id
    if (!host) return null
    // (Only the plugin enforces links: until its machine hears, the old ones hold.)
    if (!hostLinks.get(host)?.info?.terminals?.some(t => t.id === name)) return `${name}: its machine isn't connected or isn't running it: it will be told when it connects`
    try {
      await askHost(host, { t: 'links', name, coordinators: linksOf(name) })
      return null
    } catch (err) {
      return `${name}: ${err.message.replace(/^Bad Request: /, '')}`
    }
  }

  // The org chart: each squad's title and goal, where its card is, and what
  // each session is for. Written in the dashboard; a coordinator sees the goal
  // of the squads it is linked with (getChat), as data.
  const SQUAD_POS_MAX = 20_000
  function listSquads() {
    return db.prepare('SELECT coordinator, title, goal, x, y FROM squads ORDER BY coordinator').all()
      .map(r => ({ coordinator: r.coordinator, title: r.title || null, goal: r.goal || null, x: r.x, y: r.y }))
  }
  function squadInfo(coordinator) {
    const r = db.prepare('SELECT title, goal FROM squads WHERE coordinator = ?').get(coordinator)
    return r && (r.title || r.goal) ? { title: r.title || null, goal: r.goal || null } : null
  }
  function describeSquad(p) {
    const coordinator = String(p.coordinator ?? '')
    if (!NAME_RE.test(coordinator) || !isCoordinator(coordinator)) throw bad(`"${cleanText(coordinator.slice(0, 40))}" is not a coordinator`)
    const title = oneLine(p.title, 40), goal = oneLine(p.goal, 300)
    db.prepare(`INSERT INTO squads (coordinator, title, goal, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(coordinator) DO UPDATE SET title = excluded.title, goal = excluded.goal, updated_at = excluded.updated_at`).run(coordinator, title || null, goal || null, now())
    broadcast('squads', listSquads())
    return { coordinator, title: title || null, goal: goal || null }
  }
  function placeSquads(p) {
    const list = Array.isArray(p.positions) ? p.positions : null
    if (!list || !list.length || list.length > 200) throw bad('positions: a list of 1 to 200 {coordinator, x, y}')
    const clamp = v => Math.round(Math.min(SQUAD_POS_MAX, Math.max(0, v)))
    const rows = list.map(q => {
      const coordinator = String(q?.coordinator ?? '')
      if (!NAME_RE.test(coordinator) || !isCoordinator(coordinator)) throw bad(`"${cleanText(coordinator.slice(0, 40))}" is not a coordinator`)
      if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) throw bad('x and y must be numbers')
      return [coordinator, clamp(q.x), clamp(q.y)]
    })
    inTx(() => {
      for (const [c, x, y] of rows) {
        db.prepare(`INSERT INTO squads (coordinator, x, y, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(coordinator) DO UPDATE SET x = excluded.x, y = excluded.y, updated_at = excluded.updated_at`).run(c, x, y, now())
      }
    })
    broadcast('squads', listSquads())
    return { placed: rows.length }
  }
  function describeSession(p) {
    const name = String(p.name ?? '')
    if (!NAME_RE.test(name) || !identityExists(name)) throw bad('session not found')
    const description = oneLine(p.description, 300)
    db.prepare('UPDATE identities SET description = ? WHERE name = ?').run(description || null, name)
    bus.emit('session-changed', name)
    return { name, description: description || null }
  }

  return {
    organizationMethods, listTemplates, listLinks, listSquads, pushLinks, saveTemplate, deleteTemplate,
    changeLink, describeSquad, placeSquads, describeSession,
  }
}
