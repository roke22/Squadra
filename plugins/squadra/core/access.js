// Who may talk to this session: pairing, allowlists, pins and links
// (the same shape as the Telegram plugin).

import { readFileSync, renameSync, mkdirSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { agent } from './agent.js'
import { NAME_RE, log, stateDirFor, GROUP_ID_RE } from './settings.js'
import { S, active } from './session.js'
import { call, ApiError } from './client.js'
import { checkCoordinator } from './inbound.js'

function defaultAccess() {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {}, linkedCoordinators: [] }
}

function readAccessFile(s = S) {
  try {
    const parsed = JSON.parse(readFileSync(s.accessFile, 'utf8'))
    const a = {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
      permissionApprovers: Array.isArray(parsed.permissionApprovers) ? parsed.permissionApprovers.filter(n => NAME_RE.test(String(n))) : [],
      // Coordinators of other squads this coordinator works with (set by the user).
      linkedCoordinators: Array.isArray(parsed.linkedCoordinators) ? parsed.linkedCoordinators.filter(n => NAME_RE.test(String(n))) : [],
      // The role and coordinator the user approved (kept on every save).
      approved: parsed.approved && typeof parsed.approved === 'object' ? parsed.approved : undefined,
    }
    if (s) { s.lastGoodAccess = structuredClone(a); s.badAccessSince = null }
    return a
  } catch (err) {
    if (err.code === 'ENOENT') return defaultAccess()
    // Unreadable right now (for example half-written by an edit): the last
    // version this session read, never a fresh default that would forget
    // the allowlist. Moved aside only if it stays broken.
    if (s.lastGoodAccess) {
      s.badAccessSince ??= Date.now()
      if (Date.now() - s.badAccessSince < 30_000) return structuredClone(s.lastGoodAccess)
    }
    try { renameSync(s.accessFile, `${s.accessFile}.corrupt-${Date.now()}`) } catch {}
    s.badAccessSince = null
    if (s.lastGoodAccess) {
      // Put the last good version back: the allowlist and the approval stay.
      try { writePrivateFile(s.accessFile, JSON.stringify(s.lastGoodAccess, null, 2) + '\n') } catch {}
      log('access.json was unreadable: moved aside and restored from the last good version.')
      return structuredClone(s.lastGoodAccess)
    }
    log('access.json is corrupt, moved aside.')
    return defaultAccess()
  }
}

export function loadAccess(s = S) {
  return s.bootAccess ?? readAccessFile(s)
}

function saveAccess(a, s = S) {
  if (s.staticAccess) return
  mkdirSync(s.stateDir, { recursive: true, mode: 0o700 })
  writePrivateFile(s.accessFile, JSON.stringify(a, null, 2) + '\n')
  s.lastGoodAccess = structuredClone(a)
}

// A private file, written to a new temporary file and renamed over the old
// one: never through a symlink someone left in its place.
export function writePrivateFile(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
  renameSync(tmp, file)
}

// Initial access for a session:
// - static mode (access_mode "static" in launch.json): snapshot at boot, never written.
//   Pairing requires runtime mutation, so it's downgraded to allowlist.
// - worker logging in for the first time: allowlist with just its coordinator.
// - seedAllow names are merged into the allowlist.
// The role and coordinator the user approved for a name (access.json).
export function readApproved(name) {
  if (!NAME_RE.test(String(name ?? ''))) return null
  try {
    const a = JSON.parse(readFileSync(join(stateDirFor(name), 'access.json'), 'utf8'))
    const ap = a?.approved
    if (ap && (ap.role === 'coordinator' || ap.role === 'worker' || ap.role === 'solo')) {
      return {
        role: ap.role,
        coordinator: ap.role === 'worker' && NAME_RE.test(String(ap.coordinator)) ? ap.coordinator : null,
        permissionApprovers: Array.isArray(ap.permissionApprovers) ? ap.permissionApprovers.filter(n => NAME_RE.test(String(n))) : [],
      }
    }
  } catch {}
  return null
}

// The permissionApprovers listed in a name's access.json right now.
export function listedApprovers(name) {
  try {
    const a = JSON.parse(readFileSync(join(stateDirFor(name), 'access.json'), 'utf8'))
    return Array.isArray(a?.permissionApprovers) ? [...new Set(a.permissionApprovers.filter(n => NAME_RE.test(String(n))))] : []
  } catch { return [] }
}
export function writeApproved(s) {
  if (s.staticAccess) return
  const a = readAccessFile(s)
  a.approved = { role: s.role, coordinator: s.coordinator ?? null, permissionApprovers: s.confirmedApprovers ?? [] }
  saveAccess(a, s)
}

