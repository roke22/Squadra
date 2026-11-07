import { $, store } from './dom.js'
import { T, COLLATOR } from './i18n.js'
import { hosts, state, unread, companyPref } from './state.js'
import { esc } from './format.js'
import { sortedSessions, status, squadsOf, squadOpen } from './content.js'
import { currentRoute } from './router.js'
import { sessionOn } from './topbar.js'
import { hostState, addMachineDialog } from './machines.js'
import { orgSquads } from './org.js'

// sidebar
const isMachines = r => r.view === 'hosts' || r.view === 'terminal'

function renderTabs() {
  const r = currentRoute()
  const list = sortedSessions()
  const hostList = [...hosts.values()]
  const tab = (on, go, icon, label, count) => `<button role="tab" aria-selected="${on}" class="${on ? 'on' : ''}" data-go="${go}"><span>${icon}</span>${label}<span class="count">${count}</span></button>`
  setHtml($('tabs'), tab(!isMachines(r), '#/', '▦', T.tabSessions, `${list.filter(s => s.online).length}/${list.length}`) +
    tab(isMachines(r), '#/hosts', '🖥️', T.machines, `${hostList.filter(h => h.online).length}/${hostList.length}`))
}

// What a burst of stream changes redraws, once per frame (hundreds of
// sessions changing at once would otherwise redraw the sidebar hundreds of
// times).
const pending = new Set()
export function soon(fn) {
  if (!pending.size) requestAnimationFrame(() => { const fns = [...pending]; pending.clear(); for (const f of fns) f() })
  pending.add(fn)
}

// Rewritten only when what it shows changed: a rewrite every second would
// drop keyboard focus, open menus and clicks in progress.
// When only texts and attributes changed (a duration ticking, a dot's
// colour) they are patched in place, so focus and hover stay put too.
export function setHtml(el, html) {
  if (!el || el._html === html) return
  const t = document.createElement('template')
  t.innerHTML = html
  if (el._html === undefined || !patch(el, t.content)) el.innerHTML = html
  el._html = html
}
function patch(a, b) {
  const x = a.childNodes, y = b.childNodes
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) {
    const m = x[i], n = y[i]
    if (m.nodeType !== n.nodeType || m.nodeName !== n.nodeName) return false
    if (m.nodeType === 3) { if (m.data !== n.data) m.data = n.data; continue }
    if (m.nodeType !== 1) continue
    for (const at of [...m.attributes]) if (!n.hasAttribute(at.name)) m.removeAttribute(at.name)
    for (const at of n.attributes) if (m.getAttribute(at.name) !== at.value) m.setAttribute(at.name, at.value)
    if (!patch(m, n)) return false
  }
  return true
}
export function renderNav() {
  const route = currentRoute()
  renderTabs()
  if (isMachines(route)) return renderMachinesNav(route)
  const list = sortedSessions()
  const online = list.filter(s => s.online).length
  let html = `<button class="nav-item ${route.view === 'mosaic' && !route.squad ? 'sel' : ''}" data-go="#/"><span>▦</span><span class="n">${T.allSessions}</span><span class="badge" hidden></span><span class="s">${T.activeOf(online, list.length)}</span></button>`
  // Names waiting for the user: their ⋯ menu has the button.
  for (const s of list.filter(x => x.approval_pending)) {
    html += `<button class="nav-item" data-go="#/s/${encodeURIComponent(s.name)}" title="${esc(T.approveNote)}"><span>⚠️</span><span class="n">${esc(s.name)}</span><span></span><span class="s">${esc(T.approveNote)}</span></button>`
  }
  const inboxN = state.inbox.filter(i => !i.resolved_at).length
  html += `<button class="nav-item ${route.view === 'inbox' ? 'sel' : ''}" data-go="#/inbox"><span>📥</span><span class="n">${T.inbox}</span>${inboxN ? `<span class="badge">${inboxN}</span>` : '<span></span>'}</button>`
  const leadsN = list.filter(s => s.role === 'coordinator').length
  html += `<button class="nav-item ${route.view === 'leads' ? 'sel' : ''}" data-go="#/c"><span>🧭</span><span class="n">${T.leads}</span><span class="badge" hidden></span><span class="s">${T.leadsCount(leadsN)}</span></button>`
  html += `<button class="nav-item ${route.view === 'org' ? 'sel' : ''}" data-go="#/org"><span>🏢</span><span class="n">${T.org}</span><span class="badge" hidden></span><span class="s">${T.orgNavSub(orgSquads().squads.length, state.links.length)}</span></button>`
  const item = s => {
    const st = status(s)
    const n = unread.get(s.name) ?? 0
    const badge = st.waiting ? '<span class="badge perm">🔐</span>' : n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '<span></span>'
    return `<button class="nav-item ${s.role ?? ''} ${route.view === 'session' && route.name === s.name ? 'sel' : ''}" data-go="#/s/${encodeURIComponent(s.name)}" title="${esc(st.text)}">
        <span class="dot ${st.dot}"></span><span class="n">${esc(s.name)}</span>${badge}<span class="s">${esc(st.text)}</span></button>`
  }
  const { squads, orphans, solos } = squadsOf(list)
  if (squads.length) html += `<div class="nav-label">${T.squads}</div>`
  for (const { coord, workers } of squads) {
    const here = route.view === 'session' && workers.some(w => w.name === route.name)
    // (Opened when you go to one of its workers — see route() —, and then
    // folded or unfolded as you like.)
    const open = Object.hasOwn(squadOpen, coord.name) && squadOpen[coord.name] === true
    const on = workers.filter(w => w.online).length
    // Folded: the count chip also carries what needs attention inside.
    const waiting = workers.some(w => status(w).waiting)
    const unseen = workers.reduce((t, w) => t + (unread.get(w.name) ?? 0), 0)
    const alert = open ? '' : waiting ? '<span class="badge perm">🔐</span>' : unseen ? `<span class="badge">${unseen > 99 ? '99+' : unseen}</span>` : ''
    const squadOn = route.view === 'mosaic' && route.squad === coord.name
    html += `<div class="squad ${open ? 'open' : ''} ${here || squadOn || (route.view === 'session' && route.name === coord.name) ? 'sel-in' : ''}">
        <div class="squad-head">${item(coord)}<button class="squad-mosaic ${squadOn ? 'on' : ''}" data-go="#/q/${encodeURIComponent(coord.name)}" title="${esc(T.viewSquadTitle(coord.name))}" aria-label="${esc(T.viewSquadTitle(coord.name))}">▦</button><button class="squad-toggle" data-squad="${esc(coord.name)}" title="${esc(`${T.squadToggle(workers.length, open)} · ${T.squadCount(on, workers.length)}`)}" aria-expanded="${open}"><span>👥 ${workers.length ? `${on}/${workers.length}` : '0'}</span>${alert}<span class="chev">▸</span></button></div>
        <div class="squad-body">${workers.length ? workers.map(item).join('') : `<div class="squad-empty">${T.noWorkers}</div>`}</div>
      </div>`
  }
  if (orphans.length) html += `<div class="nav-label">${squads.length ? T.noCoordinator : T.workers}</div>${orphans.map(item).join('')}`
  if (solos.length) html += `<div class="nav-label">${T.standalone}</div>${solos.map(item).join('')}`
  const archivedCount = sortedSessions({ archived: true }).length
  html += `<div class="nav-sep"></div><button class="nav-item ${route.view === 'archived' ? 'sel' : ''}" data-go="#/archived"><span>🗄️</span><span class="n">${T.archived}</span><span class="badge" style="background:var(--idle)" ${archivedCount ? '' : 'hidden'}>${archivedCount}</span><span class="s">${T.archivedCount(archivedCount)}</span></button>`
  setHtml($('nav'), html)
}

