import { store, $ } from './dom.js'
import { T } from './i18n.js'
import { state, sessions, hosts, linksOf, linkListeners } from './state.js'
import { now, esc } from './format.js'
import { sortedSessions, byPresence, status } from './content.js'
import { setHtml, soon } from './nav.js'
import { currentRoute } from './router.js'
import { roleTag, renderTop, personaTag } from './topbar.js'
import { alertBox } from './mosaic.js'
import { closeMenu, confirmDialog, post, runAction, dialog } from './dialogs.js'
import { terminalOf, postJson, hostAction } from './machines.js'
import {
  personaName, newSessionDialog, addWorkerTo, saveTemplateDialog, reopenable, reopen, personaOptions,
} from './squads.js'

// org chart: each squad as a card (its coordinator and workers), the links
// between squads as lines, and what each one is for on hover. From here
// squads and agents are added, described, moved, linked, closed and
// deleted, through the same actions as everywhere else in the dashboard.

const ORG_W = 280, ORG_GAP_X = 90, ORG_GAP_Y = 40, ORG_PAD = 32, ORG_FOLD = 6

// (Fixed heights, as in the CSS: cards are laid out and linked without measuring them.)
const ORG_H = { head: 44, goal: 36, row: 32, fold: 28, foot: 42 }
export let orgZoom = (() => { const z = Number(store.get('squadraOrgZoom')); return z >= 0.4 && z <= 1.6 ? z : 1 })()
let orgDrag = null                       // a card or a new link being dragged
let orgPos = new Map()                   // coordinator -> {x, y, h}, as drawn
const orgOpen = new Set()                // squads showing all their workers
const orgSaved = new Set()               // squads placed automatically, already saved
let orgTipKey = null

const squadTitle = name => state.squadMeta.get(name)?.title || name

// What a session is for: what was written for it here, else what its persona says.
const purposeOf = s => s?.description || s?.persona?.description || ''
const personaOf = s => s?.persona?.name || personaName(s?.opened_persona) || ''
const recentOf = l => (l.recent ?? []).filter(t => now() - t < 3600_000).length
const orgNarrow = () => matchMedia('(max-width: 900px)').matches

// Squads as in the sidebar, plus the sessions opened here that haven't
// joined yet (Claude Code still starting, or waiting for its login): by the
// role and coordinator they were opened with.
const orgRole = s => s.role ?? s.opened_role ?? null
const orgCoordOf = s => s.coordinator ?? terminalOf(s.name)?.term.coordinator ?? null
export function orgSquads() {
  const list = sortedSessions()
  const coords = list.filter(s => orgRole(s) === 'coordinator')
  const names = new Set(coords.map(c => c.name))
  return {
    squads: coords.map(c => ({ coord: c, workers: list.filter(s => orgRole(s) === 'worker' && orgCoordOf(s) === c.name).sort(byPresence) })),
    orphans: list.filter(s => orgRole(s) !== 'coordinator' && orgRole(s) !== 'solo' && !(orgRole(s) === 'worker' && names.has(orgCoordOf(s)))),
    solos: list.filter(s => orgRole(s) === 'solo'),
  }
}

function orgCardHeight(q) {
  const shown = orgOpen.has(q.coord.name) ? q.workers.length : Math.min(q.workers.length, ORG_FOLD)
  return 2 + ORG_H.head + (state.squadMeta.get(q.coord.name)?.goal ? ORG_H.goal : 0) + ORG_H.row * (1 + shown) +
    (q.workers.length > ORG_FOLD ? ORG_H.fold : 0) + ORG_H.foot
}

// Where each card goes: where it was put, or, for a new squad, the lowest
// free spot in a column (all of them with "arrange").
function orgLayout(squads, { arrange = false } = {}) {
  const pos = new Map()
  const loose = []
  for (const q of squads) {
    const m = state.squadMeta.get(q.coord.name)
    if (!arrange && Number.isFinite(m?.x) && Number.isFinite(m?.y)) pos.set(q.coord.name, { x: m.x, y: m.y, h: orgCardHeight(q) })
    else loose.push(q)
  }
  if (loose.length) {
    const width = ($('org').clientWidth || 1200) / orgZoom
    const cols = Math.max(1, Math.floor((width - ORG_PAD) / (ORG_W + ORG_GAP_X)))
    const bottoms = Array.from({ length: cols }, (_, i) => {
      const x0 = ORG_PAD + i * (ORG_W + ORG_GAP_X)
      let b = ORG_PAD
      for (const p of pos.values()) if (p.x < x0 + ORG_W && p.x + ORG_W > x0) b = Math.max(b, p.y + p.h + ORG_GAP_Y)
      return b
    })
    for (const q of loose) {
      const i = bottoms.indexOf(Math.min(...bottoms))
      const p = { x: ORG_PAD + i * (ORG_W + ORG_GAP_X), y: bottoms[i], h: orgCardHeight(q), auto: true }
      bottoms[i] = p.y + p.h + ORG_GAP_Y
      pos.set(q.coord.name, p)
    }
  }
  return pos
}

