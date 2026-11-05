import { $ } from './dom.js'
import { T, LOCALE } from './i18n.js'
import { state } from './state.js'
import { esc, base, num, kfmt } from './format.js'
import { status, sortedSessions, squadsOf } from './content.js'
import { ChatView } from './chat.js'
import { setHtml } from './nav.js'
import { currentRoute, clearMosaic, mosaicPanes, teamStrip, giveWork } from './router.js'
import { roleTag, personaTag } from './topbar.js'
import { openMenu, confirmDialog, runAction } from './dialogs.js'
import { terminalOf } from './machines.js'
import { addWorkerTo } from './squads.js'
import { TermView } from './terminal.js'

export function paneHead(s) {
  const a = s.activity ?? {}
  return `<span class="dot ${status(s).dot}"></span><button class="title" data-go="#/s/${encodeURIComponent(s.name)}">${esc(s.name)}</button>${roleTag(s.role)}${personaTag(s.persona)}
      <span class="meta" title="${esc(a.cwd ?? '')}">${esc(base(a.cwd))}</span>${ctxBadge(a)}
      <button class="more" data-menu="${esc(s.name)}" title="${esc(T.actions(s.name))}" aria-label="${esc(T.actions(s.name))}">⋯</button>`
}

// Context gauge: tokens and % of the auto-compact point; amber from 60%, red from 80%.
function ctxBadge(a) {
  if (!a.context_tokens) return ''
  const pct = a.context_pct == null ? null : num(a.context_pct)
  const cls = pct == null ? '' : pct >= 80 ? 'hot' : pct >= 60 ? 'warm' : ''
  const title = pct != null ? T.contextTitle(pct, kfmt(a.context_tokens), kfmt(a.compact_at ?? 0)) : T.context(kfmt(a.context_tokens))
  return `<span class="ctx ${cls}" title="${esc(title)}">${esc(kfmt(a.context_tokens))}${pct != null ? ` · ${esc(pct)}%` : ' tok'}</span>`
}

export function paneClass(s) {
  const st = status(s)
  return `pane ${s.role ?? ''} ${st.waiting ? 'attention' : ''} ${s.online ? '' : 'offline'}`
}

export function applyCols() {
  const box = $('mosaic')
  box.classList.toggle('fixed', state.cols !== 'auto')
  if (state.cols !== 'auto') box.style.setProperty('--cols', state.cols)
}

// A heading row per squad (all-sessions mosaic only), reused across rebuilds.
const squadRows = new Map() // key -> element
function squadRow(key, coord, workers) {
  let el = squadRows.get(key)
  if (!el) { el = document.createElement('div'); squadRows.set(key, el) }
  if (!coord) {
    el.className = 'squad-row orphans'
    el.innerHTML = `<span class="n">${key === 'solos' ? T.standalone : T.noCoordinator}</span>`
    return el
  }
  const on = workers.filter(w => w.online).length
  el.className = 'squad-row'
  // Rewritten only when something changed, so a click on its buttons is never lost.
  const html = `<span class="dot ${status(coord).dot}"></span><span class="n">👥 ${esc(T.squadOf(coord.name))}</span><span class="m">${esc(T.squadCount(on, workers.length))}</span>
      <span class="acts"><button class="btn" data-go="#/q/${encodeURIComponent(coord.name)}" title="${esc(T.viewSquadTitle(coord.name))}">${T.viewSquad}</button><button class="btn" data-addworker="${esc(coord.name)}" title="${esc(T.addWorkerTo(coord.name))}">${T.addWorker}</button></span>`
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html }
  return el
}

