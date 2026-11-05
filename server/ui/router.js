import { $, store } from './dom.js'
import { T, COLLATOR } from './i18n.js'
import { state, sessions, unread } from './state.js'
import { dur, now, esc } from './format.js'
import { sortedSessions, squadOpen } from './content.js'
import { ChatView } from './chat.js'
import { setHtml, renderNav } from './nav.js'
import { personaTag, sessionTerm, renderTop } from './topbar.js'
import { buildMosaic, renderArchived } from './mosaic.js'
import { closeMenu } from './dialogs.js'
import { renderHosts } from './machines.js'
import { hideOrgTip, renderOrg } from './org.js'
import { TermView } from './terminal.js'

// views
export let mosaicPanes = new Map() // name -> {pane, view}

export const dec = v => { try { return decodeURIComponent(v) } catch { return v } }

// Set once the user moves around the dashboard (not on the page it opened on).
export let navigatedInApp = false

// (A real click or key here, not a URL change made from outside.)
// (Inside the app itself: typing the token on the login page doesn't count.)
for (const ev of ['click', 'keydown']) document.addEventListener(ev, e => { if (e.isTrusted && !$('app').hidden && e.target.closest?.('#app')) navigatedInApp = true }, true)

// Names in the address are only ever session names and machine ids: any
// other text (a crafted link) goes to the main view, never into the header.
const ROUTE_NAME = /^[A-Za-z0-9_-]{1,32}$/
const ROUTE_ID = /^[A-Za-z0-9_-]{1,64}$/
export function currentRoute() {
  if (location.hash === '#/archived') return { view: 'archived' }
  if (location.hash === '#/hosts') return { view: 'hosts' }
  if (location.hash === '#/c') return { view: 'leads' }
  if (location.hash === '#/org') return { view: 'org' }
  const q = location.hash.match(/^#\/q\/(.+)$/)
  if (q) return ROUTE_NAME.test(dec(q[1])) ? { view: 'mosaic', squad: dec(q[1]) } : { view: 'mosaic' }
  const h = location.hash.match(/^#\/h\/(.+)$/)
  if (h) return ROUTE_ID.test(dec(h[1])) ? { view: 'hosts', host: dec(h[1]) } : { view: 'hosts' }
  const t = location.hash.match(/^#\/t\/([^/]+)\/(.+)$/)
  if (t) return ROUTE_ID.test(dec(t[1])) && ROUTE_NAME.test(dec(t[2])) ? { view: 'terminal', host: dec(t[1]), term: dec(t[2]) } : { view: 'hosts' }
  // A session: its live terminal when it has one (opened on a machine
  // from here), else its chat; ".../chat" always the chat.
  const sc = location.hash.match(/^#\/s\/([^/]+)\/chat$/)
  if (sc) return ROUTE_NAME.test(dec(sc[1])) ? { view: 'session', name: dec(sc[1]), chat: true } : { view: 'mosaic' }
  const m = location.hash.match(/^#\/s\/(.+)$/)
  return m && ROUTE_NAME.test(dec(m[1])) ? { view: 'session', name: dec(m[1]) } : { view: 'mosaic' }
}

export function clearMosaic() {
  for (const p of mosaicPanes.values()) p.view.destroy()
  mosaicPanes.clear()
  state.mosaicKey = null
  $('mosaic').innerHTML = ''
}

// A worker's state in a coordinator's team: what it is doing, and for how long.
function workerState(w) {
  const a = w.activity ?? {}
  if (!w.online) return { k: 'offline', dot: '', text: T.wOffline }
  if (a.state === 'waiting') return { k: 'waiting', dot: 'err pulse', text: T.wWaiting }
  if (a.state === 'compacting') return { k: 'working', dot: 'info pulse', text: T.compacting }
  if (a.state === 'tool' || a.state === 'working') return { k: 'working', dot: 'ok pulse', text: T.wWorking(dur(now() - ((a.state === 'tool' ? a.tool?.since : a.since) ?? now()))), since: a.since }
  return { k: 'idle', dot: 'ok', text: T.wIdle(a.since ? dur(now() - a.since) : '—'), since: a.since ?? now() }
}

// A coordinator's team: who waits for a permission, who is idle (longest
// first: ready for more work), who works, who is gone.
export function teamStrip(c) {
  const ws = sortedSessions().filter(s => s.role !== 'coordinator' && s.coordinator === c.name).map(w => ({ w, st: workerState(w) }))
  const rank = { waiting: 0, idle: 1, working: 2, offline: 3 }
  ws.sort((a, b) => (rank[a.st.k] - rank[b.st.k]) || ((a.st.since ?? 0) - (b.st.since ?? 0)) || COLLATOR.compare(a.w.name, b.w.name))
  const n = k => ws.filter(x => x.st.k === k).length
  const chips = ws.map(({ w, st }) => `<span class="wchip ${st.k}"><button class="wname" data-go="#/s/${encodeURIComponent(w.name)}"><span class="dot ${st.dot}"></span>${esc(w.name)}</button>${personaTag(w.persona)}<span class="wst">${esc(st.text)}</span>${st.k === 'idle' ? `<button class="give" data-givework="${esc(c.name)}" title="${esc(T.giveWorkTitle(w.name, c.name))}">${T.giveWork}</button>` : ''}</span>`).join('')
  return `<div class="team-sum">${ws.length ? esc(T.teamSummary(ws.length, n('working'), n('idle'), n('waiting'))) : T.noWorkers}</div>
      <div class="team-list">${chips}<button class="btn addw" data-addworker="${esc(c.name)}" title="${esc(T.addWorkerTo(c.name))}">${T.addWorker}</button></div>`
}
export function refreshLeads() {
  if (currentRoute().view !== 'leads') return
  for (const [name, p] of mosaicPanes) { const s = sessions.get(name); const el = p.pane.querySelector('.team'); if (s && el) setHtml(el, teamStrip(s)) }
}

// "Give work": straight to the coordinator's terminal, ready to type (nothing typed for you).
export function giveWork(coord) {
  const p = mosaicPanes.get(coord)
  if (p?.kind === 'term' && p.view.x) { p.pane.scrollIntoView?.({ block: 'nearest' }); p.view.x.focus() }
  else location.hash = `#/s/${encodeURIComponent(coord)}`
}

export function route() {
  const r = currentRoute()
  closeMenu()
  // Going to a worker unfolds its squad in the sidebar, so it shows where you are.
  const c = r.view === 'session' && sessions.get(r.name)?.role === 'worker' ? sessions.get(r.name).coordinator : null
  if (c && squadOpen[c] !== true) { squadOpen[c] = true; store.set('squadraSquads', JSON.stringify(squadOpen)) }
  $('archived').hidden = r.view !== 'archived'
  $('org').hidden = r.view !== 'org'
  hideOrgTip()
  $('hosts').hidden = r.view !== 'hosts'
  const st = sessionTerm(r)
  const termMode = r.view === 'terminal' || !!st
  $('terminal').hidden = !termMode
  if (!termMode && state.termView) { state.termView.destroy(); state.termView = null; $('terminal').innerHTML = '' }
  if (r.view === 'hosts' || r.view === 'terminal') {
    if (state.sessionView) { state.sessionView.destroy(); state.sessionView = null; $('session').innerHTML = '' }
    clearMosaic()
    $('session').hidden = true
    $('mosaic').hidden = true
    if (r.view === 'hosts') renderHosts(r.host)
    else if (!state.termView || state.termView.host !== r.host || state.termView.term !== r.term) {
      state.termView?.destroy()
      state.termView = new TermView(r.host, r.term, $('terminal'))
    }
  } else if (r.view === 'mosaic' || r.view === 'leads') {
    if (state.sessionView) { state.sessionView.destroy(); state.sessionView = null; $('session').innerHTML = '' }
    $('session').hidden = true
    $('mosaic').hidden = false
    buildMosaic()
  } else if (r.view === 'archived' || r.view === 'org') {
    if (state.sessionView) { state.sessionView.destroy(); state.sessionView = null; $('session').innerHTML = '' }
    clearMosaic()
    $('session').hidden = true
    $('mosaic').hidden = true
    if (r.view === 'org') renderOrg(); else renderArchived()
  } else if (st) {
    // The session's live terminal, as in Machines: watch it and type to it.
    if (state.sessionView) { state.sessionView.destroy(); state.sessionView = null; $('session').innerHTML = '' }
    clearMosaic()
    $('mosaic').hidden = true
    $('session').hidden = true
    if (!state.termView || state.termView.host !== st.host.id || state.termView.term !== r.name) {
      state.termView?.destroy()
      state.termView = new TermView(st.host.id, r.name, $('terminal'))
    }
    unread.delete(r.name)
  } else {
    clearMosaic()
    $('mosaic').hidden = true
    $('session').hidden = false
    if (!state.sessionView || state.sessionView.name !== r.name) {
      state.sessionView?.destroy()
      state.sessionView = new ChatView(r.name, { full: true })
      $('session').innerHTML = ''
      $('session').appendChild(state.sessionView.el)
    }
    unread.delete(r.name)
  }
  renderTop()
  renderNav()
}

// (Only while signed in: a link opened on the login page doesn't load views, or ask the server with no token.)
window.addEventListener('hashchange', () => { if (state.token && !$('app').hidden) route() })
