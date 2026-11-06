import { state } from './state.js'

// What the dashboard asks about, in the company it shows: /api/state is that company's.
export const inCompany = path => (path.startsWith('/api/') ? `/api/c/${encodeURIComponent(state.company)}/${path.slice('/api/'.length)}` : path)

export async function api(path) {
  const r = await fetch(inCompany(path))
  if (r.status === 401) throw Object.assign(new Error('unauthorized'), { status: 401 })
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }))
  if (!j.ok) throw Object.assign(new Error(j.description), { status: j.error_code ?? r.status })
  return j.result
}

// About the server, not one company: signing in, companies, users.
export async function call(path, body, headers = {}) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }))
  if (!j.ok) throw Object.assign(new Error(j.description), { status: j.error_code ?? r.status })
  return j.result
}
