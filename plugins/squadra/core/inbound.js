// What arrives: checked, cleaned and handed to the agent.

import { readFileSync } from 'node:fs'
import { visibleText } from '../signing.js'
import { agent } from './agent.js'
import { log, PERMISSION_REPLY_RE, REPORTS } from './settings.js'
import { active } from './session.js'
import {
  readAllowPins, writePrivateFile, loadAccess, pinAllowed, gate, linkedCoordinators, dmCommandGate,
} from './access.js'
import { call, ApiError, downloadFile } from './client.js'
import { noticeAccepted, signatureAccepted } from './signed.js'

// Names and titles are sender-controlled. They land inside the <channel>
// notification — delimiter chars would let the sender break out of the tag
// or forge a second meta entry.
function safeName(s) {
  return s == null ? undefined : String(s).replace(/[<>[\]\r\n;"]/g, '_')
}

// Message text goes inside <channel …>…</channel>: a sender must not be able
// to close the tag and continue as if it were someone else (or the user).
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Mn}\s]/u

// Letters that look like the ones in "channel" (Cyrillic, Greek, small
// capitals…): compared as what they look like. Accents are dropped.
export const LOOKALIKE = {
  'с': 'c', 'ϲ': 'c', 'ᴄ': 'c', 'ⅽ': 'c', 'ꮯ': 'c', 'ç': 'c',
  'һ': 'h', 'ի': 'h', 'ℎ': 'h', 'н': 'h',
  'а': 'a', 'ɑ': 'a', 'α': 'a', 'ᴀ': 'a',
  'ո': 'n', 'ռ': 'n', 'ɴ': 'n', 'η': 'n', 'п': 'n',
  'е': 'e', 'ҽ': 'e', 'ε': 'e', 'ᴇ': 'e', 'ё': 'e', '℮': 'e',
  'ӏ': 'l', 'ⅼ': 'l', 'ℓ': 'l', 'ǀ': 'l', 'ι': 'l', 'ʟ': 'l', '|': 'l', '1': 'l', 'I': 'l', 'Ι': 'l', 'І': 'l',
  'ѕ': 's', 'і': 'i', 'ј': 'j', 'о': 'o', 'ο': 'o', 'р': 'p', 'ρ': 'p', 'х': 'x', 'χ': 'x', 'у': 'y', 'ԁ': 'd', 'ɡ': 'g', 'ԛ': 'q', 'ԝ': 'w', 'ѵ': 'v', 'ν': 'v', 'τ': 't', 'κ': 'k', 'υ': 'u', 'ʋ': 'v', 'ɩ': 'i', 'ꭓ': 'x',
  '∕': '/', '⁄': '/', '／': '/', '\\': '/', '⧸': '/', '╱': '/', '∖': '/', '⟋': '/',
}
export function skeleton(ch) {
  if (Object.hasOwn(LOOKALIKE, ch)) return LOOKALIKE[ch]
  const base = ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  return Object.hasOwn(LOOKALIKE, base) ? LOOKALIKE[base] : base
}
const LT_LOOKALIKES = new Set(['˂', 'ᐸ', '‹', '〈', '⟨', '❮', '❰', '⧼', '≮', '≺', '⋖', '﹤', '＜', '〈', '❬'])
export function safeContent(text) {
  // Look-alikes (full-width "＜") are folded first. Then, looking past
  // invisible and combining characters and spaces, any "<" that starts
  // "<channel" or "</channel" becomes "<\\" (as Claude Code escapes tags).
  // "<" here is also any character that looks like it (˂ ᐸ ‹ 〈 ⟨ ❮…).
  // Nothing else in the text changes.
  // The text itself is kept as it was (look-alikes are only folded to
  // look for the tag): what Claude reads is what was sent.
  const t = [...String(text)]
  const out = t.slice()
  // What each character is, worked out once (the looks below only read it:
  // linear, whatever the text). Looks stop within 32 characters of the "<".
  const memo = new Map()
  const info = c => {
    let m = memo.get(c)
    if (m) return m
    const n = c.normalize('NFKC')
    // (Characters drawn blank count as invisible: braille blank, Hangul fillers, hieroglyph blanks…)
    const skip = INVISIBLE.test(c) || /\p{M}/u.test(c) || /^[\u2800\u3164\uFFA0\u115F\u1160\u{13441}\u{13442}\u{1D159}]$/u.test(c)
    let folded = ''
    for (const x of n) if (!INVISIBLE.test(x) && !/\p{M}/u.test(x)) folded += skeleton(x)
    m = {
      lt: n === '<' || LT_LOOKALIKES.has(c),
      skip,
      // (Any non-ASCII punctuation or symbol right after "<" reads as a slash: ⧸ ╱ ∖ ・…)
      slashy: c === '/' || c === '\\' || skeleton(n) === '/' || (c.charCodeAt(0) > 0x7f && /[\p{P}\p{S}]/u.test(c)),
      firstSlash: [...n].some(x => !INVISIBLE.test(x) && !/\p{M}/u.test(x)) && n.codePointAt(0) > 0x7f && /[\p{P}\p{S}]/u.test(String.fromCodePoint(n.codePointAt(0))),
      folded,
      letter: /\p{L}/u.test(c),
      // A non-ASCII symbol in a letter's place (∣ │ ⍺) can pass for one.
      symbol: c.charCodeAt(0) > 0x7f && /\p{S}/u.test(c),
      ascii: c.charCodeAt(0) <= 0x7f,
      sk: skeleton(n),
    }
    if (memo.size < 5000) memo.set(c, m)
    return m
  }
  // Where the next character that isn't skipped is (invisible, combining,
  // space): looks count only those, so no padding moves "channel" out of
  // reach, and each look is a few steps whatever the text.
  const next = new Int32Array(t.length + 1)
  next[t.length] = t.length
  for (let k = t.length - 1; k >= 0; k--) next[k] = info(t[k]).skip ? next[k + 1] : k
  for (let i = 0; i < t.length; i++) {
    if (!info(t[i]).lt) continue
    let word = ''
    for (let j = next[i + 1], steps = 0; j < t.length && steps < 16 && word.length < 8; j = next[j + 1], steps++) {
      const m = info(t[j])
      word += !word && m.firstSlash ? '/' + m.folded.slice(1) : m.folded
    }
    // Also any "<" followed by a non-ASCII letter: no list of look-alikes is
    // complete, and a real tag never needs one.
    // Also a look-alike this table doesn't know: a run of 7 letters after "<"
    // or "</" with a non-ASCII one, whose ASCII letters are those of
    // "channel" in their places (ordinary text like "<añadir" is left alone).
    const run = []
    for (let j = next[i + 1], steps = 0; j < t.length && steps < 16 && run.length < 7; j = next[j + 1], steps++) {
      const m = info(t[j])
      if (run.length === 0 && m.slashy) continue
      if (!m.letter && !m.symbol) break
      run.push(t[j])
    }
    // A run that spells "channel" outright after "<" and any slash-like mark
    // (⧸ ╱ ∖ ・ ‐…): no list of slashes is complete either.
    const looksLikeTag = run.length === 7 && (run.map(c => info(c).sk).join('').toLowerCase() === 'channel' ||
      (run.some(c => !info(c).ascii) && run.every((c, k) => !info(c).ascii || c.toLowerCase() === 'channel'[k])))
    if (word.startsWith('channel') || word.startsWith('/channel') || looksLikeTag) out[i] = '<\\'
  }
  return out.join('')
}

