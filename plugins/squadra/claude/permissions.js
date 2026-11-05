// Relaying this session's permission prompts to whoever may answer them.

import { maskOutgoing, maskDeep } from '../observe.js'
import {
  RELAY_OFF, NAME_RE, log, S, active, loadAccess, readAllowPins, call, skeleton, LOOKALIKE,
  checkCoordinator,
} from '../core/index.js'

// Who may answer this session's permission prompts from another session:
// - a worker: its coordinator, if it is on the allowlist;
// - a coordinator: nobody, unless access.json lists permissionApprovers;
// - nobody at all with SQUADRA_PERMISSION_RELAY=off (set by squadra-host on
//   machines that don't allow remote control).
function permissionApprovers(s) {
  if (RELAY_OFF || s.relayOff || s.role === 'solo') return []
  const access = loadAccess(s)
  if (access.dmPolicy === 'disabled') return [] // no messages at all: no prompts either
  const allowed = new Set(access.allowFrom)
  // A worker's coordinator only once it was checked against its pin (and passed).
  if (s.role === 'worker' && (!s.coordinatorChecked || s.coordinatorRejected)) return []
  // A coordinator's: the ones the user confirmed at login (a later edit of
  // access.json takes effect at the next, confirmed, login).
  const confirmed = new Set(s.confirmedApprovers ?? [])
  const list = s.role === 'worker' ? [s.coordinator] : (Array.isArray(access.permissionApprovers) ? access.permissionApprovers.filter(n => confirmed.has(n)) : [])
  return list.filter(n => NAME_RE.test(String(n)) && allowed.has(n))
}

// Requests sent out and not answered yet: request_id -> { approvers, expires }.
const PERMISSION_TTL_MS = 15 * 60 * 1000
export const pendingPermissions = new Map()

// Wrong answers per sender: after 5 in 10 minutes, its answers are ignored.
const permissionFailures = new Map()

// Receive permission_request from Claude Code → format → send to the approvers
// only (by DM; never to groups), and remember who was asked.
// The identity (registration time) of each approver, taken when the user
// confirmed them; an approver deleted and registered again by someone else
// no longer gets the prompts. If it can't be checked, it isn't asked.
// Which registration of a name this is: the server's random identity (older
// servers: the registration second).
const identityOf = info => (info?.squadra_identity ? `i:${info.squadra_identity}` : `t:${Number(info?.created_at) || 0}`)
export async function pinApprovers(s) {
  for (const n of s.confirmedApprovers ?? []) {
    try { s.approverPins.set(n, identityOf(await call('getChat', { chat_id: n }, { s }))) } catch {}
  }
}
async function verifiedApprovers(s, list) {
  const ok = []
  for (const n of list) {
    try {
      const info = await call('getChat', { chat_id: n }, { s })
      // Confirmed by the user in this login but not pinned yet (it wasn't
      // registered, or the server didn't answer): pinned now.
      if (!s.approverPins.has(n)) s.approverPins.set(n, identityOf(info))
      // Nor one that isn't the session this one paired with (allow-pins.json).
      const pins = readAllowPins(s)
      const paired = Object.hasOwn(pins, n) ? pins[n] : undefined
      if (identityOf(info) === s.approverPins.get(n) && (paired === undefined || paired === identityOf(info))) ok.push(n)
      else log(`permission approver "${n}" was registered again on the server: not asking it`)
    } catch {}
  }
  return ok
}

// Quoted and capped; when something is left out it says so, so a cut-off
// command is never approved as if it were the whole thing.
const COMMON_LATIN = new Set(['ß', 'ẞ', 'æ', 'ø', 'œ', 'ð', 'þ', 'ł', 'đ', 'ŋ', 'ħ', 'ĸ'])

