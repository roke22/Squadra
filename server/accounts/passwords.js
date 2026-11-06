import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { ApiError } from '../platform/index.js'

// Asynchronous, so nobody waits while a password is checked; and only so many at
// once, because each one takes a lot of memory and time on purpose.
const N = 2 ** 15, R = 8, P = 1
const SIZE = 32
const AT_ONCE = 16
let running = 0

function derive(password, salt, { n = N, r = R, p = P } = {}) {
  if (running >= AT_ONCE) throw new ApiError(503, 'Service Unavailable: too many sign-ins at once; retry')
  running++
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SIZE, { N: n, r, p, maxmem: 256 * 1024 * 1024 }, (err, key) => {
      running--
      if (err) reject(err); else resolve(key)
    })
  })
}

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await derive(password, salt)
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export async function passwordMatches(password, stored) {
  const [kind, n, r, p, salt, key] = String(stored).split('$')
  if (kind !== 'scrypt') return false
  const expected = Buffer.from(key, 'base64url')
  return timingSafeEqual(await derive(password, Buffer.from(salt, 'base64url'), { n: Number(n), r: Number(r), p: Number(p) }), expected)
}

// For an address nobody has: the same work, so the time doesn't say whether it exists.
export const NOBODY = await hashPassword(randomBytes(16).toString('hex'))

export function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < 12) throw new ApiError(400, 'Bad Request: the password needs at least 12 characters')
  if (password.length > 200) throw new ApiError(400, 'Bad Request: the password can have at most 200 characters')
}
