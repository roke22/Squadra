import { randomBytes } from 'node:crypto'
import {
  cleanText, cutText, bad, ApiError, guarded, sha256, now, unix, sendError, sendJson, readParams,
} from '../platform/index.js'

export function createSessions(platform) {
  const { db, bus, readLimit, allow, takeChallenge, proofIsGood } = platform

  const MAX_UPDATES = Number(process.env.SQUADRA_MAX_UPDATES ?? 500_000)       // undelivered updates kept, in all
  const MAX_UPDATES_PER_SESSION = 10_000                                        // undelivered updates kept, per recipient
  const UPDATE_TTL_MS = 24 * 60 * 60 * 1000  // like Telegram: unconfirmed updates kept 24h
  const POLL_MAX_TIMEOUT_S = 50
  const ONLINE_GRACE_MS = 15 * 1000          // gap allowed between two polls of a live plugin

  // A session that stops polling (lost network, its machine asleep) is announced
  // DOWN only after this long: a short network cut doesn't wake its coordinator
  // twice (DOWN, then back online) nor drop what was waiting for it.
  const LOST_GRACE_MS = Number(process.env.SQUADRA_LOST_GRACE_MS ?? 2 * 60_000)
  const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

  // The persona a session says it follows (at login): what its kind and name
  // are, and its description, short. Like its role, the session's own word.
  function personaOf(p) {
    if (!p || typeof p !== 'object' || !['skill', 'agent'].includes(p.kind)) return null
    const name = typeof p.name === 'string' ? cleanText(p.name.slice(0, 128)).replace(/\s+/g, ' ').trim().slice(0, 64) : ''
    if (!name) return null
    const description = typeof p.description === 'string' ? cleanText(p.description.slice(0, 600)).replace(/\s+/g, ' ').trim().slice(0, 300) : ''
    return JSON.stringify({ kind: p.kind, name, description })
  }
  function personaView(name) {
    try { return JSON.parse(db.prepare('SELECT persona FROM identities WHERE name = ?').get(name)?.persona ?? 'null') } catch { return null }
  }

  // joined: it came with the join token, not from the dashboard or its admin.
  function register(name, reset, { joined = false } = {}) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw bad('name must match [A-Za-z0-9_-]{1,32}')
    const existing = db.prepare('SELECT name FROM identities WHERE name = ?').get(name)
    if (existing && !reset) {
      throw new ApiError(409, `Conflict: identity "${name}" already registered. Use the existing secret, or register with reset: true to rotate it.`)
    }
    const secret = `sq_${randomBytes(24).toString('base64url')}`
    if (existing) {
      db.prepare('UPDATE identities SET secret_hash = ?, needs_approval = 0, public_key = NULL, proven_instance = NULL WHERE name = ?').run(sha256(secret), name)
      // A rotated identity must not keep a stale poller (or answer) alive.
      dropAnswer(name); servedUpTo.delete(name)
      const w = waiters.get(name)
      if (w) finishPoll(w, conflict())
    } else {
      db.prepare('INSERT INTO identities (name, secret_hash, created_at, epoch, needs_approval) VALUES (?, ?, ?, ?, ?)').run(name, sha256(secret), now(), randomBytes(12).toString('hex'), joined ? 1 : 0)
    }
    return { name, secret }
  }

  function identityFromSecret(secret) {
    if (!secret) return null
    const row = db.prepare('SELECT name FROM identities WHERE secret_hash = ?').get(sha256(secret))
    return row ? row.name : null
  }

  function identityExists(name) {
    return !!db.prepare('SELECT 1 FROM identities WHERE name = ?').get(name)
  }

  // last_seen_at is written at most every 10 s per name (one database write per
  // request would let a refused caller keep the database busy).
  const lastTouched = new Map()
  function touch(name) {
    const t = now()
    if (t - (lastTouched.get(name) ?? 0) < 10_000) return
    lastTouched.set(name, t)
    db.prepare('UPDATE identities SET last_seen_at = ? WHERE name = ?').run(t, name)
  }

  // squadra_identity: which registration of that name it is (sessions pin it:
  // a name deleted and registered again by someone else is told apart).
  const epochOf = name => db.prepare('SELECT epoch FROM identities WHERE name = ?').get(name)?.epoch ?? undefined
  const userObj = name => ({ id: name, is_bot: false, first_name: name, username: name, squadra_identity: epochOf(name) })
  const linkKey = (x, y) => (x < y ? [x, y] : [y, x])
  const linked = (x, y) => !!db.prepare('SELECT 1 FROM squad_links WHERE a = ? AND b = ?').get(...linkKey(x, y))
  const linksOf = name => db.prepare('SELECT a, b FROM squad_links WHERE a = ? OR b = ? ORDER BY a, b').all(name, name).map(r => (r.a === name ? r.b : r.a))

  // A message is visible to whoever sent it, received it, or is in its group —
  // and only from that identity's creation on: a name deleted and registered
  // again doesn't inherit the old one's history.
  const identityCreatedAt = name => db.prepare('SELECT created_at FROM identities WHERE name = ?').get(name)?.created_at ?? Infinity

  const waiters = new Map() // name -> { res, timer, offset, limit }

  const conflict = () => new ApiError(409, 'Conflict: terminated by other getUpdates request; make sure that only one squadra plugin instance is running for this name')

  const pushCount = new Map()
  const MAX_UPDATES_PER_SENDER = 500 // undelivered, per sender and recipient
  function pushUpdate(recipient, payload, sender = null) {
    db.prepare('INSERT INTO updates (recipient, payload, created_at, sender) VALUES (?, ?, ?, ?)').run(recipient, JSON.stringify(payload), now(), sender)
    // One sender can't push out what others sent: its own oldest go first.
    if (sender) db.prepare('DELETE FROM updates WHERE recipient = ? AND sender = ? AND update_id <= (SELECT update_id FROM updates WHERE recipient = ? AND sender = ? ORDER BY update_id DESC LIMIT 1 OFFSET ?)').run(recipient, sender, recipient, sender, MAX_UPDATES_PER_SENDER)
    // A recipient that never picks them up keeps at most the newest
    // MAX_UPDATES_PER_SESSION (checked every 500 updates, not on each one).
    const n = (pushCount.get(recipient) ?? 0) + 1
    pushCount.set(recipient, n % 500)
    if (n >= 500) db.prepare('DELETE FROM updates WHERE recipient = ? AND update_id <= (SELECT update_id FROM updates WHERE recipient = ? ORDER BY update_id DESC LIMIT 1 OFFSET ?)').run(recipient, recipient, MAX_UPDATES_PER_SESSION)
    const w = waiters.get(recipient)
    if (w) {
      const updates = readUpdates(recipient, w.offset, w.limit)
      if (updates.length) finishPoll(w, null, updates)
    }
  }

  // At most about 1 MB per answer (always at least one update): the plugin
  // simply asks again for the rest.
  const MAX_ANSWER_BYTES = 1024 * 1024
  const servedUpTo = new Map() // name -> highest update_id already handed out
  function readUpdates(recipient, offset, limit) {
    const out = []
    let bytes = 0
    for (const r of db.prepare('SELECT update_id, payload FROM updates WHERE recipient = ? AND update_id >= ? ORDER BY update_id LIMIT ?').iterate(recipient, offset, limit)) {
      const size = Buffer.byteLength(r.payload)
      if (out.length && bytes + size > MAX_ANSWER_BYTES) break
      bytes += size
      out.push({ update_id: r.update_id, ...JSON.parse(r.payload) })
    }
    if (out.length) servedUpTo.set(recipient, Math.max(servedUpTo.get(recipient) ?? 0, out[out.length - 1].update_id))
    return out
  }
  const lastAnswer = new Map() // name -> the last immediate answer (still being sent?)
  function dropAnswer(name) {
    const pa = lastAnswer.get(name)
    if (pa && !pa.res.writableFinished && !pa.res.destroyed) { try { pa.res.destroy() } catch {} }
    lastAnswer.delete(name)
  }

  function finishPoll(w, err, result = []) {
    clearTimeout(w.timer)
    if (waiters.get(w.name) === w) waiters.delete(w.name)
    if (w.res.writableEnded) return
    if (!err) markPolled(w.name)
    if (err) sendError(w.res, err)
    else sendJson(w.res, 200, { ok: true, result })
  }

  function getUpdates(name, params, res) {
    const n = (v, d) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d)
    const offset = n(params.offset, 0)
    const limit = Math.max(1, Math.min(n(params.limit, 100), 100))
    const timeout = Math.max(0, Math.min(n(params.timeout, 0), POLL_MAX_TIMEOUT_S))

    // Session lease: once a session holds the name, only that session (its
    // instance) may poll; a caller without an instance is refused, so a copy of
    // the secret can't read or drain its queue. Names nobody claimed get the
    // plain Telegram behaviour below.
    const instance = params.instance != null ? String(params.instance) : ''
    if (instance && !/^[A-Za-z0-9_-]{8,64}$/.test(instance)) throw bad('invalid instance')
    if (instance) checkLease(name, instance)
    else if (leases.has(name)) throw new ApiError(409, `Conflict: "${name}" is held by a Squadra session`, { parameters: { reason: 'name_in_use' } })
    if (timeout === 0) readLimit(name) // after the checks: a refused caller doesn't use the holder's budget

    // Asking again for updates already handed out (offset at or below what was
    // served) and getting them at once counts like a quick poll; a plugin
    // working through its queue always asks for new ones and is never limited.
    // Decided before reading anything.
    const rereads = offset <= (servedUpTo.get(name) ?? -1) &&
      !!db.prepare('SELECT 1 FROM updates WHERE recipient = ? AND update_id >= ? LIMIT 1').get(name, offset)
    if (timeout !== 0 && rereads) readLimit(name, 'poll')
    // An answer still being sent to this name: no second one meanwhile.
    // (Only for the same session instance, and only for a short while: a
    // connection that never finishes can't block the name.)
    const pa = lastAnswer.get(name)
    if (pa && pa.instance === instance && Date.now() - pa.at < 30_000 && !pa.res.writableFinished && !pa.res.destroyed && !pa.res.closed) {
      throw new ApiError(429, 'Too Many Requests: the previous answer is still being sent')
    }

    // Like Telegram: an offset confirms every update below it.
    if (offset > 0) db.prepare('DELETE FROM updates WHERE recipient = ? AND update_id < ?').run(name, offset)

    // Newest poller wins; the previous one gets 409, exactly like Telegram.
    // (With leases, both pollers belong to the same session.)
    const prev = waiters.get(name)
    if (prev) finishPoll(prev, conflict())

    const updates = readUpdates(name, offset, limit)
    if (updates.length || timeout === 0) {
      markPolled(name)
      // An earlier answer to this name still unread is dropped: a name never
      // holds more than one unread answer on the server.
      dropAnswer(name)
      lastAnswer.set(name, { res, at: Date.now(), instance })
      return sendJson(res, 200, { ok: true, result: updates })
    }
    markPolled(name)

    const w = { name, res, offset, limit, timer: null }
    w.timer = setTimeout(() => finishPoll(w, null, []), timeout * 1000)
    res.on('close', () => {
      clearTimeout(w.timer)
      if (waiters.get(name) === w) waiters.delete(name)
      // The plugin dropped the connection mid-poll: its session ended (or lost
      // the network). Offline right away instead of after the grace window.
      if (!res.writableEnded) presence.set(name, { ...(presence.get(name) ?? {}), lastPollAt: now(), disconnected: true, pollingSince: null })
    })
    waiters.set(name, w)
  }

  // Delivery rules (not part of the Bot API):
  // - A worker only receives messages while it's connected. Sending to a
  //   disconnected worker is refused, so a task never waits in a queue for a
  //   session that may not come back; the sender can give it to someone else.
  // - A coordinator always receives: messages to it are queued while it's away.
  // - Sessions with no known role (plain Bot API clients) keep Telegram's
  //   behaviour: queued.
  function roleOf(name) {
    return db.prepare('SELECT role FROM identities WHERE name = ?').get(name)?.role ?? null
  }

  // A name taken with the join token could be one some worker is waiting for
  // as its coordinator: whoever got there first would give it orders. So until
  // it is approved in the dashboard it writes to nobody who follows it, or who
  // might (a session that hasn't said yet), and those who follow it only greet it.
  const approvalRow = name => db.prepare('SELECT needs_approval, role, coordinator, opened_role FROM identities WHERE name = ?').get(name)
  const notApproved = name => new ApiError(403, `Forbidden: "${name}" has not been approved as a coordinator yet: the user must approve it in the dashboard (open that session: Approve as coordinator)`, { parameters: { reason: 'approval_pending' } })
  function checkApproval(from, target, hello) {
    if (target.startsWith('#')) return
    const f = approvalRow(from), t = approvalRow(target)
    if (!f || !t) return
    if (f.needs_approval && (t.coordinator === from || (t.role == null && !t.opened_role))) throw notApproved(from)
    if (t.needs_approval && f.coordinator === target && !hello) throw notApproved(target)
  }
  function approveSession(name) {
    if (!identityExists(name)) throw bad('session not found')
    db.prepare('UPDATE identities SET needs_approval = 0 WHERE name = ?').run(name)
    bus.emit('session-changed', name)
    return { session: name, approved: true }
  }

  const sessionMethods = {

    getMe(name) {
      readLimit(name)
      return { ...userObj(name), is_bot: true }
    },

    // A session claims its name before polling. First come, first served: while
    // the session holding the name is online, any other session is refused.
    claimSession(name, p) {
      const instance = String(p.instance ?? '')
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(instance)) throw bad('instance is required')
      const lease = leases.get(name)
      // A connected session keeps its name: nobody can take it over (not even
      // with its identity secret). The dashboard admin can disconnect it.
      // (Checked before the rate limit: a copy of the secret refused here must
      // not use up the budget of the session that holds the name.)
      if (lease && lease.instance !== instance && holdsName(name, lease)) throw nameInUse(name, lease)
      if (!allow('claim', name, 20)) throw new ApiError(429, 'Too Many Requests: retry in a minute')
      const provenKey = sessionKeyProved(name, instance, p)
      if (provenKey) db.prepare('UPDATE identities SET public_key = ?, proven_instance = ? WHERE name = ?').run(provenKey, instance, name)
      // (solo: a plain Claude Code session opened from the dashboard, outside any squad.)
      const role = ['coordinator', 'worker', 'solo'].includes(p.role) ? p.role : null
      const coordinator = role === 'worker' && NAME_RE.test(String(p.coordinator ?? '')) ? String(p.coordinator) : null
      if (role) db.prepare('UPDATE identities SET role = ?, coordinator = ?, persona = ? WHERE name = ?').run(role, coordinator, personaOf(p.persona), name)
      const approval = approvalRow(name)
      // (It may have just become one to approve, or to wait for.)
      if (role && (role === 'coordinator' ? approval.needs_approval : coordinator && approvalRow(coordinator)?.needs_approval)) setImmediate(() => bus.emit('session-changed', role === 'coordinator' ? name : coordinator))
      // An archived session that logs in again is active again.
      if (db.prepare('UPDATE identities SET archived_at = NULL WHERE name = ? AND archived_at IS NOT NULL').run(name).changes) {
        setImmediate(() => bus.emit('session-changed', name))
      }
      if (!lease || lease.instance !== instance) setLease(name, instance)
      else delete lease.restoredUntil
      markPolled(name) // a claim is a sign of life: don't let the down sweep fire before the first poll
      return {
        name, role, since: unix(leases.get(name).since),
        ...(role === 'coordinator' && approval.needs_approval ? { approval_pending: true } : {}),
        ...(role === 'worker' && coordinator && approvalRow(coordinator)?.needs_approval ? { coordinator_pending: true } : {}),
      }
    },

    // reason: 'logout' (the user left) or 'exit' (Claude Code is closing).
    releaseSession(name, p) {
      const lease = leases.get(name)
      if (lease && lease.instance === String(p.instance ?? '')) {
        if (!allow('release', name, 20)) throw new ApiError(429, 'Too Many Requests: retry in a minute')
        if (!lease.downNotified) announceDown(name, p.reason === 'exit' ? 'exit' : 'logout')
        dropLease(name)
        const w = waiters.get(name)
        if (w) finishPoll(w, null, [])
        presence.set(name, { ...(presence.get(name) ?? {}), lastPollAt: now(), disconnected: true, pollingSince: null })
      }
      return true
    },
  }

  // Presence: a plugin is "online" while it long-polls. It dies with its Claude
  // Code session (stdin EOF), so online means the session is running.
  const presence = new Map() // name -> { pollingSince, lastPollAt, disconnected }

  // Leases: which session (plugin instance) holds each name. Kept in the
  // database too: after a server restart, the names that were held stay
  // reserved for their sessions for RESTART_GRACE_MS, so a copy of a secret
  // can't grab a name while its session reconnects.
  const leases = new Map() // name -> { instance, since, downNotified, restoredUntil? }
  const RESTART_GRACE_MS = 2 * 60 * 1000
  for (const r of db.prepare('SELECT name, instance, since FROM leases').all()) {
    leases.set(r.name, { instance: r.instance, since: r.since, downNotified: false, restoredUntil: now() + RESTART_GRACE_MS })
  }

  function setLease(name, instance) {
    dropAnswer(name) // a new holder starts clean (and an unread answer of the old one goes)
    servedUpTo.delete(name)
    const lease = { instance, since: now(), downNotified: false }
    leases.set(name, lease)
    db.prepare('INSERT OR REPLACE INTO leases (name, instance, since) VALUES (?, ?, ?)').run(name, instance, lease.since)
    return lease
  }

  function dropLease(name) {
    leases.delete(name)
    db.prepare('DELETE FROM leases WHERE name = ?').run(name)
  }

  // The lease's session still has the name: it is online, or the server just
  // restarted and it hasn't had time to reconnect.
  function holdsName(name, lease) {
    return isOnline(name) || (lease?.restoredUntil ?? 0) > now()
  }

  function nameInUse(name, lease) {
    const p = presence.get(name)
    const ago = p?.lastPollAt ? Math.round((now() - p.lastPollAt) / 1000) : null
    return new ApiError(409, `Conflict: name "${name}" is in use by another active session (connected since ${new Date(lease.since).toISOString()}${ago != null ? `, last seen ${ago}s ago` : ''})`,
      { parameters: { reason: 'name_in_use', since: unix(lease.since) } })
  }

  function kickHolder(name) {
    const w = waiters.get(name)
    if (w) finishPoll(w, new ApiError(409, `Conflict: name "${name}" was taken over by another session`, { parameters: { reason: 'taken_over' } }))
    presence.set(name, { ...(presence.get(name) ?? {}), lastPollAt: now(), disconnected: true, pollingSince: null })
  }

  function checkLease(name, instance) {
    const lease = leases.get(name)
    if (!lease) {
      setLease(name, instance)
      return
    }
    if (lease.instance === instance) {
      delete lease.restoredUntil
      // Same session polling again after we announced it down (network blip).
      if (lease.downNotified) {
        lease.downNotified = false
        db.prepare('INSERT OR REPLACE INTO leases (name, instance, since) VALUES (?, ?, ?)').run(name, lease.instance, lease.since)
        bus.emit('notice', name, `🔌 ${name} is back online (same session).`)
      }
      return
    }
    if (holdsName(name, lease)) {
      throw new ApiError(409, `Conflict: name "${name}" was taken over by another session`, { parameters: { reason: 'taken_over' } })
    }
    setLease(name, instance) // previous holder is gone
  }

  function announceDown(worker, reason) {
    const lease = leases.get(worker)
    if (lease) lease.downNotified = true
    // Only a worker's queue is dropped (its tasks go back to the coordinator);
    // what waits for a coordinator, or a session without a role, is kept.
    if (roleOf(worker) !== 'worker') return
    // Drop what the worker never picked up.
    // Only the coordinator's own messages are quoted (the tasks to reassign),
    // at most 10; anything else (other sessions, groups) is only counted: a
    // notice must not show the coordinator what it couldn't see. Only those
    // few rows are read (a queue can hold thousands).
    const coord = db.prepare('SELECT coordinator FROM identities WHERE name = ?').get(worker)?.coordinator
    const total = db.prepare('SELECT COUNT(*) AS n FROM updates WHERE recipient = ?').get(worker).n
    const coordRows = coord ? db.prepare('SELECT payload FROM updates WHERE recipient = ? AND sender = ? ORDER BY update_id LIMIT 11').all(worker, coord) : []
    const coordCount = coord ? db.prepare('SELECT COUNT(*) AS n FROM updates WHERE recipient = ? AND sender = ?').get(worker, coord).n : 0
    db.prepare('DELETE FROM updates WHERE recipient = ?').run(worker)
    const fromCoord = coordRows.map(u => JSON.parse(u.payload).message).filter(m => m && !m.squadra_notice && m.chat?.type === 'private')
    const msgs = { length: total }
    const others = total - coordCount
    // Quoted as data: this text was written by the sender, not by the server.
    const lost = fromCoord.slice(0, 10)
      .map(m => `${JSON.stringify(cutText((m.text ?? m.caption ?? '(attachment)').replace(/\s+/g, ' '), 120))}`)
    if (coordCount > 10) lost.push(`and ${coordCount - 10} more of yours`)
    if (others) lost.push(`and ${others} from other sessions or groups`)
    const what = {
      logout: `🔌 ${worker} left Squadra (logout).`,
      exit: `🔌 ${worker} disconnected: its Claude Code session was closed.`,
      lost: `⚠️ ${worker} is DOWN: it stopped responding (lost connection or its machine went down).`,
    }[reason]
    const parts = [what]
    if (msgs.length) parts.push(`It never picked up ${msgs.length} message(s), which were dropped: ${lost.join('; ')}.`)
    parts.push('If it had a task in progress, it will not finish it: consider reassigning it to another active worker.')
    bus.emit('notice', worker, parts.join(' '))
  }

  // Leases whose holder stopped polling without releasing (crash, lost network).
  // Sessions held before a restart keep their names for RESTART_GRACE_MS from
  // when the server is actually answering again (not from when it started
  // loading), and nobody is declared lost before that.
  let serving = false
  function nowServing() {
    if (serving) return
    serving = true
    for (const lease of leases.values()) if (lease.restoredUntil) lease.restoredUntil = now() + RESTART_GRACE_MS
  }
  function sweepLeases() {
    if (!serving) return
    for (const [name, lease] of leases) {
      if (!lease.downNotified && !holdsName(name, lease) && now() - (presence.get(name)?.lastPollAt ?? 0) >= LOST_GRACE_MS) {
        announceDown(name, 'lost')
        // Gone: a server restart doesn't keep the name for it any more (the same
        // session can still come back: its instance is still known here).
        db.prepare('DELETE FROM leases WHERE name = ?').run(name)
      }
    }
  }
  setInterval(guarded(sweepLeases), 3000).unref()

  function markPolled(name) {
    const p = presence.get(name)
    const back = !p || p.disconnected || now() - p.lastPollAt >= ONLINE_GRACE_MS
    presence.set(name, { pollingSince: p && !p.disconnected && p.pollingSince ? p.pollingSince : now(), lastPollAt: now(), disconnected: false })
    // An archived session that comes back (also without logging in again, after
    // a network blip) is active again, as one that claims its name is.
    if (back && db.prepare('UPDATE identities SET archived_at = NULL WHERE name = ? AND archived_at IS NOT NULL').run(name).changes) bus.emit('session-changed', name)
  }

  function isOnline(name) {
    if (waiters.has(name)) return true
    const p = presence.get(name)
    return !!p && !p.disconnected && now() - p.lastPollAt < ONLINE_GRACE_MS
  }

  // A worker that stopped responding and isn't announced DOWN yet: seconds
  // until it is (unless it comes back), or null.
  function downIn(name) {
    if (isOnline(name) || roleOf(name) !== 'worker') return null
    const lease = leases.get(name)
    if (!lease || lease.downNotified) return null
    const at = Math.max((presence.get(name)?.lastPollAt ?? 0) + LOST_GRACE_MS, lease.restoredUntil ?? 0)
    return Math.max(0, Math.ceil((at - now()) / 1000))
  }

  // A deleted session: nothing about it stays in memory, and a poll it left open ends.
  function forgetSession(name) {
    dropLease(name)
    dropAnswer(name); servedUpTo.delete(name); lastTouched.delete(name); pushCount.delete(name)
    presence.delete(name)
    const w = waiters.get(name)
    if (w) finishPoll(w, new ApiError(401, 'Unauthorized'))
  }

  function presenceOf(name) {
    const online = isOnline(name)
    const left = downIn(name)
    const p = presence.get(name)
    const lastMsg = db.prepare('SELECT MAX(created_at) AS t FROM messages WHERE from_name = ?').get(name)?.t
    const pending = db.prepare('SELECT COUNT(*) AS n FROM updates WHERE recipient = ?').get(name)?.n ?? 0
    return {
      online,
      connected_since: online && p?.pollingSince ? unix(p.pollingSince) : null,
      last_seen_at: p?.lastPollAt ? unix(p.lastPollAt) : null,
      last_message_at: lastMsg ? unix(lastMsg) : null,
      pending_updates: pending,
      ...(left != null ? { down_in: left } : {}),
    }
  }

  function cleanupUpdates() {
    db.prepare('DELETE FROM updates WHERE created_at < ?').run(now() - UPDATE_TTL_MS)
    db.prepare('DELETE FROM updates WHERE update_id <= (SELECT update_id FROM updates ORDER BY update_id DESC LIMIT 1 OFFSET ?)').run(MAX_UPDATES)
  }

  const keyRefused = text => new ApiError(403, `Forbidden: ${text}`, { parameters: { reason: 'key_refused' } })

  // A session's key, for a claim: remembered the first time, required after that.
  // (Null: a plugin older than 0.0.7, for a name that never had a key.)
  function sessionKeyProved(name, instance, p) {
    const known = db.prepare('SELECT public_key FROM identities WHERE name = ?').get(name)?.public_key ?? null
    if (p.signing_key == null) {
      if (known) throw keyRefused(`the session "${name}" has a key, and this login doesn't prove it: update the Squadra plugin (0.0.7 or later) on that machine`)
      return null
    }
    const offered = String(p.signing_key)
    const fresh = takeChallenge(String(p.challenge ?? ''))
    if (!fresh || !proofIsGood(offered, 'claim', name, p.challenge, instance, p.proof)) throw keyRefused('this login does not prove its key; try again')
    if (known && known !== offered) throw keyRefused(`the session "${name}" has a different key on this server. If it really moved to another machine or lost its key, delete it in the dashboard and open it again; if not, something else may be using its secret`)
    return offered
  }

  // A request for a held name without the holder's session id. With no id at
  // all it is most likely a plugin older than 0.0.2: said so.
  const notHolder = (name, inst) => inst
    ? new ApiError(409, `Conflict: "${name}" is connected from another session`, { parameters: { reason: 'name_in_use' } })
    : new ApiError(409, `Conflict: "${name}" is connected, and this request has no session id: update the Squadra plugin (0.0.2 or later) on that machine`, { parameters: { reason: 'plugin_outdated' } })
  // A session's requests still sending their body: at most 8 at a time. While
  // a session holds the name, requests without its session id (a copy of the
  // secret) have their own 2, so they can never use up the holder's.
  const bodiesInFlight = new Map()
  async function readParamsAs(name, req, url) {
    const lease = leases.get(name)
    const other = lease && String(req.headers['x-squadra-instance'] ?? '') !== lease.instance
    const key = other ? `${name}\0other` : name
    const n = bodiesInFlight.get(key) ?? 0
    if (n >= (other ? 2 : 8)) throw new ApiError(429, 'Too Many Requests: too many requests still sending their body')
    bodiesInFlight.set(key, n + 1)
    try { return await readParams(req, url) } finally {
      const m = (bodiesInFlight.get(key) ?? 1) - 1
      if (m > 0) bodiesInFlight.set(key, m); else bodiesInFlight.delete(key)
    }
  }

  return {
    sessionMethods, cleanupUpdates, nowServing, waiters, finishPoll, userObj, identityCreatedAt, linked,
    NAME_RE, identityExists, roleOf, checkApproval, linkKey, isOnline, downIn, presence, pushUpdate,
    presenceOf, personaView, register, approveSession, linksOf, forgetSession, leases, kickHolder,
    announceDown, dropLease, keyRefused, holdsName, identityFromSecret, notHolder, touch, readParamsAs, getUpdates,
  }
}
