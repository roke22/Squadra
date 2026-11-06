import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ApiError, DATA_DIR, FIRST_COMPANY, ROLES, TLS, TRUST_PROXY, PUBLIC_URL, allowServerWide, countedServerWide, atLeast, bad, bearer, clientIp,
  cleanText, guarded, ipKey, now, readParams, sameOrigin, sendJson, serverBaseUrl, sha256,
} from '../platform/index.js'
import { NOBODY, checkNewPassword, hashPassword, passwordMatches } from './passwords.js'
import { checkTotp, newTotpSecret, openSecret, sealSecret } from './totp.js'

const COOKIE = 'squadra_session'
const SESSION_MS = 7 * 24 * 3600_000  // however much it is used
const IDLE_MS = 24 * 3600_000         // without being used
const INVITE_MS = 7 * 24 * 3600_000
const RESET_MS = 24 * 3600_000
const RECOVERY_CODES = 10
const EMAIL = /^[^\s@]{1,100}@[^\s@]{1,150}\.[^\s@]{1,50}$/

const tooMany = () => new ApiError(429, 'Too Many Requests: wait a few minutes and try again')
const cleanEmail = v => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 300) : '')
const cleanName = v => (typeof v === 'string' ? cleanText(v.slice(0, 200)).replace(/\s+/g, ' ').trim().slice(0, 80) : '')