// Started by squadra-host from the dashboard: <state>/launch.json says the
// name's role and coordinator (written by the machine, not by the environment
// a project could set).
// A launch.json is for the start it was written for: older than this, it is
// ignored (a session that never got to start doesn't leave a standing ticket).
const LAUNCH_MAX_AGE_MS = 15 * 60_000
export function readLaunch(name) {
  if (!NAME_RE.test(String(name ?? ''))) return null
  try {
    const file = join(stateDirFor(name), 'launch.json')
    const age = Date.now() - statSync(file).mtimeMs
    if (age > LAUNCH_MAX_AGE_MS || age < -60_000) return null // too old, or dated in the future
    const l = JSON.parse(readFileSync(file, 'utf8'))
    if (l?.name !== name || (l.role !== 'coordinator' && l.role !== 'worker' && l.role !== 'solo')) return null
    return {
      role: l.role,
      coordinator: l.role === 'worker' && NAME_RE.test(String(l.coordinator)) ? l.coordinator : null,
      allowFrom: Array.isArray(l.allow_from) ? l.allow_from.filter(n => NAME_RE.test(String(n))) : [],
      staticAccess: l.access_mode === 'static',
      relayOff: l.permission_relay === false, // the machine doesn't allow remote permission answers
      persona: l.role === 'solo' ? null : launchPersona(l.persona),
    }
  } catch { return null }
}

// Coordinators of other squads a coordinator works with: the ones the user
// listed in its access.json (linkedCoordinators), and, for a session the
// machine started (launch.json), the links set in the dashboard, which the
// machine keeps in <state>/links.json while the session runs. Each one may
// message this coordinator and be messaged by it.
const LINKS_MAX = 20
function readMachineLinks(s) {
  if (!s?.fromLaunch || s.role !== 'coordinator') return []
  const file = join(s.stateDir, 'links.json')
  let st
  try { st = statSync(file) } catch { s.machineLinks = null; return [] }
  if (s.machineLinks?.mtimeMs === st.mtimeMs && s.machineLinks.size === st.size) return s.machineLinks.names
  let names = []
  try {
    const l = JSON.parse(readFileSync(file, 'utf8'))
    if (l?.name === s.name && Array.isArray(l.coordinators)) names = l.coordinators.filter(n => NAME_RE.test(String(n)) && n !== s.name).slice(0, LINKS_MAX)
  } catch {}
  s.machineLinks = { mtimeMs: st.mtimeMs, size: st.size, names }
  return names
}
export function linkedCoordinators(s = S) {
  if (!s || s.role !== 'coordinator') return []
  const own = loadAccess(s).linkedCoordinators ?? []
  return [...new Set([...own, ...readMachineLinks(s)])].filter(n => n !== s.name)
}

// When the links change while the session runs, its Claude is told (not at
// login: status and ping list them).
export function checkLinks(s) {
  if (!active(s) || s.role !== 'coordinator') return
  const now = linkedCoordinators(s).sort()
  const key = now.join(',')
  if (s.linksKey === undefined || s.linksKey === key) { s.linksKey = key; return }
  const before = new Set(s.linksKey ? s.linksKey.split(',') : [])
  s.linksKey = key
  const added = now.filter(n => !before.has(n))
  const removed = [...before].filter(n => !now.includes(n))
  log(`linked coordinators now: ${key || '(none)'}`)
  agent.deliver({
    content: `Squadra: the coordinators linked with this one changed.${added.length ? ` Linked now: ${added.join(', ')}.` : ''}${removed.length ? ` No longer linked: ${removed.join(', ')}.` : ''} Linked coordinators: ${now.join(', ') || '(none)'} (see the LINKED COORDINATORS rule).`,
    meta: { kind: 'squadra_notice', user: 'squadra' },
  })
}

