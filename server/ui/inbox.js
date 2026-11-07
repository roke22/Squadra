import { $ } from './dom.js'
import { T, LOCALE } from './i18n.js'
import { state, can, sessions, hosts } from './state.js'
import { esc } from './format.js'
import { setHtml } from './nav.js'
import { postJson } from './machines.js'
import { alertBox } from './mosaic.js'

// What coordinators left for the user. It says what they wrote and nothing more:
// what it is about, a ticket or anything else, is theirs.
const when = t => new Date(t).toLocaleString(LOCALE)
const hour = t => new Date(t).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
// (A link only if it really is one: a ref is whatever the session wrote.)
const refHtml = ref => {
  if (!ref) return ''
  let url = null
  try { url = new URL(ref) } catch {}
  return url && (url.protocol === 'https:' || url.protocol === 'http:')
    ? `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(ref)}</a>`
    : `<code>${esc(ref)}</code>`
}

// The version of each question the user has had in front of them: if its
// coordinator changes it after that, an answer is refused until they read it
// again (they must never decide on what it no longer thinks).
const seen = new Map()
// What they were typing, kept across redraws.
const drafts = new Map()

// Why an answer can't be typed in the coordinator's terminal from here (null: it can).
function cantAnswer(i) {
  const h = hosts.get(sessions.get(i.session)?.host_id)
  if (!h?.online) return T.inboxNoMachine
  if (!h.info?.answers) return T.inboxOldMachine
  if (h.info.allow_input === false) return T.inboxTypingOff
  return null
}

function item(i) {
  const open = !i.resolved_at
  const ask = i.kind === 'ask'
  if (open && !seen.has(i.id)) seen.set(i.id, i.version)
  const changed = open && seen.get(i.id) !== i.version
  const why = open && ask && can('operator') ? cantAnswer(i) : null
  const answering = open && ask && can('operator') && !why
  return `<div class="arch coordinator" data-inbox="${i.id}">
    <div class="info">
      <div class="n">${ask ? T.inboxAsk : T.inboxTell} · #${i.id}${i.updated_at ? ` <span class="inbox-upd">${esc(T.inboxUpdated(hour(i.updated_at)))}</span>` : ''}</div>
      ${changed ? `<div class="inbox-upd" data-changed>${T.inboxChangedSince}</div>` : ''}
      <div class="inbox-text">${esc(i.text)}</div>
      ${i.options.length && !answering ? `<div class="m">${T.inboxOptions}: ${i.options.map(esc).join(' · ')}</div>` : ''}
      ${i.recommended ? `<div class="m">${T.inboxRecommended}: ${esc(i.recommended)}</div>` : ''}
      ${i.ref ? `<div class="m">${refHtml(i.ref)}</div>` : ''}
      ${answering && i.options.length ? `<div class="inbox-opts">${i.options.map((o, n) => `<button class="btn" data-option="${n}">${esc(o)}</button>`).join('')}</div>` : ''}
      ${answering ? `<form class="people-form inbox-answer" data-answer="${i.id}"><input type="text" name="answer" maxlength="2000" placeholder="${esc(T.inboxDetail)}" autocomplete="off"><button class="btn primary">${T.inboxSend}</button></form>` : ''}
      ${why ? `<div class="m">${why}</div>` : ''}
      ${i.answer != null ? `<div class="m">${esc(T.inboxAnswered(i.answered_by ?? '', i.answer))}</div>` : ''}
      ${i.closed_reason ? `<div class="m">${esc(T.inboxClosed(i.closed_reason))}</div>` : ''}
      <div class="m">${esc(when(i.created_at))}${open ? '' : ` · ${T.inboxDone}`}</div>
    </div>
    <div class="acts">
      <button class="btn" data-go="#/s/${encodeURIComponent(i.session)}">${ask && open && !answering ? T.inboxAnswer : T.viewChat}</button>
      ${open && can('operator') ? `<button class="btn" data-resolve="${i.id}">${T.inboxResolve}</button>` : ''}
    </div>
  </div>`
}

// Open ones by coordinator, the one with the newest first.
function groups(open) {
  const by = new Map()
  for (const i of open) by.set(i.session, [...(by.get(i.session) ?? []), i])
  return [...by].sort((a, b) => Math.max(...b[1].map(i => i.id)) - Math.max(...a[1].map(i => i.id)))
    .map(([name, items]) => `<div class="squad-row"><span class="n">${esc(name)}</span><span class="m">${T.inboxOpenN(items.length)}</span></div>${items.map(item).join('')}`).join('')
}

export function renderInbox() {
  const open = state.inbox.filter(i => !i.resolved_at)
  const done = state.inbox.filter(i => i.resolved_at)
  const focus = document.activeElement?.closest?.('[data-answer]')?.dataset.answer
  setHtml($('inbox'), `<div class="arch-list">${open.length ? groups(open) : `<div class="mosaic-empty">${T.inboxEmpty}</div>`}
    ${done.length ? `<details><summary class="note">${T.inboxDoneList(done.length)}</summary>${done.map(item).join('')}</details>` : ''}</div>`)
  for (const f of $('inbox').querySelectorAll('[data-answer]')) {
    const input = f.elements.answer
    const d = drafts.get(Number(f.dataset.answer))
    if (d && !input.value) input.value = d
    if (f.dataset.answer === focus && document.activeElement !== input) input.focus()
  }
}

async function answer(id, text) {
  const i = state.inbox.find(x => x.id === id)
  if (!i || !text.trim()) return
  try {
    await postJson('/api/inbox/answer', { id, version: seen.get(id) ?? i.version, answer: text })
    drafts.delete(id)
  } catch (err) {
    // Changed since they read it: now they have, and it says so.
    if (err.reason === 'changed') seen.set(id, i.version)
    alertBox(err.reason === 'changed' ? T.inboxChangedSince : err.message)
    renderInbox()
  }
}

$('inbox').addEventListener('click', async e => {
  const go = e.target.closest('[data-go]')
  if (go) { location.hash = go.dataset.go; return }
  const opt = e.target.closest('[data-option]')
  if (opt) {
    const id = Number(opt.closest('[data-inbox]').dataset.inbox)
    const i = state.inbox.find(x => x.id === id)
    const detail = drafts.get(id)?.trim()
    const choice = i?.options[Number(opt.dataset.option)]
    if (choice) await answer(id, detail ? `${choice}. ${detail}` : choice)
    return
  }
  const b = e.target.closest('[data-resolve]')
  if (b) { try { await postJson('/api/inbox/resolve', { id: Number(b.dataset.resolve) }) } catch (err) { alertBox(err.message) } }
})
$('inbox').addEventListener('input', e => {
  const f = e.target.closest('[data-answer]')
  if (f) drafts.set(Number(f.dataset.answer), e.target.value)
})
$('inbox').addEventListener('submit', e => {
  const f = e.target.closest('[data-answer]')
  if (!f) return
  e.preventDefault()
  void answer(Number(f.dataset.answer), f.elements.answer.value)
})
