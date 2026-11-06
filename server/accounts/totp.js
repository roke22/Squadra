import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

// Codes that change every 30 seconds (RFC 6238, as every authenticator app does it).
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const STEP_MS = 30_000

export function newTotpSecret() {
  let bits = ''
  for (const b of randomBytes(20)) bits += b.toString(2).padStart(8, '0')
  return bits.match(/.{5}/g).map(x => B32[parseInt(x, 2)]).join('')
}

function fromBase32(text) {
  let bits = ''
  for (const c of text) bits += B32.indexOf(c).toString(2).padStart(5, '0')
  return Buffer.from(bits.match(/.{8}/g).map(x => parseInt(x, 2)))
}

export function totpCode(secret, step) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', fromBase32(secret)).update(counter).digest()
  const at = mac[mac.length - 1] & 15
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}
export const totpStep = (at = Date.now()) => Math.floor(at / STEP_MS)

// The step a code is good for (a clock half a minute off is fine), or null.
// One already used doesn't count again: someone looking over a shoulder is too late.
export function checkTotp(secret, code, lastStep, at = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null
  const now = totpStep(at)
  for (const step of [now - 1, now, now + 1]) {
    if (step > (lastStep ?? 0) && totpCode(secret, step) === code) return step
  }
  return null
}

// The secret at rest: encrypted with a key that is not in the database, and
// tied to its user, so a copy of the database alone gives no codes.
export function sealSecret(key, userId, secret) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(userId))
  const body = Buffer.concat([c.update(secret, 'utf8'), c.final()])
  return [iv, c.getAuthTag(), body].map(x => x.toString('base64url')).join('.')
}
export function openSecret(key, userId, sealed) {
  const [iv, tag, body] = String(sealed).split('.').map(x => Buffer.from(x, 'base64url'))
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAAD(Buffer.from(userId))
  d.setAuthTag(tag)
  return Buffer.concat([d.update(body), d.final()]).toString('utf8')
}
