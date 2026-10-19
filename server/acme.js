/**
 * Minimal ACME client (RFC 8555) for squadra-server: gets and renews a TLS
 * certificate from Let's Encrypt with the HTTP-01 challenge. Only Node
 * built-ins — no dependencies.
 *
 *   const acme = createAcme({ domain, email, directory, dir, log })
 *   acme.challenge(token)        → key authorization to serve at
 *                                  /.well-known/acme-challenge/<token>, or null
 *   await acme.ensureCertificate() → { key, cert } (PEM), issuing or renewing if needed
 *
 * Keys and certificates are stored in `dir` (account.key.pem, <domain>.key.pem,
 * <domain>.crt.pem) so restarts don't ask for a new certificate.
 */

import { createHash, generateKeyPairSync, createPrivateKey, sign, X509Certificate } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory'
export const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory'

// Renew when less than a third of the certificate's lifetime is left, as Let's
// Encrypt recommends (90-day certificates → at 30 days; shorter ones scale down).
const RENEW_FRACTION = 1 / 3

const b64u = buf => Buffer.from(buf).toString('base64url')

// --- DER encoding (just what a CSR needs) ---------------------------------------

function derLength(n) {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8 }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
const seq = (...items) => tlv(0x30, Buffer.concat(items))
const set = (...items) => tlv(0x31, Buffer.concat(items))
function oid(dotted) {
  const parts = dotted.split('.').map(Number)
  const bytes = [40 * parts[0] + parts[1]]
  for (const p of parts.slice(2)) {
    const chunk = [p & 0x7f]
    for (let v = p >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f))
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}

// PKCS#10 certificate signing request for one DNS name, signed with an EC P-256 key.
export function createCsr(domain, privateKey, publicKey) {
  const subject = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(domain)))))       // CN=<domain>
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const san = seq(tlv(0x82, Buffer.from(domain)))                                       // dNSName
  const extensions = seq(seq(oid('2.5.29.17'), tlv(0x04, san)))                         // subjectAltName
  const attributes = tlv(0xa0, seq(oid('1.2.840.113549.1.9.14'), set(extensions)))      // extensionRequest
  const info = seq(tlv(0x02, Buffer.from([0])), subject, spki, attributes)
  const signature = sign('sha256', info, privateKey)                                    // DER ECDSA signature
  return seq(info, seq(oid('1.2.840.10045.4.3.2')), tlv(0x03, Buffer.concat([Buffer.from([0]), signature])))
}

// --- keys ---------------------------------------------------------------------------

function loadOrCreateKey(file) {
  if (existsSync(file)) return createPrivateKey(readFileSync(file))
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  return privateKey
}

function jwkOf(privateKey) {
  const { crv, kty, x, y } = privateKey.export({ format: 'jwk' })
  return { crv, kty, x, y } // members in lexicographic order, as RFC 7638 requires for the thumbprint
}

// --- client --------------------------------------------------------------------------