// letters: also flag letters that pass for ASCII ones (for what will run;
// the description is the session's own words, in any language).
function shown(value, max, maskedBefore = 0, { letters = true } = {}) {
  const t = String(value ?? '')
  const cut = t.slice(0, max)
  // Clear secrets are masked here; but a mask can also cover what will run
  // (a "password" with a command after it), so ANY masking is said, and the
  // coordinator must then ask the user instead of approving.
  const { text: masked0, masked: maskedNow } = maskOutgoing(cut)
  const masked = maskedNow + maskedBefore
  // Characters that look like other ones (fullwidth ＃ ＼ ； ＂…) or any
  // non-ASCII punctuation/symbol are shown as their code, never as what they
  // resemble: the shell reads ＃ as a letter, not as a comment.
  // Letters too, where they pass for ASCII ones: a letter of another script
  // in a word with ASCII letters ("dеploy", "gіthub" with Cyrillic е, і), a
  // word of another script that reads as ASCII ("ѕһ"), and Latin look-alikes
  // that aren't accented letters (ɑ ʟ ᴄ). "añadir" or "façade" stay as they are.
  const chars = [...masked0]
  const suspicious = new Set()
  const wordChar = c => /[\p{L}\p{M}\p{N}]/u.test(c)
  for (let i = 0; i < chars.length;) {
    if (!wordChar(chars[i])) { i++; continue }
    let j = i
    while (j < chars.length && wordChar(chars[j])) j++
    const word = chars.slice(i, j)
    const hasAscii = word.some(c => /[A-Za-z]/.test(c))
    const readsAscii = word.every(c => c.charCodeAt(0) < 0x80 || /\p{M}/u.test(c) || /^[a-z0-9/]$/.test(skeleton(c.normalize('NFKC'))))
    for (let k = i; k < j; k++) {
      const c = chars[k]
      // (Digits of other scripts too: ০ ١ ० read as o, l, 0 next to ASCII.)
      if (c.charCodeAt(0) < 0x80 || !/[\p{L}\p{N}]/u.test(c)) continue
      const latin = /\p{Script=Latin}/u.test(c)
      // (A Latin letter that isn't an accented ASCII one — ı ꜱ ᴜ ƅ — next to
      // ASCII letters, except the usual letters of European languages.)
      const oddLatin = latin && !/^[\x00-\x7f]+$/.test(c.normalize('NFKD').replace(/\p{M}/gu, '')) && !COMMON_LATIN.has(c.toLowerCase())
      if (letters && ((!latin && (hasAscii || readsAscii)) || (oddLatin && (hasAscii || Object.hasOwn(LOOKALIKE, c))))) suspicious.add(k)
    }
    i = j
  }
  let lookalikes = 0
  // A combining mark that isn't on a letter (after a space, before "#")
  // looks like nothing — the shell still reads it as part of a word. Same for
  // letters drawn blank (Egyptian hieroglyph blanks, which Claude Code's own
  // preview shows as spaces).
  const onLetter = k => { let j = k - 1; while (j >= 0 && /\p{M}/u.test(chars[j])) j--; return j >= 0 && /\p{L}/u.test(chars[j]) }
  // (In prose, what languages use every day: no-break spaces (French "?"),
  // a zero-width non-joiner inside a word (Persian), an emoji's joiner and
  // presentation selector.)
  const PICTO = /\p{Extended_Pictographic}/u
  const JOINS = /[\p{L}\p{M}]/u
  const proseOk = k => {
    const c = chars[k], before = chars[k - 1] ?? '', after = chars[k + 1] ?? ''
    if (c === '\u00a0' || c === '\u202f' || c === '\u2009' || c === '\u3000') return true
    // (Text direction marks, in the languages that need them.)
    if (c === '\u200e' || c === '\u200f') return true
    if (c === '\u200c') return JOINS.test(before) && /\p{L}/u.test(after)
    // An emoji's joiner comes after the emoji, its selector or its skin tone;
    // in Indic scripts, between a virama and a letter.
    if (c === '\u200d') return PICTO.test(after) ? /[\p{Extended_Pictographic}\ufe0f\u{1F3FB}-\u{1F3FF}]/u.test(before) : /\p{M}/u.test(before) && /\p{L}/u.test(after)
    if (c === '\ufe0f') return PICTO.test(before) || /[\p{S}#*0-9]/u.test(before)
    if (c === '\u20e3') return /[\ufe0f#*0-9]/u.test(before)
    return false
  }
  const BLANK = /^[\u{13441}\u{13442}\u{1D159}\u2800\u3164\uFFA0\u115F\u1160]$/u
  const r = chars.map((c, k) => {
    // (DEL too: the server drops it, the shell doesn't.)
    if (c.charCodeAt(0) < 0x7f) return c
    // (In the description, what proseOk allows comes first: FE0F is a mark too.)
    if (BLANK.test(c) || (/\p{M}/u.test(c) && !onLetter(k) && (letters || !proseOk(k)))) { lookalikes++; return `\\u{${c.codePointAt(0).toString(16)}}` }
    // (Also any default-ignorable one: joiners, variation selectors, fillers —
    // the server may drop them, and the shell doesn't.)
    // (In the description — the session's own words, not what runs — only
    // what can't be seen: everyday punctuation of any language stays.)
    const special = letters ? (c.normalize('NFKC') !== c || /[\p{P}\p{S}\p{Z}\p{C}\p{Default_Ignorable_Code_Point}]/u.test(c)) : /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}]/u.test(c) && c !== ' ' && !proseOk(k)
    if (suspicious.has(k) || special) { lookalikes++; return `\\u{${c.codePointAt(0).toString(16)}}` }
    return c
  }).join('')
  const notes = []
  if (masked) notes.push(`${masked} part${masked > 1 ? 's' : ''} masked as secrets`)
  if (lookalikes) notes.push(`${lookalikes} look-alike or special character${lookalikes > 1 ? 's' : ''} shown as \\u{…}`)
  if (t.length > max) notes.push(`${t.length - max} more characters`)
  // Escaped characters make it longer: still within one message.
  const capped = r.length > max * 2 ? r.slice(0, max * 2) : r
  if (capped !== r) notes.push('the rest of the escaped text')
  return JSON.stringify(capped) + (notes.length ? ` … (${notes.join(', ')} NOT SHOWN: ask the user, don't approve)` : '')
}

