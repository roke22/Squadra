#!/usr/bin/env node
// Signs squadra-host for a release, so that `squadra-host update` can tell a
// real release from whatever a server hands out. See RELEASE.md.
//
//   node scripts/release-sign.mjs keygen <private-key-file>   # once, kept out of this repository
//   node scripts/release-sign.mjs sign <private-key-file> [<previous-private-key-file>]   # writes host/squadra-host.mjs.sig
//   node scripts/release-sign.mjs check                       # the signature matches the key in the script
//
// While a new key takes over, a release is signed with both: each machine
// checks with the key it has, and this one brings it the new key.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../host/squadra-host.mjs', import.meta.url))
const SIGNATURE = `${SCRIPT}.sig`
const die = text => { process.stderr.write(`${text}\n`); process.exit(1) }

const body = () => readFileSync(SCRIPT)
const embeddedKey = () => /^const RELEASE_PUBLIC_KEY = '([A-Za-z0-9_-]*)'$/m.exec(body().toString('utf8'))?.[1] ?? ''
const publicOf = key => createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url')

const [cmd, file, previousFile] = process.argv.slice(2)
if (cmd === 'keygen' && file) {
  const { privateKey } = generateKeyPairSync('ed25519')
  writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' })
  process.stdout.write(`Private key: ${file} (keep it out of the repository, and backed up)\nPublic key, for RELEASE_PUBLIC_KEY in host/squadra-host.mjs:\n${publicOf(privateKey)}\n`)
} else if (cmd === 'sign' && file) {
  const key = createPrivateKey(readFileSync(file))
  if (publicOf(key) !== embeddedKey()) die('this key is not the one in RELEASE_PUBLIC_KEY (host/squadra-host.mjs)')
  const keys = [key]
  if (previousFile) {
    const previous = createPrivateKey(readFileSync(previousFile))
    if (previous.asymmetricKeyType !== 'ed25519') die('the previous key is not an Ed25519 key')
    if (publicOf(previous) === embeddedKey()) die('the previous key is the same as the current one')
    keys.push(previous)
  }
  writeFileSync(SIGNATURE, keys.map(k => `${sign(null, body(), k).toString('base64url')}\n`).join(''))
  process.stdout.write(`Signed: ${SIGNATURE}${previousFile ? ' (with both keys)' : ''}\n`)
} else if (cmd === 'check') {
  const key = embeddedKey()
  if (!key) die('RELEASE_PUBLIC_KEY is empty in host/squadra-host.mjs')
  let signature
  try { signature = readFileSync(SIGNATURE, 'utf8').trim() } catch { die(`${SIGNATURE} is missing: sign this release`) }
  const publicKey = createPublicKey({ key: Buffer.from(key, 'base64url'), format: 'der', type: 'spki' })
  if (!signature.split(/\s+/).some(s => verify(null, body(), publicKey, Buffer.from(s, 'base64url')))) die('the signature does not match host/squadra-host.mjs: sign it again')
  process.stdout.write('The signature matches.\n')
} else {
  die('usage: release-sign.mjs keygen <private-key-file> | sign <private-key-file> | check')
}
