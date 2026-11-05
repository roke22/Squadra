import { store } from './dom.js'
import { T, COLLATOR } from './i18n.js'
import { sessions } from './state.js'
import { esc, dur, now } from './format.js'

export const MAX_VIEW_ITEMS = 600   // per chat view
export const MAX_RENDER_TEXT = 8000 // characters of one text shown
const MAX_RENDER_TAGS = 600  // HTML tags one formatted text may become
export const MAX_VIEW_HTML = 1_500_000 // characters of markup one chat view draws
export const MAX_VIEW_TAGS = 60_000     // and HTML tags
export const tagsIn = h => { let n = 0; for (let i = h.indexOf('<'); i >= 0; i = h.indexOf('<', i + 1)) n++; return n }
const MAX_RENDER_DETAIL = 3000 // characters of a tool's input/output, a summary…

// Escaped and clipped text of an item's field, computed once: a session
// sending huge events can't make every re-render slow.
const clipCache = new WeakMap()
export function clipEsc(it, field, max = MAX_RENDER_DETAIL) {
  if (!it || typeof it !== 'object') return ''
  let m = clipCache.get(it)
  if (!m) clipCache.set(it, m = new Map())
  if (!m.has(field)) {
    const t = String(it[field] ?? '')
    m.set(field, esc(t.length > max ? t.slice(0, max) : t) + (t.length > max ? ` <span class="dim-note">${T.moreChars(t.length - max)}</span>` : ''))
  }
  return m.get(field)
}

// Markdown of an item, computed once.
const mdCache = new WeakMap()
export function mdCached(it) {
  if (!mdCache.has(it)) {
    const t = String(it.text ?? '')
    const clipped = t.length > MAX_RENDER_TEXT ? `${t.slice(0, MAX_RENDER_TEXT)}…` : t
    // At most MAX_RENDER_TAGS elements per text: thousands of lines, list
    // items or `code` spans would make every redraw of the view slow, so
    // such a text is shown as plain text (one element) instead.
    const html = md(clipped)
    let tags = 0
    for (let i = html.indexOf('<'); i >= 0 && tags <= MAX_RENDER_TAGS; i = html.indexOf('<', i + 1)) tags++
    mdCache.set(it, tags > MAX_RENDER_TAGS ? `<div style="white-space:pre-wrap">${esc(clipped)}</div>` : html)
  }
  return mdCache.get(it)
}

// Small, safe markdown: everything is escaped first, then a few constructs.
function md(src) {
  const blocks = []
  let text = esc(src).replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`)
    return `\u0000${blocks.length - 1}\u0000`
  })
  const inline = s => s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)<>]{1,2000})\)/g, (m, label, href) => {
      // A link into this dashboard (e.g. straight to a terminal) is shown as text.
      // Judged on the URL as the browser will read it (entities decoded);
      // one with user:password@ in it is never made a link.
      let own = true
      let realHost = ''
      const decode = x => x.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      try {
        const u = new URL(decode(href))
        const bare = h => h.toLowerCase().replace(/\.+(?=:|$)/, '') // "host." is the same host
        own = bare(u.host) === bare(location.host) || !!u.username || !!u.password || /@/.test(href) || u.hash.startsWith('#/')
        // Whenever the text isn't the address itself, the real host goes
        // next to it (a label can pass for another site in many ways).
        const l = decode(label.replace(/<[^>]*>/g, '')).trim()
        // So does a host written with characters that look like others
        // (gіthub.com with a Cyrillic і, a division slash for "/", %2E for ".").
        const written = decode(href).replace(/^https?:\/\//i, '').split(/[/?#\\]/)[0].replace(/^[^@]*@/, '')
        if ((l !== decode(href) && l !== u.href) || /[^\x21-\x7e]|%/.test(written) || /(^|\.)xn--/i.test(u.hostname)) realHost = u.host
      } catch {}
      return own ? `${label} (${href})` : `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>${realHost ? ` <span class="dim-note">(${esc(realHost)})</span>` : ''}`
    })
  // Line by line: runs of "- " / "1. " lines become lists, headings stand
  // alone, other lines join into paragraphs; blank lines end a paragraph.
  const out = []
  let para = [], list = null
  const endPara = () => { if (para.length) out.push(`<p>${para.join('<br>')}</p>`); para = [] }
  const endList = () => { if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${i}</li>`).join('')}</${list.tag}>`); list = null }
  for (const line of text.split('\n')) {
    const ul = /^\s*[-*+] (.*)$/.exec(line)
    const ol = /^\s*\d+[.)] (.*)$/.exec(line)
    if (ul || ol) {
      endPara()
      const tag = ul ? 'ul' : 'ol'
      if (list && list.tag !== tag) endList()
      if (!list) list = { tag, items: [] }
      list.items.push(inline((ul ?? ol)[1]))
      continue
    }
    endList()
    if (!line.trim()) { endPara(); continue }
    if (/^\u0000\d+\u0000$/.test(line.trim())) { endPara(); out.push(line.trim()); continue }
    if (/^#{1,6} /.test(line)) { endPara(); out.push(`<span class="h">${inline(line.replace(/^#{1,6} /, ''))}</span>`); continue }
    para.push(inline(line))
  }
  endList(); endPara()
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)])
}