// The tool call's exact input, from the PreToolUse hook: an input of this
// tool that accounts for the whole preview (every key and value, nothing left
// over), so an older, shorter call ("npm test") never stands in for the one
// being approved ("npm test && …"). Two calls can still read the same once
// flattened (they differ by an invisible character), and the hook can arrive
// before the request (another hook delayed the prompt) or after it: so it
// always waits RELAY_SETTLE_MS, looks at every such input from
// RELAY_LOOKBACK_MS before the request on, and vouches only when exactly one
// distinct input matches. One that matches later withdraws the request
// (withdrawIfAmbiguous). A preview Claude Code shortened or masked can't be
// compared: null (the caller warns).
export const TOOL_INPUT_KEEP_MS = 60_000
const RELAY_LOOKBACK_MS = 30_000
const RELAY_SETTLE_MS = 1500
function previewCovers(preview) {
  const flat = x => String(x).replace(/[^\x21-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim()
  const fp = flat(preview)
  // In order: each key, then its value, with only JSON punctuation between
  // them and nothing left over — so another call with the same values under
  // other keys ({command: "ls", description: "rm -rf …"}) doesn't match.
  // Strings as JSON text, other values as JSON.
  const between = x => x.replace(/[\s{}\[\]":,]/g, '') === ''
  return input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false
    let pos = 0
    for (const [k, v] of Object.entries(input)) {
      for (const tok of [JSON.stringify(k).slice(1, -1), typeof v === 'string' ? JSON.stringify(v).slice(1, -1) : JSON.stringify(v)]) {
        const f = flat(tok)
        if (!f) continue
        const at = fp.indexOf(f, pos)
        if (at < 0 || !between(fp.slice(pos, at))) return false
        pos = at + f.length
      }
    }
    return between(fp.slice(pos))
  }
}
async function exactToolInput(s, tool, preview, since) {
  if (/\[REDACTED\]|⋯|…/.test(preview)) return null
  const covers = previewCovers(preview)
  const wait = since + RELAY_SETTLE_MS - Date.now()
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  // Inputs of this window were dropped (a flood): the real one may be gone.
  if ((s.toolInputsDroppedAt ?? 0) >= since - RELAY_LOOKBACK_MS) return null
  const ok = s.toolInputs.filter(x => x.tool === tool && x.at >= since - RELAY_LOOKBACK_MS && covers(x.input))
  const distinct = new Set(ok.map(x => JSON.stringify(x.input)))
  return distinct.size === 1 ? ok[0].input : null
}

// A call whose input also matches a request already sent, but isn't the one
// shown: the coordinator may be approving the wrong one. The request is
// withdrawn (its answer is no longer taken) and the approvers are told.
export function withdrawIfAmbiguous(s, tool, input) {
  const json = JSON.stringify(input)
  for (const [id, p] of pendingPermissions) {
    if (p.withdrawn || p.tool !== tool || !p.shownJson || p.shownJson === json || !p.covers(input)) continue
    p.withdrawn = true
    const text = `🔐 Permission ${id} WITHDRAWN: another call matched the same request, so the input shown may not be the one that would run. Don't answer it; ask the user to decide at the session.`
    for (const chat_id of p.approvers) void call('sendMessage', { chat_id, text }, { s }).catch(e => log(`withdrawal notice to ${chat_id} failed: ${e.message}`))
  }
}

export async function onPermissionRequest(params) {
  const requestAt = Date.now()
  const s = S
  if (!s?.secret) return
  const { request_id, tool_name, description, input_preview } = params
  if (!request_id || !/^[a-km-z]{5}$/i.test(String(request_id))) return
  if (s.role === 'worker' && !(await checkCoordinator(s, { fresh: true }))) return
  let approvers = permissionApprovers(s)
  // A coordinator's approvers must still be the identities the user confirmed.
  if (s.role === 'coordinator') approvers = await verifiedApprovers(s, approvers)
  if (!approvers.length || !active(s)) return // (logged out while checking: nothing is sent)
  for (const [id, p] of pendingPermissions) if (p.expires < Date.now()) pendingPermissions.delete(id)
  const pending = { approvers: new Set(approvers), expires: Date.now() + PERMISSION_TTL_MS }
  pendingPermissions.set(String(request_id).toLowerCase(), pending)
  // The tool's input and description come from the session's work (a repo
  // can shape them): quoted as JSON, secrets masked, and the fixed lines come
  // first, so nothing in them can pose as another field.
  // What the coordinator is shown is the tool call's EXACT input, from the
  // hook, not Claude Code's preview (which turns invisible characters into
  // spaces: "done<U+200B>#; x" would read as a comment). If it can't be
  // matched, the preview is shown with a warning.
  const exact = await exactToolInput(s, String(tool_name ?? ''), String(input_preview ?? ''), requestAt)
  if (!active(s)) return
  if (exact != null) Object.assign(pending, { tool: String(tool_name ?? ''), covers: previewCovers(String(input_preview ?? '')), shownJson: JSON.stringify(exact) })
  // (Masked value by value first: secrets quoted inside the JSON too.)
  const deep = exact != null ? maskDeep(exact, t => maskOutgoing(t).text) : null
  // (Bash's own "description" field never runs: the session's words, shown
  // like the description line, apart from what runs.)
  const v = deep?.value
  const prose = String(tool_name ?? '') === 'Bash' && v && typeof v === 'object' && typeof v.description === 'string' ? v.description : null
  const rest = prose != null ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'description')) : v
  const inputLine = exact != null
    ? shown(JSON.stringify(rest), 3000, deep.masked) + (prose != null ? `\nIts "description" field (does not run): ${shown(prose, 1000, 0, { letters: false })}` : '')
    : `${shown(input_preview, 3000)} … (the exact input could not be checked: invisible characters may show as spaces. NOT SHOWN exactly: ask the user, don't approve)`
  const text =
    `🔐 Permission: ${JSON.stringify(String(tool_name ?? ''))}\n` +
    `Session: ${s.name}\n` +
    `Reply "yes ${request_id}" or "no ${request_id}"\n` +
    `Description (from the session): ${shown(description, 1000, 0, { letters: false })}\n` +
    `Input (from the session): ${inputLine}`
  for (const chat_id of approvers) {
    // Remembered: this session's Claude can't edit_message the prompt afterwards.
    void call('sendMessage', { chat_id, text }, { s }).then(m => { if (m?.message_id) s.relayIds.add(Number(m.message_id)) })
      .catch(e => log(`permission_request send to ${chat_id} failed: ${e.message}`))
  }
}

// A "yes/no <code>" counts only as a DM from someone asked about that very
// request, while it is pending. Returns the verdict, or null to ignore it.
// Returns the verdict, null to drop the message (a wrong answer to a real
// request), or 'chat' when it isn't an answer at all ("yes merge" is just text).
export function takePermissionReply(msg, match) {
  const sender = String(msg.from?.id ?? '')
  const id = match[2].toLowerCase()
  const p = pendingPermissions.get(id)
  if (!p) return 'chat'
  if (p.withdrawn) return null
  // (Too late: dropped, but it isn't a wrong answer.)
  if (p.expires < Date.now()) { pendingPermissions.delete(id); return null }
  const fails = (permissionFailures.get(sender) ?? []).filter(t => Date.now() - t < 10 * 60 * 1000)
  if (fails.length >= 5) return null
  if (msg.chat?.type !== 'private' || !p.approvers.has(sender)) {
    fails.push(Date.now())
    permissionFailures.set(sender, fails)
    if (fails.length === 5) log(`ignoring permission answers from "${sender}" for 10 minutes: too many that matched no request sent to it`)
    return null
  }
  pendingPermissions.delete(id)
  return { request_id: id, behavior: match[1].toLowerCase().startsWith('y') ? 'allow' : 'deny' }
}