// A link's line, between the two cards' sides (or top and bottom, when one
// is above the other), and the middle point for its label.
function orgLinkPath(p, q) {
  const pc = p.x + ORG_W / 2, qc = q.x + ORG_W / 2
  if (Math.abs(pc - qc) >= ORG_W + 20) {
    const right = qc > pc
    const x1 = right ? p.x + ORG_W : p.x, x2 = right ? q.x : q.x + ORG_W
    const y1 = p.y + ORG_H.head / 2, y2 = q.y + ORG_H.head / 2
    const d = Math.max(40, Math.abs(x2 - x1) / 2) * (right ? 1 : -1)
    return { d: `M${x1} ${y1} C${x1 + d} ${y1} ${x2 - d} ${y2} ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 }
  }
  const down = q.y > p.y
  const y1 = down ? p.y + p.h : p.y, y2 = down ? q.y : q.y + q.h
  const d = Math.max(30, Math.abs(y2 - y1) / 2) * (down ? 1 : -1)
  return { d: `M${pc} ${y1} C${pc} ${y1 + d} ${qc} ${y2 - d} ${qc} ${y2}`, mx: (pc + qc) / 2, my: (y1 + y2) / 2 }
}
function orgLinesHtml() {
  let paths = '', labels = ''
  for (const l of state.links) {
    const p = orgPos.get(l.a), q = orgPos.get(l.b)
    if (!p || !q) continue
    const { d, mx, my } = orgLinkPath(p, q)
    const n = recentOf(l)
    // (Amber from three quarters of what two coordinators may send each other in an hour.)
    const cls = n >= 60 ? 'full' : n >= 45 ? 'warn' : ''
    paths += `<path class="l ${cls}" d="${d}"/><path class="hit" d="${d}" data-la="${esc(l.a)}" data-lb="${esc(l.b)}"/>`
    labels += `<button class="org-label ${cls}" style="left:${Math.round(mx)}px;top:${Math.round(my)}px" data-la="${esc(l.a)}" data-lb="${esc(l.b)}" title="${esc(T.orgLinkRecent(n))}">🔗 ${n}</button>`
  }
  return { paths, labels }
}

function orgAgent(s, kind) {
  const pct = s.activity?.context_pct
  const persona = personaOf(s)
  return `<div class="org-agent ${kind}" data-orgtip="agent:${esc(s.name)}" tabindex="0">
      <span class="dot ${status(s).dot}"></span><span class="n">${esc(s.name)}</span>${persona ? `<span class="org-persona">🎭 ${esc(persona)}</span>` : ''}
      <span class="org-ctx">${Number.isFinite(pct) ? `<span class="ctx ${pct >= 80 ? 'hot' : pct >= 60 ? 'warm' : ''}">${Math.round(pct)}%</span>` : ''}</span>
      <button class="org-more" data-orgmenu="agent" data-name="${esc(s.name)}" aria-label="${esc(T.orgAgentMenu(s.name))}">⋯</button></div>`
}
function orgCard(q, p) {
  const c = q.coord, m = state.squadMeta.get(c.name) ?? {}
  const shown = orgOpen.has(c.name) ? q.workers : q.workers.slice(0, ORG_FOLD)
  const on = q.workers.filter(w => w.online).length
  return `<div class="org-card" data-squad="${esc(c.name)}" style="left:${p.x}px;top:${p.y}px">
      <div class="org-head" data-orgtip="squad:${esc(c.name)}" tabindex="0"><span class="org-title">${esc(m.title || c.name)}</span>${c.online && !on ? `<span class="org-self" title="${esc(T.orgSelfWorking)}">🛠</span>` : ''}<span class="org-count" title="${esc(T.squadCount(on, q.workers.length))}">👥 ${on}/${q.workers.length}</span><button class="org-more" data-orgmenu="squad" data-name="${esc(c.name)}" aria-label="${esc(T.orgSquadMenu(c.name))}">⋯</button></div>
      ${m.goal ? `<div class="org-goal">${esc(m.goal)}</div>` : ''}
      ${orgAgent(c, 'coord')}${shown.map(w => orgAgent(w, 'worker')).join('')}
      ${q.workers.length > ORG_FOLD ? `<button class="org-fold" data-orgfold="${esc(c.name)}">${orgOpen.has(c.name) ? T.orgLess : T.orgMore(q.workers.length - shown.length)}</button>` : ''}
      <div class="org-foot"><button class="btn" data-orgact="addagent" data-name="${esc(c.name)}">${T.orgAddAgent}</button></div>
      <span class="org-handle" data-orghandle="${esc(c.name)}" title="${esc(T.orgLinkHandle)}"></span></div>`
}

export function renderOrg() {
  if (orgDrag) return // (drawn again when the drag ends)
  const { squads, orphans, solos } = orgSquads()
  orgPos = orgLayout(squads)
  // New squads stay where they were first put.
  const fresh = squads.filter(q => orgPos.get(q.coord.name).auto && !orgSaved.has(q.coord.name))
  if (fresh.length) {
    for (const q of fresh) orgSaved.add(q.coord.name)
    postJson('/api/org/positions', { positions: fresh.map(q => ({ coordinator: q.coord.name, x: orgPos.get(q.coord.name).x, y: orgPos.get(q.coord.name).y })) }).catch(() => {})
  }
  let w = 0, h = 0
  for (const p of orgPos.values()) { w = Math.max(w, p.x + ORG_W); h = Math.max(h, p.y + p.h) }
  w += ORG_PAD + 240; h += ORG_PAD + 160 // (room to drag a card further)
  const { paths, labels } = orgLinesHtml()
  const extra = [[T.noCoordinator, orphans], [T.standalone, solos]].filter(([, l]) => l.length)
    .map(([label, l]) => `<div class="org-extra"><div class="org-extra-h">${esc(label)}</div>${l.map(s => orgAgent(s, 'loose')).join('')}</div>`).join('')
  setHtml($('org'), `${squads.length ? '' : `<div class="org-empty"><p>${T.orgEmpty}</p><button class="btn primary" data-orgact="newsquad">${T.orgNewSquad}</button></div>`}
      <div class="org-wrap" style="width:${Math.round(w * orgZoom)}px;height:${squads.length ? Math.round(h * orgZoom) : 0}px">
        <div class="org-stage" style="width:${w}px;height:${h}px;transform:scale(${orgZoom})">
          <svg class="org-lines" width="${w}" height="${h}">${paths}</svg>
          ${squads.map(q => orgCard(q, orgPos.get(q.coord.name))).join('')}
          <div class="org-labels">${labels}</div>
        </div>
      </div>${extra ? `<div class="org-extras">${extra}</div>` : ''}`)
  if (orgTipKey) {
    const el = $('org').querySelector(`[data-orgtip="${CSS.escape(orgTipKey)}"]`)
    if (el) showOrgTip(el); else hideOrgTip()
  }
}

// During a drag: only the moved card and the lines.
function drawOrgLines() {
  const { paths, labels } = orgLinesHtml()
  const svg = $('org').querySelector('.org-lines')
  const tmp = svg.querySelector('.tmp')?.outerHTML ?? ''
  svg.innerHTML = paths + tmp
  $('org').querySelector('.org-labels').innerHTML = labels
}
const stagePoint = e => {
  const r = $('org').querySelector('.org-stage').getBoundingClientRect()
  return { x: (e.clientX - r.left) / orgZoom, y: (e.clientY - r.top) / orgZoom }
}
function endOrgDrag() {
  if (!orgDrag) return
  $('org').querySelectorAll('.drop').forEach(x => x.classList.remove('drop'))
  $('org').querySelector('.org-lines .tmp')?.remove()
  orgDrag = null
  $('org')._html = undefined // (the DOM was changed by hand: drawn again in full)
  renderOrg()
}

// Hover (or keyboard focus): what a squad or an agent is for.
function orgTipHtml(key) {
  const i = key.indexOf(':')
  const kind = key.slice(0, i), name = key.slice(i + 1)
  if (kind === 'agent') {
    const s = sessions.get(name)
    if (!s) return ''
    const where = terminalOf(name)
    const host = where?.host ?? hosts.get(s.host_id)
    const folder = where?.term.folder ?? s.activity?.cwd
    const purpose = purposeOf(s)
    const pct = s.activity?.context_pct
    return `<div class="org-tip-t">${esc(name)} ${roleTag(orgRole(s))}</div>
        <p>${purpose ? esc(purpose) : `<i>${T.orgNoPurpose}</i>`}</p>
        ${personaOf(s) ? `<div>🎭 ${esc(personaOf(s))}${s.description && s.persona?.description ? ` — <span class="m">${esc(s.persona.description)}</span>` : ''}</div>` : ''}
        <div class="m"><span class="dot ${status(s).dot}"></span> ${esc(status(s).text)}</div>
        ${host || folder ? `<div class="m">${[host ? T.onHost(host.name) : '', folder].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
        ${Number.isFinite(pct) ? `<div class="m">${esc(T.contextPct(Math.round(pct)))}</div>` : ''}`
  }
  const c = sessions.get(name)
  if (!c) return ''
  const m = state.squadMeta.get(name) ?? {}
  const workers = orgSquads().squads.find(q => q.coord.name === name)?.workers ?? []
  const linked = linksOf(name)
  return `<div class="org-tip-t">${esc(m.title || name)}${m.title ? ` <span class="m">· ${esc(name)}</span>` : ''}</div>
      <p>${m.goal ? esc(m.goal) : `<i>${T.orgNoGoal}</i>`}</p>
      ${personaOf(c) ? `<div>🎭 ${esc(personaOf(c))}</div>` : ''}
      <div class="m">${esc(T.squadCount(workers.filter(w => w.online).length, workers.length))}</div>
      ${c.online && !workers.some(w => w.online) ? `<div class="m">🛠 ${esc(T.orgSelfWorking)}</div>` : ''}
      ${linked.length ? `<div class="m">🔗 ${linked.map(n => esc(squadTitle(n))).join(', ')}</div>` : ''}`
}
const orgTip = document.createElement('div')
orgTip.className = 'org-tip'
orgTip.hidden = true
orgTip.setAttribute('role', 'tooltip')
document.body.appendChild(orgTip)
function showOrgTip(el) {
  const html = orgTipHtml(el.dataset.orgtip)
  if (!html) return hideOrgTip()
  orgTipKey = el.dataset.orgtip
  setHtml(orgTip, html)
  orgTip.hidden = false
  const r = el.getBoundingClientRect()
  const w = orgTip.offsetWidth, h = orgTip.offsetHeight
  const left = r.right + 10 + w <= innerWidth ? r.right + 10 : Math.max(8, r.left - 10 - w)
  orgTip.style.left = `${left}px`
  orgTip.style.top = `${Math.max(8, Math.min(r.top, innerHeight - h - 8))}px`
}
export function hideOrgTip() { orgTip.hidden = true; orgTipKey = null }
$('org').addEventListener('pointerover', e => { const el = e.target.closest('[data-orgtip]'); if (el && !orgDrag && !state.menuEl && el.dataset.orgtip !== orgTipKey) showOrgTip(el) })
$('org').addEventListener('pointerout', e => { const el = e.target.closest('[data-orgtip]'); if (el && !el.contains(e.relatedTarget)) hideOrgTip() })
$('org').addEventListener('focusin', e => { const el = e.target.closest('[data-orgtip]'); if (el) showOrgTip(el) })
$('org').addEventListener('focusout', hideOrgTip)
$('org').addEventListener('scroll', hideOrgTip)

// Dragging a card by its header moves it; dragging its handle onto another
// card links the two squads.
$('org').addEventListener('pointerdown', e => {
  if (e.button !== 0 || orgNarrow()) return
  const handle = e.target.closest('[data-orghandle]')
  const head = !handle && !e.target.closest('button') && e.target.closest('.org-head')
  if (!handle && !head) return
  e.preventDefault()
  hideOrgTip()
  if (handle) {
    const from = handle.dataset.orghandle
    orgDrag = { kind: 'link', from }
    $('org').querySelector('.org-lines').insertAdjacentHTML('beforeend', '<path class="l tmp" d=""/>')
  } else {
    const card = head.closest('.org-card')
    orgDrag = { kind: 'card', name: card.dataset.squad, card, px: e.clientX, py: e.clientY, x: parseFloat(card.style.left), y: parseFloat(card.style.top), moved: false }
  }
})
addEventListener('pointermove', e => {
  if (!orgDrag) return
  if (orgDrag.kind === 'card') {
    const dx = (e.clientX - orgDrag.px) / orgZoom, dy = (e.clientY - orgDrag.py) / orgZoom
    if (!orgDrag.moved && Math.hypot(dx, dy) < 4) return
    orgDrag.moved = true
    const x = Math.max(0, Math.round(orgDrag.x + dx)), y = Math.max(0, Math.round(orgDrag.y + dy))
    orgDrag.card.style.left = `${x}px`
    orgDrag.card.style.top = `${y}px`
    Object.assign(orgPos.get(orgDrag.name), { x, y })
    drawOrgLines()
    return
  }
  const p = orgPos.get(orgDrag.from)
  if (!p) return
  const to = stagePoint(e)
  const x1 = p.x + ORG_W, y1 = p.y + ORG_H.head / 2
  $('org').querySelector('.org-lines .tmp')?.setAttribute('d', `M${x1} ${y1} C${x1 + 60} ${y1} ${to.x - 60} ${to.y} ${to.x} ${to.y}`)
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.org-card')
  $('org').querySelectorAll('.org-card.drop').forEach(x => { if (x !== over) x.classList.remove('drop') })
  if (over && over.dataset.squad !== orgDrag.from) over.classList.add('drop')
})
addEventListener('pointerup', async e => {
  const d = orgDrag
  if (!d) return
  if (d.kind === 'card') {
    if (d.moved) {
      const p = orgPos.get(d.name)
      state.squadMeta.set(d.name, { ...(state.squadMeta.get(d.name) ?? { coordinator: d.name }), x: p.x, y: p.y })
      postJson('/api/org/positions', { positions: [{ coordinator: d.name, x: p.x, y: p.y }] }).catch(err => alertBox(err.message))
    }
    return endOrgDrag()
  }
  const to = document.elementFromPoint(e.clientX, e.clientY)?.closest('.org-card')?.dataset.squad
  endOrgDrag()
  if (!to || to === d.from) return
  try {
    const r = await postJson('/api/links/add', { a: d.from, b: to })
    if (r?.warnings?.length) alertBox(r.warnings.join(' · '))
  } catch (err) { alertBox(err.message) }
})
addEventListener('keydown', e => { if (e.key === 'Escape' && orgDrag) endOrgDrag() })
addEventListener('resize', () => { if (currentRoute().view === 'org') soon(renderOrg) })

$('org').addEventListener('click', e => {
  const menu = e.target.closest('[data-orgmenu]')
  if (menu) return menu.dataset.orgmenu === 'squad' ? squadMenu(menu, menu.dataset.name) : agentMenu(menu, menu.dataset.name)
  const fold = e.target.closest('[data-orgfold]')
  if (fold) { const n = fold.dataset.orgfold; if (orgOpen.has(n)) orgOpen.delete(n); else orgOpen.add(n); return renderOrg() }
  const link = e.target.closest('[data-la]')
  if (link) return linkMenu(link, link.dataset.la, link.dataset.lb)
})
$('org').addEventListener('dblclick', e => {
  const a = e.target.closest('.org-agent')
  if (a && !e.target.closest('button')) location.hash = `#/s/${encodeURIComponent(a.dataset.orgtip.slice(6))}`
})

// (The top bar's buttons too.)
document.addEventListener('click', e => {
  const act = e.target.closest('[data-orgact]')
  if (act) {
    if (act.dataset.orgact === 'newsquad') newSessionDialog(undefined, { role: 'coordinator' })
    if (act.dataset.orgact === 'addagent') addWorkerTo(act.dataset.name)
    if (act.dataset.orgact === 'arrange') arrangeOrg()
  }
  const z = e.target.closest('[data-orgzoom]')
  if (z) {
    const v = z.dataset.orgzoom
    orgZoom = v === '1' ? 1 : Math.min(1.6, Math.max(0.4, Math.round((orgZoom + (v === '+' ? 0.1 : -0.1)) * 10) / 10))
    store.set('squadraOrgZoom', String(orgZoom))
    renderOrg()
    renderTop()
  }
})

function arrangeOrg() {
  const { squads } = orgSquads()
  if (!squads.length) return
  const pos = orgLayout(squads, { arrange: true })
  for (const [name, p] of pos) state.squadMeta.set(name, { ...(state.squadMeta.get(name) ?? { coordinator: name }), x: p.x, y: p.y })
  renderOrg()
  postJson('/api/org/positions', { positions: [...pos].map(([coordinator, p]) => ({ coordinator, x: p.x, y: p.y })) }).catch(err => alertBox(err.message))
}

// A small menu next to what was clicked: [{label, run, danger, disabled}].
function orgMenuAt(anchor, items, head = '') {
  closeMenu()
  hideOrgTip()
  state.menuEl = document.createElement('div')
  state.menuEl.className = 'menu'
  state.menuEl.innerHTML = (head ? `<div class="hint">${head}</div>` : '') +
    items.filter(Boolean).map((it, i) => `<button data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${esc(it.label)}</button>`).join('')
  document.body.appendChild(state.menuEl)
  const r = anchor.getBoundingClientRect()
  const w = state.menuEl.offsetWidth
  state.menuEl.style.top = `${Math.min(r.bottom + 4, innerHeight - state.menuEl.offsetHeight - 8)}px`
  state.menuEl.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`
  const list = items.filter(Boolean)
  state.menuEl.addEventListener('click', e => {
    const b = e.target.closest('button')
    if (!b || b.disabled) return
    closeMenu()
    list[Number(b.dataset.i)].run()
  })
}

function squadMenu(anchor, name) {
  const workers = orgSquads().squads.find(q => q.coord.name === name)?.workers ?? []
  const members = [...workers.map(w => w.name), name]
  const running = members.filter(n => terminalOf(n))
  const anyOn = members.some(n => sessions.get(n)?.online)
  orgMenuAt(anchor, [
    { label: T.orgEditSquad, run: () => squadDialog(name) },
    { label: T.addWorkerTo(name), run: () => addWorkerTo(name) },
    { label: T.links(linksOf(name).length), run: () => linksDialog(name) },
    { label: T.viewSquad, run: () => { location.hash = `#/q/${encodeURIComponent(name)}` } },
    { label: T.saveTemplateTitle(name), run: () => saveTemplateDialog(name) },
    { label: T.orgCloseSquad, danger: true, disabled: !running.length, run: () => confirmDialog({
      title: T.orgCloseSquadTitle(squadTitle(name)), text: T.orgCloseSquadText(running.map(n => `<b>${esc(n)}</b>`).join(', ')), confirm: T.orgCloseSquad, danger: true,
      run: async () => { for (const n of running) { const w = terminalOf(n); if (w) await postJson('/api/terminals/kill', { host: w.host.id, term: n }) } },
    }) },
    { label: T.orgDeleteSquad, danger: true, disabled: anyOn || running.length > 0, run: () => confirmDialog({
      title: T.orgDeleteSquadTitle(squadTitle(name)), text: T.orgDeleteSquadText(members.map(n => `<b>${esc(n)}</b>`).join(', ')), confirm: T.orgDeleteSquad, danger: true,
      run: async () => { for (const n of members) if (sessions.has(n)) await post('delete', n) },
    }) },
  ])
}

