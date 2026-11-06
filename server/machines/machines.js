import {
  createHash, randomBytes, createPublicKey, generateKeyPairSync, hkdfSync, diffieHellman, createCipheriv,
  createDecipheriv,
} from 'node:crypto'
import {
  bad, ApiError, allowServerWide, ipKey, cachedFile, now, sha256, serverBaseUrl, clientIp, refuseSocket, logError,
  VERSION, cleanText, cutText, acceptWebSocket, sameOrigin,
} from '../platform/index.js'

const HOST_SCRIPT = [new URL('../../host/squadra-host.mjs', import.meta.url), new URL('../squadra-host.mjs', import.meta.url)]

// The installers that prepare a machine and run squadra-host (install/ in
// the repository, or next to this file in the Docker image).
export const INSTALLERS = { 'linux.sh': 'text/x-shellscript; charset=utf-8', 'macos.sh': 'text/x-shellscript; charset=utf-8', 'windows.bat': 'text/plain; charset=utf-8' }
export const installer = name => cachedFile(new URL(`../../install/${name}`, import.meta.url)) ?? cachedFile(new URL(`../install/${name}`, import.meta.url))
export const hostScript = () => {
  for (const f of HOST_SCRIPT) {
    const c = cachedFile(f, body => ({ sha: createHash('sha256').update(body).digest('hex') }))
    if (c) return c
  }
  return null
}

export const hostSignature = () => {
  for (const f of HOST_SCRIPT) {
    const c = cachedFile(new URL(`${f.href}.sig`))
    if (c) return c
  }
  return null
}

// Enrollment attempts: 10 a minute per address (IPv6 per /64). There is no
// overall cap on purpose: anyone could use it to block real enrollments, and
// codes are 40 bits, single use and valid 15 minutes, so guessing one is out
// of reach even from many addresses.
export const enrollmentKey = code => sha256(String(code ?? '').trim().toUpperCase())
export function checkEnrollRate(req) {
  if (!allowServerWide('enroll', ipKey(clientIp(req)), 10)) throw new ApiError(429, 'Too Many Requests: retry in a minute')
}

// What a socket says it comes with: as subprotocols, the only thing a browser
// can set on one.
const offeredProtocols = req => String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(x => x.trim())
export const offeredCredential = req => offeredProtocols(req).find(x => x.startsWith('auth.'))?.slice('auth.'.length) ?? ''