export function createAcme({ domain, email, directory = LETS_ENCRYPT, dir, log = () => {} }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const accountKey = loadOrCreateKey(join(dir, 'account.key.pem'))
  const jwk = jwkOf(accountKey)
  const thumbprint = b64u(createHash('sha256').update(JSON.stringify(jwk)).digest())
  const certFile = join(dir, `${domain}.crt.pem`)
  const keyFile = join(dir, `${domain}.key.pem`)
  const tokens = new Map() // token -> key authorization, while a challenge is pending

  let dirCache = null
  let nonce = null
  let kid = null

  async function getDirectory() {
    if (!dirCache) {
      const res = await fetch(directory)
      if (!res.ok) throw new Error(`ACME directory ${directory}: HTTP ${res.status}`)
      dirCache = await res.json()
    }
    return dirCache
  }

  async function newNonce() {
    const res = await fetch((await getDirectory()).newNonce, { method: 'HEAD' })
    return res.headers.get('replay-nonce')
  }

  // Signed POST (JWS, ES256). payload undefined = POST-as-GET.
  async function post(url, payload, { useJwk = false, accept } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const protectedHeader = { alg: 'ES256', nonce: nonce ?? await newNonce(), url, ...(useJwk ? { jwk } : { kid }) }
      nonce = null
      const p64 = b64u(JSON.stringify(protectedHeader))
      const body64 = payload === undefined ? '' : b64u(JSON.stringify(payload))
      const sig = sign('sha256', Buffer.from(`${p64}.${body64}`), { key: accountKey, dsaEncoding: 'ieee-p1363' })
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/jose+json', ...(accept ? { Accept: accept } : {}) },
        body: JSON.stringify({ protected: p64, payload: body64, signature: b64u(sig) }),
      })
      nonce = res.headers.get('replay-nonce')
      const type = res.headers.get('content-type') ?? ''
      const body = type.includes('json') ? await res.json() : await res.text()
      if (res.ok) return { body, location: res.headers.get('location'), headers: res.headers }
      if (body?.type === 'urn:ietf:params:acme:error:badNonce') continue // retry with the fresh nonce
      throw new Error(`ACME ${url}: ${res.status} ${body?.detail ?? body}`)
    }
    throw new Error('ACME: too many bad nonces')
  }

  async function ensureAccount() {
    if (kid) return
    const { location } = await post((await getDirectory()).newAccount, {
      termsOfServiceAgreed: true,
      ...(email ? { contact: [`mailto:${email}`] } : {}),
    }, { useJwk: true })
    kid = location
  }

  async function poll(url, done, { tries = 40, delay = 1500 } = {}) {
    for (let i = 0; i < tries; i++) {
      const { body } = await post(url)
      if (done(body)) return body
      if (body.status === 'invalid') throw new Error(`ACME: ${url} is invalid: ${JSON.stringify(body.error ?? body.challenges?.find(c => c.error)?.error ?? body)}`)
      await new Promise(r => setTimeout(r, delay))
    }
    throw new Error(`ACME: timed out waiting for ${url}`)
  }

  async function issue() {
    log(`requesting a certificate for ${domain} from ${directory}`)
    await ensureAccount()
    const { body: order, location: orderUrl } = await post((await getDirectory()).newOrder, {
      identifiers: [{ type: 'dns', value: domain }],
    })
    for (const authzUrl of order.authorizations) {
      const { body: authz } = await post(authzUrl)
      if (authz.status === 'valid') continue
      const challenge = authz.challenges.find(c => c.type === 'http-01')
      if (!challenge) throw new Error('ACME: no http-01 challenge offered')
      tokens.set(challenge.token, `${challenge.token}.${thumbprint}`)
      try {
        await post(challenge.url, {})
        await poll(authzUrl, a => a.status === 'valid')
      } finally {
        tokens.delete(challenge.token)
      }
    }
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    await post(order.finalize, { csr: b64u(createCsr(domain, privateKey, publicKey)) })
    const done = await poll(orderUrl, o => o.status === 'valid' && o.certificate)
    const { body: chain } = await post(done.certificate, undefined, { accept: 'application/pem-certificate-chain' })
    const key = privateKey.export({ type: 'pkcs8', format: 'pem' })
    // (Each written whole and then renamed: a crash never leaves half a file.)
    writeFileSync(`${keyFile}.new`, key, { mode: 0o600 })
    writeFileSync(`${certFile}.new`, chain)
    renameSync(`${keyFile}.new`, keyFile)
    renameSync(`${certFile}.new`, certFile)
    log(`certificate for ${domain} issued, valid until ${new X509Certificate(chain).validTo}`)
    return { key, cert: chain }
  }

  function stored() {
    try {
      const cert = readFileSync(certFile, 'utf8')
      const key = readFileSync(keyFile, 'utf8')
      const x = new X509Certificate(cert)
      if (!x.checkHost(domain)) return null
      // (The key must be this certificate's: a crash between the two writes
      // of an older version could leave a mismatched pair.)
      if (!x.checkPrivateKey(createPrivateKey(key))) return null
      const from = Date.parse(x.validFrom)
      const to = Date.parse(x.validTo)
      return { key, cert, expires: to, renewAt: to - (to - from) * RENEW_FRACTION }
    } catch { return null }
  }

  return {
    domain,
    challenge: token => tokens.get(token) ?? null,
    // The stored certificate unless it's in the last third of its life; otherwise a new one.
    async ensureCertificate({ force = false } = {}) {
      const s = stored()
      if (s && !force && Date.now() < s.renewAt) return { key: s.key, cert: s.cert, renewed: false }
      const fresh = await issue()
      return { ...fresh, renewed: true }
    },
    storedCertificate: () => stored(),
  }
}
