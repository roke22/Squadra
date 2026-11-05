import { $, store } from './dom.js'
import { T } from './i18n.js'
import { sessions, state, linksOf, hosts } from './state.js'
import { esc, kfmt } from './format.js'
import { sortedSessions, status } from './content.js'
import { setHtml } from './nav.js'
import { currentRoute } from './router.js'
import { applyCols, buildMosaic } from './mosaic.js'
import { runAction } from './dialogs.js'
import { terminalOf, hostLine, hostAction } from './machines.js'
import { reopenable, reopen, addWorkerTo, saveTemplateDialog } from './squads.js'
import { orgSquads, orgZoom, linksDialog } from './org.js'

// The terminal a session view shows (null: its chat).
export const sessionTerm = r => (r.view === 'session' && !r.chat ? terminalOf(r.name) : null)

// The Squadra session behind a machine's terminal: only one that machine
// opened (a machine could list any name; it can't make it its own).
export function sessionOn(hostId, term) {
  const s = sessions.get(term)
  return s && s.host_id === hostId ? s : null
}

export function roleTag(role) {
  return role ? `<span class="role-tag ${role}">${role === 'coordinator' ? T.roleCoordinator : role === 'solo' ? T.roleSolo : T.roleWorker}</span>` : ''
}

// A task's final report (done, blocked, failed, question), or information
// that needs none (fyi), on a message.
export function msgTag(it) {
  if (['done', 'blocked', 'failed', 'question'].includes(it.report)) return ` <span class="rep ${it.report}">${T.reportTag[it.report]}</span>`
  return it.fyi ? ` <span class="rep fyi">${T.fyiTag}</span>` : ''
}

// The persona (skill or agent) a session follows.
export function personaTag(p) {
  return p?.name ? `<span class="persona-tag" title="${esc(`${p.kind === 'agent' ? T.personaAgent : T.personaSkill} ${p.name}${p.description ? ` — ${p.description}` : ''}`)}">🎭 ${esc(p.name)}</span>` : ''
}