// Who can sign in, and what they are in each company. It is about the whole
// server, in control.db: nothing here reads what is inside a company.
//
// A session goes through stages: 'totp' (password right, code missing),
// 'totp_setup' (password right, and this user must set codes up first) and 'ok'.
// Only the last one reaches anything beyond the screens to get there.
export function createAccounts(server, { control, companyName, companyStatus, dropClients }) {
  const { isServerToken } = server

  // The key for TOTP secrets: in the data folder, not in the database.
  const KEY_FILE = join(DATA_DIR, 'totp-key')
  const totpKey = (() => {
    try {
      const k = Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'base64url')
      if (k.length === 32) return k
    } catch {}
    const k = randomBytes(32)
    writeFileSync(KEY_FILE, `${k.toString('base64url')}\n`, { mode: 0o600 })
    return k
  })()

  const q = sql => control.prepare(sql)
  const userById = id => q('SELECT * FROM users WHERE id = ?').get(id)
  const userByEmail = email => q('SELECT * FROM users WHERE email = ?').get(email)
  const hasUsers = () => !!q('SELECT 1 FROM users LIMIT 1').get()
  // (The oldest first: the one someone lands in, when it isn't said which.)
  const membershipsOf = id => q('SELECT company_id, role FROM memberships WHERE user_id = ? ORDER BY created_at').all(id)
  const roleIn = (user, company) => q('SELECT role FROM memberships WHERE user_id = ? AND company_id = ?').get(user.id, company)?.role ?? null
  const ownersOf = company => q("SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? AND m.role = 'owner' AND u.disabled_at IS NULL").get(company).n

  function audit(actor, action, target, req, detail = null) {
    q('INSERT INTO platform_audit (at, user_id, action, target, ip, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(now(), actor?.id ?? (actor?.token ? 'server-token' : null), action, target ?? null, req ? clientIp(req) : null, detail)
  }

  // Whoever can write in terminals, or run the server, signs in with codes.
  const needsTotp = user => !!user.is_platform_admin || membershipsOf(user.id).some(m => atLeast(m.role, 'operator'))
  function stageOf(user, session) {
    if (user.totp_enabled_at) return session.mfa_ok ? 'ok' : 'totp'
    return needsTotp(user) ? 'totp_setup' : 'ok'
  }

  function isHttps(req) {
    return TLS || PUBLIC_URL.startsWith('https://') || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https')
  }
  // Over https, a name browsers keep to this very host: a neighbour under the
  // same domain can't set it.
  const cookieName = req => (isHttps(req) ? `__Host-${COOKIE}` : COOKIE)
  const cookieLine = (req, value, maxAge) => `${cookieName(req)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`

  function cookieOf(req) {
    const name = cookieName(req)
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const [k, v] = part.trim().split('=')
      if (k === name) return v ?? ''
    }
    return ''
  }

  function startSession(req, res, user, mfaOk) {
    const token = randomBytes(32).toString('base64url')
    const t = now()
    q('INSERT INTO login_sessions (token_hash, user_id, mfa_ok, ip, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sha256(token), user.id, mfaOk ? 1 : 0, clientIp(req), t, t, t + SESSION_MS)
    q('UPDATE users SET last_login_at = ? WHERE id = ?').run(t, user.id)
    res.setHeader('Set-Cookie', cookieLine(req, token, Math.floor(SESSION_MS / 1000)))
    return { token_hash: sha256(token), user_id: user.id, mfa_ok: mfaOk ? 1 : 0 }
  }

  // The second factor done: the session goes on under a new token, so one known
  // from before (planted in this browser for the victim to finish) is worth nothing.
  function finishSession(req, res, session) {
    const token = randomBytes(32).toString('base64url')
    q('UPDATE login_sessions SET token_hash = ?, mfa_ok = 1 WHERE token_hash = ?').run(sha256(token), session.token_hash)
    res.setHeader('Set-Cookie', cookieLine(req, token, Math.floor(SESSION_MS / 1000)))
    return { ...session, token_hash: sha256(token), mfa_ok: 1 }
  }

  // The session a request comes with, if it is still good.
  function sessionOf(req) {
    const token = cookieOf(req)
    if (!token) return null
    const hash = sha256(token)
    const s = q('SELECT * FROM login_sessions WHERE token_hash = ?').get(hash)
    if (!s) return null
    const t = now()
    if (s.expires_at < t || s.last_seen_at + IDLE_MS < t) { endSession(hash); return null }
    const user = userById(s.user_id)
    if (!user || user.disabled_at) return null
    // (Written at most once a minute: one write per request would keep the database busy.)
    if (t - s.last_seen_at > 60_000) q('UPDATE login_sessions SET last_seen_at = ? WHERE token_hash = ?').run(t, hash)
    return { session: s, user }
  }

  function endSession(hash) {
    q('DELETE FROM login_sessions WHERE token_hash = ?').run(hash)
    dropClients(a => a?.session === hash)
  }

  function endAllSessions(userId, { except = null } = {}) {
    q('DELETE FROM login_sessions WHERE user_id = ? AND token_hash IS NOT ?').run(userId, except)
    dropClients(a => a?.id === userId && a.session !== except)
  }

  // Who is calling, for what needs a finished sign-in. A request with a cookie
  // that changes something must come from this dashboard's own page.
  function actorOf(req) {
    const found = sessionOf(req)
    if (!found || stageOf(found.user, found.session) !== 'ok') throw new ApiError(401, 'Unauthorized')
    if (req.method !== 'GET' && !sameOrigin(req)) throw new ApiError(403, 'Forbidden')
    const { user, session } = found
    return { id: user.id, email: user.email, name: user.name, is_platform_admin: !!user.is_platform_admin, session: session.token_hash }
  }

  function me(user, session) {
    const stage = stageOf(user, session)
    // (Which companies, only once the sign-in is finished.)
    const mine = stage === 'ok' ? membershipsOf(user.id).map(m => ({ id: m.company_id, name: companyName(m.company_id), role: m.role, ...companyStatus(m.company_id) })).filter(c => c.name) : []
    const companies = mine.filter(c => c.status !== 'deleting').map(({ id, name, role }) => ({ id, name, role }))
    return {
      stage,
      // (Those of theirs waiting to be deleted: an owner can bring them back.)
      deleting: mine.filter(c => c.status === 'deleting' && c.role === 'owner').map(({ id, name, delete_after }) => ({ id, name, delete_after })),
      user: { id: user.id, email: user.email, name: user.name, is_platform_admin: !!user.is_platform_admin, totp_enabled: !!user.totp_enabled_at },
      companies,
    }
  }

  // Codes for this user: a new secret until one of its codes is entered.
  function setUpTotp(user) {
    const secret = newTotpSecret()
    q('UPDATE users SET totp_secret_enc = ?, totp_last_step = NULL WHERE id = ?').run(sealSecret(totpKey, user.id, secret), user.id)
    const label = encodeURIComponent(`Squadra:${user.email}`)
    return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=Squadra&algorithm=SHA1&digits=6&period=30` }
  }

  // Wrong codes: 5 every 5 minutes per person, however many sessions try.
  // (Only the wrong ones: signing in often is no reason to wait.)
  const CODES_WINDOW = 5 * 60_000
  function checkCodeBudget(user) { if (countedServerWide('wrong-code', user.id, CODES_WINDOW) >= 5) throw tooMany() }
  const codeFailed = user => allowServerWide('wrong-code', user.id, 1000, CODES_WINDOW)

  function codeIsGood(user, code) {
    const step = checkTotp(openSecret(totpKey, user.id, user.totp_secret_enc), String(code ?? '').replace(/\s/g, ''), user.totp_last_step)
    if (step === null) return false
    q('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id)
    return true
  }

  function recoveryCodeIsGood(user, code) {
    const hash = sha256(String(code ?? '').trim().toLowerCase())
    return q('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').run(now(), user.id, hash).changes > 0
  }

  function newRecoveryCodes(user) {
    q('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id)
    const codes = Array.from({ length: RECOVERY_CODES }, () => randomBytes(10).toString('hex'))
    for (const c of codes) q('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)').run(user.id, sha256(c))
    return codes
  }

  // Wrong passwords: 10 every 15 minutes per address and account, also per /48 for
  // IPv6, where one site has many /64. Only wrong ones count, so someone else's
  // failures never lock out whoever has the right password, however many
  // addresses they come from. (The cost: guesses spread over very many addresses
  // aren't stopped. Those who can do anything have a second factor as well.)
  const PASSWORD_WINDOW = 15 * 60_000
  const passwordKey = (req, email) => `${ipKey(clientIp(req))}\0${email}`
  const siteKey = (req, email) => { const ip = ipKey(clientIp(req)); return ip.endsWith('/64') ? `${ip.split(':').slice(0, 3).join(':')}\0${email}` : null }
  function checkPasswordBudget(req, email) {
    const site = siteKey(req, email)
    if (countedServerWide('wrong-password', passwordKey(req, email), PASSWORD_WINDOW) >= 10 || (site && countedServerWide('wrong-password-site', site, PASSWORD_WINDOW) >= 50)) throw tooMany()
  }
  function passwordFailed(req, email) {
    allowServerWide('wrong-password', passwordKey(req, email), 1000, PASSWORD_WINDOW)
    const site = siteKey(req, email)
    if (site) allowServerWide('wrong-password-site', site, 1000, PASSWORD_WINDOW)
  }
  // What a password was checked against may be out of date when the check ends
  // (it takes time, on purpose): a reset or a disable meanwhile wins.
  const stillHolds = user => { const now_ = userById(user.id); return !!now_ && !now_.disabled_at && now_.password_hash === user.password_hash }
  const dropResetLinks = email => q("DELETE FROM invitations WHERE kind = 'reset' AND email = ? AND used_at IS NULL").run(email)

  async function newUser({ email, name, password, isAdmin = false }) {
    checkNewPassword(password)
    const id = `u_${randomBytes(9).toString('base64url')}`
    const password_hash = await hashPassword(password)
    q('INSERT INTO users (id, email, name, password_hash, is_platform_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, email, name, password_hash, isAdmin ? 1 : 0, now())
    return userById(id)
  }

  // Joining never lowers anyone: an invitation for less is no way to demote
  // someone, least of all an owner. (Changing a role is members/role.)
  function addMember(user, company, role, by) {
    const current = roleIn(user, company)
    if (current && atLeast(current, role)) return current
    q(`INSERT INTO memberships (user_id, company_id, role, created_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, company_id) DO UPDATE SET role = excluded.role`).run(user.id, company, role, by ?? null, now())
    return role
  }

  // Pending invitations to this company for someone whose place in it was just decided.
  const dropInvitationsFor = (company, email) => q("DELETE FROM invitations WHERE kind = 'invite' AND company_id = ? AND email = ? AND used_at IS NULL").run(company, email)

  // A link of one use, to copy by hand: there is no mail in this server.
  function newLink(req, kind, fields, ttl, by) {
    const token = randomBytes(32).toString('base64url')
    q('INSERT INTO invitations (token_hash, kind, email, company_id, role, is_platform_admin, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha256(token), kind, fields.email, fields.company ?? null, fields.role ?? null, fields.isAdmin ? 1 : 0, by ?? null, now() + ttl)
    return { link: `${serverBaseUrl(req)}/#/${kind}/${token}`, expires_at: now() + ttl }
  }

  function linkFor(kind, token) {
    const row = q('SELECT * FROM invitations WHERE token_hash = ? AND kind = ?').get(sha256(String(token ?? '')), kind)
    if (!row || row.used_at || row.expires_at < now()) throw new ApiError(404, 'Not Found: this link is wrong, was used already, or has expired')
    return row
  }

  // A link says what whoever made it could give then. It is good while they
  // still can: someone who lost that doesn't leave a way back behind them.
  function inviterStillCan(row) {
    if (!row.created_by) return true // (the server token)
    const by = userById(row.created_by)
    if (!by || by.disabled_at) return false
    if (by.is_platform_admin) return true
    if (row.kind !== 'invite' || !row.company_id || row.is_platform_admin) return false
    const role = roleIn(by, row.company_id)
    return !!role && canGrant(role, row.role)
  }

  // /auth/* and /bootstrap. Anyone can call them, so each has its limit, and the
  // bodies are small.
  async function handle(path, req, res, url) {
    const answer = result => sendJson(res, 200, { ok: true, result })
    if (path === '/auth/status') return answer({ needs_owner: !hasUsers() })
    if (req.method !== 'POST') throw new ApiError(405, 'Method Not Allowed')
    if (req.headers.origin && !sameOrigin(req)) throw new ApiError(403, 'Forbidden')
    if (!allowServerWide('auth-ip', ipKey(clientIp(req)), 60)) throw tooMany()
    const params = await readParams(req, url, 4096, { pool: 'public' })

    if (path === '/bootstrap') {
      if (!allowServerWide('bootstrap', ipKey(clientIp(req)), 10)) throw tooMany()
      if (!isServerToken(bearer(req))) throw new ApiError(401, 'Unauthorized')
      if (hasUsers()) throw new ApiError(409, 'Conflict: this server has users already')
      const email = cleanEmail(params.email), name = cleanName(params.name)
      if (!EMAIL.test(email)) throw bad('this is not an email address')
      if (!name) throw bad('a name is needed')
      const user = await newUser({ email, name, password: params.password, isAdmin: true })
      addMember(user, FIRST_COMPANY, 'owner', null)
      audit(user, 'bootstrap', user.email, req)
      const s = startSession(req, res, user, false)
      return answer(me(user, s))
    }

    if (path === '/auth/login') {
      const email = cleanEmail(params.email)
      if (!allowServerWide('login-ip', ipKey(clientIp(req)), 30)) throw tooMany()
      checkPasswordBudget(req, email)
      const user = userByEmail(email)
      const good = await passwordMatches(String(params.password ?? '').slice(0, 200), user?.password_hash ?? NOBODY)
      if (!user || !good || !stillHolds(user)) {
        passwordFailed(req, email)
        // (Only for an account: what is typed for no account is written nowhere.)
        if (user) audit(user, 'login-failed', email, req)
        throw new ApiError(401, 'Unauthorized: wrong email or password')
      }
      const s = startSession(req, res, user, false)
      audit(user, 'login', user.email, req)
      return answer(me(user, s))
    }

    if (path === '/auth/invite/info') {
      const row = linkFor('invite', params.token)
      if (!inviterStillCan(row)) throw new ApiError(404, 'Not Found: this link is wrong, was used already, or has expired')
      return answer({ email: row.email, company: row.company_id ? companyName(row.company_id) : null, role: row.role, known: !!userByEmail(row.email) })
    }

    if (path === '/auth/invite/accept') {
      if (!allowServerWide('accept', ipKey(clientIp(req)), 30)) throw tooMany()
      const row = linkFor('invite', params.token)
      if (!inviterStillCan(row)) throw new ApiError(404, 'Not Found: this link is wrong, was used already, or has expired')
      let user = userByEmail(row.email)
      if (user) {
        // Someone who has an account already: joining another company needs its password.
        checkPasswordBudget(req, user.email)
        if (!await passwordMatches(String(params.password ?? '').slice(0, 200), user.password_hash) || !stillHolds(user)) {
          passwordFailed(req, user.email)
          audit(user, 'invite-password-failed', row.company_id ?? 'platform', req)
          throw new ApiError(401, 'Unauthorized: wrong password')
        }
        if (row.is_platform_admin) q('UPDATE users SET is_platform_admin = 1 WHERE id = ?').run(user.id)
      } else {
        const name = cleanName(params.name)
        if (!name) throw bad('a name is needed')
        user = await newUser({ email: row.email, name, password: params.password, isAdmin: !!row.is_platform_admin })
      }
      // (Used up only now: a password refused above doesn't waste the link. Taken
      // once, whatever else arrived while the password was being worked out.)
      if (!q('UPDATE invitations SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(now(), row.token_hash).changes) throw new ApiError(404, 'Not Found: this link was used already')
      if (row.company_id && companyName(row.company_id)) addMember(user, row.company_id, row.role, row.created_by)
      audit(user, 'invite-accepted', row.company_id ?? 'platform', req, row.role)
      user = userById(user.id)
      const s = startSession(req, res, user, false)
      return answer(me(user, s))
    }

    if (path === '/auth/reset') {
      if (!allowServerWide('accept', ipKey(clientIp(req)), 30)) throw tooMany()
      const row = linkFor('reset', params.token)
      const user = userByEmail(row.email)
      if (!user || !inviterStillCan(row)) throw new ApiError(404, 'Not Found: this link is wrong, was used already, or has expired')
      checkNewPassword(params.password)
      const hash = await hashPassword(params.password)
      if (!q('UPDATE invitations SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(now(), row.token_hash).changes) throw new ApiError(404, 'Not Found: this link was used already')
      q('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id)
      dropResetLinks(user.email)
      if (row.role === 'clear-totp') {
        q('UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ?').run(user.id)
        q('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id)
      }
      endAllSessions(user.id)
      audit(user, 'password-reset', user.email, req)
      return answer({ done: true })
    }

    // From here on, a session that has at least the right password.
    const found = sessionOf(req)
    if (!found) throw new ApiError(401, 'Unauthorized')
    const { user, session } = found

    if (path === '/auth/logout') {
      endSession(session.token_hash)
      res.setHeader('Set-Cookie', cookieLine(req, '', 0))
      audit(user, 'logout', user.email, req)
      return answer({ done: true })
    }

    if (path === '/auth/totp') {
      if (!user.totp_enabled_at) throw bad('this account has no codes set up')
      checkCodeBudget(user)
      const good = params.recovery != null ? recoveryCodeIsGood(user, params.recovery) : codeIsGood(user, params.code)
      if (!good) {
        codeFailed(user)
        audit(user, 'totp-failed', user.email, req)
        throw new ApiError(401, 'Unauthorized: wrong code')
      }
      const finished = finishSession(req, res, session)
      audit(user, params.recovery != null ? 'recovery-code-used' : 'totp-ok', user.email, req)
      return answer(me(userById(user.id), finished))
    }

    if (path === '/auth/totp/setup') {
      if (user.totp_enabled_at) throw new ApiError(409, 'Conflict: codes are set up already')
      return answer(setUpTotp(user))
    }

    if (path === '/auth/totp/enable') {
      if (user.totp_enabled_at || !user.totp_secret_enc) throw bad('ask for a new secret first')
      checkCodeBudget(user)
      if (!codeIsGood(user, params.code)) { codeFailed(user); throw new ApiError(401, 'Unauthorized: wrong code') }
      q('UPDATE users SET totp_enabled_at = ? WHERE id = ?').run(now(), user.id)
      const finished = finishSession(req, res, session)
      audit(user, 'totp-enabled', user.email, req)
      const codes = newRecoveryCodes(user)
      return answer({ recovery_codes: codes, ...me(userById(user.id), finished) })
    }

    if (path === '/auth/password') {
      if (stageOf(user, session) !== 'ok') throw new ApiError(401, 'Unauthorized')
      if (!allowServerWide('password', user.id, 5, 15 * 60_000)) throw tooMany()
      if (!await passwordMatches(String(params.current ?? '').slice(0, 200), user.password_hash)) throw new ApiError(401, 'Unauthorized: wrong password')
      checkNewPassword(params.password)
      const next = await hashPassword(params.password)
      // (Only if nothing changed meanwhile: this session may have ended, or another password been set.)
      if (!sessionOf(req) || !q('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?').run(next, user.id, user.password_hash).changes) throw new ApiError(401, 'Unauthorized')
      dropResetLinks(user.email)
      endAllSessions(user.id, { except: session.token_hash })
      audit(user, 'password-changed', user.email, req)
      return answer({ done: true })
    }

    throw new ApiError(404, 'Not Found')
  }

  // GET /api/me: also before finishing the sign-in, so the page knows what to ask.
  function meAnswer(req) {
    const found = sessionOf(req)
    if (!found) throw new ApiError(401, 'Unauthorized')
    return me(found.user, found.session)
  }

  function checkRole(role) {
    if (!ROLES.includes(role)) throw bad(`the role must be one of: ${ROLES.join(', ')}`)
  }

  // Nobody gives more than they have. The server token and owners give anything.
  const canGrant = (actorRole, role) => atLeast(actorRole, role) && (actorRole === 'owner' || role !== 'owner')

  function listMembers(companyId) {
    return q(`SELECT u.id, u.email, u.name, u.disabled_at, u.totp_enabled_at, m.role, m.created_at FROM memberships m
              JOIN users u ON u.id = m.user_id WHERE m.company_id = ? ORDER BY u.name`).all(companyId)
      .map(r => ({ id: r.id, email: r.email, name: r.name, role: r.role, disabled: !!r.disabled_at, totp: !!r.totp_enabled_at, since: r.created_at }))
  }

  const companyMethods = {
    members: { role: 'manager', method: 'GET', run: ({ company }) => listMembers(company.id) },
    'members/invite': {
      role: 'manager', method: 'POST',
      run({ company, actor, actorRole, params, req }) {
        const email = cleanEmail(params.email)
        if (!EMAIL.test(email)) throw bad('this is not an email address')
        checkRole(params.role)
        if (!canGrant(actorRole, params.role)) throw new ApiError(403, 'Forbidden: you can\'t give that role')
        audit(actor, 'member-invited', company.id, req, `${email} as ${params.role}`)
        return newLink(req, 'invite', { email, company: company.id, role: params.role }, INVITE_MS, actor.id)
      },
    },
    'members/role': {
      role: 'manager', method: 'POST',
      run({ company, actor, actorRole, params, req }) {
        const target = userById(String(params.user ?? ''))
        const current = target && roleIn(target, company.id)
        if (!current) throw bad('that person is not in this company')
        checkRole(params.role)
        if (!canGrant(actorRole, params.role) || !canGrant(actorRole, current)) throw new ApiError(403, 'Forbidden: you can\'t change that role')
        if (current === 'owner' && params.role !== 'owner' && ownersOf(company.id) <= 1) throw new ApiError(409, 'Conflict: a company needs an owner')
        q('UPDATE memberships SET role = ? WHERE user_id = ? AND company_id = ?').run(params.role, target.id, company.id)
        dropInvitationsFor(company.id, target.email)
        if (atLeast(current, 'manager') && !atLeast(params.role, 'manager')) company.machines.cancelEnrollments()
        company.dropClients(a => a?.id === target.id)
        audit(actor, 'member-role', company.id, req, `${target.email}: ${current} to ${params.role}`)
        return { id: target.id, role: params.role }
      },
    },
    'members/remove': {
      role: 'manager', method: 'POST',
      run({ company, actor, actorRole, params, req }) {
        const target = userById(String(params.user ?? ''))
        const current = target && roleIn(target, company.id)
        if (!current) throw bad('that person is not in this company')
        if (!canGrant(actorRole, current)) throw new ApiError(403, 'Forbidden: you can\'t remove that person')
        if (current === 'owner' && ownersOf(company.id) <= 1) throw new ApiError(409, 'Conflict: a company needs an owner')
        q('DELETE FROM memberships WHERE user_id = ? AND company_id = ?').run(target.id, company.id)
        dropInvitationsFor(company.id, target.email)
        // Who could manage the company may have kept its join token, or a code.
        const couldManage = atLeast(current, 'manager')
        if (couldManage) company.machines.cancelEnrollments()
        company.dropClients(a => a?.id === target.id)
        audit(actor, 'member-removed', company.id, req, target.email)
        return { id: target.id, removed: true, rotate_join_token: couldManage }
      },
    },
    invitations: {
      role: 'manager', method: 'GET',
      run: ({ company }) => q("SELECT token_hash, email, role, created_by, expires_at FROM invitations WHERE kind = 'invite' AND company_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY expires_at").all(company.id, now())
        // (The id is a hash of a hash: it can cancel, but it can't be used as the link.)
        .map(r => ({ id: sha256(r.token_hash), email: r.email, role: r.role, expires_at: r.expires_at })),
    },
    'invitations/cancel': {
      role: 'manager', method: 'POST',
      run({ company, actor, actorRole, params, req }) {
        const row = q("SELECT token_hash, email, role FROM invitations WHERE kind = 'invite' AND company_id = ? AND used_at IS NULL").all(company.id).find(r => sha256(r.token_hash) === String(params.id ?? ''))
        if (!row) throw bad('no such invitation')
        if (!canGrant(actorRole, row.role)) throw new ApiError(403, 'Forbidden: you can\'t cancel that one')
        q('DELETE FROM invitations WHERE token_hash = ?').run(row.token_hash)
        audit(actor, 'invitation-cancelled', company.id, req, row.email)
        return { cancelled: true }
      },
    },
    'join-token': { role: 'manager', method: 'GET', run: ({ company }) => ({ join_token: company.platform.joinToken().token }) },
    'join-token/rotate': {
      role: 'manager', method: 'POST',
      run({ company, actor, req }) {
        audit(actor, 'join-token-rotated', company.id, req)
        return company.platform.rotateJoinToken()
      },
    },
  }

  // What only an administrator of the server does (or the server token).
  const adminMethods = {
    'users': {
      method: 'GET',
      run: () => q('SELECT id, email, name, is_platform_admin, disabled_at, totp_enabled_at, last_login_at FROM users ORDER BY name').all()
        .map(r => ({ id: r.id, email: r.email, name: r.name, is_platform_admin: !!r.is_platform_admin, disabled: !!r.disabled_at, totp: !!r.totp_enabled_at, last_login_at: r.last_login_at, companies: membershipsOf(r.id).map(m => ({ id: m.company_id, role: m.role })) })),
    },
    'users/invite': {
      method: 'POST',
      run({ actor, params, req }) {
        const email = cleanEmail(params.email)
        if (!EMAIL.test(email)) throw bad('this is not an email address')
        if (params.company != null) { if (!companyName(String(params.company))) throw bad('no such company'); checkRole(params.role) }
        audit(actor, 'user-invited', params.company == null ? 'platform' : String(params.company), req, `${email}${params.role ? ` as ${params.role}` : ''}${params.is_platform_admin === true ? ' (administrator)' : ''}`)
        return newLink(req, 'invite', { email, company: params.company == null ? null : String(params.company), role: params.role ?? null, isAdmin: params.is_platform_admin === true }, INVITE_MS, actor.id)
      },
    },
    // Links not used yet, of any kind, across the server, and cancelling one.
    'pending-links': {
      method: 'GET',
      run: () => q('SELECT token_hash, kind, email, company_id, role, is_platform_admin, expires_at FROM invitations WHERE used_at IS NULL AND expires_at > ? ORDER BY expires_at').all(now())
        .map(r => ({ id: sha256(r.token_hash), kind: r.kind, email: r.email, company: r.company_id, role: r.role === 'clear-totp' ? null : r.role, clears_codes: r.role === 'clear-totp', is_platform_admin: !!r.is_platform_admin, expires_at: r.expires_at })),
    },
    'pending-links/cancel': {
      method: 'POST',
      run({ actor, params, req }) {
        const row = q('SELECT token_hash, kind, email FROM invitations WHERE used_at IS NULL').all().find(r => sha256(r.token_hash) === String(params.id ?? ''))
        if (!row) throw bad('no such link')
        q('DELETE FROM invitations WHERE token_hash = ?').run(row.token_hash)
        audit(actor, 'link-cancelled', row.email, req, row.kind)
        return { cancelled: true }
      },
    },
    'users/disable': { method: 'POST', run: args => setDisabled(args, true) },
    'users/enable': { method: 'POST', run: args => setDisabled(args, false) },
    'users/reset': {
      method: 'POST',
      run({ actor, params, req }) {
        const target = userById(String(params.user ?? ''))
        if (!target) throw bad('no such user')
        audit(actor, 'password-reset-link', target.email, req, params.clear_totp === true ? 'with codes cleared' : null)
        dropResetLinks(target.email) // (Only the last one works.)
        return newLink(req, 'reset', { email: target.email, role: params.clear_totp === true ? 'clear-totp' : null }, RESET_MS, actor.id)
      },
    },
    // To read what is inside a company, an administrator has to join it, and it is written down.
    'companies/join': {
      method: 'POST',
      run({ actor, params, req }) {
        const company = String(params.company ?? '')
        if (!companyName(company)) throw bad('no such company')
        if (actor.token) throw bad('the server token has no account: invite someone instead')
        checkRole(params.role ?? 'owner')
        const role = addMember(actor, company, params.role ?? 'owner', actor.id)
        audit(actor, 'admin-joined-company', company, req, role)
        return { company, role }
      },
    },
  }

  function setDisabled({ actor, params, req }, disabled) {
    const target = userById(String(params.user ?? ''))
    if (!target) throw bad('no such user')
    if (disabled && target.id === actor.id) throw bad('you can\'t disable yourself')
    if (disabled && target.is_platform_admin && !q('SELECT 1 FROM users WHERE is_platform_admin = 1 AND disabled_at IS NULL AND id != ?').get(target.id)) throw new ApiError(409, 'Conflict: the server needs an administrator')
    if (disabled) for (const m of membershipsOf(target.id)) if (m.role === 'owner' && ownersOf(m.company_id) <= 1) throw new ApiError(409, `Conflict: this is the only owner of the company ${companyName(m.company_id) ?? m.company_id}`)
    q('UPDATE users SET disabled_at = ? WHERE id = ?').run(disabled ? now() : null, target.id)
    if (disabled) endAllSessions(target.id)
    audit(actor, disabled ? 'user-disabled' : 'user-enabled', target.email, req)
    return { id: target.id, disabled }
  }

  // The server token gets someone back in: a link to set a new password, and
  // new codes, for whoever lost theirs.
  function recoverAccess(p, req) {
    const target = userByEmail(cleanEmail(p.email))
    if (!target) throw bad('no such user')
    audit({ token: true }, 'access-recovered', target.email, req)
    dropResetLinks(target.email)
    return newLink(req, 'reset', { email: target.email, role: 'clear-totp' }, RESET_MS, null)
  }

  // Sessions that ran out take their open streams and terminals with them.
  function sweep() {
    const t = now()
    for (const s of q('SELECT token_hash FROM login_sessions WHERE expires_at < ? OR last_seen_at < ?').all(t, t - IDLE_MS)) endSession(s.token_hash)
    q('DELETE FROM invitations WHERE expires_at < ?').run(t - 30 * 24 * 3600_000)
    q('DELETE FROM platform_audit WHERE at < ?').run(t - 365 * 24 * 3600_000)
    q('DELETE FROM platform_audit WHERE id <= (SELECT id FROM platform_audit ORDER BY id DESC LIMIT 1 OFFSET 200000)').run()
  }
  setInterval(guarded(sweep), 60_000).unref()

  return { handle, actorOf, meAnswer, roleIn, hasUsers, companyMethods, adminMethods, audit, recoverAccess }
}
