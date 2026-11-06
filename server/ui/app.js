import { $, store } from './dom.js'
import { T, LANG } from './i18n.js'
import { state, sessions, hosts } from './state.js'
import { esc } from './format.js'
import { begin, loginScreen, noCompany, signOut } from './signin.js'
import { openPeople } from './people.js'
import { clearMosaic } from './router.js'
import { closeMenu } from './dialogs.js'
import { termLink } from './terminal.js'
import { connect } from './stream.js'
import './format.js'
import './content.js'
import './chat.js'
import './nav.js'
import './topbar.js'
import './mosaic.js'
import './machines.js'
import './squads.js'
import './org.js'

export let serverVersion = null // (from /health and the stream)

// Light or dark: the system's, unless chosen with the 🌙/☀️ button
// (remembered per browser). The page sets it first thing, so it doesn't flash.
const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)') ?? { matches: false, addEventListener() {} }
const themeNow = () => document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light')

// The dashboard is only built after the server says the sign-in is finished.
function show(id) { for (const x of ['splash', 'login', 'app']) $(x).hidden = x !== id }

// Out of the dashboard, with nothing of it left on the page. (err: why, on the sign-in page.)
export function showLogin(err = '') {
  state.streamGen++
  state.streamAbort?.abort()
  // (Open dialogs go too: an enrollment command isn't left over the login page.)
  for (const m of document.querySelectorAll('.modal-bg')) { try { m.onclose?.() } catch {} ; m.remove() }
  clearMosaic()
  state.sessionView?.destroy(); state.sessionView = null
  state.termView?.destroy(); state.termView = null
  termLink.close()
  sessions.clear()
  hosts.clear()
  closeMenu()
  state.me = null
  show('login')
  loginScreen(err)
}

// A finished sign-in: into the company in the address, or the last one here, if
// this user is in it. Otherwise the page loads again for one they are in.
function enter(me) {
  const here = me.companies.find(c => c.id === state.company)
  if (!here) {
    const first = me.companies[0]
    if (!first) {
      if (!me.user.is_platform_admin) { show('login'); return noCompany() }
      state.me = me
      show('app')
      return openPeople()
    }
    store.set('squadraCompany', first.id)
    location.replace(`${location.pathname}?company=${encodeURIComponent(first.id)}${location.hash}`)
    return
  }
  state.me = me
  state.role = here.role
  store.set('squadraCompany', here.id)
  document.body.dataset.role = here.role
  const select = $('companySelect')
  select.hidden = me.companies.length < 2
  select.innerHTML = me.companies.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')
  select.value = here.id
  $('addHostBtn').hidden = !['manager', 'owner'].includes(here.role)
  show('app')
  connect()
}

$('companySelect').addEventListener('change', e => {
  store.set('squadraCompany', e.target.value)
  location.href = `${location.pathname}?company=${encodeURIComponent(e.target.value)}`
})

$('logoutBtn').addEventListener('click', async () => {
  await signOut()
  store.set('squadraSignedOut', String(Date.now()))
  showLogin()
})
$('peopleBtn').addEventListener('click', () => openPeople())

// static texts, version footer and language switch
$('splash').textContent = T.connecting
$('connText').textContent = T.connecting
$('logoutBtn').textContent = T.logout
$('peopleBtn').textContent = T.people
$('menuBtn').setAttribute('aria-label', T.sessionsMenu)
$('addHostBtn').title = T.addTitle
$('addHostBtn').setAttribute('aria-label', T.addTitle)

// The button shows the mode it switches to.
function themeButtons() {
  const dark = themeNow() === 'dark'
  for (const b of document.querySelectorAll('[data-theme-toggle]')) {
    b.textContent = dark ? '☀️' : '🌙'
    b.title = dark ? T.lightMode : T.darkMode
    b.setAttribute('aria-label', b.title)
  }
}
for (const b of document.querySelectorAll('[data-theme-toggle]')) {
  b.addEventListener('click', () => {
    const next = themeNow() === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    store.set('squadraTheme', next)
    themeButtons()
  })
}
darkQuery.addEventListener('change', themeButtons)
themeButtons()
for (const b of document.querySelectorAll('[data-lang]')) {
  b.classList.toggle('on', b.dataset.lang === LANG)
  b.addEventListener('click', () => { store.set('squadraLang', b.dataset.lang); location.reload() })
}

// "0.0.2" < "0.0.3" (numeric parts).
export const olderThan = (a, b) => {
  const x = String(a).split('.').map(n => parseInt(n, 10)), y = String(b).split('.').map(n => parseInt(n, 10))
  if ([...x, ...y].some(Number.isNaN)) return false
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
}
export function setVersion(v) {
  serverVersion = v
  for (const el of document.querySelectorAll('.ver')) el.textContent = `Squadra v${v}`
}
fetch('/health').then(r => r.json()).then(j => { if (j.version) setVersion(j.version) }).catch(() => {})

// Logged out in another tab of this browser: this one too.
window.addEventListener('storage', e => { if (e.key === 'squadraSignedOut' && state.me) showLogin() })

// boot (what older versions kept in this browser goes: it was the server token)
store.del('squadraToken'); store.del('swarmToken')
show('splash')
begin(enter).then(() => { if (!state.me && $('app').hidden) show('login') }, err => { show('login'); loginScreen(T.cannotConnect(err.message)) })
