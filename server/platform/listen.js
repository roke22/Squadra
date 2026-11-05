import { createServer as createHttpsServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { readFileSync, watchFile } from 'node:fs'
import { createAcme } from './acme.js'
import { join } from 'node:path'
import {
  HOST, PUBLIC_URL, PORT, VERSION, DATA_DIR, TRUST_PROXY, TLS, TLS_MODE, TLS_KEY, TLS_CERT, DOMAIN,
  ACME_EMAIL, ACME_DIRECTORY, HTTP_PORT,
} from './config.js'
import { refuseSocket, guardRequest } from './http.js'
import { ipKey, allow } from './limits.js'

export async function startListening(platform, { nowServing, handle, onUpgrade }) {
  const { TOKEN_SOURCE, SERVER_TOKEN, joinToken, SERVER_KEY, SERVER_KEY_FILE } = platform

  const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
  const servers = []

  const isNewToken = source => source.endsWith('(new)')
  function startupBanner(scheme) {
    nowServing()
    const everywhere = HOST === '0.0.0.0' || HOST === '::'
    const url = PUBLIC_URL || `${scheme}://${everywhere ? '<this-machine-ip>' : HOST}:${PORT}`
    const lines = [
      `squadra-server v${VERSION}: listening on ${scheme}://${HOST}:${PORT}${everywhere ? ' (all interfaces)' : ''} (data: ${DATA_DIR})`,
      '',
      // (The tokens themselves only the time they are made, not at every start:
      // logs are kept, and read, by more than whoever holds these.)
      ...(isNewToken(TOKEN_SOURCE)
        ? [`  Server token — admin: signs in to the dashboard. Keep it in the browser only (${TOKEN_SOURCE}). It is only shown this once:`, `    ${SERVER_TOKEN}`]
        : [`  Server token — admin: signs in to the dashboard. Keep it in the browser only. It is in ${TOKEN_SOURCE}.`]),
      '',
      `  Join token — for machines: registers new sessions, nothing else (${joinToken().source}).`,
      '  Configure each machine from Claude Code with:',
      `    /squadra:configure ${url} ${isNewToken(joinToken().source) ? joinToken().token : '<join-token>'}`,
      `  Dashboard: ${url}/`,
      '',
      `  Server key: ${SERVER_KEY.fingerprint} (${SERVER_KEY_FILE}). Machines and sessions remember it: back this`,
      '  file up with the data. Without it they refuse this server until they are added again.',
    ]
    if (TRUST_PROXY && !PUBLIC_URL) {
      lines.push('', '  ⚠️  --trust-proxy without --public-url: set the public address so enrollment commands',
        '      and machines use it (forwarded Host headers are never trusted for that).')
    }
    if (!TLS && !PUBLIC_URL && !everywhere && LOOPBACK.has(HOST)) {
      lines.push('', '  Only reachable from this machine. To serve your domain over HTTPS, start with',
        '  --domain your-domain (automatic Let\'s Encrypt certificate). See --help.')
    }
    if (!TLS && !LOOPBACK.has(HOST) && !PUBLIC_URL.startsWith('https://')) {
      lines.push('', '  ⚠️  Listening beyond this machine over plain HTTP: the server token, session secrets and',
        '      everything the dashboard shows travel unencrypted. Use --domain (built-in HTTPS),',
        '      a TLS reverse proxy (see deploy/), or a private network such as Tailscale.')
    }
    process.stderr.write(lines.join('\n') + '\n\n')
  }

  // Connections per address: at most 256 at once, room for several machines
  // behind one NAT with many sessions each (behind a trusted proxy all come
  // from it, so then none is counted). A connection idle for 2 minutes is
  // closed (long polls answer within 50 s, the dashboard's stream pings every
  // 20 s, and WebSockets turn this off for themselves).
  const connectionsByIp = new Map()
  function listen(srv, port, host) {
    // A malformed request only closes its own connection.
    srv.on('clientError', (err, socket) => refuseSocket(socket, '400 Bad Request'))
    srv.timeout = 120_000
    srv.on('connection', socket => {
      if (TRUST_PROXY) return
      const ip = ipKey(socket.remoteAddress)
      const n = (connectionsByIp.get(ip) ?? 0) + 1
      connectionsByIp.set(ip, n)
      socket.once('close', () => { const m = (connectionsByIp.get(ip) ?? 1) - 1; if (m > 0) connectionsByIp.set(ip, m); else connectionsByIp.delete(ip) })
      if (n > 256) {
        // (Said in the log, at most once a minute: behind a tunnel or proxy
        // without --trust-proxy every client shares one address.)
        if (allow('conn-cap-log', 'all', 1)) process.stderr.write(`squadra-server: ${ip} has 256 connections open: refusing more (behind a reverse proxy or tunnel? start with --trust-proxy)\n`)
        socket.destroy()
      }
    })
    return new Promise((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(port, host, () => { srv.off('error', reject); resolve() })
    })
  }

  function failListen(err, port) {
    const hint = err.code === 'EACCES' && port < 1024
      ? ` Ports below 1024 need privileges: run as root, grant it with "sudo setcap cap_net_bind_service=+ep $(command -v node)", or use Docker with -p ${port}:${port}.`
      : err.code === 'EADDRINUSE' ? ' Something else is already using that port.' : ''
    process.stderr.write(`squadra-server: cannot listen on port ${port}: ${err.message}.${hint}\n`)
    process.exit(1)
  }

  function httpsServer(creds) {
    const srv = createHttpsServer({ key: creds.key, cert: creds.cert }, handle)
    srv.requestTimeout = 0 // long polls and big uploads manage their own limits
    srv.on('upgrade', onUpgrade)
    servers.push(srv)
    return srv
  }

  if (TLS_MODE === 'http') {
    const srv = createHttpServer(handle)
    srv.requestTimeout = 0
    srv.on('upgrade', onUpgrade)
    servers.push(srv)
    listen(srv, PORT, HOST).then(() => startupBanner('http'), err => failListen(err, PORT))
  } else if (TLS_MODE === 'files') {
    const read = () => ({ key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) })
    let creds
    try { creds = read() } catch (err) {
      process.stderr.write(`squadra-server: cannot read the certificate: ${err.message}\n`)
      process.exit(2)
    }
    const srv = httpsServer(creds)
    listen(srv, PORT, HOST).then(() => startupBanner('https'), err => failListen(err, PORT))
    // Renewed by certbot or similar: pick the new files up without restarting.
    for (const f of [TLS_CERT, TLS_KEY]) {
      watchFile(f, { interval: 60_000 }, () => {
        try { srv.setSecureContext(read()); process.stderr.write('squadra-server: certificate reloaded\n') }
        catch (err) { process.stderr.write(`squadra-server: certificate reload failed: ${err.message}\n`) }
      }).unref?.()
    }
  } else {
    // Automatic certificate. Port 80 answers ACME challenges and redirects
    // everything else to HTTPS; HTTPS starts as soon as a certificate is ready.
    const acme = createAcme({
      domain: DOMAIN,
      email: ACME_EMAIL,
      directory: ACME_DIRECTORY,
      dir: join(DATA_DIR, 'tls'),
      log: m => process.stderr.write(`squadra-server: ${m}\n`),
    })
    const challengeServer = createHttpServer((req, res) => {
      if (!guardRequest(req, res)) return
      const m = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(req.url ?? '')
      if (m) {
        const answer = acme.challenge(m[1])
        res.writeHead(answer ? 200 : 404, { 'Content-Type': 'text/plain' })
        return res.end(answer ?? 'not found')
      }
      res.writeHead(301, { Location: `${PUBLIC_URL}${req.url ?? '/'}` })
      res.end()
    })
    servers.push(challengeServer)
    await listen(challengeServer, HTTP_PORT, HOST).catch(err => failListen(err, HTTP_PORT))

    let https = null
    const obtain = async () => {
      for (let attempt = 1; ; attempt++) {
        try { return await acme.ensureCertificate() } catch (err) {
          const delay = Math.min(60_000 * attempt, 30 * 60_000)
          process.stderr.write(`squadra-server: could not get a certificate for ${DOMAIN}: ${err.message}\n` +
            `  Check that the domain's DNS points to this machine and that port ${HTTP_PORT} is reachable from the internet. Retrying in ${delay / 60_000} min.\n`)
          await new Promise(r => setTimeout(r, delay))
        }
      }
    }
    // A stored certificate that is still valid is served right away, even if
    // it is due for renewal: renewing (below) must not keep HTTPS down while
    // the certificate authority can't be reached.
    const kept = acme.storedCertificate()
    const creds = kept && Date.now() < kept.expires - 60_000 ? kept : await obtain()
    https = httpsServer(creds)
    await listen(https, PORT, HOST).catch(err => failListen(err, PORT))
    startupBanner('https')
    if (creds === kept && Date.now() >= kept.renewAt) {
      acme.ensureCertificate().then(c => { if (c.renewed) { https.setSecureContext({ key: c.key, cert: c.cert }); process.stderr.write('squadra-server: certificate renewed\n') } },
        err => process.stderr.write(`squadra-server: certificate renewal failed (will retry): ${err.message}\n`))
    }
    // Check twice a day; renew 30 days before expiry and swap it in live.
    setInterval(async () => {
      try {
        const c = await acme.ensureCertificate()
        if (c.renewed) { https.setSecureContext({ key: c.key, cert: c.cert }); process.stderr.write('squadra-server: certificate renewed\n') }
      } catch (err) {
        process.stderr.write(`squadra-server: certificate renewal failed (will retry): ${err.message}\n`)
      }
    }, 12 * 60 * 60 * 1000).unref()
  }

  return { servers }
}