// A worker remembers which identity its coordinator was the first time they
// talked (when it was created on the server). If a session with that name is
// later deleted and registered again — by someone else — the worker stops
// taking its messages instead of obeying an impostor.
// Checked again for every message from the coordinator and every permission
// request (fresh), and otherwise at most every COORDINATOR_RECHECK_MS: a
// coordinator deleted and registered again (by someone else) while this
// worker runs is caught too.
const COORDINATOR_RECHECK_MS = 60_000
// batch: for a message from the coordinator, once per batch of messages: a
// burst of them, each waiting for its own check, would keep this session from
// polling for long enough to be taken for gone.
export async function checkCoordinator(s, { fresh = false, batch = false } = {}) {
  if (s.role !== 'worker' || s.coordinatorRejected) return !s.coordinatorRejected
  if (batch && s.pollBatch && s.coordinatorBatch === s.pollBatch) return true
  if (!fresh && s.coordinatorChecked && Date.now() - (s.coordinatorCheckedAt ?? 0) < COORDINATOR_RECHECK_MS) return true
  let info
  try { info = await call('getChat', { chat_id: s.coordinator }, { s }) } catch (err) {
    // Not registered yet: nothing to compare with.
    if (err instanceof ApiError && err.code === 400) return true
    // Couldn't check (busy server, network…): trust only a recent good
    // check; otherwise null, "not known yet" (never a yes).
    log(`could not check coordinator "${s.coordinator}" (${err.message})`)
    if (!fresh && s.coordinatorChecked && Date.now() - (s.coordinatorCheckedAt ?? 0) < COORDINATOR_RECHECK_MS) return true
    return null
  }
  s.coordinatorChecked = true
  s.coordinatorCheckedAt = Date.now()
  const created = Number(info.created_at) || 0
  const identity = info.squadra_identity ? String(info.squadra_identity) : null
  let pin = null
  try { pin = JSON.parse(readFileSync(s.coordinatorPinFile, 'utf8')) } catch {}
  // A pin from before identities were random has only the second: compared
  // once that way, then rewritten with the identity.
  const same = pin && pin.name === s.coordinator && (pin.identity ? pin.identity === identity : pin.created_at === created)
  // Without a pin for this coordinator (first time, or it changed), the one
  // in allow-pins.json counts: a former coordinator registered again by
  // someone else isn't taken on trust.
  const paired = readAllowPins(s)[s.coordinator]
  const mismatch = (pin && pin.name === s.coordinator && !same) ||
    ((!pin || pin.name !== s.coordinator) && paired !== undefined && identity && paired !== `i:${identity}`)
  if (mismatch) {
    s.coordinatorRejected = true
    log(`coordinator "${s.coordinator}" is not the identity this worker paired with: ignoring it`)
    if (active(s)) {
      agent.deliver({
        content: `Squadra warning: the session "${s.coordinator}" is not the coordinator this worker knew (it was registered again on the server). Its messages are being ignored. Tell the user: if this is expected, they can delete ${s.coordinatorPinFile}, run /squadra:access unpin ${s.coordinator}, and log in again.`,
        meta: { kind: 'squadra_notice', user: 'squadra' },
      })
    }
    return false
  }
  if (!pin || pin.name !== s.coordinator || (!pin.identity && identity)) {
    try { writePrivateFile(s.coordinatorPinFile, JSON.stringify({ name: s.coordinator, identity, created_at: created }, null, 2) + '\n') } catch {}
  }
  s.coordinatorBatch = s.pollBatch
  return true
}

