import { join } from 'node:path'
import { statSync, createReadStream } from 'node:fs'
import {
  guardRequest, sendJson, clientIp, readParams, bearer, own, sendError, VERSION, UI_FILE, VENDOR_FILES,
  MAX_JSON_BODY, cachedFile, pageHeaders, ApiError, allowServerWide, ipKey, sha256, refuseSocket, logError,
  ALLOW_TOKEN_API, atLeast, pathTooLong, cleanText, trimSlashes,
} from './platform/index.js'
import {
  INSTALLERS, installer, hostScript, hostSignature, checkEnrollRate, enrollmentKey, offeredCredential,
} from './machines/index.js'

const MAX_IDENTITIES = Number(process.env.SQUADRA_MAX_SESSIONS ?? 500)

export function createRoutes(server, companies, accounts) {
  const { isServerToken, serverIdentity } = server

  // Who calls /api: the server token, only until there are users (or if this
  // server was started to keep it); otherwise a finished sign-in.
  function actorOf(req, token) {
    if (token) {
      if (isServerToken(token) && (ALLOW_TOKEN_API || !accounts.hasUsers())) return { token: true }
      throw new ApiError(401, 'Unauthorized')
    }
    return accounts.actorOf(req)
  }

  // The company a dashboard or an admin call is for, by the id it names.
  function named(id) {
    const company = companies.get(String(id))
    if (!company) throw new ApiError(404, 'Not Found: no such company')
    return company
  }

  // A call about one company, by someone who is in it. For anyone else it doesn't
  // exist. A role too low is told so, and what no table mentions nobody may do.
  async function companyCall(company, what, req, res, url, actor) {
    const role = actor.token ? 'owner' : accounts.roleIn(actor, company.id)
    if (!role) throw new ApiError(404, 'Not Found: no such company')
    req.actor = actor.token ? null : actor
    const allow = needed => { if (!atLeast(role, needed)) throw new ApiError(403, `Forbidden: this needs the role ${needed} in this company`) }
    // Checked again once the body has arrived: a request that started before
    // someone lost access doesn't act after it.
    const bodyOf = async needed => {
      const params = await readParams(req, url)
      if (!actor.token) {
        accounts.actorOf(req)
        if (!atLeast(accounts.roleIn(actor, company.id), needed)) throw new ApiError(403, `Forbidden: this needs the role ${needed} in this company`)
      }
      return params
    }

    // What is written down: every change, by whom, with what it was about and
    // never its content. (Not what only moves things around on the screen.)
    const written = (action, params) => {
      if (action === 'org/positions' || action === 'terminal/ticket' || action === 'hosts/personas') return
      const target = params.session ?? params.term ?? params.name ?? params.host ?? params.coordinator ?? params.email ?? params.user ?? null
      company.platform.audit(actor, action, target == null ? null : cleanText(String(target).slice(0, 400)).slice(0, 200), clientIp(req))
    }

    const people = own(accounts.companyMethods, what) ?? own(companies.companyMethods, what)
    if (people) {
      if (req.method !== people.method) throw new ApiError(405, 'Method Not Allowed')
      allow(people.role)
      const params = req.method === 'POST' ? await bodyOf(people.role) : {}
      // (The role as it is now, for what it may give.)
      const actorRole = actor.token ? 'owner' : accounts.roleIn(actor, company.id)
      if (req.method === 'POST') written(what, params)
      if (people.streams) {
        written(what, params)
        // (Once it has started answering, an error can only cut it short.)
        return await people.run({ company, actor, actorRole, params, req, res, url }).catch(err => { if (res.headersSent) res.destroy(); else throw err })
      }
      return sendJson(res, 200, { ok: true, result: await people.run({ company, actor, actorRole, params, req, url }) })
    }

    const { dashboardActions, dashboardRoles, openStream, dashboardReads } = company.dashboard
    if (req.method === 'POST') {
      const act = own(dashboardActions, what)
      if (!act) throw new ApiError(404, 'Not Found')
      const needed = own(dashboardRoles.actions, what)
      allow(needed)
      const params = await bodyOf(needed)
      const result = await act(params, req)
      written(what, params)
      return sendJson(res, 200, { ok: true, result })
    }
    if (req.method !== 'GET') throw new ApiError(405, 'Method Not Allowed')
    if (what === 'stream') { allow(dashboardRoles.reads.stream); return openStream(req, res) }
    const fn = own(dashboardReads, what)
    if (!fn) throw new ApiError(404, 'Not Found')
    allow(own(dashboardRoles.reads, what))
    return sendJson(res, 200, { ok: true, result: fn(url.searchParams) })
  }

  // /api about the server itself: companies and users.
  async function platformCall(what, req, res, url, actor) {
    if (what === 'companies') {
      if (req.method !== 'GET') throw new ApiError(405, 'Method Not Allowed')
      if (actor.token || actor.is_platform_admin) return sendJson(res, 200, { ok: true, result: companies.list() })
      const mine = companies.list().filter(c => accounts.roleIn(actor, c.id))
      return sendJson(res, 200, { ok: true, result: mine.map(c => ({ id: c.id, name: c.name, status: c.status })) })
    }
    // A company waiting to be deleted: its owners and administrators can bring it back.
    if (what === 'companies/restore') {
      if (req.method !== 'POST') throw new ApiError(405, 'Method Not Allowed')
      const id = String((await readParams(req, url)).company ?? '')
      if (!actor.token && !actor.is_platform_admin && accounts.roleIn(actor, id) !== 'owner') throw new ApiError(404, 'Not Found: no company waiting to be deleted with that id')
      const restored = companies.restore(id)
      accounts.audit(actor, 'company-restored', id, req)
      return sendJson(res, 200, { ok: true, result: restored })
    }
    if (!actor.token && !actor.is_platform_admin) throw new ApiError(403, 'Forbidden: this is for administrators of the server')
    if (what === 'machines') {
      if (req.method !== 'GET') throw new ApiError(405, 'Method Not Allowed')
      return sendJson(res, 200, { ok: true, result: companies.machines() })
    }
    if (what === 'companies/create') {
      if (req.method !== 'POST') throw new ApiError(405, 'Method Not Allowed')
      const params = await readParams(req, url)
      if (!actor.token && !accounts.actorOf(req).is_platform_admin) throw new ApiError(403, 'Forbidden: this is for administrators of the server')
      const made = companies.adminMethods.createCompany(params)
      accounts.audit(actor, 'company-created', made.id, req, made.name)
      return sendJson(res, 200, { ok: true, result: made })
    }
    const method = own(accounts.adminMethods, what)
    if (!method) throw new ApiError(404, 'Not Found')
    if (req.method !== method.method) throw new ApiError(405, 'Method Not Allowed')
    const params = req.method === 'POST' ? await readParams(req, url) : {}
    if (!actor.token && !accounts.actorOf(req).is_platform_admin) throw new ApiError(403, 'Forbidden: this is for administrators of the server')
    return sendJson(res, 200, { ok: true, result: method.run({ actor, params, req }) })
  }

  async function handle(req, res) {
    if (!guardRequest(req, res)) return
    try {
      if (pathTooLong(req.url)) throw new ApiError(414, 'URI Too Long')
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = trimSlashes(url.pathname) || '/'

      if (path === '/health') return sendJson(res, 200, { ok: true, result: 'ok', version: VERSION })

      // Dashboard page: public HTML; it asks for the server token and sends it
      // with every /api call.
      if (req.method === 'GET' && (path === '/' || path === '/ui')) {
        const page = cachedFile(UI_FILE, body => ({ headers: pageHeaders(body) }))
        if (!page) throw new ApiError(404, 'Not Found')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.body.length, 'Cache-Control': 'no-store', ...page.headers })
        return res.end(page.body)
      }
      // What the page is made of: only scripts and styles by a plain name, from
      // its own folder. (Public, like the page; not cached, so an update takes
      // effect at once and the parts of a page are never from two versions.)
      const uiFile = req.method === 'GET' ? /^\/ui\/([a-z0-9-]+)\.(js|css)$/.exec(path) : null
      if (uiFile) {
        const f = cachedFile(new URL(`./ui/${uiFile[1]}.${uiFile[2]}`, import.meta.url))
        if (!f) throw new ApiError(404, 'Not Found')
        res.writeHead(200, { 'Content-Type': uiFile[2] === 'js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Content-Length': f.body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        return res.end(f.body)
      }
      // The web terminal (xterm.js), served from here rather than a CDN.
      if (req.method === 'GET' && Object.hasOwn(VENDOR_FILES, path)) {
        const [file, type] = VENDOR_FILES[path]
        const f = cachedFile(new URL(file, import.meta.url))
        if (!f) throw new ApiError(404, 'Not Found')
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': f.body.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' })
        return res.end(f.body)
      }

      // squadra-host: the program itself (public, like the dashboard page) and enrollment.
      if (req.method === 'GET' && path === '/host/squadra-host.mjs') {
        const f = hostScript()
        if (!f) throw new ApiError(404, 'Not Found')
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': f.body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        return res.end(f.body)
      }
      // Its release signature, checked by squadra-host update with the key it
      // already has: a server can't hand a machine a program of its own.
      if (req.method === 'GET' && path === '/host/squadra-host.mjs.sig') {
        const f = hostSignature()
        if (!f) throw new ApiError(404, 'Not Found')
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': f.body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        return res.end(f.body)
      }
      if (req.method === 'GET' && path.startsWith('/install/') && Object.hasOwn(INSTALLERS, path.slice('/install/'.length))) {
        const f = installer(path.slice('/install/'.length))
        if (!f) throw new ApiError(404, 'Not Found')
        res.writeHead(200, { 'Content-Type': INSTALLERS[path.slice('/install/'.length)], 'Content-Length': f.body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        return res.end(f.body)
      }
      // Proof that this is the server they remember (public, like the two above).
      if (req.method === 'GET' && path === '/server-identity') {
        if (!allowServerWide('server-identity', ipKey(clientIp(req)), 300)) throw new ApiError(429, 'Too Many Requests: retry in a minute')
        return sendJson(res, 200, { ok: true, result: serverIdentity(url.searchParams.get('nonce')) })
      }
      if (path === '/host/enroll') {
        if (req.method !== 'POST') throw new ApiError(405, 'Method Not Allowed')
        checkEnrollRate(req)
        const params = await readParams(req, url, 64 * 1024, { pool: 'public' })
        const key = enrollmentKey(params.code)
        const result = companies.forEnrollment(key).machines.enrollHost(params, req)
        companies.enrolled(key)
        return sendJson(res, 200, { ok: true, result })
      }

      const token = bearer(req)

      // A machine's secret stays in an Authorization header, which proxies hide
      // from their logs: to connect, it trades it for a ticket of one use.
      if (path === '/host/ticket') {
        if (req.method !== 'POST') throw new ApiError(405, 'Method Not Allowed')
        if (req.headers.origin) throw new ApiError(403, 'Forbidden')
        const company = companies.of(token)
        const host = token ? company.platform.db.prepare('SELECT id, public_key FROM hosts WHERE secret_hash = ?').get(sha256(token)) : null
        if (!host) throw new ApiError(401, 'Unauthorized')
        if (!company.platform.allow('hostticket', host.id, 60)) throw new ApiError(429, 'Too Many Requests: retry in a minute')
        return sendJson(res, 200, { ok: true, result: company.machines.hostTicketAnswer(host, await readParams(req, url, 4096, { pool: 'public' })) })
      }

      if (path === '/bootstrap' || path.startsWith('/auth/')) return await accounts.handle(path, req, res, url)

      if (path.startsWith('/api/')) {
        // (Before a sign-in is finished too: the page needs to know what to ask for.)
        if (path === '/api/me' && !token) return sendJson(res, 200, { ok: true, result: accounts.meAnswer(req) })
        const actor = actorOf(req, token)
        const what = path.slice('/api/'.length)
        // /api/c/<company>/<what>.
        if (what.startsWith('c/')) {
          const m = /^c\/([^/]+)\/(.+)$/.exec(what)
          if (!m) throw new ApiError(404, 'Not Found')
          return await companyCall(named(m[1]), m[2], req, res, url, actor)
        }
        if (what === 'companies' || what.startsWith('companies/') || what === 'users' || what.startsWith('users/') || what === 'machines' || what === 'pending-links' || what === 'pending-links/cancel') return await platformCall(what, req, res, url, actor)
        // Without a company: scripts with the server token, on the first one.
        if (!actor.token) throw new ApiError(404, 'Not Found')
        return await companyCall(companies.first(), what, req, res, url, actor)
      }

      // Registration: the join token registers new names; the server token can
      // also rotate an existing name's secret (reset).
      if (path === '/register') {
        const admin = isServerToken(token)
        // (The server token says which company in the request; the join token is of one.)
        const joining = admin ? null : companies.of(token)
        if (!admin && !joining.platform.isJoinToken(token)) throw new ApiError(401, 'Unauthorized')
        // New names: 10 a minute per address and 60 overall per company, and a cap
        // in all, so per-session budgets can't be multiplied by registering more names.
        if (!admin && (!allowServerWide('register-ip', ipKey(clientIp(req)), 10) || !joining.platform.allow('register', 'all', 60))) {
          throw new ApiError(429, 'Too Many Requests: retry in a minute')
        }
        const roomForOne = () => {
          if (!admin && joining.platform.db.prepare('SELECT COUNT(*) AS n FROM identities').get().n >= joining.platform.quota('max_sessions', MAX_IDENTITIES)) {
            const max = joining.platform.quota('max_sessions', MAX_IDENTITIES)
            throw new ApiError(403, `Forbidden: this server already has ${max} sessions; delete some in the dashboard (or raise SQUADRA_MAX_SESSIONS)`)
          }
        }
        roomForOne()
        const params = await readParams(req, url, admin ? MAX_JSON_BODY : 4096, admin ? undefined : { pool: 'public' })
        roomForOne() // (others may have registered while this body arrived)
        if (params.reset === true && !admin) {
          throw new ApiError(403, 'Forbidden: only the server (admin) token can rotate an existing identity; delete the session from the dashboard and register it again, or ask the admin')
        }
        const target = admin && params.company != null ? named(params.company) : joining ?? companies.first()
        return sendJson(res, 200, { ok: true, result: target.sessions.register(params.name, admin && params.reset === true, { joined: !admin }) })
      }
      // Admin: server token only. What is about one company says which (the first, if not).
      if (path.startsWith('/admin/')) {
        if (!isServerToken(token)) throw new ApiError(401, 'Unauthorized')
        const method = path.slice('/admin/'.length)
        const params = await readParams(req, url)
        // (Once there are people, what is done with the token is written down.)
        if (accounts.hasUsers()) accounts.audit({ token: true }, `admin-${method}`.slice(0, 60), params.company == null ? null : String(params.company).slice(0, 64), req)
        if (method === 'recoverAccess') return sendJson(res, 200, { ok: true, result: accounts.recoverAccess(params, req) })
        const overall = own(companies.adminMethods, method)
        if (overall) return sendJson(res, 200, { ok: true, result: overall(params) })
        const company = params.company != null ? named(params.company) : companies.first()
        const fn = own(company.dashboard.adminMethods, method)
        if (!fn) throw new ApiError(404, 'Not Found: method not found')
        return sendJson(res, 200, { ok: true, result: fn(params) })
      }

      // Everything else: identity secret, in the company it says it is of.
      const company = companies.of(token)
      const { db, dataDir, readLimit, spendStorage } = company.platform
      const { identityFromSecret, leases, notHolder, touch, readParamsAs, getUpdates } = company.sessions
      const { canSeeFile, upload } = company.messaging
      const name = identityFromSecret(token)
      if (!name) throw new ApiError(401, 'Unauthorized')
      // Once a session holds this name, only that session (its instance id,
      // which the plugin keeps in memory) can act as it: a copy of
      // identity.json alone can't speak for a coordinator. Another session can
      // only take the name over by claiming it once the holder is gone.
      const lease = leases.get(name)
      // (claim, poll and release check the instance themselves.)
      if (lease && path !== '/claimSession' && path !== '/getUpdates' && path !== '/releaseSession') {
        const inst = String(req.headers['x-squadra-instance'] ?? '')
        if (inst !== lease.instance) throw notHolder(name, inst)
      }
      // A session with a key acts only from the session id that proved it: its
      // secret alone (a copy in a log, say) does nothing, connected or not.
      const keyed = db.prepare('SELECT public_key, proven_instance FROM identities WHERE name = ?').get(name)
      if (keyed?.public_key && path !== '/claimSession') {
        const inst = String(req.headers['x-squadra-instance'] ?? '')
        if (inst !== keyed.proven_instance) throw notHolder(name, inst)
      }
      touch(name)

      if (req.method === 'GET' && path.startsWith('/file/')) {
        readLimit(name, 'download')
        let rel
        try { rel = decodeURIComponent(path.slice('/file/'.length)) } catch { throw new ApiError(404, 'Not Found') }
        const f = db.prepare('SELECT * FROM files WHERE path = ?').get(rel)
        if (!f || !canSeeFile(name, f.file_id)) throw new ApiError(404, 'Not Found')
        spendStorage('download', name, f.size, 2 * 1024 ** 3) // at most 2 GB of downloads an hour
        const full = join(dataDir, f.path)
        const st = statSync(full)
        res.writeHead(200, {
          'Content-Type': f.mime ?? 'application/octet-stream',
          'Content-Length': st.size,
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'attachment',
        })
        createReadStream(full).on('error', () => res.destroy()).pipe(res)
        return
      }

      // Checked again once the body has arrived: a request that started before
      // its session was disconnected, deleted or taken over by another session
      // doesn't act after it.
      const stillValid = () => {
        if (identityFromSecret(token) !== name) throw new ApiError(401, 'Unauthorized')
        const l = leases.get(name)
        if (l && path !== '/claimSession' && path !== '/getUpdates' && path !== '/releaseSession' &&
          String(req.headers['x-squadra-instance'] ?? '') !== l.instance) {
          throw notHolder(name, String(req.headers['x-squadra-instance'] ?? ''))
        }
      }
      const method = path.slice(1)
      if (method === 'sendDocument' || method === 'sendPhoto') {
        if (req.method !== 'POST') throw new ApiError(405, 'Method Not Allowed')
        const msg = await upload(name, method === 'sendPhoto' ? 'photo' : 'document', url.searchParams, req, stillValid)
        return sendJson(res, 200, { ok: true, result: msg })
      }
      if (method === 'getUpdates') {
        const params = await readParamsAs(name, req, url)
        stillValid()
        return getUpdates(name, params, res)
      }
      const fn = own(company.methods, method)
      if (!fn) throw new ApiError(404, 'Not Found: method not found')
      const params = await readParamsAs(name, req, url)
      stillValid()
      // A claim comes with its session id in the header too, like every later
      // request: a plugin that doesn't send it (older than 0.0.2) would claim
      // the name and then fail at everything — it is told now instead.
      if (method === 'claimSession' && String(req.headers['x-squadra-instance'] ?? '') !== String(params.instance ?? '')) {
        throw notHolder(name, String(req.headers['x-squadra-instance'] ?? ''))
      }
      return sendJson(res, 200, { ok: true, result: await fn(name, params) })
    } catch (err) {
      sendError(res, err)
    }
  }

  // A socket goes to the company whose ticket or secret it comes with, which
  // does everything else about it.
  function onUpgrade(req, socket, head) {
    try {
      const cred = offeredCredential(req)
      const company = companies.all().find(c => c.machines.hasTicket(cred)) ?? companies.of(cred)
      company.machines.onUpgrade(req, socket, head)
    } catch (err) {
      socket.on('error', () => {})
      if (!(err instanceof ApiError)) logError(`bad upgrade request: ${err.message}`)
      refuseSocket(socket, err instanceof ApiError ? `${err.code} Unavailable` : '500 Internal Server Error')
    }
  }

  return { handle, onUpgrade }
}
