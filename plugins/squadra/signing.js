/**
 * Signed messages between sessions.
 *
 * The server relays messages and says who sent them. Whoever controls it (or
 * the connection to it) could write as anyone, so each session also signs what
 * it sends with its own Ed25519 key, which never leaves its machine. A session
 * remembers the key of each sender the first time it hears from it, and from
 * then on takes only what that key signed. No dependencies, no state: the
 * plugin keeps the keys and decides what to do with the answers.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'

// What the server may remove from a message (its UNSAFE_CHARS), all of it: a
// signature covers the text without them, so it holds whatever the server kept.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\u115f\u1160\u17b4\u17b5\u2065\u2800\u3164\uffa0\ufeff\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}\u180b-\u180f\ufe00-\ufe0f\u{e0100}-\u{e01ef}\p{Cf}]/gu
const signableText = text => String(text ?? '').toWellFormed().replace(INVISIBLE, '')

// Those characters aren't signed, so they could have been added on the way, and
// Claude reads them even if nobody sees them. What reaches Claude has only the
// ones that mean something where they are: an emoji's selector and joiner, and
// the joiners inside words of the scripts that use them.
const PICTO = /\p{Extended_Pictographic}/u
const LETTER = /\p{L}|\p{M}/u
export function visibleText(text) {
  return String(text ?? '').toWellFormed().replace(INVISIBLE, (ch, at, all) => {
    const before = String.fromCodePoint(at > 0 ? all.codePointAt(at - (/[\udc00-\udfff]/.test(all[at - 1]) ? 2 : 1)) ?? 0 : 0)
    const after = String.fromCodePoint(all.codePointAt(at + ch.length) ?? 0)
    if (ch === '\ufe0f') return PICTO.test(before) || /^[0-9#*]$/.test(before) ? ch : ''
    if (ch === '\u200d') return (PICTO.test(before) || before === '\ufe0f') && PICTO.test(after) ? ch : LETTER.test(before) && LETTER.test(after) ? ch : ''
    if (ch === '\u200c') return LETTER.test(before) && LETTER.test(after) ? ch : ''
    return ''
  })
}

export function newSigningKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    private: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    public: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  }
}

// A key as written by newSigningKey, or null if it isn't one.
export function readSigningKey(stored) {
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(String(stored.private), 'base64url'), format: 'der', type: 'pkcs8' })
    if (privateKey.asymmetricKeyType !== 'ed25519') return null
    return { privateKey, public: createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url') }
  } catch {
    return null
  }
}

// To compare a key by eye, in two terminals.
export const keyFingerprint = publicKey => createHash('sha256').update(String(publicKey)).digest('hex').slice(0, 16).replace(/(.{4})(?=.)/g, '$1 ')

// An edit is bound to the message it changes. The server keeps a message's
// fyi and report through an edit, so an edit doesn't sign them.
const signedBytes = ({ from, to, ts, nonce, text, fyi, report, editId, file }) => Buffer.from(JSON.stringify([
  'squadra-message-1', String(from), String(to), ts, nonce, signableText(text),
  editId == null ? [fyi === true, report ?? null] : Number(editId),
  file ?? null,
]))

// file: sha256 (hex) of the attachment.
export function sealMessage(key, fields, { now = Date.now() } = {}) {
  const ts = now
  const nonce = randomBytes(12).toString('base64url')
  const s = sign(null, signedBytes({ ...fields, ts, nonce }), key.privateKey).toString('base64url')
  return Buffer.from(JSON.stringify({ k: key.public, ts, n: nonce, ...(fields.file ? { f: fields.file } : {}), s })).toString('base64url')
}

// What a signature says, if it is good for these fields: { key, ts, nonce,
// file }. Otherwise null. Whose key it is, is for the caller to decide.
export function openMessage(sealed, fields) {
  try {
    if (typeof sealed !== 'string' || sealed.length > 1024) return null
    const { k, ts, n, f, s } = JSON.parse(Buffer.from(sealed, 'base64url').toString('utf8'))
    if (typeof k !== 'string' || typeof s !== 'string' || typeof n !== 'string' || n.length > 64 || !Number.isSafeInteger(ts)) return null
    if (f !== undefined && !/^[0-9a-f]{64}$/.test(f)) return null
    const publicKey = createPublicKey({ key: Buffer.from(k, 'base64url'), format: 'der', type: 'spki' })
    if (publicKey.asymmetricKeyType !== 'ed25519') return null
    const ok = verify(null, signedBytes({ ...fields, ts, nonce: n, file: f }), publicKey, Buffer.from(s, 'base64url'))
    return ok ? { key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), ts, nonce: n, file: f ?? null } : null
  } catch {
    return null
  }
}

// --- the server, and this session to it ---------------------------------------------------

function signedBy(publicKeyText, fields, sig) {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(String(publicKeyText), 'base64url'), format: 'der', type: 'spki' })
    return publicKey.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(JSON.stringify(fields)), publicKey, Buffer.from(String(sig), 'base64url'))
  } catch {
    return false
  }
}

// What the server answers when asked to prove its key on our nonce: { key,
// challenge }, or null if that isn't a proof.
export function openServerIdentity(answer, nonce) {
  const { key, challenge, sig } = answer ?? {}
  if (typeof key !== 'string' || typeof challenge !== 'string') return null
  return signedBy(key, ['squadra-server-identity-1', nonce, challenge], sig) ? { key, challenge } : null
}

// A notice the server generated (it has no sender to sign it).
// (company: the one this session is of, on a server with several. A notice is signed for it.)
export const serverNoticeIsGood = (serverKey, sig, { company, from, to, id, date, text }) => signedBy(serverKey, [...(company ? ['squadra-notice-2', company] : ['squadra-notice-1']), from, to, id, date, text], sig)

// That this session holds its key, for this server and this login only.
export const proveKey = (key, serverKey, purpose, subject, challenge, extra) => sign(null, Buffer.from(JSON.stringify(['squadra-client-proof-1', serverKey, purpose, subject, challenge, extra])), key.privateKey).toString('base64url')