export async function handleInbound(s, msg, { edited = false } = {}) {
  if (!active(s)) return
  if (s.role === 'solo') return // outside any squad: no messages (the server refuses them too)
  // An edited permission request is never taken: what was asked can't change.
  if (edited && /^\s*🔐 Permission/.test(String(msg.text ?? ''))) { log(`ignored an edited permission request from ${msg.from?.id}`); return }
  if (s.role === 'worker' && String(msg.from?.id) === s.coordinator) {
    const ok = await checkCoordinator(s, { fresh: true, batch: true })
    // Couldn't be checked now: the message is taken again later, not lost.
    if (ok === null) throw new RetryLater('coordinator could not be checked')
    if (!ok) return
  }
  const chat_id = String(msg.chat?.id ?? '')
  const text = msg.text ?? msg.caption ?? (msg.photo ? '(image)' : msg.document ? `(document: ${safeName(msg.document.file_name) ?? 'file'})` : '')

  // Notices generated by the server (a worker left or went down). Delivered only
  // if the worker is one of ours; never trigger pairing.
  if (msg.squadra_notice) {
    // (The server only tells coordinators about their workers. They can't be
    // signed, so nothing else may arrive this way.)
    if (s.role !== 'coordinator') return
    if (!noticeAccepted(s, msg)) return
    const acc = loadAccess(s)
    if (acc.dmPolicy === 'disabled' || msg.chat?.type !== 'private' || String(msg.chat.id) !== String(msg.from?.id) || !acc.allowFrom.includes(String(msg.from?.id))) return
    if (!pinAllowed(s, String(msg.from.id), msg.from.squadra_identity)) return
    if (!active(s)) return
    agent.deliver({
      content: safeContent(visibleText(text)),
      meta: { kind: 'squadra_notice', user: safeName(msg.from.id), ts: new Date((msg.date ?? 0) * 1000).toISOString() },
    })
    return
  }

  // Commands are DM-only and answered by the plugin, not by Claude.
  if (!edited && msg.chat?.type === 'private' && /^\/(start|help|status)\s*$/.test(text)) {
    return handleCommand(s, msg, text.trim().slice(1))
  }

  const result = gate(msg, { pairing: !edited })
  if (result.action === 'drop') return

  if (result.action === 'pair') {
    if (edited) return
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await call('sendMessage', {
      chat_id,
      text: `${lead}: the user must run this in the terminal of session "${s.name}":\n\n/squadra:access pair ${result.code}`,
      squadra_auto: true, // an automatic reply: not a conversation with the sender
      squadra_fyi: true, // and not a task for a worker: it reports nothing back
    }, { s }).catch(err => log(`pairing reply failed: ${err.message}`))
    // Also tell our own Claude, so the user sees the request in this terminal.
    // Claude must not approve it itself (see instructions).
    if (!result.isResend && active(s)) {
      agent.deliver({
        content: `Session "${safeName(msg.from.id)}" wants to talk to you. If the user recognises it, they must run in this terminal: /squadra:access pair ${result.code}  (do not approve it yourself).`,
        meta: { kind: 'pairing_request', user: safeName(msg.from.id), code: result.code },
      })
    }
    return
  }

  if (!signatureAccepted(s, msg, edited)) return

  const access = result.access
  const from = msg.from
  const msgId = msg.message_id

  // Permission-reply intercept: "yes xxxxx" for a request we sent to this
  // sender becomes the structured verdict instead of a chat message. Anything
  // else that looks like one (wrong sender, group, unknown code) is dropped.
  if (!edited) {
    const permMatch = PERMISSION_REPLY_RE.exec(text)
    if (permMatch) {
      const verdict = agent.takePermissionReply(msg, permMatch)
      if (verdict === null) return
      if (verdict !== 'chat') {
      agent.givePermission(verdict)
      if (msgId != null) {
        const emoji = verdict.behavior === 'allow' ? '✅' : '❌'
        void call('setMessageReaction', { chat_id, message_id: msgId, reaction: [{ type: 'emoji', emoji }] }, { s }).catch(() => {})
      }
      return
      }
    }
  }

  // "Typing" signal — lets the sender know its message reached this session.
  void call('sendChatAction', { chat_id, action: 'typing' }, { s }).catch(() => {})

  // Ack reaction — optional, like Telegram's ackReaction. Never wakes the sender.
  if (access.ackReaction && msgId != null && !edited) {
    void call('setMessageReaction', { chat_id, message_id: msgId, reaction: [{ type: 'emoji', emoji: access.ackReaction }] }, { s }).catch(() => {})
  }

  // Photos are downloaded right away; other files on demand.
  let imagePath
  let attachment
  const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1] : null
  // Photos are fetched right away only up to 10 MB; bigger ones wait, like documents.
  // (At most 8 seconds: the next poll waits for this one, and a session that
  // doesn't poll for 15 seconds is taken for gone. A slow one is offered
  // like a document instead.)
  if (photo && Number(photo.file_size ?? 0) <= 10 * 1024 * 1024) {
    const left = (s.photoDeadline ?? Date.now() + 8000) - Date.now()
    if (left <= 0) imagePath = null
    else {
      let timer
      const abort = new AbortController()
      imagePath = await Promise.race([
        downloadFile(photo.file_id, s, abort.signal).catch(err => { if (!abort.signal.aborted) log(`photo download failed: ${err.message}`); return undefined }),
        new Promise(r => { timer = setTimeout(() => r(null), left) }),
      ])
      clearTimeout(timer)
      if (imagePath === null) abort.abort() // (the slow download stops; it is offered as an attachment)
    }
  }
  if (photo && imagePath === null) log('photo download is slow: offered as an attachment instead')
  if ((photo && !imagePath) || (!photo && msg.document)) {
    msg.document ??= { file_id: photo.file_id, file_size: photo.file_size, file_name: 'image' }
    attachment = {
      kind: 'document',
      file_id: msg.document.file_id,
      size: msg.document.file_size,
      mime: msg.document.mime_type,
      name: safeName(msg.document.file_name),
    }
  }

  if (!active(s)) return
  if (!edited) {
    s.recent.push({
      from: String(from.id),
      group: msg.chat.type === 'group' ? chat_id : null,
      ts: new Date((msg.date ?? 0) * 1000).toISOString(),
      text: text.length > 1500 ? `${visibleText(text).slice(0, 1500)}… (truncated)` : visibleText(text),
    })
    if (s.recent.length > 6) s.recent.shift()
  }
  // A worker's task: a message from its coordinator (not one that only
  // informs). It ends with a final report, which the Stop hook requires.
  const isTask = s.role === 'worker' && !edited && msg.chat.type === 'private' && String(from.id) === s.coordinator && !msg.squadra_fyi && msgId != null
  if (isTask) {
    s.tasks.set(Number(msgId), { at: Date.now(), started: false })
    s.stopAsked = false
    while (s.tasks.size > 50) s.tasks.delete(s.tasks.keys().next().value)
  }
  const report = REPORTS.includes(msg.squadra_report) ? msg.squadra_report : null
  // image_path goes in meta only — an in-content "[image attached — read: PATH]"
  // annotation is forgeable by any allowlisted sender typing that string.
  agent.deliver({
    content: safeContent(visibleText(text)),
    meta: {
      chat_id: safeName(chat_id),
      ...(msgId != null ? { message_id: safeName(msgId) } : {}),
      user: safeName(from.username ?? from.id),
      user_id: safeName(from.id),
      // From the coordinator of another squad linked with this one.
      ...(msg.chat.type === 'private' && linkedCoordinators(s).includes(String(from.id)) ? { linked: 'true' } : {}),
      ...(msg.squadra_fyi ? { fyi: 'true' } : {}),
      ...(report ? { report } : {}),
      ts: new Date((msg.edit_date ?? msg.date ?? 0) * 1000).toISOString(),
      ...(msg.chat.type === 'group' ? { group: safeName(chat_id) } : {}),
      ...(msg.reply_to_message?.message_id != null ? { in_reply_to: safeName(msg.reply_to_message.message_id) } : {}),
      ...(edited ? { edited: 'true' } : {}),
      ...(imagePath ? { image_path: imagePath } : {}),
      ...(attachment ? {
        attachment_kind: attachment.kind,
        attachment_file_id: safeName(attachment.file_id),
        ...(attachment.size != null ? { attachment_size: safeName(attachment.size) } : {}),
        ...(attachment.mime ? { attachment_mime: safeName(attachment.mime) } : {}),
        ...(attachment.name ? { attachment_name: attachment.name } : {}),
      } : {}),
    },
  })
}