// The persona the machine started the session with (a skill or an agent, in
// its system prompt): its kind, name and short description, for its squad to
// know. One line each, no control characters.
export function launchPersona(p) {
  if (!p || typeof p !== 'object' || !['skill', 'agent'].includes(p.kind)) return null
  const line = (v, n) => String(v ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
  const name = line(p.name, 64)
  return name ? { kind: p.kind, name, description: line(p.description, 300) } : null
}
export const personaLabel = p => `${p.kind} "${p.name}"${p.description ? ` (${p.description})` : ''}`

export function prepareAccess(s) {
  if (s.staticAccess) {
    const a = readAccessFile(s)
    for (const n of s.seedAllow) if (!a.allowFrom.includes(n)) a.allowFrom.push(n)
    if (a.dmPolicy === 'pairing') {
      log('static mode — dmPolicy "pairing" downgraded to "allowlist"')
      a.dmPolicy = 'allowlist'
    }
    a.pending = {}
    s.bootAccess = a
    return
  }
  const fresh = !existsSync(s.accessFile)
  const a = readAccessFile(s)
  let changed = false
  if (fresh && s.role === 'worker') { a.dmPolicy = 'allowlist'; changed = true }
  for (const n of s.seedAllow) if (!a.allowFrom.includes(n)) { a.allowFrom.push(n); changed = true }
  if (changed || fresh) saveAccess(a, s)
}

// Outbound gate — reply/react/edit can only target chats the inbound gate
// would deliver from.
export function assertAllowedChat(chat_id) {
  // A worker that rejected its coordinator (pin mismatch) doesn't report to it.
  if (S.role === 'worker' && chat_id === S.coordinator && S.coordinatorRejected) {
    throw new Error(`"${chat_id}" is not the coordinator this session was paired with; the user must sort it out (see the earlier warning)`)
  }
  const access = loadAccess()
  if (access.allowFrom.includes(chat_id) || linkedCoordinators(S).includes(chat_id)) return
  if (GROUP_ID_RE.test(chat_id) && Object.hasOwn(access.groups, chat_id)) return
  throw new Error(`chat ${chat_id} is not allowlisted — the user must add it with /squadra:access`)
}

// Before writing to a session this one is pinned to (allow-pins.json), it
// must still be that identity: a name deleted and registered again by
// someone else gets nothing. Checked at most once a minute per name; if it
// can't be checked, nothing is sent.
export async function peerMatchesPin(s, name) {
  const pins = readAllowPins(s)
  if (!Object.hasOwn(pins, name)) return true
  s.peerChecks ??= new Map()
  const c = s.peerChecks.get(name)
  if (c && c.pin === pins[name] && Date.now() - c.at < 60_000) return c.ok
  let info
  try { info = await call('getChat', { chat_id: name }, { s }) } catch (err) {
    if (err instanceof ApiError && err.code === 400) return false // (not registered now)
    throw new Error(`could not check that "${name}" is still the session this one paired with (${err.message}); try again`)
  }
  const ok = !info?.squadra_identity || pins[name] === `i:${info.squadra_identity}`
  if (s.peerChecks.size > 500) s.peerChecks.clear()
  s.peerChecks.set(name, { ok, pin: pins[name], at: Date.now() })
  return ok
}
export async function assertPeerIsPinned(chat_id) {
  const s = S
  if (!s || GROUP_ID_RE.test(chat_id)) return
  // A worker's coordinator: its own pin too (checked at most once a minute).
  if (s.role === 'worker' && chat_id === s.coordinator && (await checkCoordinator(s)) !== true) {
    throw new Error(`"${chat_id}" could not be confirmed as the coordinator this session was paired with: nothing was sent`)
  }
  if (!(await peerMatchesPin(s, chat_id))) {
    throw new Error(`"${chat_id}" is not the session this one paired with (it was deleted and registered again on the server): nothing was sent. If that is expected, the user can run /squadra:access unpin ${chat_id}`)
  }
}

function pruneExpired(a) {
  const t = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < t) { delete a.pending[code]; changed = true }
  }
  return changed
}

// Which registration of each name this session talks to (the server's
// random identity), taken from its first message or its pairing request. A
// name deleted and registered again — by anyone with the join token — is a
// different session: its messages are dropped until the user re-allows it.
export function forgetCoordinatorPin(s, coordinator) {
  try {
    const pin = JSON.parse(readFileSync(s.coordinatorPinFile, 'utf8'))
    if (pin?.name === coordinator) rmSync(s.coordinatorPinFile, { force: true })
  } catch {}
  const pins = readAllowPins(s)
  if (Object.hasOwn(pins, coordinator)) {
    delete pins[coordinator]
    try { writePrivateFile(s.allowPinsFile, JSON.stringify(pins, null, 2) + '\n') } catch {}
  }
}
export function readAllowPins(s) {
  try {
    const p = JSON.parse(readFileSync(s.allowPinsFile, 'utf8'))
    if (p && typeof p === 'object' && !Array.isArray(p)) return p
  } catch {}
  return {}
}
export function pinAllowed(s, senderId, identity) {
  if (!s || !identity) return true // (a server that doesn't say: nothing to compare)
  const want = `i:${identity}`
  const pins = readAllowPins(s)
  if (Object.hasOwn(pins, senderId)) {
    if (pins[senderId] === want) return true
    s.allowPinWarned ??= new Set()
    if (!s.allowPinWarned.has(senderId)) {
      s.allowPinWarned.add(senderId)
      log(`"${senderId}" is not the session this one paired with (it was registered again on the server): ignoring it`)
      if (active(s)) {
        agent.deliver({
          content: `Squadra warning: the session "${senderId}" is not the one this session paired with (it was deleted and registered again on the server). Its messages are being ignored. Tell the user: if this is expected, they can run /squadra:access unpin ${senderId}.`,
          meta: { kind: 'squadra_notice', user: 'squadra' },
        })
      }
    }
    return false
  }
  pins[senderId] = want
  // Bounded: names no longer allowed anywhere are forgotten first.
  const names = Object.keys(pins)
  if (names.length > 500) {
    const a = loadAccess(s)
    const kept = new Set([...a.allowFrom, ...linkedCoordinators(s), ...Object.values(a.pending ?? {}).map(p => p.senderId),
      ...Object.values(a.groups ?? {}).flatMap(g => [...(g.allowFrom ?? []), ...(g.invite ?? [])]), senderId])
    for (const n of names) if (!kept.has(n)) delete pins[n]
  }
  try { writePrivateFile(s.allowPinsFile, JSON.stringify(pins, null, 2) + '\n') } catch {}
  return true
}