export function renderTop() {
  const r = currentRoute()
  if (r.view === 'org') {
    const { squads } = orgSquads()
    setHtml($('topTitle'), `🏢 ${T.org}`)
    $('topSub').textContent = T.orgSub(squads.length, squads.reduce((t, q) => t + 1 + q.workers.length, 0), state.links.length)
    setHtml($('topRight'), `<span class="seg"><button data-orgzoom="-" aria-label="${esc(T.orgZoomOut)}">−</button><button data-orgzoom="1" title="${esc(T.orgZoomReset)}">${Math.round(orgZoom * 100)}%</button><button data-orgzoom="+" aria-label="${esc(T.orgZoomIn)}">+</button></span><button class="btn" data-orgact="arrange" title="${esc(T.orgArrangeTitle)}">${T.orgArrange}</button><button class="btn primary" data-orgact="newsquad">${T.orgNewSquad}</button>`)
    return
  }
  if (r.view === 'leads') {
    const cs = sortedSessions().filter(s => s.role === 'coordinator')
    const ws = sortedSessions().filter(s => s.role !== 'coordinator' && cs.some(c => c.name === s.coordinator))
    setHtml($('topTitle'), `🧭 ${T.leads}`)
    $('topSub').textContent = T.leadsSub(cs.length, ws.length)
    setHtml($('topRight'), `<span>${T.columns}</span><span class="seg" id="colsSeg">${['auto', '1', '2', '3', '4'].map(n => `<button data-c="${n}" class="${n === state.cols ? 'on' : ''}">${n === 'auto' ? T.auto : n}</button>`).join('')}</span>`)
    return
  }
  if (r.view === 'mosaic') {
    const modeSeg = `<span class="seg" id="modeSeg">${['terms', 'chats'].map(m => `<button data-mode="${m}" class="${m === state.mosaicMode ? 'on' : ''}">${m === 'terms' ? T.modeTerms : T.modeChats}</button>`).join('')}</span>`
    const colsSeg = `${modeSeg}<span>${T.columns}</span><span class="seg" id="colsSeg">${['auto', '2', '3', '4', '5', '6'].map(n => `<button data-c="${n}" class="${n === state.cols ? 'on' : ''}">${n === 'auto' ? T.auto : n}</button>`).join('')}</span>`
    if (r.squad) {
      const c = sessions.get(r.squad)
      const ws = sortedSessions().filter(s => s.role !== 'coordinator' && s.coordinator === r.squad)
      setHtml($('topTitle'), `<span class="dot ${c ? status(c).dot : ''}"></span>👥 ${esc(T.squadOf(r.squad))}`)
      const linked = linksOf(r.squad)
      $('topSub').textContent = [T.squadCount(ws.filter(w => w.online).length, ws.length), linked.length ? T.linkedWith(linked.join(', ')) : ''].filter(Boolean).join(' · ')
      setHtml($('topRight'), `${colsSeg}<button class="btn" data-addworker="${esc(r.squad)}" title="${esc(T.addWorkerTo(r.squad))}">${T.addWorker}</button><button class="btn" data-links="${esc(r.squad)}" title="${esc(T.linksTitle(r.squad))}">${T.links(linked.length)}</button><button class="btn" data-savetpl="${esc(r.squad)}" title="${esc(T.saveTemplateTitle(r.squad))}">${T.saveTemplate}</button><button class="btn" data-go="#/">${T.backAll}</button>`)
      return
    }
    setHtml($('topTitle'), T.allSessions)
    $('topSub').textContent = ''
    setHtml($('topRight'), colsSeg)
  } else if (r.view === 'hosts') {
    const h = r.host && hosts.get(r.host)
    setHtml($('topTitle'), h ? `<span class="dot ${h.online ? 'ok' : ''}"></span>${esc(h.name)}` : T.allMachines)
    $('topSub').textContent = h ? hostLine(h) : T.machinesSub
    setHtml($('topRight'), `<button class="btn" data-hact="add">${T.addMachine}</button><button class="btn" data-hact="templates">${T.templates}</button><button class="btn primary" data-hact="new">${T.newSession}</button>`)
  } else if (r.view === 'terminal') {
    const h = hosts.get(r.host)
    const t = h?.info?.terminals?.find(x => x.id === r.term)
    const s = sessionOn(r.host, r.term)
    setHtml($('topTitle'), `<span class="dot ${s ? status(s).dot : ''}"></span>⌨ ${esc(r.term)} ${roleTag(s?.role ?? t?.role)} ${personaTag(s?.persona ?? t?.persona)}`)
    $('topSub').textContent = [h ? T.onHost(h.name) : '', t?.folder ?? '', h?.info && !t ? T.notListed : ''].filter(Boolean).join(' · ')
    const acts = []
    if (s) acts.push(`<button class="btn" data-go="#/s/${encodeURIComponent(r.term)}/chat">${T.chat}</button>`)
    acts.push(`<button class="btn" data-tact="redraw">${T.redraw}</button>`)
    if (t && h?.online) acts.push(`<button class="btn danger" data-tact="kill">${T.closeSession}</button>`)
    acts.push(`<button class="btn" data-go="#/h/${encodeURIComponent(r.host)}">${T.back}</button>`)
    setHtml($('topRight'), acts.join(''))
  } else if (r.view === 'archived') {
    setHtml($('topTitle'), T.archivedTitle)
    $('topSub').textContent = T.archivedSub
    setHtml($('topRight'), `<button class="btn" data-go="#/">${T.backAll}</button>`)
  } else {
    const s = sessions.get(r.name)
    const a = s?.activity ?? {}
    setHtml($('topTitle'), `<span class="dot ${status(s).dot}"></span>${esc(r.name)} ${roleTag(s?.role)} ${personaTag(s?.persona)}${s?.archived_at ? ` <span class="role-tag" style="background:var(--panel-2);color:var(--muted)">${T.archivedTag}</span>` : ''}`)
    $('topSub').textContent = [a.cwd, a.context_tokens ? T.context(kfmt(a.context_tokens)) + (a.context_pct != null ? ` (${T.contextPct(a.context_pct)})` : '') : '', s?.role === 'worker' && s.coordinator ? T.coordinatorOf(s.coordinator) : ''].filter(Boolean).join(' · ')
    const acts = []
    const where = terminalOf(r.name)
    if (where && !r.chat) {
      // Its terminal on screen: the chat a click away, and the terminal's own actions.
      acts.push(`<button class="btn" data-go="#/s/${encodeURIComponent(r.name)}/chat">${T.chat}</button>`)
      acts.push(`<button class="btn" data-tact="redraw">${T.redraw}</button>`)
      acts.push(`<button class="btn danger" data-tact="kill">${T.closeSession}</button>`)
      acts.push(`<button class="btn" data-go="${s?.archived_at ? '#/archived' : '#/'}">${s?.archived_at ? T.backArchived : T.backAll}</button>`)
      setHtml($('topRight'), acts.join(''))
      return
    }
    if (where) acts.push(`<button class="btn" data-go="#/s/${encodeURIComponent(r.name)}">${T.terminal}</button>`)
    if (reopenable(s)) acts.push(`<button class="btn primary" data-reopen="${esc(r.name)}">${T.reopen}</button>`)
    if (s) {
      if (s.approval_pending) acts.push(`<button class="btn primary" data-act="approve" data-s="${esc(s.name)}">${T.approve}</button>`)
      acts.push(`<button class="btn" data-act="clear" data-s="${esc(s.name)}">${T.clearChat}</button>`)
      if (!s.online) acts.push(s.archived_at
        ? `<button class="btn" data-act="unarchive" data-s="${esc(s.name)}">${T.unarchive}</button>`
        : `<button class="btn" data-act="archive" data-s="${esc(s.name)}">${T.archive}</button>`)
      if (!s.online) acts.push(`<button class="btn danger" data-act="delete" data-s="${esc(s.name)}">${T.delete}</button>`)
    }
    acts.push(`<button class="btn" data-go="${s?.archived_at ? '#/archived' : '#/'}">${s?.archived_at ? T.backArchived : T.backAll}</button>`)
    setHtml($('topRight'), acts.join(''))
  }
}

