import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import {
  ApiError, DATA_DIR, FIRST_COMPANY, bad, cleanText, guarded, logError, now, openControl,
} from './platform/index.js'
import { createCompany } from './company.js'

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const COMPANY_NAME = /^[\p{L}\p{N} ._&-]{1,80}$/u
// A secret of a company: its kind, then the company. (The first company's have
// none, and an old one, being random, may look as if it had: see of().)
const CREDENTIAL_COMPANY = /^s[qjh]_([a-z0-9]{8})_/

// What a company may keep, when it isn't what the server starts with.
const QUOTAS = ['max_sessions', 'max_messages', 'max_events', 'max_updates', 'max_files_gb']

// The copy of the data taken before a server first has companies: for going back
// if something goes wrong. It holds what sessions have deleted since, so it goes.
const BEFORE_COMPANIES = join(DATA_DIR, 'squadra-before-companies.db')
const COPY_KEPT_MS = 7 * 24 * 3600_000

export function createCompanies(server) {
  // (First: if it fails, this server is as it was.)
  if (!existsSync(join(DATA_DIR, 'control.db')) && existsSync(join(DATA_DIR, 'squadra.db'))) copyBeforeCompanies()
  const control = openControl()

  const open = new Map() // id -> a company running
  const failed = new Set() // ids of those that could not start: the others go on
  let serving = false

  const row = id => control.prepare('SELECT * FROM companies WHERE id = ?').get(id)
  const folderOf = id => (id === FIRST_COMPANY ? DATA_DIR : join(DATA_DIR, 'companies', id))
  const quotasOf = r => { try { return JSON.parse(r.limits_json) } catch { return {} } }

  function start(r) {
    const company = createCompany(server, {
      id: r.id, dir: folderOf(r.id), quotas: quotasOf(r),
      routeEnrollment: (hash, expires) => {
        if (r.id !== FIRST_COMPANY) control.prepare('INSERT OR REPLACE INTO enrollment_routes (code_hash, company_id, expires_at) VALUES (?, ?, ?)').run(hash, r.id, expires)
      },
    })
    if (serving) company.sessions.nowServing()
    open.set(r.id, company)
    return company
  }

  // A server's data as it was before companies is the first company, in place.
  if (!row(FIRST_COMPANY)) control.prepare('INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)').run(FIRST_COMPANY, 'Default', now())
  start(row(FIRST_COMPANY))
  for (const r of control.prepare('SELECT * FROM companies WHERE id != ?').all(FIRST_COMPANY)) {
    try { start(r) } catch (err) {
      failed.add(r.id)
      logError(`company ${r.id} could not start: ${err.stack ?? err}`)
    }
  }

  function cleanup() {
    control.prepare('DELETE FROM enrollment_routes WHERE expires_at < ?').run(now())
    try { if (now() - statSync(BEFORE_COMPANIES).mtimeMs > COPY_KEPT_MS) rmSync(BEFORE_COMPANIES, { force: true }) } catch {}
  }
  setInterval(guarded(cleanup), 3600_000).unref()
  cleanup()

  const nameOf = id => row(id)?.name ?? null
  // Across every company: someone lost a session, or all their access.
  const dropClients = match => { for (const c of open.values()) c.dropClients(match) }

  const first = () => open.get(FIRST_COMPANY)
  const get = id => open.get(id) ?? null

  // The company a credential says it is of: it only opens that one. A prefix of
  // no company is an old secret that looks like one by chance.
  function of(credential) {
    const id = CREDENTIAL_COMPANY.exec(String(credential ?? ''))?.[1]
    if (id && failed.has(id)) throw new ApiError(503, 'Service Unavailable: this company could not start; see the server log')
    return (id && open.get(id)) || first()
  }

  function forEnrollment(key) {
    const id = control.prepare('SELECT company_id FROM enrollment_routes WHERE code_hash = ?').get(key)?.company_id
    if (id && failed.has(id)) throw new ApiError(503, 'Service Unavailable: this company could not start; see the server log')
    return (id && open.get(id)) || first()
  }
  const enrolled = key => control.prepare('DELETE FROM enrollment_routes WHERE code_hash = ?').run(key)

  function cleanQuotas(limits) {
    const out = {}
    for (const [k, v] of Object.entries(limits ?? {})) {
      if (!QUOTAS.includes(k)) throw bad(`unknown limit "${k}": it can be ${QUOTAS.join(', ')}`)
      if (!Number.isSafeInteger(v) || v < 1) throw bad(`${k} must be a whole number above zero`)
      out[k] = v
    }
    return out
  }

  const view = r => ({ id: r.id, name: r.name, status: failed.has(r.id) ? 'unavailable' : r.status, limits: quotasOf(r), created_at: r.created_at })
  const list = () => control.prepare('SELECT * FROM companies ORDER BY created_at, id').all().map(view)

  // Which machines serve which companies, by what each machine says it is:
  // for looking at, never for deciding anything.
  function machines() {
    const byMachine = new Map()
    for (const c of open.values()) {
      for (const h of c.machines.listHosts()) {
        const key = h.info?.machine ?? h.id
        if (!byMachine.has(key)) byMachine.set(key, { machine: key, hostname: h.info?.hostname ?? h.name, instances: [] })
        byMachine.get(key).instances.push({
          company: c.id, company_name: nameOf(c.id), host: h.id, name: h.name, online: h.online, os_user: h.info?.os_user ?? null,
          sessions: h.info?.terminals?.length ?? 0, max_sessions: h.info?.max_sessions ?? null,
        })
      }
    }
    return [...byMachine.values()].map(m => {
      const users = new Set(m.instances.map(i => i.os_user))
      return {
        ...m,
        sessions: m.instances.reduce((n, i) => n + i.sessions, 0),
        isolation: m.machine.startsWith('h_') ? 'unknown' : m.instances.length < 2 ? 'dedicated' : users.size === m.instances.length && !users.has(null) ? 'os-user' : 'same-user',
      }
    }).sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)))
  }

  function newId() {
    for (;;) {
      const id = [...randomBytes(8)].map(b => ID_ALPHABET[b % ID_ALPHABET.length]).join('')
      if (!row(id) && !existsSync(folderOf(id))) return id
    }
  }

  function add(p) {
    const name = typeof p.name === 'string' ? cleanText(p.name.slice(0, 200)).trim() : ''
    if (!COMPANY_NAME.test(name)) throw bad('the name may have letters, digits, spaces and . _ & - (max 80)')
    if (control.prepare('SELECT 1 FROM companies WHERE name = ?').get(name)) throw new ApiError(409, `Conflict: there is already a company called "${name}"`)
    const limits = cleanQuotas(p.limits)
    const id = newId()
    mkdirSync(join(DATA_DIR, 'companies'), { recursive: true, mode: 0o700 })
    control.prepare('INSERT INTO companies (id, name, limits_json, created_at) VALUES (?, ?, ?, ?)').run(id, name, JSON.stringify(limits), now())
    let company
    try { company = start(row(id)) } catch (err) {
      control.prepare('DELETE FROM companies WHERE id = ?').run(id)
      rmSync(folderOf(id), { recursive: true, force: true })
      throw err
    }
    process.stderr.write(`squadra-server: company "${name}" (${id}) created\n`)
    return { ...view(row(id)), join_token: company.platform.joinToken().token }
  }

  // Limits: from now on (each module reads them when it needs them).
  function setQuotas(p) {
    const id = String(p.company ?? '')
    const company = get(id)
    if (!company) throw new ApiError(404, 'Not Found: no such company')
    const limits = cleanQuotas(p.limits)
    control.prepare('UPDATE companies SET limits_json = ? WHERE id = ?').run(JSON.stringify(limits), id)
    company.platform.setQuotas(limits)
    return view(row(id))
  }

  const adminMethods = {
    createCompany: add,
    listCompanies: list,
    setCompanyLimits: setQuotas,
  }

  function nowServing() {
    serving = true
    for (const c of open.values()) c.sessions.nowServing()
  }

  function close() {
    for (const c of open.values()) c.close()
    try { control.close() } catch {}
  }

  return {
    control, machines, first, get, of, nameOf, dropClients, all: () => [...open.values()], list, adminMethods, forEnrollment, enrolled, nowServing, close,
  }
}

// (Refusing to go on without it. Under another name until it is whole.)
function copyBeforeCompanies() {
  const partial = `${BEFORE_COMPANIES}.partial`
  rmSync(partial, { force: true })
  const db = new DatabaseSync(join(DATA_DIR, 'squadra.db'))
  try {
    db.prepare('VACUUM INTO ?').run(partial)
    renameSync(partial, BEFORE_COMPANIES)
    process.stderr.write(`squadra-server: a copy of the data before companies is in ${BEFORE_COMPANIES}; it is deleted after 7 days\n`)
  } catch (err) {
    rmSync(partial, { force: true })
    process.stderr.write(`squadra-server: cannot copy the data before upgrading it (${err.message}). Nothing changed\n`)
    process.exit(1)
  } finally { db.close() }
}
