// The server's key and signed messages (see ../signing.js).

import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import {
  keyFingerprint, openServerIdentity, serverNoticeIsGood, readSigningKey, newSigningKey,
  openMessage,
} from '../signing.js'
import { agent } from './agent.js'
import { ROOT_DIR, SERVER_URL, log } from './settings.js'
import { active } from './session.js'
import { writePrivateFile } from './access.js'
import { ApiError, readJson } from './client.js'

// Remembered per server for the whole machine, the first time it proves it.
const serverKeyFile = join(ROOT_DIR, '.server-keys', createHash('sha256').update(SERVER_URL).digest('hex').slice(0, 16))
const pinnedServerKey = () => { try { return readFileSync(serverKeyFile, 'utf8').trim() || null } catch { return null } }

export class ServerKeyError extends Error {}

// { key, challenge }, or null from a server older than this plugin that never
// had a key here. Anything that isn't the server we remember: ServerKeyError.
export async function serverIdentity() {
  const nonce = randomBytes(18).toString('base64url')
  const res = await fetch(`${SERVER_URL}/server-identity?nonce=${nonce}`, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  const pinned = pinnedServerKey()
  const impostor = why => new ServerKeyError(`${SERVER_URL} is not the server this machine knows: ${why}. Nothing was sent to it. It may be an impostor. Only if you know the server's key was really replaced, delete ${serverKeyFile} and log in again`)
  if (res.status === 401 || res.status === 404) {
    if (pinned) throw impostor(`it proves no key, and it should have ${keyFingerprint(pinned)}`)
    return null
  }
  if (!res.ok) throw new ApiError(res.status, `the server answered HTTP ${res.status} when asked for its key`)
  const answer = openServerIdentity((await readJson(res).catch(() => null))?.result, nonce)
  if (!answer) throw impostor('it did not prove its key')
  if (pinned && answer.key !== pinned) throw impostor(`its key is ${keyFingerprint(answer.key)}, and it should be ${keyFingerprint(pinned)}`)
  if (!pinned) {
    try {
      mkdirSync(join(ROOT_DIR, '.server-keys'), { recursive: true, mode: 0o700 })
      writeFileSync(serverKeyFile, answer.key + '\n', { mode: 0o600, flag: 'wx' })
      log(`this server's key is ${keyFingerprint(answer.key)}: remembered`)
    } catch (err) {
      if (err.code !== 'EEXIST') log(`could not remember the server's key: ${err.message}`)
      else if (pinnedServerKey() !== answer.key) throw impostor(`its key is ${keyFingerprint(answer.key)}, and it should be ${keyFingerprint(pinnedServerKey())}`)
    }
  }
  return answer
}

// A notice only if the server signed it, for this session, and not one seen before.
export function noticeAccepted(s, msg) {
  if (!s.serverKey) return true
  const good = serverNoticeIsGood(s.serverKey, msg.squadra_server_sig, { from: String(msg.from?.id), to: s.name, id: msg.message_id, date: msg.date, text: msg.text ?? '' })
  if (!good || msg.message_id <= (s.lastNoticeId ?? 0)) { log(`notice "from" ${msg.from?.id} ignored: the server did not sign it, or it was seen before`); return false }
  s.lastNoticeId = msg.message_id
  return true
}

// This session's key: made once, kept next to its identity, never sent anywhere.
export function loadSigningKey(s) {
  try {
    const key = readSigningKey(JSON.parse(readFileSync(s.signingKeyFile, 'utf8')))
    if (key) return key
  } catch {}
  const stored = newSigningKey()
  writePrivateFile(s.signingKeyFile, JSON.stringify(stored) + '\n')
  return readSigningKey(stored)
}

// The key each sender signs with, per server and for the whole machine: a
// server can't get a new session here to take another key for that name.
// One file per name, created once: two sessions can't overwrite each other.
const PEER_KEYS_DIR = join(ROOT_DIR, '.peer-keys', createHash('sha256').update(SERVER_URL).digest('hex').slice(0, 16))
const peerKeyFile = name => join(PEER_KEYS_DIR, name)
export function readPeerKey(name) {
  try { return readFileSync(peerKeyFile(name), 'utf8').trim() || null } catch { return null }
}
function pinPeerKey(name, key) {
  try {
    mkdirSync(PEER_KEYS_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(peerKeyFile(name), key + '\n', { mode: 0o600, flag: 'wx' })
  } catch (err) {
    if (err.code !== 'EEXIST') log(`could not remember the key of "${name}": ${err.message}`)
    return readPeerKey(name) === key
  }
  return true
}

// A signature is good once: nobody can hand a session an old message again.
const SIG_MAX_AGE_MS = 8 * 24 * 3600_000 // (messages are kept for 7 days)
const SIG_SEEN_MAX = 2000
function signatureReplayed(s, sender, opened) {
  if (!s.sigSeen) {
    s.sigSeen = { floor: 0, map: new Map() }
    try {
      const saved = JSON.parse(readFileSync(s.sigSeenFile, 'utf8'))
      s.sigSeen.floor = Number(saved.floor) || 0
      s.sigSeen.map = new Map(saved.seen)
    } catch {}
  }
  const seen = s.sigSeen
  const t = Date.now()
  if (opened.ts > t + 24 * 3600_000 || opened.ts < t - SIG_MAX_AGE_MS || opened.ts < seen.floor) return true
  const id = `${sender}:${opened.nonce}`
  if (seen.map.has(id)) return true
  seen.map.set(id, opened.ts)
  for (const [k, ts] of seen.map) {
    if (ts >= t - SIG_MAX_AGE_MS && seen.map.size <= SIG_SEEN_MAX) break
    seen.map.delete(k)
    seen.floor = Math.max(seen.floor, ts)
  }
  try { writePrivateFile(s.sigSeenFile, JSON.stringify({ floor: seen.floor, seen: [...seen.map] }) + '\n') } catch (err) { log(`could not save the signatures seen: ${err.message}`) }
  return false
}

function signatureWarning(s, sender, why) {
  log(`message from "${sender}" ignored: ${why}`)
  s.sigWarned ??= new Set()
  if (s.sigWarned.has(sender) || !active(s)) return
  s.sigWarned.add(sender)
  agent.deliver({
    content: `Squadra warning: a message from "${sender}" was ignored: ${why}. Something other than that session may be writing as it, or the server or the connection to it may be compromised. Tell the user. Only if they know that session really has a new key (it moved to another machine, say), they can delete ${peerKeyFile(sender)} and the next signed message from that name is accepted.`,
    meta: { kind: 'squadra_notice', user: 'squadra' },
  })
}

// Whether to take this message, by its signature. A sender not heard from yet
// is taken at its word: the first signed message sets the key to expect. No
// signature from a sender with no key known is an older plugin.
export function signatureAccepted(s, msg, edited) {
  const sender = String(msg.from.id)
  const file = msg.photo?.length ? msg.photo[msg.photo.length - 1] : msg.document
  const pinned = readPeerKey(sender)
  if (!msg.squadra_sig) {
    if (pinned) { signatureWarning(s, sender, 'it is not signed, and that session signs what it sends'); return false }
    if (file?.file_id) s.fileHashes.set(file.file_id, null)
    return true
  }
  const opened = openMessage(msg.squadra_sig, {
    from: sender,
    to: msg.chat.type === 'group' ? msg.chat.id : s.name,
    text: msg.text ?? msg.caption ?? '',
    fyi: msg.squadra_fyi === true,
    report: msg.squadra_report,
    editId: edited ? msg.message_id : null,
  })
  // (A signature for an attachment on a message without one, or the other way round: not what was sent.)
  if (!opened || !opened.file !== !file) { signatureWarning(s, sender, 'its signature is not valid'); return false }
  if (pinned && pinned !== opened.key) { signatureWarning(s, sender, 'it is signed with a different key than the one that session had'); return false }
  if (signatureReplayed(s, sender, opened)) { log(`message from "${sender}" ignored: a signature already used, or too old`); return false }
  if (!pinned && !pinPeerKey(sender, opened.key)) { signatureWarning(s, sender, 'it is signed with a different key than the one that session had'); return false }
  if (file?.file_id) {
    if (s.fileHashes.size > 2000) s.fileHashes.delete(s.fileHashes.keys().next().value)
    s.fileHashes.set(file.file_id, opened.file)
  }
  return true
}