function agentMenu(anchor, name) {
  const s = sessions.get(name)
  if (!s) return
  const where = terminalOf(name)
  const role = s.opened_role ?? s.role
  orgMenuAt(anchor, [
    { label: T.orgDescribe, run: () => describeDialog(name) },
    s.host_id && (role === 'worker' || role === 'coordinator') ? { label: T.orgReshape, disabled: !hosts.get(s.host_id)?.online, run: () => reshapeDialog(name) } : null,
    where ? { label: T.terminal, run: () => { location.hash = `#/t/${encodeURIComponent(where.host.id)}/${encodeURIComponent(name)}` } } : null,
    { label: T.openChat, run: () => { location.hash = `#/s/${encodeURIComponent(name)}/chat` } },
    reopenable(s) ? { label: T.reopen, run: () => reopen(name) } : null,
    where ? { label: T.closeSession, danger: true, run: () => hostAction('kill', where.host.id, name) } : null,
    { label: T.deleteSession, danger: true, disabled: s.online, run: () => runAction('delete', name) },
  ])
}

function linkMenu(anchor, a, b) {
  const l = state.links.find(x => x.a === a && x.b === b)
  if (!l) return
  orgMenuAt(anchor, [
    { label: T.unlink, danger: true, run: () => postJson('/api/links/delete', { a, b }).catch(err => alertBox(err.message)) },
  ], `${esc(squadTitle(a))} ↔ ${esc(squadTitle(b))}<br>${esc(T.orgLinkRecent(recentOf(l)))}`)
}