// session status (sidebar, pane headers, status bars)
export function status(s) {
  if (!s) return { dot: '', text: '' }
  const a = s.activity ?? {}
  if (!s.online) return { dot: '', text: T.offline(s.last_seen_at ? dur(now() - s.last_seen_at * 1000) : '—') }
  switch (a.state) {
    case 'tool': return { dot: 'warn pulse', text: `${a.tool?.name ?? T.tool} · ${dur(now() - (a.tool?.since ?? now()))} · ${a.tool?.summary ?? ''}` }
    case 'working': return { dot: 'ok pulse', text: T.working(dur(now() - (a.since ?? now()))) }
    case 'waiting': return { dot: 'err pulse', waiting: true, text: a.tool?.name ? T.waitingTool(a.tool.name, a.tool.summary ?? '') : T.waitingInput(a.waiting) }
    case 'compacting': return { dot: 'info pulse', text: T.compacting }
    case 'idle': return { dot: 'ok', text: T.idle(dur(now() - (a.since ?? now()))) }
    case 'ended': return { dot: '', text: T.ended }
    default: return { dot: 'ok', text: a.observe === 'off' ? T.connectedNoObs : T.connected }
  }
}

export const byPresence = (a, b) => (b.online - a.online) || COLLATOR.compare(a.name, b.name)

// Squads: each coordinator with the workers that report to it. Workers whose
// coordinator isn't here (or sessions with no role) go in "orphans".
export function squadsOf(list) {
  const coords = list.filter(s => s.role === 'coordinator').sort(byPresence)
  const names = new Set(coords.map(c => c.name))
  return {
    squads: coords.map(c => ({ coord: c, workers: list.filter(s => s.role === 'worker' && s.coordinator === c.name).sort(byPresence) })),
    orphans: list.filter(s => s.role !== 'coordinator' && s.role !== 'solo' && !(s.role === 'worker' && names.has(s.coordinator))).sort(byPresence),
    // Standalone sessions: each on its own, outside every squad.
    solos: list.filter(s => s.role === 'solo').sort(byPresence),
  }
}

export function sortedSessions({ archived = false } = {}) {
  const list = [...sessions.values()].filter(s => !s.deleted && !!s.archived_at === archived)
  const { squads, orphans, solos } = squadsOf(list)
  return [...squads.flatMap(q => [q.coord, ...q.workers]), ...orphans, ...solos]
}

// Which squads are unfolded in the sidebar (remembered per browser).
export const squadOpen = (() => { try { return JSON.parse(store.get('squadraSquads') || '{}') } catch { return {} } })()