// Machines sidebar: every machine, with the sessions opened on it.
function renderMachinesNav(route) {
  const list = [...hosts.values()].sort((a, b) => (b.online - a.online) || COLLATOR.compare(a.name, b.name))
  let html = `<button class="nav-item ${route.view === 'hosts' && !route.host ? 'sel' : ''}" data-go="#/hosts"><span>🖥️</span><span class="n">${T.allMachines}</span><span></span><span class="s">${T.machinesCount(list.filter(h => h.online).length, list.length)}</span></button>`
  if (list.length) html += `<div class="nav-label">${T.machines}</div>`
  for (const h of list) {
    const terms = h.info?.terminals ?? []
    const sub = h.online ? `${T.hostOnline} · ${T.hostSessions(terms.length)}` : hostState(h)
    html += `<button class="nav-item ${route.view === 'hosts' && route.host === h.id ? 'sel' : ''}" data-go="#/h/${encodeURIComponent(h.id)}" title="${esc(sub)}">
        <span class="dot ${h.online ? 'ok' : ''}"></span><span class="n">${esc(h.name)}</span><span></span><span class="s">${esc(sub)}</span></button>`
    if (!h.online) continue
    for (const t of terms) {
      const s = sessionOn(h.id, t.id)
      const st = s ? status(s) : { dot: '', text: '' }
      html += `<button class="nav-item sub ${t.role ?? ''} ${route.view === 'terminal' && route.host === h.id && route.term === t.id ? 'sel' : ''}" data-go="#/t/${encodeURIComponent(h.id)}/${encodeURIComponent(t.id)}" title="${esc(st.text)}">
          <span class="dot ${st.dot}"></span><span class="n">⌨ ${esc(t.name)}</span>${st.waiting ? '<span class="badge perm">🔐</span>' : '<span></span>'}</button>`
    }
  }
  setHtml($('nav'), html)
}

$('tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-go]')
  if (b) location.hash = b.dataset.go
})
$('addHostBtn').addEventListener('click', () => {
  $('side').classList.remove('open')
  if (!isMachines(currentRoute())) location.hash = '#/hosts'
  addMachineDialog()
})

$('nav').addEventListener('click', e => {
  const t = e.target.closest('[data-squad]')
  if (t) {
    const name = t.dataset.squad
    squadOpen[name] = !t.closest('.squad').classList.contains('open')
    store.set(companyPref('squadraSquads'), JSON.stringify(squadOpen))
    return renderNav()
  }
  const b = e.target.closest('[data-go]')
  if (!b) return
  location.hash = b.dataset.go
  $('side').classList.remove('open')
})
$('menuBtn').addEventListener('click', () => $('side').classList.toggle('open'))