function squadDialog(name) {
  const m = state.squadMeta.get(name) ?? {}
  const d = dialog(`<h3>${esc(T.orgEditSquadTitle(name))}</h3>
      <label class="field"><span>${T.orgSquadTitle}</span><input type="text" name="title" maxlength="40" value="${esc(m.title ?? '')}" placeholder="${esc(name)}" autocomplete="off"></label>
      <label class="field"><span>${T.orgGoal}</span><textarea name="goal" maxlength="300" rows="3">${esc(m.goal ?? '')}</textarea><span class="hint">${T.orgGoalHint}</span></label>
      <div class="err" style="color:var(--err);font-size:13px;min-height:1.2em"></div>
      <div class="actions"><button class="btn" data-cancel>${T.cancel}</button><button class="btn primary" data-ok>${T.save}</button></div>`)
  const f = n => d.el.querySelector(`[name=${n}]`)
  f('title').focus()
  d.el.querySelector('[data-ok]').addEventListener('click', async () => {
    try { await postJson('/api/org/squad', { coordinator: name, title: f('title').value, goal: f('goal').value }); d.close() } catch (err) { d.el.querySelector('.err').textContent = err.message }
  })
}

function describeDialog(name) {
  const s = sessions.get(name)
  if (!s) return
  const d = dialog(`<h3>${esc(T.orgDescribeTitle(name))}</h3>
      <label class="field"><span>${T.orgPurpose}</span><textarea name="desc" maxlength="300" rows="3" placeholder="${esc(s.persona?.description ?? '')}">${esc(s.description ?? '')}</textarea><span class="hint">${T.orgDescribeHint}</span></label>
      <div class="err" style="color:var(--err);font-size:13px;min-height:1.2em"></div>
      <div class="actions"><button class="btn" data-cancel>${T.cancel}</button><button class="btn primary" data-ok>${T.save}</button></div>`)
  const ta = d.el.querySelector('textarea')
  ta.focus()
  d.el.querySelector('[data-ok]').addEventListener('click', async () => {
    try { await postJson('/api/org/describe', { name, description: ta.value }); d.close() } catch (err) { d.el.querySelector('.err').textContent = err.message }
  })
}