export function buildMosaic() {
  const box = $('mosaic')
  const r = currentRoute()
  // The coordinators view: each coordinator's terminal and its team.
  const leads = r.view === 'leads'
  const key = `${leads ? 'leads' : r.squad ? `q:${r.squad}` : 'all'}:${state.mosaicMode}`
  if (state.mosaicKey !== key) { clearMosaic(); state.mosaicKey = key }
  box.classList.toggle('terms', leads || state.mosaicMode === 'terms')
  box.classList.toggle('leads', leads)
  applyCols()
  const squad = r.squad
  const all = sortedSessions()
  const list = leads ? all.filter(s => s.role === 'coordinator') : squad ? all.filter(s => s.name === squad || (s.role !== 'coordinator' && s.coordinator === squad)) : all
  // The order on screen: in the full mosaic, each squad under its heading row.
  const order = []
  if (squad || leads) order.push(...list.map(s => ({ s })))
  else {
    const { squads, orphans, solos } = squadsOf(all)
    for (const q of squads) order.push({ row: squadRow(`q:${q.coord.name}`, q.coord, q.workers) }, { s: q.coord }, ...q.workers.map(s => ({ s })))
    if (orphans.length) order.push(...(squads.length ? [{ row: squadRow('orphans') }] : []), ...orphans.map(s => ({ s })))
    if (solos.length) order.push({ row: squadRow('solos') }, ...solos.map(s => ({ s })))
  }
  const rowsUsed = new Set(order.filter(o => o.row).map(o => o.row))
  for (const [k, el] of squadRows) if (!rowsUsed.has(el)) { el.remove(); squadRows.delete(k) }
  // keep existing panes (and their scroll/history), add new, drop deleted
  const visible = new Set(list.map(s => s.name))
  for (const [name, p] of mosaicPanes) if (!visible.has(name)) { p.view.destroy(); p.pane.remove(); mosaicPanes.delete(name) }
  if (!list.length) {
    const arch = sortedSessions({ archived: true }).length
    box.innerHTML = `<div class="mosaic-empty">${leads ? T.leadsEmpty : squad ? esc(T.squadEmpty(squad)) : T.mosaicEmpty(arch)}</div>`
    squadRows.clear()
    return
  }
  box.querySelector('.mosaic-empty')?.remove()
  // Moving a node in the DOM resets its scroll: remember where each chat was.
  const scroll = new Map([...mosaicPanes].filter(([, p]) => p.kind === 'chat').map(([n, p]) => [n, { bottom: p.view.atBottom(), top: p.view.scrollEl.scrollTop }]))
  let prev = null
  for (const { s, row } of order) {
    if (row) {
      const expected = prev ? prev.nextSibling : box.firstChild
      if (expected !== row) box.insertBefore(row, expected)
      prev = row
      continue
    }
    let p = mosaicPanes.get(s.name)
    // Its live terminal (sessions opened on a machine from here), or its chat.
    const term = leads || state.mosaicMode === 'terms' ? terminalOf(s.name) : null
    const kind = term ? 'term' : 'chat'
    if (p && p.kind !== kind) { p.view.destroy(); p.pane.remove(); mosaicPanes.delete(s.name); p = null }
    if (!p) {
      const pane = document.createElement('section')
      pane.innerHTML = `<div class="pane-head"></div>`
      let view
      if (term) {
        const body = document.createElement('div')
        body.className = 'pane-term'
        pane.appendChild(body)
        view = new TermView(term.host.id, s.name, body, { compact: true })
      } else {
        view = new ChatView(s.name)
        pane.appendChild(view.el)
      }
      if (leads) { const team = document.createElement('div'); team.className = 'team'; pane.appendChild(team) }
      p = { pane, view, kind }
      mosaicPanes.set(s.name, p)
    }
    p.pane.className = paneClass(s)
    setHtml(p.pane.querySelector('.pane-head'), paneHead(s))
    if (leads) setHtml(p.pane.querySelector('.team'), teamStrip(s))
    // Only move panes that are out of order.
    const expected = prev ? prev.nextSibling : box.firstChild
    if (expected !== p.pane) box.insertBefore(p.pane, expected)
    prev = p.pane
  }
  for (const [n, st] of scroll) {
    const p = mosaicPanes.get(n)
    if (!p) continue
    if (st.bottom) p.view.toBottom(); else p.view.scrollEl.scrollTop = st.top
  }
}

// Counts and dots in the squad headings, without rebuilding the mosaic.
export function refreshSquadRows() {
  if (!squadRows.size) return
  const { squads } = squadsOf(sortedSessions())
  for (const q of squads) if (squadRows.has(`q:${q.coord.name}`)) squadRow(`q:${q.coord.name}`, q.coord, q.workers)
}

$('mosaic').addEventListener('click', e => {
  const gw = e.target.closest('[data-givework]')
  if (gw) return giveWork(gw.dataset.givework)
  const aw = e.target.closest('[data-addworker]')
  if (aw) return addWorkerTo(aw.dataset.addworker)
  const m = e.target.closest('[data-menu]')
  if (m) return openMenu(m, m.dataset.menu)
  const b = e.target.closest('[data-go]')
  if (b) location.hash = b.dataset.go
})

export function alertBox(text) {
  confirmDialog({ title: T.couldNotComplete, text: esc(text), confirm: T.ok, run: async () => {} })
}

// archived view
export function renderArchived() {
  const list = sortedSessions({ archived: true })
  $('archived').innerHTML = `<div class="arch-list">${list.length ? list.map(s => `
      <div class="arch ${s.role ?? ''}">
        <div class="info">
          <div class="n"><span class="dot ${status(s).dot}"></span>${esc(s.name)} ${roleTag(s.role)}</div>
          <div class="m">${T.archivedAt(new Date(s.archived_at).toLocaleString(LOCALE))} · ${esc(status(s).text)}${s.activity?.cwd ? ` · ${esc(s.activity.cwd)}` : ''}</div>
        </div>
        <div class="acts">
          <button class="btn" data-go="#/s/${encodeURIComponent(s.name)}">${T.viewChat}</button>
          <button class="btn" data-act="unarchive" data-s="${esc(s.name)}">${T.unarchive}</button>
          <button class="btn danger" data-act="delete" data-s="${esc(s.name)}" ${s.online ? 'disabled' : ''}>${T.delete}</button>
        </div>
      </div>`).join('') : `<div class="mosaic-empty">${T.noArchived}</div>`}</div>`
}

$('archived').addEventListener('click', e => {
  const go = e.target.closest('[data-go]')
  if (go) location.hash = go.dataset.go
  const act = e.target.closest('[data-act]')
  if (act && !act.disabled) runAction(act.dataset.act, act.dataset.s)
})