export function gate(msg, { pairing = true } = {}) {
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = msg.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = msg.chat?.type
  // Only well-formed names and groups: these ids end up in access.json and in
  // file names (approved/<senderId>), so anything else is dropped.
  if (!NAME_RE.test(senderId)) return { action: 'drop' }
  if (chatType === 'private' && String(msg.chat.id) !== senderId) return { action: 'drop' }
  if (chatType === 'group' && !GROUP_ID_RE.test(String(msg.chat.id))) return { action: 'drop' }

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId) || linkedCoordinators(S).includes(senderId)) {
      return pinAllowed(S, senderId, from.squadra_identity) ? { action: 'deliver', access } : { action: 'drop' }
    }
    if (access.dmPolicy === 'allowlist' || !pairing) return { action: 'drop' }

    // pairing mode — check for existing non-expired code for this sender
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        // Reply twice max (initial + one reminder), then go silent.
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    // One pending code per sender (above), at most 10 in all. Extra attempts are silently dropped.
    if (Object.keys(access.pending).length >= 10) return { action: 'drop' }

    const code = randomBytes(3).toString('hex') // 6 hex chars
    const t = Date.now()
    access.pending[code] = {
      senderId,
      chatId: String(msg.chat.id),
      createdAt: t,
      expiresAt: t + 60 * 60 * 1000, // 1h
      replies: 1,
    }
    saveAccess(access)
    // Approving this code pairs with the session that asked for it (pinned
    // now if the name wasn't; a pin already there is never replaced by a
    // request: only the user's unpin does that).
    pinAllowed(S, senderId, from.squadra_identity)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group') {
    const groupId = String(msg.chat.id)
    const policy = Object.hasOwn(access.groups, groupId) ? access.groups[groupId] : null
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: 'drop' }
    if (requireMention && !isMentioned(msg, access.mentionPatterns)) return { action: 'drop' }
    if (!pinAllowed(S, senderId, from.squadra_identity)) return { action: 'drop' }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

// Like gate() but for commands: no pairing side effects, just allow/drop.
// Answers to /start, /help and /status: at most 2 per sender an hour (each
// one is a message this session sends, from its own sending budget).
const commandAnswers = new Map()
export function dmCommandGate(msg) {
  if (msg.chat?.type !== 'private' || !msg.from) return null
  const senderId = String(msg.from.id)
  if (!NAME_RE.test(senderId) || String(msg.chat.id) !== senderId) return null
  const recent = (commandAnswers.get(senderId) ?? []).filter(t => Date.now() - t < 3600_000)
  if (recent.length >= 2) return null
  recent.push(Date.now())
  commandAnswers.set(senderId, recent)
  if (commandAnswers.size > 1000) commandAnswers.delete(commandAnswers.keys().next().value)
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)
  if (access.dmPolicy === 'disabled') return null
  if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) return null
  return { access, senderId }
}

function isMentioned(msg, extraPatterns) {
  const text = msg.text ?? msg.caption ?? ''
  const escaped = S.name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  if (new RegExp(`(^|[^A-Za-z0-9_-])@${escaped}(?![A-Za-z0-9_-])`, 'i').test(text)) return true
  // Reply to one of our messages counts as an implicit mention.
  if (msg.reply_to_message?.from?.id === S.name) return true
  for (const pat of extraPatterns ?? []) {
    try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
  }
  return false
}