export function createMachines(platform, { sessions, observation }) {
  const {
    bus, db, broadcast, SERVER_KEY, joinToken, signAsServer, allow, takeChallenge, proofIsGood, credentialPrefix,
    routeEnrollment, log, companyId,
  } = platform
  const {
    NAME_RE, roleOf, checkApproval, isOnline, keyRefused, holdsName, leases, linksOf, register, dropLease,
  } = sessions
  const { activityOf } = observation

  // A persona: a skill or an agent a session follows (its machine found it in
  // the session's folder, or in that user's ~/.claude). Its id on the machine:
  const PERSONA_ID_RE = /^(skill|agent):(project|user):[A-Za-z0-9._-]{1,64}$/

  // A coordinator giving one of its workers a new task, unrelated to the last
  // one, can have the worker's context cleared first: lighter (cheaper) turns
  // from then on. Claude can't clear its own context, so the worker's machine
  // types /clear in its terminal, as the user would, and the worker's plugin
  // confirms it (its SessionStart "clear" event). Only the coordinator's own
  // worker, opened from the dashboard, connected and idle, once a minute.
  const FRESH_WAIT_MS = Number(process.env.SQUADRA_FRESH_WAIT_MS ?? 20_000)
  const freshWaiters = new Map() // worker -> resolve(confirmed)
  bus.on('context-cleared', name => freshWaiters.get(name)?.(true))
  async function freshStart(name, p) {
    const worker = String(p.chat_id ?? '')
    const no = (reason, text) => ({ cleared: false, reason, text })
    if (!NAME_RE.test(worker)) throw bad('chat_id must be one of your workers')
    const row = db.prepare('SELECT role, coordinator, host_id FROM identities WHERE name = ?').get(worker)
    if (roleOf(name) !== 'coordinator' || row?.role !== 'worker' || row.coordinator !== name) return no('not_your_worker', `"${worker}" is not a worker of yours`)
    checkApproval(name, worker, false)
    if (!row.host_id || !hostLinks.has(row.host_id)) return no('no_machine', `"${worker}" was not opened from the dashboard, or its machine is not connected: nobody can type /clear in its terminal`)
    if (!isOnline(worker)) return no('offline', `"${worker}" is not connected`)
    const state = activityOf(worker).state
    if (state !== 'idle') return no('busy', state === 'unknown' ? `what "${worker}" is doing is not known (its observation is off)` : `"${worker}" is not idle right now (${state})`)
    if (freshWaiters.has(worker)) return no('busy', `"${worker}" is being cleared already`)
    if (!allow('fresh', worker, 1, 60_000)) return no('too_soon', `"${worker}" was cleared less than a minute ago`)
    const confirmed = new Promise(resolve => freshWaiters.set(worker, resolve))
    const timer = setTimeout(() => freshWaiters.get(worker)?.(false), FRESH_WAIT_MS)
    try {
      try {
        await askHost(row.host_id, { t: 'clear', term: worker, coordinator: name })
      } catch (err) {
        return no('machine_refused', `its machine did not clear it: ${err.message.replace(/^(Bad Request|Conflict): /, '')}`)
      }
      if (await confirmed) {
        log(`"${name}" cleared the context of its worker "${worker}"`)
        return { cleared: true }
      }
      return no('not_confirmed', `/clear was typed in the terminal of "${worker}" but it didn't confirm it within ${Math.round(FRESH_WAIT_MS / 1000)} s`)
    } finally {
      clearTimeout(timer)
      freshWaiters.delete(worker)
    }
  }

  const machineMethods = {
    freshStart,
  }

  // A host is squadra-host running on a machine. It joins with a one-time code
  // the dashboard generates (POST /host/enroll), gets its own secret, and keeps a
  // WebSocket open to /host/connect. Through it the server can only ask for a
  // session *spec* (name, role, folder, compact window, persona id) — the host validates it
  // against its own local rules and always runs the same fixed command — and
  // relay terminal output and keystrokes for the dashboard's web terminal.
  //
  // Sessions are never opened by Claude: only the dashboard (the user) can.
  const ENROLL_TTL_MS = 15 * 60 * 1000
  const HOST_REPLY_TIMEOUT_MS = 20_000
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O, 1/I
  const hostLinks = new Map() // host id -> { ws, info, connectedAt, pending: Map(req -> {resolve, reject, timer}), viewers: Map(term -> Set(viewer)) }
  let hostReqSeq = 0

  function hostRow(id) {
    return db.prepare('SELECT * FROM hosts WHERE id = ?').get(id)
  }

  function hostView(row) {
    const link = hostLinks.get(row.id)
    let info = null
    try { info = link?.info ?? JSON.parse(row.info ?? 'null') } catch {}
    return {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      last_seen_at: link ? now() : row.last_seen_at,
      online: !!link,
      // Enrolled but never connected (it failed, or was never started).
      pending: !link && row.first_connected_at == null,
      connected_since: link?.connectedAt ?? null,
      enrollment: row.enrollment ?? null, // which "Add machine" code it used
      info,
    }
  }

  const listHosts = () => db.prepare('SELECT * FROM hosts ORDER BY name').all().map(hostView)

  function broadcastHost(id) {
    const row = hostRow(id)
    broadcast('host', row ? hostView(row) : { id, removed: true })
  }

  function enrollCode() {
    const bytes = randomBytes(8)
    const chars = [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
    return `${chars.slice(0, 4)}-${chars.slice(4)}`
  }

  // Dashboard: a one-time code, valid 15 minutes, and the command to run on the machine.
  function createEnrollment(p, req) {
    const name = String(p.name ?? '').trim()
    if (name && !/^[\p{L}\p{N} ._-]{1,40}$/u.test(name)) throw bad('the name may have letters, digits, spaces, dots, dashes and underscores (max 40)')
    const code = enrollCode()
    const t = now()
    db.prepare('DELETE FROM host_enrollments WHERE expires_at < ?').run(t)
    // (A random id, not derived from the code: the dashboard tells the machine
    // that used this very code from any other one that connects.)
    const ticket = randomBytes(12).toString('hex')
    db.prepare('INSERT INTO host_enrollments (code_hash, name, created_at, expires_at, configure_plugin, ticket) VALUES (?, ?, ?, ?, ?, ?)')
      .run(enrollmentKey(code), name, t, t + ENROLL_TTL_MS, p.configure_plugin === true ? 1 : 0, ticket)
    routeEnrollment(enrollmentKey(code), t + ENROLL_TTL_MS)
    const base = serverBaseUrl(req)
    const q = s => `'${String(s).replace(/'/g, `'\\''`)}'` // always a single shell word
    const ps = s => `'${String(s).replace(/'/g, "''")}'`
    // The command checks the program it downloads against this server's copy
    // (sha256sum on Linux, shasum on macOS) before running it.
    const sha = hostScript()?.sha ?? null
    // (A company's machine gets its own copy of everything: see squadra-host.)
    const company = credentialPrefix ? ` --company=${companyId}` : ''
    const verify = sha ? ` && echo ${q(`${sha}  squadra-host.mjs`)} | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -)` : ''
    return {
      code,
      enrollment: ticket,
      expires_at: t + ENROLL_TTL_MS,
      server_url: base,
      sha256: sha,
      server_key: SERVER_KEY.hash,
      // The Squadra plugin release that goes with this server (squadra-host pins the same one).
      plugin_command: `claude plugin marketplace add roke22/Squadra#v${VERSION} && claude plugin install squadra@squadra`,
      // One command per system: the installer prepares the machine (tmux, Node,
      // Claude Code) and runs squadra-host with this code. (Windows: inside WSL.)
      install: {
        linux: `curl -fsSL ${q(`${base}/install/linux.sh`)} | bash -s -- ${q(base)} ${code}${sha ? ` --sha256 ${sha}` : ''} --server-key=${SERVER_KEY.hash}${company}`,
        macos: `curl -fsSL ${q(`${base}/install/macos.sh`)} | bash -s -- ${q(base)} ${code}${sha ? ` --sha256 ${sha}` : ''} --server-key=${SERVER_KEY.hash}${company}`,
        // (PowerShell's quotes. "--server-key x", not "=": a .bat splits its arguments at "=".)
        windows: `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm ${ps(`${base}/install/windows.bat`)} -OutFile "$env:TEMP\\squadra-install.bat"; & "$env:TEMP\\squadra-install.bat" ${ps(base)} ${code}${sha ? ` --sha256 ${sha}` : ''} --server-key ${SERVER_KEY.hash}${credentialPrefix ? ` --company ${companyId}` : ''}`,
      },
      // Just squadra-host, on a machine that already has what it needs.
      // Downloaded into a new private folder: nobody can swap the file between the check and the run.
      command: `cd "$(mktemp -d)" && curl -fsSLo squadra-host.mjs ${q(`${base}/host/squadra-host.mjs`)}${verify} && node squadra-host.mjs enroll ${q(base)} ${code} --server-key=${SERVER_KEY.hash}${company}`,
    }
  }

  // Whoever could make codes lost access: those not used yet stop working.
  const cancelEnrollments = () => db.prepare('DELETE FROM host_enrollments').run()

  function enrollHost(p, req) {
    const ip = clientIp(req)
    const t = now()
    const row = db.prepare('SELECT * FROM host_enrollments WHERE code_hash = ?').get(enrollmentKey(p.code))
    if (!row || row.expires_at < t) {
      throw new ApiError(403, 'Forbidden: the code is wrong or has expired; generate a new one in the dashboard (Machines → + Add machine)')
    }
    // A copy of squadra-host set up for another company (without what the
    // dashboard's command says, say) would use another's folder.
    // (Older ones don't say, and only a company's own copy keeps its sessions apart:
    // the command for one always downloads this server's squadra-host.)
    if (String(p.company ?? (credentialPrefix ? '' : companyId)) !== companyId) throw new ApiError(403, 'Forbidden: this code is for another company: run the whole command the dashboard gives')
    db.prepare('DELETE FROM host_enrollments WHERE code_hash = ?').run(row.code_hash) // single use
    const id = `h_${randomBytes(8).toString('hex')}`
    const info = ownTerminals(sanitizeHostInfo(p.info), id)
    const secret = `sh_${credentialPrefix}${randomBytes(32).toString('base64url')}`
    // The hostname comes from the machine: keep only the characters a name may have.
    const fromHost = String(info?.hostname ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40)
    const name = row.name || fromHost || id
    db.prepare('INSERT INTO hosts (id, name, secret_hash, created_at, last_seen_at, info, enrollment) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, uniqueHostName(name), sha256(secret), t, t, JSON.stringify(info), row.ticket ?? null)
    broadcastHost(id)
    log(`host "${hostRow(id).name}" (${id}) enrolled from ${ip}`)
    return {
      id, secret, name: hostRow(id).name,
      // The plugin's server address always; the join token only if the admin
      // asked for it (sessions opened from the dashboard don't need it: their
      // names are registered by the server).
      plugin: { url: serverBaseUrl(req), ...(row.configure_plugin ? { token: joinToken().token } : {}) },
    }
  }

  function uniqueHostName(name) {
    let candidate = name.slice(0, 40)
    for (let i = 2; db.prepare('SELECT 1 FROM hosts WHERE name = ?').get(candidate); i++) candidate = `${name.slice(0, 36)}-${i}`
    return candidate
  }

  // What a host says about itself is shown in the dashboard: keep it small and typed.
  function sanitizeHostInfo(info) {
    if (!info || typeof info !== 'object') return null
    const str = (v, n = 200) => typeof v === 'string' ? cutText(cleanText(v.slice(0, n * 2)), n) : null
    const terminals = (Array.isArray(info.terminals) ? info.terminals : []).slice(0, 64).map(t => ({
      id: str(t?.id, 40),
      // A terminal is shown by its session's name, which is its id (a machine
      // can't label one of its terminals as another machine's session).
      name: str(t?.id, 40),
      role: ['coordinator', 'worker', 'solo'].includes(t?.role) ? t.role : null,
      coordinator: str(t?.coordinator, 40),
      folder: str(t?.folder, 500),
      compact_window: Number.isInteger(t?.compact_window) ? t.compact_window : null,
      persona: t?.persona && PERSONA_ID_RE.test(String(t.persona.id)) && ['skill', 'agent'].includes(t.persona.kind)
        ? { id: t.persona.id, kind: t.persona.kind, name: str(t.persona.name, 64) } : null,
      created_at: Number.isFinite(t?.created_at) ? t.created_at : null,
    })).filter(t => t.id && NAME_RE.test(t.id))
    return {
      hostname: str(info.hostname, 100),
      machine: /^[0-9a-f]{16,64}$/.test(String(info.machine)) ? info.machine : null, // (its word: only for showing)
      os_user: str(info.os_user, 64),
      shares_user: info.shares_user === true,
      platform: str(info.platform, 40),
      arch: str(info.arch, 40),
      node: str(info.node, 40),
      tmux: str(info.tmux, 40),
      claude: str(info.claude, 80),
      version: str(info.version, 40),
      folders: (Array.isArray(info.folders) ? info.folders : []).slice(0, 50).map(f => str(f, 500)).filter(Boolean),
      home: str(info.home, 500),
      // (Older machines don't say: their folders are changed there only.)
      folders_from_dashboard: info.folders_from_dashboard === true,
      max_sessions: Number.isInteger(info.max_sessions) ? info.max_sessions : null,
      allow_input: info.allow_input !== false,
      allow_resume: info.allow_resume === true, // (older machines don't say: taken as no)
      plugin: info.plugin && typeof info.plugin === 'object'
        ? { installed: info.plugin.installed === true, enabled: info.plugin.enabled === true, version: str(info.plugin.version, 40) }
        : null,
      terminals,
    }
  }

  // A machine can only list sessions it opened: a name the server reserved for
  // another machine is dropped from what it says it runs.
  function ownTerminals(info, hostId) {
    if (!info) return info
    info.terminals = info.terminals.filter(t => {
      const owner = db.prepare('SELECT host_id FROM identities WHERE name = ?').get(t.id)?.host_id
      return !owner || owner === hostId
    })
    return info
  }

  // Ask a connected host for something and wait for its reply.
  function askHost(id, msg) {
    const link = hostLinks.get(id)
    if (!link) {
      if (!hostRow(id)) throw bad('host not found')
      throw new ApiError(409, 'Conflict: that machine is not connected right now', { parameters: { reason: 'host_offline' } })
    }
    const req = ++hostReqSeq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        link.pending.delete(req)
        reject(new ApiError(504, 'Gateway Timeout: the machine did not answer in time'))
      }, HOST_REPLY_TIMEOUT_MS)
      link.pending.set(req, { resolve, reject, timer })
      link.ws.send(JSON.stringify({ ...msg, req }))
    })
  }

  function dropHostLink(hostId, link) {
    for (const p of link.pending.values()) { clearTimeout(p.timer); p.reject(new ApiError(502, 'Bad Gateway: the machine disconnected')) }
    link.pending.clear()
    for (const [term, set] of link.viewers) for (const v of set) { v.ws.send(JSON.stringify({ t: 'host_down', host: hostId, term })); v.attached.delete(`${hostId}\0${term}`) }
    link.viewers.clear()
  }

  function openHostLink(ws, req, row) {
    let link = null
    let hostId = null
    const hello = setTimeout(() => ws.close(4000, 'hello expected'), 10_000)
    // squadra-host pings every 25 s: a machine silent for 90 s is gone (it
    // crashed, slept or lost its network without closing), not online.
    let lastHeard = now()
    const alive = setInterval(() => { if (now() - lastHeard > 90_000) ws.close(4008, 'nothing heard for 90 seconds') }, 30_000)
    alive.unref?.()
    ws.onactivity = () => { lastHeard = now() }
    ws.onmessage = text => {
      lastHeard = now()
      let m
      try { m = JSON.parse(text) } catch {}
      if (!m || typeof m !== 'object' || Array.isArray(m)) return link ? undefined : ws.close(4000, 'hello expected')
      if (!link) {
        // (Authenticated when the socket was accepted: the hello carries its info.)
        if (m.t !== 'hello') return ws.close(4000, 'hello expected')
        // Disconnected from the dashboard meanwhile.
        if (!db.prepare('SELECT 1 FROM hosts WHERE id = ?').get(row.id)) return ws.close(4001, 'unknown or disconnected host')
        clearTimeout(hello)
        ws.maxMessage = 8 * 1024 * 1024 // terminal screens can be large (squadra-host keeps them under 2 MB)
        hostId = row.id
        // One live connection per host: the newest wins. The old one is cleaned
        // up first (its requests fail, its viewers are told).
        const old = hostLinks.get(hostId)
        if (old) { hostLinks.delete(hostId); dropHostLink(hostId, old); old.ws.close(4002, 'replaced by a newer connection') }
        // A hello without info: until the machine sends it (right after the
        // welcome), the last one known is shown.
        let known = null
        try { known = JSON.parse(row.info ?? 'null') } catch {}
        link = { ws, info: ownTerminals(sanitizeHostInfo(m.info ?? known), row.id), connectedAt: now(), pending: new Map(), viewers: new Map() }
        hostLinks.set(hostId, link)
        db.prepare('UPDATE hosts SET last_seen_at = ?, info = ?, first_connected_at = COALESCE(first_connected_at, ?) WHERE id = ?').run(now(), JSON.stringify(link.info), now(), hostId)
        ws.send(JSON.stringify({ t: 'welcome', host: { id: hostId, name: row.name } }))
        log(`host "${row.name}" connected from ${req.socket.remoteAddress}`)
        broadcastHost(hostId)
        return
      }
      switch (m.t) {
        case 'ping':
          // (Answered: the machine notices a server that silently went away.
          // Not to one that doesn't read its answers, and a few a minute.)
          if (ws.buffered > 64 * 1024) break
          if (allow('hostping', hostId, 30)) ws.send(JSON.stringify({ t: 'pong' }))
          break
        case 'info':
          // squadra-host sends it when something changes: a machine sending
          // it nonstop is ignored (each one is a database write and a broadcast).
          if (!allow('hostinfo', hostId, 60)) break
          link.info = ownTerminals(sanitizeHostInfo(m.info), hostId)
          db.prepare('UPDATE hosts SET last_seen_at = ?, info = ? WHERE id = ?').run(now(), JSON.stringify(link.info), hostId)
          broadcastHost(hostId)
          break
        case 'reply': {
          const p = link.pending.get(m.req)
          if (!p) break
          link.pending.delete(m.req)
          clearTimeout(p.timer)
          // (Only text from the machine: anything else is its generic refusal.)
          const why = typeof m.error === 'string' ? m.error : 'refused by the machine'
          if (m.ok) p.resolve(m.result ?? true)
          else p.reject(new ApiError(400, `Bad Request: ${cleanText(why.slice(0, 1000)).slice(0, 500)}`, { parameters: { reason: 'machine_refused' } }))
          break
        }
        case 'screen': case 'out': case 'exit': case 'notice': {
          if (typeof m.term !== 'string') break
          const term = m.term
          const set = link.viewers.get(term)
          if (!set) break
          const withData = m.t === 'out' || m.t === 'screen' // only output carries data
          const out = JSON.stringify({ t: m.t, host: hostId, term, data: withData && typeof m.data === 'string' ? m.data : undefined, text: typeof m.text === 'string' ? cleanText(m.text.slice(0, 600)).slice(0, 300) : undefined })
          for (const v of set) {
            // A viewer that can't keep up misses output and gets a fresh screen later.
            if (v.ws.buffered > 4 * 1024 * 1024) { if (withData) v.stale = true; continue }
            // Caught up after missing output: ask the machine for a fresh screen.
            if (v.stale && v.ws.buffered < 1024 * 1024) { v.stale = false; link.ws.send(JSON.stringify({ t: 'refresh', term })) }
            if (link.viewers.get(term) !== set) break // (that send closed the machine's link: they were told)
            v.ws.send(out)
          }
          if (m.t === 'exit') link.viewers.delete(term)
          break
        }
      }
    }
    ws.onclose = () => {
      clearTimeout(hello)
      clearInterval(alive)
      if (!link || hostLinks.get(hostId) !== link) return
      hostLinks.delete(hostId)
      dropHostLink(hostId, link)
      if (hostRow(hostId)) db.prepare('UPDATE hosts SET last_seen_at = ? WHERE id = ?').run(now(), hostId)
      log(`host ${hostId} disconnected`)
      broadcastHost(hostId)
    }
  }

  // Dashboard web terminal: one WebSocket per browser tab, authenticated with
  // the server token in its first message, multiplexing every terminal it shows.
  function openViewerLink(ws, req, actor) {
    // (Authenticated when the socket was accepted, with a one-time ticket,
    // which says who asked for it: what is done here is theirs.)
    const viewer = { ws, attached: new Set(), typed: new Set() }
    ws.actor = actor
    const who = actor?.email ?? `dashboard (${req.socket.remoteAddress})`
    ws.maxMessage = 1024 * 1024 // (an image pasted into a terminal; text is at most 64 KB)
    const detachAll = () => {
      for (const key of viewer.attached) {
        const [host, term] = key.split('\0')
        detach(host, term)
      }
      viewer.attached.clear()
    }
    function detach(host, term) {
      const link = hostLinks.get(host)
      const set = link?.viewers.get(term)
      if (!set) return
      set.delete(viewer)
      if (!set.size) { link.viewers.delete(term); link.ws.send(JSON.stringify({ t: 'detach', term })) }
    }
    const size = (c, r) => ({ cols: Math.floor(Math.max(20, Math.min(Number(c) || 120, 500))), rows: Math.floor(Math.max(5, Math.min(Number(r) || 36, 200))) })
    ws.onmessage = text => {
      let m
      try { m = JSON.parse(text) } catch {}
      if (!m || typeof m !== 'object' || Array.isArray(m)) return
      const host = String(m.host ?? '')
      const term = String(m.term ?? '')
      const key = `${host}\0${term}`
      const link = hostLinks.get(host)
      // A dashboard can't make a machine work nonstop: at most 300 terminal
      // messages every 10 seconds per dashboard socket.
      const t = now()
      viewer.msgTimes = (viewer.msgTimes ?? []).filter(x => t - x < 10_000)
      if (viewer.msgTimes.length >= 300) return
      viewer.msgTimes.push(t)
      if (m.t === 'attach') {
        if (!link) return ws.send(JSON.stringify({ t: 'host_down', host, term }))
        if (!NAME_RE.test(term)) return
        // Already watching it: a refresh at the new size, nothing else.
        if (viewer.attached.has(key)) return link.ws.send(JSON.stringify({ t: 'resize', term, ...size(m.cols, m.rows) })), link.ws.send(JSON.stringify({ t: 'refresh', term }))
        if (!link.viewers.has(term)) link.viewers.set(term, new Set())
        link.viewers.get(term).add(viewer)
        viewer.attached.add(key)
        log(`${who} is viewing "${term}" on host ${host}`)
        return link.ws.send(JSON.stringify({ t: 'attach', term, ...size(m.cols, m.rows) }))
      }
      if (!viewer.attached.has(key) || !link) return
      if (m.t === 'detach') { viewer.attached.delete(key); return detach(host, term) }
      if (m.t === 'resize') return link.ws.send(JSON.stringify({ t: 'resize', term, ...size(m.cols, m.rows) }))
      if (m.t === 'refresh') { viewer.stale = false; return link.ws.send(JSON.stringify({ t: 'refresh', term })) }
      if (m.t === 'in' && typeof m.data === 'string' && m.data.length <= 64 * 1024) {
        if (!viewer.typed.has(key)) {
          viewer.typed.add(key)
          log(`${who} is typing in "${term}" on host ${host}`)
        }
        return link.ws.send(JSON.stringify({ t: 'in', term, data: m.data }))
      }
      // An image pasted into the terminal: to the machine, which saves it and
      // pastes its path into Claude Code (a few a minute per terminal).
      if (m.t === 'image' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(m.type) && typeof m.data === 'string' && m.data.length <= 800_000) {
        if (!allow('paste-image', key, 20)) return ws.send(JSON.stringify({ t: 'notice', host, term, text: 'too many images pasted: wait a minute' }))
        return link.ws.send(JSON.stringify({ t: 'image', term, type: m.type, data: m.data }))
      }
    }
    ws.onclose = () => detachAll()
    ws.send(JSON.stringify({ t: 'ready' }))
  }

  function onUpgrade(req, socket, head) {
    // Node hands the socket over without its error listener: a client that
    // resets it after being refused must not raise an uncaught error.
    socket.on('error', () => {})
    // Nothing in a request can take the server down. An address that isn't
    // even a URL is the client's mistake: refused, not logged.
    try { upgrade(req, socket, head) } catch (err) {
      if (err?.code === 'ERR_INVALID_URL') return refuseSocket(socket, '400 Bad Request')
      logError(`bad upgrade request: ${err.message}`)
      try { socket.destroy() } catch {}
    }
  }
  function upgrade(req, socket, head) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '')
    // squadra-host never sends an Origin: a browser page can't hold machine slots.
    if (path === '/host/connect' && req.headers.origin) { refuseSocket(socket, '403 Forbidden'); return }
    if (path !== '/host/connect' && path !== '/api/terminal') {
      refuseSocket(socket, '404 Not Found')
      return
    }
    // The dashboard's terminal socket only from the dashboard's own page (a
    // browser always sends Origin; squadra-host sends none).
    if (path === '/api/terminal' && req.headers.origin && !sameOrigin(req)) { refuseSocket(socket, '403 Forbidden'); return }
    // Authenticated before the socket is accepted, so nobody without a
    // credential holds a connection open: the credential comes as a
    // subprotocol ("squadra", "auth.<credential>"). The dashboard's is a
    // one-time ticket (POST /api/terminal/ticket), and so is a machine's (POST
    // /host/ticket); machines older than 0.0.7 send their secret here.
    const offered = offeredProtocols(req)
    const cred = offeredCredential(req)
    // (Credentials are random, 192 bits or more: a wrong one costs one lookup.)
    const refuse = (status, text) => refuseSocket(socket, `${status} ${text}`)
    if (!offered.includes('squadra') || !cred) {
      // squadra-host older than 0.0.2 (it sent its secret in a message): it is
      // told why, in the close reason it prints, and the log says so (once a
      // minute at most). The socket is closed at once.
      if (path === '/host/connect' && req.headers.upgrade?.toLowerCase() === 'websocket') {
        if (allowServerWide('old-host-log', 'all', 1)) log(`a squadra-host older than 0.0.2 tried to connect from ${req.socket.remoteAddress}: update it (see the README)`)
        const old = acceptWebSocket(req, socket, head, { log: logError, maxMessage: 1024 })
        old?.close(4426, 'this squadra-host is older than the server (0.0.2): update it: add the machine again from the dashboard (+ Add machine)')
        return
      }
      return refuse(426, 'Upgrade Required')
    }
    let host = null
    let ticketed = false
    let linkKeys = null
    let viewerTicket = null
    if (path === '/host/connect') {
      ticketed = cred.startsWith(HOST_TICKET_PREFIX)
      if (ticketed) {
        const taken = takeHostTicket(cred)
        host = taken ? db.prepare('SELECT * FROM hosts WHERE id = ?').get(taken.host) : null
        linkKeys = taken?.keys ?? null
      } else host = db.prepare('SELECT * FROM hosts WHERE secret_hash = ?').get(sha256(cred))
      // A machine reconnecting nonstop would write to the database and update
      // every dashboard each time: at most 30 connections a minute.
      if (host && !allow('hosthello', host.id, 30)) return refuse(429, 'Too Many Requests')
    } else {
      viewerTicket = takeTerminalTicket(cred)
      if (!viewerTicket) return refuse(401, 'Unauthorized')
    }
    const ws = acceptWebSocket(req, socket, head, { log: logError, maxMessage: 16 * 1024, protocol: 'squadra' })
    if (!ws) return
    // A machine that was disconnected is told so (and stops), at once.
    // (A ticket says nothing about the machine: lost in a restart of this
    // server, say. It asks for another, which tells it if it was disconnected.)
    if (path === '/host/connect' && !host && ticketed) { ws.close(4002, 'ticket expired: asking for another'); return }
    if (path === '/host/connect' && !host) { ws.close(4001, 'unknown or disconnected host'); return }
    // A machine that has proved its key doesn't connect with its secret alone,
    // nor without the encrypted link that key gets it.
    if (path === '/host/connect' && host.public_key && !linkKeys) { ws.close(4003, 'this machine has a key: update its squadra-host (0.0.7 or later)'); return }
    if (linkKeys) encryptSocket(ws, linkKeys)
    wsClients.add(ws)
    if (path === '/host/connect') openHostLink(ws, req, host)
    else openViewerLink(ws, req, viewerTicket.actor)
    const handler = ws.onclose
    ws.onclose = () => { wsClients.delete(ws); handler() }
  }

  // The same for a machine's link: 30 seconds, used once, for that machine.
  const HOST_TICKET_PREFIX = 'ht_'
  const hostTickets = new Map() // ticket -> { host, expires }
  function newHostTicket(host, keys = null) {
    for (const [t, v] of hostTickets) if (v.expires < Date.now()) hostTickets.delete(t)
    if (hostTickets.size >= 1000) hostTickets.delete(hostTickets.keys().next().value)
    const ticket = `${HOST_TICKET_PREFIX}${randomBytes(24).toString('base64url')}`
    hostTickets.set(ticket, { host, keys, expires: Date.now() + 30_000 })
    return ticket
  }
  function takeHostTicket(ticket) {
    const v = hostTickets.get(ticket)
    if (!v) return null
    hostTickets.delete(ticket)
    return v.expires >= Date.now() ? v : null
  }

  // A machine's ticket. With a proof of its key, the link it opens is encrypted
  // between the two of them, whatever is on the way: the keys come from an
  // exchange that this server signs and that machine proved it took part in.
  function hostTicketAnswer(host, p) {
    if (p.proof == null) {
      if (host.public_key) throw keyRefused('this machine has a key, and this request doesn\'t prove it: update its squadra-host (0.0.7 or later)')
      return { ticket: newHostTicket(host.id) }
    }
    const offered = String(p.key ?? '')
    const eph = String(p.eph ?? '')
    const fresh = takeChallenge(String(p.challenge ?? ''))
    if (!fresh || !proofIsGood(offered, 'host-ticket', host.id, p.challenge, eph, p.proof)) throw keyRefused('this request does not prove the machine\'s key; try again')
    if (host.public_key && host.public_key !== offered) throw keyRefused('this machine has a different key on this server. If it really lost its key, remove it in the dashboard and add it again; if not, something else may be using its secret')
    let peer
    try {
      peer = createPublicKey({ key: Buffer.from(eph, 'base64url'), format: 'der', type: 'spki' })
      if (peer.asymmetricKeyType !== 'x25519') throw new Error('not x25519')
    } catch { throw bad('eph is not a key') }
    if (!host.public_key) db.prepare('UPDATE hosts SET public_key = ? WHERE id = ?').run(offered, host.id)
    const mine = generateKeyPairSync('x25519')
    const myEph = mine.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
    const okm = Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey: mine.privateKey, publicKey: peer }), String(p.challenge), `squadra-link-1|${eph}|${myEph}`, 64))
    const ticket = newHostTicket(host.id, { fromHost: okm.subarray(0, 32), toHost: okm.subarray(32) })
    return { ticket, eph: myEph, sig: signAsServer(['squadra-link-1', eph, myEph, String(p.challenge), ticket]) }
  }

  // Every message on that link: AES-256-GCM, numbered by its place in each
  // direction, so none can be changed, repeated, dropped or moved unnoticed.
  const linkIv = n => { const iv = Buffer.alloc(12); iv.writeBigUInt64BE(n, 4); return iv }
  function encryptSocket(ws, { fromHost, toHost }) {
    let sent = 0n
    let received = 0n
    const rawSend = ws.send
    ws.send = text => {
      const c = createCipheriv('aes-256-gcm', toHost, linkIv(sent++))
      const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()])
      return rawSend(Buffer.concat([body, c.getAuthTag()]).toString('base64'))
    }
    let handler = () => {}
    const inbound = raw => {
      let text
      try {
        const all = Buffer.from(raw, 'base64')
        const d = createDecipheriv('aes-256-gcm', fromHost, linkIv(received++))
        d.setAuthTag(all.subarray(-16))
        text = Buffer.concat([d.update(all.subarray(0, -16)), d.final()]).toString('utf8')
      } catch {
        return ws.close(4003, 'a message that does not check')
      }
      handler(text)
    }
    Object.defineProperty(ws, 'onmessage', { get: () => inbound, set: h => { handler = h } })
  }

  // One-time tickets for the dashboard's terminal socket (a browser can't send
  // an Authorization header on a WebSocket): 30 seconds, used once.
  const terminalTickets = new Map() // ticket -> { expires (ms), actor }
  function newTerminalTicket(actor) {
    for (const [t, v] of terminalTickets) if (v.expires < Date.now()) terminalTickets.delete(t)
    if (terminalTickets.size >= 100) terminalTickets.delete(terminalTickets.keys().next().value)
    const ticket = randomBytes(24).toString('base64url')
    terminalTickets.set(ticket, { expires: Date.now() + 30_000, actor })
    return { ticket }
  }
  function takeTerminalTicket(ticket) {
    const v = ticket ? terminalTickets.get(ticket) : undefined
    if (v === undefined) return null
    terminalTickets.delete(ticket)
    return v.expires >= Date.now() ? v : null
  }
  // Someone lost access: a ticket they asked for and haven't used goes too.
  function dropTickets(match) {
    for (const [t, v] of terminalTickets) if (v.actor && match(v.actor)) terminalTickets.delete(t)
  }
  // (Tickets say nothing of whose they are: each company knows its own.)
  const hasTicket = ticket => hostTickets.has(ticket) || terminalTickets.has(ticket)
  const wsClients = new Set()

  function removeHost(id) {
    const row = hostRow(id)
    if (!row) throw bad('host not found')
    db.prepare('UPDATE identities SET host_id = NULL WHERE host_id = ?').run(id) // no longer "opened from the dashboard"
    db.prepare('DELETE FROM hosts WHERE id = ?').run(id)
    hostLinks.get(id)?.ws.close(4001, 'this machine was disconnected from the dashboard')
    broadcast('host', { id, removed: true })
    log(`host "${row.name}" (${id}) removed from the dashboard`)
    return { id, removed: true }
  }

  function renameHost(id, name) {
    name = String(name ?? '').trim()
    if (!/^[\p{L}\p{N} ._-]{1,40}$/u.test(name)) throw bad('the name may have letters, digits, spaces, dots, dashes and underscores (max 40)')
    if (!hostRow(id)) throw bad('host not found')
    if (db.prepare('SELECT 1 FROM hosts WHERE name = ? AND id != ?').get(name, id)) throw bad(`another machine is already called "${name}"`)
    db.prepare('UPDATE hosts SET name = ? WHERE id = ?').run(name, id)
    broadcastHost(id)
    return hostView(hostRow(id))
  }

  // Open a session on a host. The spec is passed through as-is: the host is the
  // one that validates it (its rules are local and the server can't widen them).
  // Here we only refuse names already taken by a connected session.
  // The name is reserved here, for this machine: the server registers it and
  // hands its secret to the machine with the spec, so nobody holding the join
  // token can grab the name first. A name registered by some other session is
  // refused (delete that session in the dashboard to free it).
  // Allow or remove a folder on a machine: the machine checks it against its
  // own rules (and may keep its folders to itself) and answers with its list.
  async function changeHostFolders(p) {
    const id = String(p.host ?? '')
    const action = p.action === 'add' || p.action === 'remove' ? p.action : null
    if (!action) throw bad('action must be add or remove')
    const path = typeof p.path === 'string' ? p.path.trim() : ''
    if (!path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) throw bad('a folder path is needed')
    const r = await askHost(id, { t: 'folders', action, path })
    return { folders: (Array.isArray(r?.folders) ? r.folders : []).slice(0, 50).filter(f => typeof f === 'string').map(f => cleanText(f.slice(0, 1000)).slice(0, 500)) }
  }

  // The skills and agents a session opened in that folder of a machine could
  // follow (the machine looks for them, within its own rules).
  async function hostPersonas(p) {
    const id = String(p.host ?? '')
    const folder = typeof p.folder === 'string' ? p.folder.trim() : ''
    if (!folder || folder.length > 4096 || /[\x00-\x1f\x7f]/.test(folder)) throw bad('a folder path is needed')
    const r = await askHost(id, { t: 'personas', folder })
    const str = (v, n) => typeof v === 'string' ? cleanText(v.slice(0, n * 2)).replace(/\s+/g, ' ').trim().slice(0, n) : ''
    return {
      personas: (Array.isArray(r?.personas) ? r.personas : []).slice(0, 200)
        .filter(x => x && PERSONA_ID_RE.test(String(x.id)) && ['skill', 'agent'].includes(x.kind) && ['project', 'user'].includes(x.scope))
        .map(x => ({ id: x.id, kind: x.kind, scope: x.scope, name: str(x.name, 64) || x.id.split(':')[2], description: str(x.description, 300), no_squadra_tools: x.no_squadra_tools === true })),
    }
  }

  async function openTerminalOn(p) {
    const id = String(p.host ?? '')
    const spec = p.spec && typeof p.spec === 'object' && !Array.isArray(p.spec) ? { ...p.spec } : null
    if (!spec) throw bad('spec is required')
    delete spec.identity
    const name = String(spec.name ?? '')
    if (!NAME_RE.test(name)) throw bad('name must match [A-Za-z0-9_-]{1,32}')
    if (!hostLinks.has(id)) return askHost(id, { t: 'open', spec }) // reports host_offline / not found
    if (holdsName(name, leases.get(name))) {
      throw new ApiError(409, `Conflict: a session named "${name}" is already connected`, { parameters: { reason: 'name_in_use' } })
    }
    const existing = db.prepare('SELECT host_id FROM identities WHERE name = ?').get(name)
    if (existing && existing.host_id !== id) {
      throw new ApiError(409, `Conflict: the name "${name}" is already registered by another session; pick another name, or delete that session in the dashboard`, { parameters: { reason: 'name_taken' } })
    }
    // Already running there (its plugin just not connected right now), or
    // being opened right now (a second click, another tab): its secret is left
    // alone, and the machine would refuse a second one anyway.
    const key = `${id}\0${name}`
    if (hostLinks.get(id)?.info?.terminals?.some(t => t.id === name) || opening.has(key)) {
      throw new ApiError(409, `Conflict: a session named "${name}" is already open on that machine`, { parameters: { reason: 'open_on_host' } })
    }
    opening.set(key, now())
    let timedOut = false
    try { return await openNow(id, name, spec, existing) } catch (err) {
      timedOut = err instanceof ApiError && err.code === 504
      throw err
    } finally {
      // (Kept a little after a timeout only: the machine may still be opening it.
      // Once it answered, yes or no, the name is free to try again.)
      if (timedOut) setTimeout(() => opening.delete(key), 15_000).unref?.()
      else opening.delete(key)
    }
  }
  const opening = new Map() // "host\0name" -> since: an open in progress
  async function openNow(id, name, spec, existing) {
    let created = false
    // The role it was opened with (the dashboard trusts that one, not whatever
    // the session claims later).
    const openedRole = spec.role === 'coordinator' || spec.role === 'solo' ? spec.role : 'worker'
    const openedPersona = PERSONA_ID_RE.test(String(spec.persona ?? '')) ? spec.persona : null
    // A coordinator's links are the ones set here, never what the page sends.
    delete spec.links
    if (openedRole === 'coordinator') { const l = linksOf(name); if (l.length) spec.links = l }
    if (!existing) {
      spec.identity = register(name, false).secret
      db.prepare('UPDATE identities SET host_id = ?, opened_role = ?, opened_persona = ? WHERE name = ?').run(id, openedRole, openedPersona, name)
      created = true
    } else {
      // Already this machine's name, and not connected: a new secret goes with
      // it, so the session can log in even if the last one never arrived (or
      // the session was disconnected from the dashboard).
      dropLease(name)
      spec.identity = register(name, true).secret
      db.prepare('UPDATE identities SET opened_role = ?, opened_persona = ? WHERE name = ?').run(openedRole, openedPersona, name)
    }
    // A worker's coordinator, as it was opened (until it says so itself at
    // login): the org chart keeps it in its squad while it isn't connected.
    if (openedRole === 'worker' && NAME_RE.test(String(spec.coordinator ?? ''))) db.prepare('UPDATE identities SET coordinator = ? WHERE name = ?').run(spec.coordinator, name)
    try {
      const result = await askHost(id, { t: 'open', spec })
      log(`opened session "${name}" on host ${id}`)
      return result
    } catch (err) {
      // Only when the machine said no: after a timeout it may still open the
      // session, and the name must stay reserved for it.
      if (created && err instanceof ApiError && err.code === 400) db.prepare('DELETE FROM identities WHERE name = ? AND host_id = ?').run(name, id)
      throw err
    }
  }

  async function killTerminalOn(p) {
    const id = String(p.host ?? '')
    const term = String(p.term ?? '')
    if (!NAME_RE.test(term)) throw bad('invalid session')
    return askHost(id, { t: 'kill', term })
  }

  return {
    machineMethods, onUpgrade, wsClients, sanitizeHostInfo, ownTerminals, PERSONA_ID_RE, listHosts,
    createEnrollment, renameHost, removeHost, changeHostFolders, hostPersonas, openTerminalOn,
    killTerminalOn, newTerminalTicket, hostRow, hostLinks, askHost, enrollHost, hostTicketAnswer, hasTicket, dropTickets, cancelEnrollments,
  }
}
