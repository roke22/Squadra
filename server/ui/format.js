import { LOCALE, LANG } from './i18n.js'
import { state, sessions } from './state.js'

// helpers
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const now = () => Date.now() + state.serverSkew

// (One formatter for all: building one per call costs more than the rest of a redraw.)
const TIME_FMT = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false })
export const hhmm = ms => TIME_FMT.format(new Date(ms))
export const dur = ms => {
  if (ms > 0 && ms < 1000) return `${(ms / 1000).toFixed(1).replace('.', LANG === 'es' ? ',' : '.')} s`
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}
export const kfmt = v => { const n = Number(v) || 0; return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n) }
export const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
export const base = p => String(p ?? '').split('/').filter(Boolean).pop() ?? ''
const roleOf = name => sessions.get(name)?.role ?? ''
