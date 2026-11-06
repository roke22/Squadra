import { T } from './i18n.js'
import { state } from './state.js'
import { call, inCompany } from './api.js'
import { esc } from './format.js'
import { dialog } from './dialogs.js'

const ROLES = ['observer', 'operator', 'manager', 'owner']
const atLeast = (role, needed) => ROLES.indexOf(role) >= ROLES.indexOf(needed)
const roleSelect = (value, attrs = '') => `<select ${attrs}>${ROLES.map(r => `<option value="${r}" ${r === value ? 'selected' : ''}>${esc(T.roles[r])}</option>`).join('')}</select>`
const linkBox = l => `<div class="cmdrow"><pre class="cmd">${esc(l.link)}</pre><button class="btn" data-copy>${esc(T.copy)}</button></div><p class="note">${esc(T.linkOnce)}</p>`

// The dashboard's people: who is in this company, and (for an administrator of
// the server) the companies and users.
export function openPeople() {
  const admin = state.me?.user.is_platform_admin
  const manager = atLeast(state.role, 'manager')
  const tabs = [
    ...(manager ? [['members', T.tabMembers]] : []),
    ...(admin ? [['companies', T.tabCompanies], ['users', T.tabUsers]] : []),
    ['account', T.tabAccount],
  ]
  const d = dialog(`<h3>${esc(T.people)}</h3>
    <nav class="tabs people-tabs">${tabs.map(([k, label]) => `<button type="button" class="tab" data-tab="${k}">${esc(label)}</button>`).join('')}</nav>
    <div class="err"></div><div data-body></div>
    <div class="actions"><button class="btn" data-cancel>${esc(T.close)}</button></div>`, { wide: true })
  const body = d.el.querySelector('[data-body]')
  const fail = err => { d.el.querySelector('.err').textContent = err.status === 429 ? T.tooManyTries : err.message.replace(/^(Unauthorized|Bad Request|Not Found|Conflict|Forbidden): /, '') }
  const ok = () => { d.el.querySelector('.err').textContent = '' }

  async function show(tab) {
    ok()
    for (const b of d.el.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab)
    try { await ({ members, companies, users, account })[tab]() } catch (err) { fail(err) }
  }

  async function members() {
    const [list, { join_token }] = await Promise.all([call(inCompany('/api/members')), call(inCompany('/api/join-token'))])
    body.innerHTML = `<table class="people"><tbody>${list.map(m => `<tr><td><b>${esc(m.name)}</b><br><span class="note">${esc(m.email)}${m.disabled ? ` · ${esc(T.disabled)}` : ''}</span></td>
        <td>${roleSelect(m.role, `data-role-of="${esc(m.id)}"`)}</td><td><button class="btn danger" data-remove="${esc(m.id)}">${esc(T.remove)}</button></td></tr>`).join('')}</tbody></table>
      <form data-invite class="row2"><label class="field"><span>${esc(T.email)}</span><input type="text" name="email" required></label>
        <label class="field"><span>${esc(T.role)}</span>${roleSelect('operator', 'name="role"')}</label>
        <button class="btn primary">${esc(T.invite)}</button></form><div data-link></div>
      <h4>${esc(T.joinToken)}</h4><p class="note">${esc(T.joinTokenHint)}</p>
      <div class="cmdrow"><pre class="cmd">${esc(join_token)}</pre><button class="btn" data-copy>${esc(T.copy)}</button></div>
      <button class="btn danger" data-rotate>${esc(T.rotate)}</button>`
    body.querySelector('[data-invite]').onsubmit = async e => {
      e.preventDefault()
      ok()
      try {
        const r = await call(inCompany('/api/members/invite'), Object.fromEntries(new FormData(e.target)))
        body.querySelector('[data-link]').innerHTML = linkBox(r)
      } catch (err) { fail(err) }
    }
    for (const s of body.querySelectorAll('[data-role-of]')) {
      s.onchange = async () => {
        ok()
        try { await call(inCompany('/api/members/role'), { user: s.dataset.roleOf, role: s.value }) } catch (err) { fail(err); await members() }
      }
    }
  }

  async function companies() {
    const list = await call('/api/companies')
    const mine = new Set(state.me.companies.map(c => c.id))
    body.innerHTML = `<table class="people"><tbody>${list.map(c => `<tr><td><b>${esc(c.name)}</b><br><span class="note">${esc(c.id)}${c.status === 'unavailable' ? ` · ${esc(T.unavailable)}` : ''}</span></td>
        <td>${mine.has(c.id) ? `<a class="btn" href="?company=${encodeURIComponent(c.id)}">${esc(T.openCompany)}</a>` : `<button class="btn" data-join="${esc(c.id)}">${esc(T.joinCompany)}</button>`}</td></tr>`).join('')}</tbody></table>
      <form data-create class="row2"><label class="field"><span>${esc(T.companyName)}</span><input type="text" name="name" required maxlength="80"></label>
        <button class="btn primary">${esc(T.createCompany)}</button></form><div data-link></div>`
    body.querySelector('[data-create]').onsubmit = async e => {
      e.preventDefault()
      ok()
      try {
        const r = await call('/api/companies/create', Object.fromEntries(new FormData(e.target)))
        await call('/api/companies/join', { company: r.id })
        state.me.companies.push({ id: r.id, name: r.name, role: 'owner' })
        await companies()
      } catch (err) { fail(err) }
    }
  }

  async function users() {
    const list = await call('/api/users')
    body.innerHTML = `<table class="people"><tbody>${list.map(u => `<tr><td><b>${esc(u.name)}</b>${u.is_platform_admin ? ` <span class="note">${esc(T.administrator)}</span>` : ''}<br><span class="note">${esc(u.email)}${u.disabled ? ` · ${esc(T.disabled)}` : ''}</span></td>
        <td><button class="btn" data-reset="${esc(u.id)}">${esc(T.resetLink)}</button>
        <button class="btn danger" data-${u.disabled ? 'enable' : 'disable'}="${esc(u.id)}">${esc(u.disabled ? T.enable : T.disable)}</button></td></tr>`).join('')}</tbody></table><div data-link></div>`
  }

  function account() {
    const me = state.me.user
    body.innerHTML = `<p><b>${esc(me.name)}</b> · ${esc(me.email)}</p>
      <form data-password><label class="field"><span>${esc(T.password)}</span><input type="password" name="current" autocomplete="current-password" required></label>
      <label class="field"><span>${esc(T.newPassword)}</span><input type="password" name="password" autocomplete="new-password" minlength="12" required></label>
      <button class="btn primary">${esc(T.setPassword)}</button></form><p class="note" data-done></p>`
    body.querySelector('[data-password]').onsubmit = async e => {
      e.preventDefault()
      ok()
      try {
        await call('/auth/password', Object.fromEntries(new FormData(e.target)))
        e.target.reset()
        body.querySelector('[data-done]').textContent = T.passwordSet
      } catch (err) { fail(err) }
    }
  }

  body.addEventListener('click', async e => {
    const b = e.target.closest('button')
    if (!b) return
    ok()
    try {
      if (b.dataset.copy !== undefined) await navigator.clipboard?.writeText(b.previousElementSibling.textContent)
      if (b.dataset.remove) { await call(inCompany('/api/members/remove'), { user: b.dataset.remove }); await members() }
      if (b.dataset.rotate !== undefined) { await call(inCompany('/api/join-token/rotate'), {}); await members() }
      if (b.dataset.join) { await call('/api/companies/join', { company: b.dataset.join }); state.me.companies.push({ id: b.dataset.join, role: 'owner' }); await companies() }
      if (b.dataset.reset) body.querySelector('[data-link]').innerHTML = linkBox(await call('/api/users/reset', { user: b.dataset.reset }))
      if (b.dataset.disable) { await call('/api/users/disable', { user: b.dataset.disable }); await users() }
      if (b.dataset.enable) { await call('/api/users/enable', { user: b.dataset.enable }); await users() }
    } catch (err) { fail(err) }
  })
  for (const b of d.el.querySelectorAll('[data-tab]')) b.onclick = () => show(b.dataset.tab)
  show(tabs[0][0])
}
