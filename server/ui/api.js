import { state } from './state.js'

export async function api(path) {
  const r = await fetch(path, { headers: { Authorization: `Bearer ${state.token}` } })
  if (r.status === 401) throw Object.assign(new Error('unauthorized'), { status: 401 })
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }))
  if (!j.ok) throw Object.assign(new Error(j.description), { status: j.error_code ?? r.status })
  return j.result
}
