import { inCompany } from './api.js'
import { T } from './i18n.js'
import { sessions, state, can } from './state.js'
import { esc } from './format.js'
import { currentRoute } from './router.js'
import { alertBox } from './mosaic.js'
import { terminalOf } from './machines.js'
import { reopenable, reopen, addWorkerTo } from './squads.js'
import { showLogin } from './app.js'

// actions: clear chat, archive / unarchive, delete

export function closeMenu() { state.menuEl?.remove(); state.menuEl = null }
document.addEventListener('click', e => { if (state.menuEl && !e.target.closest('.menu') && !e.target.closest('[data-menu], [data-hmenu], [data-orgmenu], [data-la]')) closeMenu() })
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenu(); [...document.querySelectorAll('.modal-bg')].at(-1)?.querySelector('[data-cancel]')?.click() } })

export function openMenu(anchor, name) {
  closeMenu()
  const s = sessions.get(name)
  if (!s) return
  const off = s.online
  state.menuEl = document.createElement('div')
  state.menuEl.className = 'menu'
  const where = terminalOf(name)
  state.menuEl.innerHTML = `
 ${reopenable(s) && can('operator') ? `<button data-act="reopen">${T.reopen}</button>` : ''}
      <button data-go="#/s/${encodeURIComponent(name)}">${T.openChat}</button>
      ${where && can('operator') ? `<button data-go="#/t/${encodeURIComponent(where.host.id)}/${encodeURIComponent(name)}">${T.terminal}</button>` : ''}
      ${s.role === 'coordinator' ? `<button data-go="#/q/${encodeURIComponent(name)}">${T.viewSquad}</button>${can('operator') ? `<button data-act="addworker">${esc(T.addWorkerTo(name))}</button>` : ''}` : ''}
      ${s.approval_pending && can('manager') ? `<button data-act="approve">${T.approve}</button>` : ''}
      ${can('operator') ? `<button data-act="clear">${T.clearChat}</button>
      ${off ? `<button data-act="kick" class="danger">${T.kick}</button>` : ''}
      <button data-act="archive" ${off ? 'disabled' : ''}>${T.archive}</button>
      ${can('manager') ? `<button data-act="delete" class="danger" ${off ? 'disabled' : ''}>${T.deleteSession}</button>` : ''}
      ${off ? `<div class="hint">${T.offlineHint}</div>` : ''}` : ''}`
  document.body.appendChild(state.menuEl)
  const r = anchor.getBoundingClientRect()
  const w = state.menuEl.offsetWidth
  state.menuEl.style.top = `${Math.min(r.bottom + 4, innerHeight - state.menuEl.offsetHeight - 8)}px`
  state.menuEl.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`
  state.menuEl.addEventListener('click', e => {
    const b = e.target.closest('button')
    if (!b || b.disabled) return
    closeMenu()
    if (b.dataset.go) location.hash = b.dataset.go
    else if (b.dataset.act === 'reopen') reopen(name)
    else runAction(b.dataset.act, name)
  })
}

export function confirmDialog({ title, text, confirm, danger = false, option = null, run }) {
  const bg = document.createElement('div')
  bg.className = 'modal-bg'
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><p>${text}</p>${option ? `<label class="check"><input type="checkbox" data-option checked> <span>${esc(option)}</span></label>` : ''}<div class="err"></div>
      <div class="actions"><button class="btn" data-cancel>${T.cancel}</button><button class="btn primary ${danger ? 'danger' : ''}" data-ok>${esc(confirm)}</button></div></div>`
  document.body.appendChild(bg)
  const close = () => bg.remove()
  bg.addEventListener('click', e => { if (e.target === bg) close() })
  bg.querySelector('[data-cancel]').addEventListener('click', close)
  const ok = bg.querySelector('[data-ok]')
  ;(danger ? bg.querySelector('[data-cancel]') : ok).focus() // Enter never confirms something destructive
  ok.addEventListener('click', async () => {
    ok.disabled = true
    try { await run(bg.querySelector('[data-option]')?.checked); close() } catch (err) {
      bg.querySelector('.err').textContent = err.message
      ok.disabled = false
    }
  })
}

export async function post(action, session) {
  const r = await fetch(inCompany(`/api/${action}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session }),
  })
  if (r.status === 401) { showLogin(T.sessionEnded); throw new Error(T.unauthorized) }
  const j = await r.json()
  if (!j.ok) throw new Error(j.parameters?.reason === 'session_online' ? T.sessionOnline : j.description)
  return j.result
}

export function runAction(action, name) {
  if (action === 'addworker') return addWorkerTo(name)
  const s = sessions.get(name)
  const who = `<b>${esc(name)}</b>`
  if (action === 'approve') {
    return confirmDialog({ title: T.approveTitle(name), text: T.approveText(who), confirm: T.approve, run: () => post('approve', name) })
  }
  if (action === 'kick') {
    return confirmDialog({ title: T.kickTitle(name), text: T.kickText(who), confirm: T.kick, danger: true, run: () => post('kick', name) })
  }
  if (action === 'clear') {
    return confirmDialog({
      title: T.clearTitle(name),
      text: T.clearText(who, s?.online),
      confirm: T.clearChat,
      danger: true,
      run: () => post('clear', name),
    })
  }
  if (action === 'archive') {
    return confirmDialog({
      title: T.archiveTitle(name),
      text: T.archiveText(who),
      confirm: T.archive,
      run: () => post('archive', name),
    })
  }
  if (action === 'unarchive') return post('unarchive', name).catch(err => alertBox(err.message))
  if (action === 'delete') {
    return confirmDialog({
      title: T.deleteTitle(name),
      text: T.deleteText(who, esc(name)),
      confirm: T.delete,
      danger: true,
      run: async () => {
        await post('delete', name)
        if (currentRoute().name === name) location.hash = s?.archived_at ? '#/archived' : '#/'
      },
    })
  }
}

// A dialog with arbitrary content; returns its root and a close function.
export function dialog(html, { wide = false } = {}) {
  const bg = document.createElement('div')
  bg.className = 'modal-bg'
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`
  document.body.appendChild(bg)
  const close = () => { bg.remove(); bg.onclose?.() }
  bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-cancel]')) close() })
  return { el: bg, close }
}