async function handleCommand(s, msg, command) {
  const gated = dmCommandGate(msg)
  if (!gated) return
  const chat_id = String(msg.chat.id)
  const { access, senderId } = gated
  let text
  if (command === 'start') {
    text =
      `This is Squadra session "${s.name}".\n\n` +
      `To pair:\n` +
      `1. Send me anything and you will get a 6-character code.\n` +
      `2. The user approves it in the terminal of "${s.name}": /squadra:access pair <code>`
  } else if (command === 'help') {
    text =
      `Messages you send here reach session "${s.name}". Text, images and documents; replies come back in the same chat.\n\n` +
      `/start — pairing instructions\n` +
      `/status — your pairing status`
  } else {
    if (access.allowFrom.includes(senderId)) text = `Paired with "${s.name}" as ${senderId}.`
    else {
      const pending = Object.entries(access.pending).find(([, p]) => p.senderId === senderId)
      text = pending
        ? `Pairing pending: the user must run in "${s.name}": /squadra:access pair ${pending[0]}`
        : `Not paired. Send me a message to get a code.`
    }
  }
  await call('sendMessage', { chat_id, text, squadra_auto: true, squadra_fyi: true }, { s }).catch(err => log(`command reply failed: ${err.message}`))
}

// Retry polling with backoff on any error. Persistent 409 means another plugin
// instance is polling as this name (another session with the same name, here
// or on another machine). Stops as soon as this session is logged out.
export class RetryLater extends Error {}