$('topRight').addEventListener('click', e => {
  const c = e.target.closest('[data-c]')
  if (c) { state.cols = c.dataset.c; store.set('squadraCols', state.cols); applyCols(); renderTop() }
  const ro = e.target.closest('[data-reopen]')
  if (ro) return reopen(ro.dataset.reopen)
  const md = e.target.closest('[data-mode]')
  if (md) { state.mosaicMode = md.dataset.mode === 'chats' ? 'chats' : 'terms'; store.set('squadraMosaicMode', state.mosaicMode); buildMosaic(); renderTop() }
  const go = e.target.closest('[data-go]')
  if (go) location.hash = go.dataset.go
  const act = e.target.closest('[data-act]')
  if (act) runAction(act.dataset.act, act.dataset.s)
  const hact = e.target.closest('[data-hact]')
  if (hact) hostAction(hact.dataset.hact, hact.dataset.h)
  const aw = e.target.closest('[data-addworker]')
  if (aw) addWorkerTo(aw.dataset.addworker)
  const stp = e.target.closest('[data-savetpl]')
  if (stp) saveTemplateDialog(stp.dataset.savetpl)
  const lk = e.target.closest('[data-links]')
  if (lk) linksDialog(lk.dataset.links)
  const tact = e.target.closest('[data-tact]')
  if (tact) {
    const r = currentRoute()
    const st = sessionTerm(r)
    if (tact.dataset.tact === 'redraw') state.termView?.refresh()
    if (tact.dataset.tact === 'kill') hostAction('kill', r.host ?? st?.host.id, r.term ?? r.name)
  }
})
