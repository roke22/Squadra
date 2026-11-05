import { mkdirSync, chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  randomBytes, generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign as signBytes,
  timingSafeEqual,
} from 'node:crypto'
import { DATA_DIR } from './config.js'
import { sha256 } from './basics.js'
import { ApiError } from './errors.js'

export function openCredentials() {
  // Messages, attachments and observation are private: only this user can read
  // the data folder and what the server creates in it.
  process.umask(0o077)
  mkdirSync(join(DATA_DIR, 'files'), { recursive: true, mode: 0o700 })
  for (const p of [DATA_DIR, join(DATA_DIR, 'files')]) { try { chmodSync(p, 0o700) } catch {} }
  for (const f of ['squadra.db', 'squadra.db-wal', 'squadra.db-shm']) { try { chmodSync(join(DATA_DIR, f), 0o600) } catch {} }

  // Server token: SQUADRA_SERVER_TOKEN if set; otherwise the one saved in
  // DATA_DIR/server-token; otherwise a new one, generated and saved there so
  // restarts keep the same token and plugins don't need reconfiguring.
  const TOKEN_FILE = join(DATA_DIR, 'server-token')
  const { token: SERVER_TOKEN, source: TOKEN_SOURCE } = (() => {
    const fromEnv = process.env.SQUADRA_SERVER_TOKEN ?? process.env.SWARM_SERVER_TOKEN // SWARM_: former name
    if (fromEnv) {
      if (fromEnv.length < 16) {
        process.stderr.write('squadra-server: SQUADRA_SERVER_TOKEN must be at least 16 chars\n')
        process.exit(1)
      }
      return { token: fromEnv, source: 'env SQUADRA_SERVER_TOKEN' }
    }
    try {
      const saved = readFileSync(TOKEN_FILE, 'utf8').trim()
      if (saved.length >= 16) return { token: saved, source: TOKEN_FILE }
    } catch {}
    const generated = randomBytes(24).toString('hex')
    writeFileSync(TOKEN_FILE, generated + '\n', { mode: 0o600 })
    return { token: generated, source: `${TOKEN_FILE} (new)` }
  })()

  // Join token: lets a machine register NEW session names (POST /register
  // without reset) and nothing else. It is what plugins and enrolled machines
  // keep on disk; the server token above is the admin credential (dashboard,
  // web terminals, /admin, rotating identities) and never leaves the browser.
  const JOIN_TOKEN_FILE = join(DATA_DIR, 'join-token')
  let { token: JOIN_TOKEN, source: JOIN_TOKEN_SOURCE } = (() => {
    const fromEnv = process.env.SQUADRA_JOIN_TOKEN
    if (fromEnv) {
      if (fromEnv.length < 16 || fromEnv === SERVER_TOKEN) {
        process.stderr.write('squadra-server: SQUADRA_JOIN_TOKEN must be at least 16 chars and differ from the server token\n')
        process.exit(1)
      }
      return { token: fromEnv, source: 'env SQUADRA_JOIN_TOKEN' }
    }
    try {
      const saved = readFileSync(JOIN_TOKEN_FILE, 'utf8').trim()
      if (saved.length >= 16 && saved !== SERVER_TOKEN) return { token: saved, source: JOIN_TOKEN_FILE }
    } catch {}
    const generated = `sj_${randomBytes(24).toString('hex')}`
    writeFileSync(JOIN_TOKEN_FILE, generated + '\n', { mode: 0o600 })
    return { token: generated, source: `${JOIN_TOKEN_FILE} (new)` }
  })()

  // This server's own key: made the first time it starts, and kept. Machines and
  // sessions remember it, and from then on talk only to whoever can prove to hold
  // it. Never replaced by itself: that would look like an impostor to all of them.
  const SERVER_KEY_FILE = join(DATA_DIR, 'server-key')
  const SERVER_KEY = (() => {
    let pem = null
    try { pem = readFileSync(SERVER_KEY_FILE) } catch (err) {
      if (err.code !== 'ENOENT') { process.stderr.write(`squadra-server: cannot read ${SERVER_KEY_FILE}: ${err.message}\n`); process.exit(1) }
    }
    if (pem === null) {
      pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' })
      writeFileSync(SERVER_KEY_FILE, pem, { mode: 0o600, flag: 'wx' })
    }
    try {
      const privateKey = createPrivateKey(pem)
      if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key')
      const pub = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url')
      const hash = createHash('sha256').update(pub).digest('hex')
      return { privateKey, public: pub, hash, fingerprint: hash.slice(0, 16).replace(/(.{4})(?=.)/g, '$1 ') }
    } catch (err) {
      process.stderr.write(`squadra-server: ${SERVER_KEY_FILE} is not a usable key (${err.message}). Put the backup back; a new key would make every machine and session refuse this server\n`)
      process.exit(1)
    }
  })()
  const signAsServer = fields => signBytes(null, Buffer.from(JSON.stringify(fields)), SERVER_KEY.privateKey).toString('base64url')

  const sameSecret = (token, secret) => typeof token === 'string' && token !== '' &&
    timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(sha256(secret)))
  const isServerToken = token => sameSecret(token, SERVER_TOKEN)
  const isJoinToken = token => sameSecret(token, JOIN_TOKEN)
  const joinToken = () => ({ token: JOIN_TOKEN, source: JOIN_TOKEN_SOURCE })

  // A new join token: machines configured with the old one can no longer
  // register new names (their existing identities keep working).
  function rotateJoinToken() {
    if (process.env.SQUADRA_JOIN_TOKEN) throw new ApiError(409, 'Conflict: the join token comes from SQUADRA_JOIN_TOKEN; change it there')
    JOIN_TOKEN = `sj_${randomBytes(24).toString('hex')}`
    JOIN_TOKEN_SOURCE = JOIN_TOKEN_FILE
    writeFileSync(JOIN_TOKEN_FILE, JOIN_TOKEN + '\n', { mode: 0o600 })
    process.stderr.write('squadra-server: join token rotated\n')
    return { join_token: JOIN_TOKEN }
  }

  return {
    SERVER_TOKEN, TOKEN_SOURCE, SERVER_KEY_FILE, SERVER_KEY, signAsServer, isServerToken, isJoinToken,
    joinToken, rotateJoinToken,
  }
}
