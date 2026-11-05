import { $ } from './dom.js'
import { T } from './i18n.js'
import {
  state, sessions, templateListeners, linkListeners, hosts, views, hostListeners, unread,
} from './state.js'
import { esc } from './format.js'
import { sortedSessions, status } from './content.js'
import { toolName } from './chat.js'
import { soon, setHtml, renderNav } from './nav.js'
import { route, currentRoute, mosaicPanes, refreshLeads, dec } from './router.js'
import { renderTop, sessionTerm } from './topbar.js'
import { paneHead, buildMosaic, paneClass, refreshSquadRows, renderArchived } from './mosaic.js'
import { renderHosts, terminalOf } from './machines.js'
import { noteLinkMessage } from './squads.js'
import { renderOrg } from './org.js'
import { setVersion, showLogin } from './app.js'

// live stream
function onStream(type, data) {
  if (type === 'hello') {
    state.serverSkew = data.server_time - Date.now()
    if (data.version) setVersion(data.version)
    sessions.clear()
    for (const s of data.sessions) sessions.set(s.name, s)
    state.groups = data.groups ?? []
    state.templates = data.templates ?? []
    for (const fn of templateListeners) fn()
    state.links = data.links ?? []
    for (const fn of linkListeners) fn()
    state.squadMeta = new Map((data.squads ?? []).map(q => [q.coordinator, q]))
    hosts.clear()
    for (const h of data.hosts ?? []) hosts.set(h.id, h)
    // After a reconnect, what happened in between isn't in the open chats:
    // they load again from the server.
    if (state.streamHelloSeen) for (const v of views) v.reset()
    state.streamHelloSeen = true
    route()
    return
  }
  if (type === 'host') {
    if (data.removed) hosts.delete(data.id); else hosts.set(data.id, data)
    for (const fn of hostListeners) fn(data)
    const r = currentRoute()
    if (r.view === 'hosts') { if (r.host && data.removed && data.id === r.host) { location.hash = '#/hosts'; return } renderHosts(r.host); soon(renderTop) }
    if (r.view === 'terminal' || r.view === 'session') soon(renderTop)
    if (r.view === 'org') soon(renderOrg)
    // A session's terminal opened or ended: its view switches between terminal and chat.
    if (r.view === 'session' && !!sessionTerm(r) !== (!!state.termView && !$('terminal').hidden)) soon(route)
    if (r.view === 'mosaic' || r.view === 'leads') {
      for (const [name, p] of mosaicPanes) { const s = sessions.get(name); if (s) setHtml(p.pane.querySelector('.pane-head'), paneHead(s)) }
      // A session whose terminal opened or ended: its pane switches between terminal and chat.
      const terms = r.view === 'leads' || state.mosaicMode === 'terms'
      if ([...mosaicPanes].some(([name, p]) => (terms && !!terminalOf(name)) !== (p.kind === 'term'))) soon(buildMosaic)
    }
    soon(renderNav)
    return
  }
  if (type === 'session') {
    const prev = sessions.get(data.name)
    if (data.deleted) { sessions.delete(data.name); unread.delete(data.name) } else sessions.set(data.name, data)
    const r = currentRoute()
    if (r.view === 'mosaic' || r.view === 'leads') {
      if (!prev || data.deleted || !!prev.archived_at !== !!data.archived_at || prev.role !== data.role || prev.coordinator !== data.coordinator) buildMosaic()
      else { const p = mosaicPanes.get(data.name); if (p) { p.pane.className = paneClass(data); setHtml(p.pane.querySelector('.pane-head'), paneHead(data)) } soon(refreshSquadRows); soon(refreshLeads) }
    }
    if (r.view === 'archived') renderArchived()
    if (r.view === 'org') { soon(renderOrg); soon(renderTop) }
    if (r.view === 'session' && r.name === data.name && data.deleted) { location.hash = '#/'; return }
    for (const v of views) if (v.name === data.name) { v.renderStatus(); v.scheduleRender() }
    soon(renderNav)
    // The top bar shows one session (or one squad): only its changes matter.
    if ((r.view === 'session' && r.name === data.name) || r.view === 'terminal' || r.squad) soon(renderTop)
    return
  }
  if (type === 'templates') {
    state.templates = Array.isArray(data) ? data : []
    for (const fn of templateListeners) fn()
    return
  }
  if (type === 'links') {
    state.links = Array.isArray(data) ? data : []
    for (const fn of linkListeners) fn()
    if (currentRoute().squad || currentRoute().view === 'org') soon(renderTop)
    if (currentRoute().view === 'org') soon(renderOrg)
    soon(renderNav)
    return
  }
  if (type === 'squads') {
    state.squadMeta = new Map((Array.isArray(data) ? data : []).map(q => [q.coordinator, q]))
    if (currentRoute().view === 'org') soon(renderOrg)
    return
  }
  if (type === 'cleared') {
    const s = sessions.get(data.session)
    if (s) s.cleared_at = data.at
    for (const v of views) if (v.name === data.session) v.reset()
    unread.delete(data.session)
    soon(renderNav)
    return
  }
  if (type === 'edited') {
    // An edited message: the new text replaces the old one where it is shown.
    for (const v of views) {
      const i = v.items.findIndex(x => x.t === 'message' && x.id === data.id)
      if (i >= 0) { v.items[i] = { ...v.items[i], text: data.text, edited_at: data.edited_at }; v.scheduleRender() }
    }
    return
  }
  if (type === 'message') noteLinkMessage(data)
  if (type === 'event' || type === 'message') {
    const it = type === 'event' ? { ...data, t: 'event' } : { ...data, t: 'message', ts: data.created_at }
    if (it.t === 'event' && it.kind === 'usage') return
    let shown = false
    for (const v of views) if (v.live(it)) shown = true
    // unread counters for sessions not on screen
    const r = currentRoute()
    if (r.view === 'session') {
      const owners = it.t === 'event' ? [it.session] : [it.from, it.target].filter(n => sessions.has(n))
      let changed = false
      for (const n of owners) if (n !== r.name) { unread.set(n, (unread.get(n) ?? 0) + 1); changed = true }
      if (changed) soon(renderNav)
    }
    void shown
  }
}

