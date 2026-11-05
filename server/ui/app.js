import { $, store } from './dom.js'
import { T, LANG } from './i18n.js'
import { state, sessions, hosts } from './state.js'
import { api } from './api.js'
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

// login: the dashboard is only built after the server accepts the token
function show(id) { for (const x of ['splash', 'login', 'app']) $(x).hidden = x !== id }

// keep: the server couldn't be reached (not a wrong token): the saved token stays.
export function showLogin(err = '', { keep = false } = {}) {
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
  // (Not a token another tab has just signed in with.)
  if (!keep) { if ((store.get('squadraToken') ?? state.token) === state.token) store.del('squadraToken'); store.del('swarmToken') }
  state.token = null
  show('login')
  $('loginErr').textContent = err
  $('tokenInput').value = ''
  $('tokenInput').focus()
}

async function enter(candidate) {
  state.token = candidate
  await api('/api/state') // throws if the token is wrong
  store.set('squadraToken', state.token)
  $('tokenInput').value = ''
  show('app')
  connect()
}

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault()
  $('loginBtn').disabled = true
  $('loginErr').textContent = ''
  try {
    await enter($('tokenInput').value.trim())
  } catch (err) {
    state.token = null
    $('loginErr').textContent = err.status === 401 ? T.tokenWrong : T.cannotConnect(err.message)
  } finally {
    $('loginBtn').disabled = false
  }
})

$('logoutBtn').addEventListener('click', () => showLogin())

// static texts, version footer and language switch
$('splash').textContent = T.connecting
$('loginIntro').innerHTML = T.loginIntro
$('tokenInput').placeholder = T.tokenPlaceholder
$('loginBtn').textContent = T.enter
$('connText').textContent = T.connecting
$('logoutBtn').textContent = T.logout
$('logoutBtn').title = T.logoutTitle
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
window.addEventListener('storage', e => { if (e.key === 'squadraToken' && !e.newValue && state.token) showLogin() })

// boot
if (state.token) {
  show('splash')
  enter(state.token).catch(err => err.status === 401 ? showLogin(T.storedTokenInvalid) : showLogin(T.cannotConnect(err.message), { keep: true }))
} else {
  show('login')
  $('tokenInput').focus()
}
