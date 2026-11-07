import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { unix, now, guarded, bad, ApiError, VERSION, ROLES } from '../platform/index.js'

export function createDashboard(platform, { sessions, observation, machines, messaging, inbox, organization }) {
  const { rotateJoinToken, db, bus, broadcast, sseClients, truncateLog, dataDir, log, every } = platform
  const {
    register, approveSession, presenceOf, personaView, identityCreatedAt, identityExists, isOnline, linksOf,
    forgetSession, leases, kickHolder, announceDown, dropLease,
  } = sessions
  const { activityOf, eventView, activity } = observation
  const {
    PERSONA_ID_RE, listHosts, createEnrollment, renameHost, removeHost, changeHostFolders, hostPersonas,
    openTerminalOn, killTerminalOn, newTerminalTicket, typeAnswer,
  } = machines
  const { messageView, closeGroup, handOverGroup, fileRow } = messaging
  const {
    listTemplates, listLinks, listSquads, pushLinks, saveTemplate, deleteTemplate, changeLink, describeSquad,
    placeSquads, describeSession,
  } = organization

  const adminMethods = {
    register(p) {
      return register(p.name, p.reset === true)
    },
    rotateJoinToken: () => rotateJoinToken(),
    approveSession: p => approveSession(String(p.name ?? '')),
    listIdentities() {
      return db.prepare('SELECT name, created_at, last_seen_at FROM identities ORDER BY name').all()
        .map(r => ({ name: r.name, created_at: unix(r.created_at), ...presenceOf(r.name) }))
    },
    deleteIdentity(p) {
      return deleteSession(String(p.name ?? ''))
    },
    listGroups() {
      return allGroups()
    },
  }

  bus.on('session-changed', name => broadcast('session', sessionView(name)))

  function sessionView(name) {
    const row = db.prepare('SELECT name, role, coordinator, created_at, archived_at, cleared_at, host_id, opened_role, opened_persona, description, needs_approval FROM identities WHERE name = ?').get(name)
    if (!row) return { name, deleted: true }
    const a = activityOf(name)
    return {
      name,
      role: row.role ?? null,
      coordinator: row.coordinator ?? null,
      persona: personaView(name),
      archived_at: row.archived_at ?? null,
      cleared_at: row.cleared_at ?? null,
      host_id: row.host_id ?? null, // the machine that opened it from the dashboard
      opened_role: row.host_id && ['coordinator', 'worker', 'solo'].includes(row.opened_role) ? row.opened_role : null, // and as what
      opened_persona: row.host_id && PERSONA_ID_RE.test(String(row.opened_persona ?? '')) ? row.opened_persona : null, // and with which persona
      description: row.description || null, // what it is for (org chart)
      // Acts as a coordinator (or some worker expects it to) and nobody approved it yet.
      approval_pending: !!row.needs_approval && (row.role === 'coordinator' || !!db.prepare('SELECT 1 FROM identities WHERE coordinator = ?').get(name)),
      ...presenceOf(name),
      activity: { ...a, tool: a.tool ? { ...a.tool } : null },
    }
  }

  // Every group with its members, in one query.
  function allGroups() {
    const byId = new Map(db.prepare('SELECT id FROM groups ORDER BY id').all().map(g => [g.id, { id: g.id, members: [] }]))
    for (const r of db.prepare('SELECT group_id, name FROM group_members').all()) byId.get(r.group_id)?.members.push(r.name)
    return [...byId.values()]
  }

  // Presence and role changes don't come with events: watch them.
  const lastSessionKey = new Map()
  every(2000, guarded(() => {
    if (sseClients.size === 0) return
    for (const { name } of db.prepare('SELECT name FROM identities').all()) {
      const v = sessionView(name)
      const key = `${v.online}|${v.role}|${v.coordinator}|${v.pending_updates}|${v.archived_at}`
      if (lastSessionKey.get(name) !== key) {
        lastSessionKey.set(name, key)
        broadcast('session', v)
      }
    }
  }))

  const dashboardReads = {
    // One session's history for the chat view: its events and Squadra
    // messages it sent or received, merged by time, newest page first. Paginate
    // backwards with ?before=<next_before>. The cursor is exact (time, type, id),
    // so items sharing a millisecond are never skipped or repeated.
    // Order (newest first): ts DESC, then events before messages, then id DESC.
    timeline(q) {
      const session = q.get('session')
      if (!session) throw bad('session is required')
      const limit = Math.max(1, Math.min(Number(q.get('limit') ?? 150) || 150, 500))
      let cts = Number.MAX_SAFE_INTEGER, crank = 2, cid = 0 // start: newer than anything
      const raw = q.get('before')
      if (raw) {
        const m = /^(\d+):([01]):(\d+)$/.exec(raw)
        if (!m) throw bad('invalid before cursor')
        cts = Number(m[1]); crank = Number(m[2]); cid = Number(m[3])
      }
      // Strictly older than the cursor, per item type (event rank 1, message rank 0).
      const evCond = crank === 2 ? 'ts <= ?' : crank === 1 ? '(ts < ? OR (ts = ? AND id < ?))' : 'ts < ?'
      const evArgs = crank === 1 ? [cts, cts, cid] : [cts]
      const msgCond = crank === 0 ? '(created_at < ? OR (created_at = ? AND id < ?))' : 'created_at <= ?'
      const msgArgs = crank === 0 ? [cts, cts, cid] : [crank === 1 ? cts : cts]
      // Nothing from before the chat was cleared.
      const since = db.prepare('SELECT cleared_at FROM identities WHERE name = ?').get(session)?.cleared_at ?? 0
      const evs = db.prepare(`SELECT * FROM events WHERE session = ? AND kind != 'usage' AND ts > ? AND ${evCond} ORDER BY ts DESC, id DESC LIMIT ?`)
        .all(session, since, ...evArgs, limit)
        .map(r => ({ ...eventView(r.id, r.session, r.ts, r.kind, JSON.parse(r.data), { stored: true }), t: 'event' }))
      // What this session could see (canSeeMessage): nothing from before its
      // identity was created (a name registered again starts empty), and in
      // groups only what came after it joined.
      const born = identityCreatedAt(session)
      // One ordered, indexed query per source (sent, received, each group),
      // each LIMITed, merged here: a page costs a page, not the whole history.
      const floor = Math.max(since + 1, born === Infinity ? Number.MAX_SAFE_INTEGER : born)
      // (Only ids and times per source; the rows themselves are read once, for the page.)
      const page = (where, ...args) => db.prepare(`SELECT id, created_at FROM messages WHERE ${where} AND created_at >= ? AND ${msgCond} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, floor, ...msgArgs, limit)
      const keys = [...page('from_name = ?', session), ...page('target = ?', session)]
      const inGroup = db.prepare(`SELECT id, created_at FROM messages WHERE target = ? AND from_name != ? AND created_at >= ? AND ${msgCond} ORDER BY created_at DESC, id DESC LIMIT ?`)
      for (const g of db.prepare('SELECT group_id, joined_at FROM group_members WHERE name = ?').all(session)) {
        keys.push(...inGroup.all(g.group_id, session, Math.max(floor, g.joined_at ?? 0), ...msgArgs, limit))
      }
      const seenIds = new Set()
      const ids = keys.filter(r => !seenIds.has(r.id) && seenIds.add(r.id))
        .sort((a, b) => b.created_at - a.created_at || b.id - a.id).slice(0, limit).map(r => r.id)
      const byId = db.prepare('SELECT * FROM messages WHERE id = ?')
      const msgs = ids.map(id => byId.get(id)).filter(Boolean)
        .map(r => ({ t: 'message', ts: r.created_at, ...messageView(r) }))
      const rank = x => (x.t === 'event' ? 1 : 0)
      const merged = [...evs, ...msgs]
        .sort((a, b) => b.ts - a.ts || rank(b) - rank(a) || b.id - a.id)
        .slice(0, limit)
      const last = merged[merged.length - 1]
      return {
        items: merged.reverse(),
        next_before: last ? `${last.ts}:${rank(last)}:${last.id}` : null,
        has_more: merged.length === limit,
      }
    },

    state() {
      return {
        server_time: now(),
        version: VERSION,
        sessions: db.prepare('SELECT name FROM identities ORDER BY name').all().map(r => sessionView(r.name)),
        hosts: listHosts(),
        groups: allGroups(),
        templates: listTemplates(),
        links: listLinks(),
        inbox: inbox.list(),
        squads: listSquads(),
      }
    },
    events(q) {
      const limit = Math.max(1, Math.min(Number(q.get('limit') ?? 300) || 300, 1000))
      const before = Number(q.get('before') ?? Number.MAX_SAFE_INTEGER)
      const session = q.get('session')
      const rows = session
        ? db.prepare('SELECT * FROM events WHERE session = ? AND id < ? ORDER BY id DESC LIMIT ?').all(session, before, limit)
        : db.prepare('SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
      return rows.reverse().map(r => eventView(r.id, r.session, r.ts, r.kind, JSON.parse(r.data), { stored: true }))
    },
    hosts() {
      return listHosts()
    },
    inbox() {
      return inbox.list()
    },
    messages(q) {
      const limit = Math.max(1, Math.min(Number(q.get('limit') ?? 200) || 200, 1000))
      const before = Number(q.get('before') ?? Number.MAX_SAFE_INTEGER)
      const session = q.get('session')
      const rows = session
        ? db.prepare(`SELECT * FROM messages WHERE id < ? AND (from_name = ? OR target = ? OR target IN (SELECT group_id FROM group_members WHERE name = ?)) ORDER BY id DESC LIMIT ?`).all(before, session, session, session, limit)
        : db.prepare('SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
      return rows.reverse().map(messageView)
    },
  }

  // Clear a session's chat: its own activity is deleted; squadra messages stay
  // (they're also part of the other side's chat) but are hidden from this one.
  function clearChat(name) {
    if (!identityExists(name)) throw bad('session not found')
    const at = now()
    db.prepare('DELETE FROM events WHERE session = ?').run(name)
    db.prepare('UPDATE identities SET cleared_at = ? WHERE name = ?').run(at, name)
    broadcast('cleared', { session: name, at })
    return { session: name, cleared_at: at }
  }

  // Delete a session from the server. Only while it's disconnected: a live
  // session would just come back. Its messages stay in other sessions' chats.
  function deleteSession(name, { requireOffline = true } = {}) {
    if (!identityExists(name)) throw bad('session not found')
    if (requireOffline && isOnline(name)) {
      throw new ApiError(409, `Conflict: "${name}" is connected; it can only be deleted when disconnected`, { parameters: { reason: 'session_online' } })
    }
    const groupsOf = db.prepare('SELECT group_id FROM group_members WHERE name = ?').all(name).map(r => r.group_id)
    db.prepare('DELETE FROM identities WHERE name = ?').run(name)
    db.prepare('DELETE FROM group_members WHERE name = ?').run(name)
    db.prepare('DELETE FROM group_invites WHERE name = ? OR invited_by = ?').run(name, name)
    for (const g of groupsOf) if (!db.prepare('SELECT 1 FROM group_members WHERE group_id = ?').get(g)) closeGroup(g); else handOverGroup(g, name)
    // Workers that pointed at it no longer do: a new session with this name
    // won't receive their notices.
    db.prepare('UPDATE identities SET coordinator = NULL WHERE coordinator = ?').run(name)
    // Nor is it linked with other squads any more, nor its squad described.
    if (db.prepare('DELETE FROM squads WHERE coordinator = ?').run(name).changes) broadcast('squads', listSquads())
    const links = linksOf(name)
    db.prepare('DELETE FROM squad_links WHERE a = ? OR b = ?').run(name, name)
    if (links.length) { broadcast('links', listLinks()); for (const n of links) void pushLinks(n) }
    db.prepare('DELETE FROM updates WHERE recipient = ?').run(name)
    // What it queued for others goes too (it may be why it was deleted).
    db.prepare('DELETE FROM updates WHERE sender = ?').run(name)
    db.prepare('DELETE FROM events WHERE session = ?').run(name)
    // Its conversations: what it wrote and what was written to it, also the
    // attachments sent to it. Nothing of a deleted session waits to expire.
    const sentToIt = db.prepare('SELECT file_id FROM messages WHERE target = ? AND file_id IS NOT NULL').all(name).map(r => r.file_id)
    db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE from_name = ? OR target = ?)').run(name, name)
    db.prepare('DELETE FROM messages WHERE from_name = ? OR target = ?').run(name, name)
    for (const id of sentToIt) {
      const f = fileRow(id)
      if (!f) continue
      try { rmSync(join(dataDir, f.path), { force: true }) } catch {}
      db.prepare('DELETE FROM files WHERE file_id = ?').run(id)
    }
    // Its attachments go too (they count against the server's total).
    for (const f of db.prepare('SELECT file_id, path FROM files WHERE owner = ?').all(name)) {
      try { rmSync(join(dataDir, f.path), { force: true }) } catch {}
      db.prepare('DELETE FROM files WHERE file_id = ?').run(f.file_id)
    }
    forgetSession(name)
    activity.delete(name)
    lastSessionKey.delete(name)
    broadcast('session', { name, deleted: true })
    truncateLog()
    return { session: name, deleted: true }
  }

  // Archive: hide a disconnected session from the main views, keeping its history.
  function setArchived(name, archived) {
    if (!identityExists(name)) throw bad('session not found')
    if (archived && isOnline(name)) {
      throw new ApiError(409, `Conflict: "${name}" is connected; it can only be archived when disconnected`, { parameters: { reason: 'session_online' } })
    }
    db.prepare('UPDATE identities SET archived_at = ? WHERE name = ?').run(archived ? now() : null, name)
    const view = sessionView(name)
    broadcast('session', view)
    return view
  }

  // Disconnect a session from the dashboard: its secret is replaced (and the
  // new one thrown away), so whoever holds a copy of the old one is out for
  // good. The session can then be archived or deleted; to use the name again,
  // open it again from the dashboard on its machine, or delete it.
  function kickSession(name) {
    if (!identityExists(name)) throw bad('session not found')
    const lease = leases.get(name)
    kickHolder(name)
    // What it had queued for others isn't delivered — dropped first, so the
    // notice that it left (queued as its own) still reaches its coordinator.
    db.prepare('DELETE FROM updates WHERE sender = ?').run(name)
    if (lease && !lease.downNotified) announceDown(name, 'logout')
    dropLease(name)
    register(name, true)
    broadcast('session', sessionView(name))
    log(`session "${name}" disconnected from the dashboard`)
    return sessionView(name)
  }

  // An answer from the inbox: closed as answered, then typed in the
  // coordinator's terminal. If it can't be typed, it is open again.
  async function answerFromInbox(p, actor) {
    const taken = inbox.takeAnswer(p, actor?.email ?? 'server token')
    const asked = taken.text.replace(/\s+/g, ' ')
    try {
      // (Said to come from the inbox: typed here, it would look as if the user
      // were following this session now, and the next question went to the chat.)
      await typeAnswer(taken.session, `Inbox #${taken.id} ("${asked.length > 80 ? `${asked.slice(0, 80)}…` : asked}"), the user answers from their inbox: ${taken.answer} [They are not following this session: anything else for them goes to ask_user or tell_user.]`)
    } catch (err) {
      inbox.giveBack(taken.id)
      throw err
    }
    return { id: taken.id, answered: true }
  }

  const dashboardActions = {
    kick: p => kickSession(String(p.session ?? '')),
    approve: p => approveSession(String(p.session ?? '')),
    clear: p => clearChat(String(p.session ?? '')),
    delete: p => deleteSession(String(p.session ?? '')),
    archive: p => setArchived(String(p.session ?? ''), true),
    unarchive: p => setArchived(String(p.session ?? ''), false),
    'hosts/enroll': (p, req) => createEnrollment(p, req),
    'hosts/rename': p => renameHost(String(p.host ?? ''), p.name),
    'hosts/remove': p => {
      const host = String(p.host ?? '')
      // (Read first: removing it clears what says which ones it opened.)
      const opened = p.disconnect_sessions === true ? db.prepare('SELECT name FROM identities WHERE host_id = ?').all(host).map(r => r.name) : []
      const removed = removeHost(host)
      for (const name of opened) kickSession(name)
      return { ...removed, disconnected: opened }
    },
    'hosts/folders': p => changeHostFolders(p),
    'hosts/personas': p => hostPersonas(p),
    'templates/save': p => saveTemplate(p),
    'templates/delete': p => deleteTemplate(String(p.name ?? '')),
    'links/add': p => changeLink(p, true),
    'links/delete': p => changeLink(p, false),
    'org/squad': p => describeSquad(p),
    'org/positions': p => placeSquads(p),
    'org/describe': p => describeSession(p),
    'terminals/open': p => openTerminalOn(p),
    'terminals/kill': p => killTerminalOn(p),
    'terminal/ticket': (p, req) => newTerminalTicket(req.actor ?? null),
    'inbox/resolve': p => inbox.resolve(Number(p.id)),
    'inbox/answer': (p, req) => answerFromInbox(p, req.actor),
  }

  // Who may do each thing, at least. Whatever isn't here nobody may do, and the
  // server refuses to start (see the end): every new action says who it is for.
  const dashboardRoles = {
    reads: { inbox: 'observer', timeline: 'observer', state: 'observer', events: 'observer', hosts: 'observer', messages: 'observer', stream: 'observer' },
    actions: {
      'inbox/resolve': 'operator', 'inbox/answer': 'operator', kick: 'operator', clear: 'operator', archive: 'operator', unarchive: 'operator',
      'terminals/open': 'operator', 'terminals/kill': 'operator', 'terminal/ticket': 'operator', 'hosts/personas': 'operator',
      approve: 'manager', delete: 'manager',
      'hosts/enroll': 'manager', 'hosts/rename': 'manager', 'hosts/remove': 'manager', 'hosts/folders': 'manager',
      'templates/save': 'manager', 'templates/delete': 'manager', 'links/add': 'manager', 'links/delete': 'manager',
      'org/squad': 'manager', 'org/positions': 'manager', 'org/describe': 'manager',
    },
  }
  for (const [table, roles] of [[dashboardActions, dashboardRoles.actions], [{ ...dashboardReads, stream: true }, dashboardRoles.reads]]) {
    for (const what of Object.keys(table)) if (!ROLES.includes(roles[what])) throw new Error(`"${what}" doesn't say who may do it`)
  }

  function openStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // don't let nginx/caddy buffer it
    })
    res.write(`event: hello\ndata: ${JSON.stringify(dashboardReads.state())}\n\n`)
    res.actor = req.actor ?? null
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
  }

  return { dashboardReads, dashboardActions, dashboardRoles, adminMethods, openStream }
}
