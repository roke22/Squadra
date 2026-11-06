import { $, store } from './dom.js'
import { T } from './i18n.js'
import { state } from './state.js'
import { call } from './api.js'
import { esc } from './format.js'

// The screens before the dashboard: the first owner, signing in, codes, and the
// links of an invitation or a new password. Each is a form; what comes next
// depends on what the server answers.
let onSubmit = null
let enter = () => {}

function screen(intro, fields, button, submit) {
  $('loginIntro').innerHTML = intro
  $('loginFields').innerHTML = fields
  $('loginBtn').textContent = button
  $('loginBtn').hidden = !submit
  $('loginErr').textContent = ''
  onSubmit = submit
  $('loginFields').querySelector('input')?.focus()
}
const input = (name, label, type = 'text', autocomplete = 'off', extra = '') => `<label class="field"><span>${esc(label)}</span><input name="${name}" type="${type}" autocomplete="${autocomplete}" required ${extra}></label>`
const values = () => Object.fromEntries(new FormData($('loginForm')))

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault()
  if (!onSubmit) return
  $('loginBtn').disabled = true
  $('loginErr').textContent = ''
  try { await onSubmit(values()) } catch (err) {
    $('loginErr').textContent = err.status === 429 ? T.tooManyTries : err.message.replace(/^(Unauthorized|Bad Request|Not Found|Conflict|Forbidden): /, '')
  } finally {
    $('loginBtn').disabled = false
  }
})

// Whatever stage the server says this sign-in is at.
function next(me) {
  if (me.stage === 'totp') return codeScreen()
  if (me.stage === 'totp_setup') return setupScreen()
  return enter(me)
}

function ownerScreen() {
  screen(T.ownerIntro, input('token', T.tokenPlaceholder, 'password') + input('name', T.yourName, 'text', 'name') + input('email', T.email, 'email', 'username') + input('password', T.newPassword, 'password', 'new-password', 'minlength="12"'), T.createOwner, async v => {
    const { token, ...fields } = v
    next(await call('/bootstrap', fields, { Authorization: `Bearer ${token.trim()}` }))
  })
}

export function loginScreen(err = '') {
  screen(T.loginIntro, input('email', T.email, 'email', 'username') + input('password', T.password, 'password', 'current-password'), T.enter, async v => next(await call('/auth/login', v)))
  $('loginErr').textContent = err
}

function codeScreen(recovery = false) {
  screen(recovery ? T.recoveryIntro : T.codeIntro,
    (recovery ? input('recovery', T.recoveryCode) : input('code', T.code, 'text', 'one-time-code', 'inputmode="numeric" maxlength="6"')) +
    `<button type="button" class="linkish" id="codeSwitch">${esc(recovery ? T.useCode : T.useRecovery)}</button>`,
    T.enter, async v => next(await call('/auth/totp', v)))
  $('codeSwitch').onclick = () => codeScreen(!recovery)
}

async function setupScreen() {
  const { secret, uri } = await call('/auth/totp/setup', {})
  screen(T.setupIntro, `<p class="secret"><code>${esc(secret)}</code></p><p class="note"><a href="${esc(uri)}">${esc(T.setupLink)}</a></p>${input('code', T.code, 'text', 'one-time-code', 'inputmode="numeric" maxlength="6"')}`, T.setupConfirm, async v => {
    const done = await call('/auth/totp/enable', v)
    screen(T.recoveryShow, `<pre class="codes">${esc(done.recovery_codes.join('\n'))}</pre>`, T.recoverySaved, async () => next(done))
  })
}

async function inviteScreen(token) {
  const info = await call('/auth/invite/info', { token })
  const where = info.company ? T.inviteTo(esc(info.company), esc(info.role)) : T.inviteServer
  const fields = info.known
    ? input('password', T.password, 'password', 'current-password')
    : input('name', T.yourName, 'text', 'name') + input('password', T.newPassword, 'password', 'new-password', 'minlength="12"')
  screen(`${where} <b>${esc(info.email)}</b>`, fields, T.acceptInvite, async v => {
    const me = await call('/auth/invite/accept', { ...v, token })
    history.replaceState(null, '', location.pathname + location.search)
    next(me)
  })
}

function resetScreen(token) {
  screen(T.resetIntro, input('password', T.newPassword, 'password', 'new-password', 'minlength="12"'), T.setPassword, async v => {
    await call('/auth/reset', { ...v, token })
    history.replaceState(null, '', location.pathname + location.search)
    loginScreen(T.passwordSet)
  })
}

// What to show on opening the page. (Tokens of a link go in the part of the
// address the browser doesn't send anywhere.)
export async function begin(onEnter) {
  enter = onEnter
  const link = location.hash.match(/^#\/(invite|reset)\/([A-Za-z0-9_-]+)$/)
  if (link) {
    try { return await (link[1] === 'invite' ? inviteScreen(link[2]) : resetScreen(link[2])) } catch (err) {
      history.replaceState(null, '', location.pathname + location.search)
      loginScreen(err.status === 404 ? T.linkGone : T.cannotConnect(err.message))
      return
    }
  }
  try {
    next(await call('/api/me'))
  } catch (err) {
    if (err.status !== 401) throw err
    const { needs_owner } = await call('/auth/status')
    if (needs_owner) ownerScreen(); else loginScreen()
  }
}

export const signOut = () => call('/auth/logout', {}).catch(() => {})
export const noCompany = () => { state.me = null; screen(T.noCompany, '', '', null) }
