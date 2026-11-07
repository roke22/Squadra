import { $ } from './dom.js'
import { T, LOCALE } from './i18n.js'
import { state, can } from './state.js'
import { esc } from './format.js'
import { setHtml } from './nav.js'
import { postJson } from './machines.js'
import { alertBox } from './mosaic.js'

// What coordinators left for the user. It says what they wrote and nothing more:
// what it is about, a ticket or anything else, is theirs.
const when = t => new Date(t).toLocaleString(LOCALE)
// (A link only if it really is one: a ref is whatever the session wrote.)
const refHtml = ref => {
  if (!ref) return ''
  let url = null
  try { url = new URL(ref) } catch {}
  return url && (url.protocol === 'https:' || url.protocol === 'http:')
    ? `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(ref)}</a>`
    : `<code>${esc(ref)}</code>`
}

function item(i) {
  const open = !i.resolved_at
  return `<div class="arch" data-inbox="${i.id}">
    <div class="info">
      <div class="n">${i.kind === 'ask' ? T.inboxAsk : T.inboxTell} · ${esc(i.session)}</div>
      <div>${esc(i.text)}</div>
      ${i.options.length ? `<div class="m">${T.inboxOptions}: ${i.options.map(esc).join(' · ')}</div>` : ''}
      ${i.recommended ? `<div class="m">${T.inboxRecommended}: ${esc(i.recommended)}</div>` : ''}
      ${i.ref ? `<div class="m">${refHtml(i.ref)}</div>` : ''}
      <div class="m">${esc(when(i.created_at))}${open ? '' : ` · ${T.inboxDone}`}</div>
    </div>
    <div class="acts">
      <button class="btn" data-go="#/s/${encodeURIComponent(i.session)}">${i.kind === 'ask' && open ? T.inboxAnswer : T.viewChat}</button>
      ${open && can('operator') ? `<button class="btn" data-resolve="${i.id}">${T.inboxResolve}</button>` : ''}
    </div>
  </div>`
}

export function renderInbox() {
  const open = state.inbox.filter(i => !i.resolved_at)
  const done = state.inbox.filter(i => i.resolved_at)
  setHtml($('inbox'), `<div class="arch-list">${open.length ? open.map(item).join('') : `<div class="mosaic-empty">${T.inboxEmpty}</div>`}
    ${done.length ? `<details><summary class="note">${T.inboxDoneList(done.length)}</summary>${done.map(item).join('')}</details>` : ''}</div>`)
}

$('inbox').addEventListener('click', async e => {
  const go = e.target.closest('[data-go]')
  if (go) { location.hash = go.dataset.go; return }
  const b = e.target.closest('[data-resolve]')
  if (b) { try { await postJson('/api/inbox/resolve', { id: Number(b.dataset.resolve) }) } catch (err) { alertBox(err.message) } }
})