function setConn(cls, text) { $('connDot').className = `dot ${cls}`; $('connText').textContent = text }
export async function connect() {
  const gen = ++state.streamGen
  let backoff = 1000
  for (;;) {
    if (gen !== state.streamGen) return
    state.streamAbort = new AbortController()
    try {
      const r = await fetch('/api/stream', { headers: { Authorization: `Bearer ${state.token}` }, signal: state.streamAbort.signal })
      if (r.status === 401) return showLogin(T.tokenInvalid)
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
      setConn('ok', T.live)
      backoff = 1000
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      // The server pings every 20 s: nothing for 45 s means a connection that
      // silently died (it would stay "live" for ever): made again.
      const read = () => {
        let timer
        const silent = new Promise((_, reject) => { timer = setTimeout(() => { reader.cancel().catch(() => {}); reject(new Error('silent')) }, 45_000) })
        return Promise.race([reader.read(), silent]).finally(() => clearTimeout(timer))
      }
      for (;;) {
        const { value, done } = await read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          let type = 'message', data = ''
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) type = line.slice(7)
            else if (line.startsWith('data: ')) data += line.slice(6)
          }
          if (data) { try { onStream(type, JSON.parse(data)) } catch (e) { console.error(e) } }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') return
    }
    if (gen !== state.streamGen) return
    setConn('err', T.reconnecting)
    await new Promise(res => setTimeout(res, backoff))
    backoff = Math.min(backoff * 2, 15000)
  }
}

// What needs you, across every session: permissions and nearly-full contexts.
function renderAlerts() {
  const box = $('alerts')
  if (!box) return
  // Sessions opened from the dashboard (host_id) first: a flood from other
  // sessions can't push them out of view.
  const list = sortedSessions().filter(s => s.online).sort((a, b) => !!b.host_id - !!a.host_id)
  const items = []
  for (const s of list) {
    const st = status(s)
    if (st.waiting) {
      const a = s.activity ?? {}
      const what = a.tool ? `${toolName(a.tool.name)}${a.tool.summary ? ` · ${a.tool.summary}` : ''}` : a.waiting
      items.push({ cls: '', name: s.name, html: T.alertPerm(esc(s.name), esc(what ?? '')) })
    }
  }
  for (const s of list) {
    const p = s.activity?.context_pct
    if (p != null && p >= 80) items.push({ cls: 'ctxw', name: s.name, html: T.alertCtx(esc(s.name), p) })
  }
  const key = items.map(i => i.html).join('|')
  if (box.dataset.key === key) return
  box.dataset.key = key
  box.hidden = !items.length
  const shown = items.slice(0, 4)
  setHtml(box, items.length ? `<span class="lbl">${T.needsYou}</span>${shown.map(i => `<button class="alert ${i.cls}" data-go="#/s/${encodeURIComponent(i.name)}">${i.html}</button>`).join('')}${items.length > shown.length ? `<span class="t">${T.alertMore(items.length - shown.length)}</span>` : ''}` : '')
}
$('alerts').addEventListener('click', e => {
  const b = e.target.closest('[data-go]')
  if (!b) return
  // The machine's terminal is where a permission is answered, when there is one.
  const name = dec(b.dataset.go.slice(4))
  const where = terminalOf(name)
  location.hash = where && sessions.get(name) && status(sessions.get(name)).waiting ? `#/t/${encodeURIComponent(where.host.id)}/${encodeURIComponent(name)}` : b.dataset.go
})

setInterval(() => {
  for (const v of views) v.tick()
  renderNav()
  renderAlerts()
  refreshSquadRows()
  const r = currentRoute()
  if (r.view === 'mosaic' || r.view === 'leads') for (const [name, p] of mosaicPanes) { const s = sessions.get(name); if (s) p.pane.querySelector('.pane-head .dot').className = `dot ${status(s).dot}` }
  refreshLeads()
}, 1000)