// Another persona, or (a worker) another squad: both are fixed when a
// session starts (its system prompt, its coordinator), so the session is
// closed and opened again with them, in the same folder.
function reshapeDialog(name) {
  const s = sessions.get(name)
  const h = hosts.get(s?.host_id)
  if (!s || !h?.online) return alertBox(T.orgNeedsMachine)
  const where = terminalOf(name)
  const folder = where?.term.folder ?? s.activity?.cwd
  if (!folder) return alertBox(T.orgNoFolder(name))
  const role = s.opened_role ?? s.role
  const coords = orgSquads().squads.map(q => q.coord).filter(x => x.name !== name)
  const resume = h.info?.allow_resume === true
  const was = where?.term.persona?.id ?? s.opened_persona ?? ''
  const d = dialog(`<h3>${esc(T.orgReshapeTitle(name))}</h3><p class="hint" style="font-size:12.5px;margin:-2px 0 12px">${T.orgReshapeHint(esc(folder))}</p>
      <label class="field"><span>${T.persona}</span><select name="persona"><option value="">${T.personaNone}</option></select></label>
      <div class="persona-hint"></div>
      ${role === 'worker' ? `<label class="field"><span>${T.orgSquad}</span><select name="coord">${coords.map(c => `<option value="${esc(c.name)}" ${c.name === s.coordinator ? 'selected' : ''}>${esc(squadTitle(c.name))}${squadTitle(c.name) !== c.name ? ` (${esc(c.name)})` : ''}</option>`).join('')}</select></label>` : ''}
      ${resume ? `<label style="display:flex;gap:8px;align-items:center;font-size:13px;margin:4px 0 10px"><input type="checkbox" name="resume" checked> ${T.orgResume}</label>` : `<p class="hint" style="font-size:12px;color:var(--muted)">${T.orgNoResume}</p>`}
      <div class="err" style="color:var(--err);font-size:13px;min-height:1.2em"></div>
      <div class="actions"><button class="btn" data-cancel>${T.cancel}</button><button class="btn primary" data-ok>${T.orgReopenBtn}</button></div>`, { wide: true })
  const f = n => d.el.querySelector(`[name=${n}]`)
  const hint = d.el.querySelector('.persona-hint')
  let list = []
  const note = () => { const p = list.find(x => x.id === f('persona').value); hint.textContent = p?.description ?? '' }
  f('persona').addEventListener('change', note)
  postJson('/api/hosts/personas', { host: h.id, folder }).then(r => {
    list = r.personas ?? []
    f('persona').innerHTML = `<option value="">${T.personaNone}</option>${personaOptions(list, was, false)}`
    note()
  }).catch(err => { hint.textContent = `${T.personaLoadFailed}: ${err.message}` })
  const ok = d.el.querySelector('[data-ok]')
  ok.addEventListener('click', async () => {
    const spec = { name, role, folder }
    if (role === 'worker') spec.coordinator = f('coord')?.value || orgCoordOf(s)
    if (f('persona').value) spec.persona = f('persona').value
    if (where?.term.compact_window) spec.compact_window = where.term.compact_window
    if (f('resume')?.checked) spec.resume = true
    ok.disabled = true
    ok.textContent = T.orgReopening
    try {
      if (where) await postJson('/api/terminals/kill', { host: h.id, term: name })
      // (Until its terminal is gone and it is no longer connected: the name is free again.)
      const t0 = Date.now()
      while (terminalOf(name) || sessions.get(name)?.online) {
        if (Date.now() - t0 > 20_000) throw new Error(T.orgStillOn(name))
        await new Promise(r => setTimeout(r, 300))
      }
      await postJson('/api/terminals/open', { host: h.id, spec })
      d.close()
      location.hash = `#/t/${encodeURIComponent(h.id)}/${encodeURIComponent(name)}`
    } catch (err) {
      d.el.querySelector('.err').textContent = err.message
      ok.disabled = false
      ok.textContent = T.orgReopenBtn
    }
  })
}

// links between squads: two coordinators that may message each other. Set
// here; the machine of each one is told while it runs.
export function linksDialog(coord) {
  const body = () => {
    const mine = linksOf(coord)
    const others = sortedSessions().filter(s => s.role === 'coordinator' && s.name !== coord && !mine.includes(s.name))
    return `${mine.length
      ? `<div class="tpl-list">${mine.map(n => { const o = sessions.get(n); return `<div class="tpl-row"><span class="dot ${o ? status(o).dot : ''}"></span><span class="n">${esc(n)}</span><span class="m">${personaTag(o?.persona)}</span><button class="btn danger" data-unlink="${esc(n)}">${T.unlink}</button></div>` }).join('')}</div>`
      : `<p class="hint">${T.noLinks}</p>`}
      ${others.length
      ? `<label class="field"><span>${T.linkWith}</span><span style="display:flex;gap:8px"><select name="peer" style="flex:1">${others.map(o => `<option value="${esc(o.name)}">${esc(o.name)}</option>`).join('')}</select><button class="btn primary" data-link>${T.linkAdd}</button></span></label>`
      : `<p class="hint">${T.noOtherCoordinators}</p>`}`
  }
  const d = dialog(`<h3>${esc(T.linksTitle(coord))}</h3><p class="hint" style="font-size:12.5px;margin:-2px 0 12px">${T.linksHint}</p>
      <div data-body>${body()}</div>
      <div class="err" style="color:var(--err);font-size:13px;min-height:1.2em"></div>
      <div class="actions"><button class="btn" data-cancel>${T.done}</button></div>`, { wide: true })
  const err = d.el.querySelector('.err')
  const refresh = () => setHtml(d.el.querySelector('[data-body]'), body())
  linkListeners.add(refresh)
  const closed = d.el.onclose
  d.el.onclose = () => { linkListeners.delete(refresh); closed?.() }
  const change = async (path, other) => {
    err.textContent = ''
    try {
      const r = await postJson(path, { a: coord, b: other })
      // (The link is set; a machine that couldn't apply it now says why.)
      if (r?.warnings?.length) err.textContent = r.warnings.join(' · ')
    } catch (e) { err.textContent = e.message }
  }
  d.el.addEventListener('click', e => {
    if (e.target.closest('[data-link]')) return change('/api/links/add', d.el.querySelector('[name=peer]').value)
    const u = e.target.closest('[data-unlink]')
    if (u) change('/api/links/delete', u.dataset.unlink)
  })
}
