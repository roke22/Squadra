import { parseArgs } from 'node:util'
import { LETS_ENCRYPT_STAGING, LETS_ENCRYPT } from './acme.js'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

// Command-line flags win over environment variables.
//
//   --host <ip>          interface to listen on (default 127.0.0.1: this machine only)
//   --all-interfaces     same as --host 0.0.0.0 (every IP of the machine)
//   --port <n>           default 7787
//   --public-url <url>   the address agents and browsers use, e.g. https://squadra.example.com
//                        (behind a TLS reverse proxy): the setup and enrollment commands use it, and
//                        the dashboard's terminal accepts it as its Origin
//   --trust-proxy        behind a reverse proxy: take the client's address from X-Forwarded-For
//   --data-dir <path>    default ./data
//
// HTTPS without a reverse proxy:
//   --domain <name>      get and renew a Let's Encrypt certificate automatically (needs ports 80 and 443)
//   --acme-email <addr>  contact address for Let's Encrypt (optional)
//   --acme-staging       use Let's Encrypt's staging environment (for trying it out)
//   --acme-directory <url>  another ACME server
//   --tls-cert <file> --tls-key <file>   use your own certificate (reloaded when the files change)
//   --http-port <n>      port for ACME challenges and the HTTP→HTTPS redirect (default 80)
const { values: ARGS } = (() => {
  try {
    return parseArgs({
      options: {
        host: { type: 'string' },
        'all-interfaces': { type: 'boolean' },
        port: { type: 'string' },
        'public-url': { type: 'string' },
        'data-dir': { type: 'string' },
        domain: { type: 'string' },
        'acme-email': { type: 'string' },
        'acme-staging': { type: 'boolean' },
        'acme-directory': { type: 'string' },
        'tls-cert': { type: 'string' },
        'tls-key': { type: 'string' },
        'http-port': { type: 'string' },
        'trust-proxy': { type: 'boolean' },
        'allow-token-api': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (err) {
    process.stderr.write(`squadra-server: ${err.message}\nRun with --help to see the options.\n`)
    process.exit(2)
  }
})()

if (ARGS.help) {
  process.stdout.write(`Usage: node server.js [options]

  --host <ip>          Interface to listen on (default 127.0.0.1: this machine only). Env: HOST
  --all-interfaces     Listen on every IP of the machine (same as --host 0.0.0.0)
  --port <n>           Port (default 7787). Env: PORT
  --public-url <url>   Public address, e.g. https://squadra.example.com. Env: PUBLIC_URL
  --data-dir <path>    Database and files (default ./data). Env: DATA_DIR

HTTPS, built in (no reverse proxy needed):
  --domain <name>      Get and renew a Let's Encrypt certificate automatically. Env: SQUADRA_DOMAIN
                       Needs the domain's DNS pointing here and ports 80 and 443 reachable.
  --acme-email <addr>  Contact address for Let's Encrypt (optional). Env: ACME_EMAIL
  --acme-staging       Use Let's Encrypt staging (test certificates, higher limits)
  --acme-directory <url>  Another ACME server. Env: ACME_DIRECTORY
  --tls-cert <file>    Your own certificate (PEM, full chain). Env: TLS_CERT
  --tls-key <file>     Its private key (PEM). Env: TLS_KEY
                       Both are reloaded automatically when the files change.
  --http-port <n>      Port for ACME challenges and the HTTP→HTTPS redirect (default 80)
  --trust-proxy        Behind a reverse proxy: take the client address from X-Forwarded-For
                       (for rate limits). Only with a proxy that sets it. Env: TRUST_PROXY=1

Accounts:
  --allow-token-api    Keep the server token working on /api once there are users, for your
                       own scripts. It acts on any company. Env: SQUADRA_ALLOW_TOKEN_API=1

With HTTPS the server listens on all interfaces and port 443 by default.

Examples:
  node server.js                                    # http://127.0.0.1:7787, this machine only
  node server.js --domain squadra.example.com       # https://squadra.example.com, automatic certificate
  node server.js --tls-cert full.pem --tls-key key.pem --public-url https://squadra.example.com
`)
  process.exit(0)
}

export const DOMAIN = (ARGS.domain ?? process.env.SQUADRA_DOMAIN ?? '').trim().toLowerCase()
export const TLS_CERT = ARGS['tls-cert'] ?? process.env.TLS_CERT ?? ''
export const TLS_KEY = ARGS['tls-key'] ?? process.env.TLS_KEY ?? ''

// 'http' (default), 'acme' (automatic Let's Encrypt) or 'files' (your own certificate)
export const TLS_MODE = DOMAIN ? 'acme' : (TLS_CERT || TLS_KEY) ? 'files' : 'http'
export const TLS = TLS_MODE !== 'http'
export const ACME_DIRECTORY = ARGS['acme-directory'] ?? process.env.ACME_DIRECTORY ?? (ARGS['acme-staging'] ? LETS_ENCRYPT_STAGING : LETS_ENCRYPT)
export const ACME_EMAIL = ARGS['acme-email'] ?? process.env.ACME_EMAIL ?? ''
export const HTTP_PORT = Number(ARGS['http-port'] ?? process.env.HTTP_PORT ?? 80)
export const TRUST_PROXY = ARGS['trust-proxy'] === true || process.env.TRUST_PROXY === '1'
export const ALLOW_TOKEN_API = ARGS['allow-token-api'] === true || process.env.SQUADRA_ALLOW_TOKEN_API === '1'

export const PORT = Number(ARGS.port ?? process.env.PORT ?? (TLS ? 443 : 7787))
export const HOST = ARGS['all-interfaces'] ? '0.0.0.0' : (ARGS.host ?? process.env.HOST ?? (TLS ? '0.0.0.0' : '127.0.0.1'))
export const DATA_DIR = ARGS['data-dir'] ?? process.env.DATA_DIR ?? join(process.cwd(), 'data')
export const PUBLIC_URL = (ARGS['public-url'] ?? process.env.PUBLIC_URL ?? (DOMAIN ? `https://${DOMAIN}${PORT === 443 ? '' : `:${PORT}`}` : '')).replace(/\/+$/, '')
for (const [label, n] of [['port', PORT], ['http port', HTTP_PORT]]) {
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    process.stderr.write(`squadra-server: invalid ${label} "${n}"\n`)
    process.exit(2)
  }
}
if (DOMAIN && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(DOMAIN)) {
  process.stderr.write(`squadra-server: invalid domain "${DOMAIN}"\n`)
  process.exit(2)
}
if (TLS_MODE === 'files' && !(TLS_CERT && TLS_KEY)) {
  process.stderr.write('squadra-server: --tls-cert and --tls-key go together\n')
  process.exit(2)
}
// (It goes into the commands the dashboard gives: nothing a shell would read.)
if (PUBLIC_URL && !/^https?:\/\/[^\s/'"`$\\&|;<>()^%!]+(\/[^\s'"`$\\&|;<>()^%!]*)?$/.test(PUBLIC_URL)) {
  process.stderr.write(`squadra-server: invalid public URL "${PUBLIC_URL}" (expected http(s)://host[:port])\n`)
  process.exit(2)
}
export const MAX_JSON_BODY = 1024 * 1024          // 1 MB
export const UI_FILE = new URL('../ui/index.html', import.meta.url)

// xterm.js for the web terminal, vendored (see vendor/README.md).
export const VENDOR_FILES = {
  '/vendor/xterm.js': ['./vendor/xterm.js', 'text/javascript; charset=utf-8'],
  '/vendor/addon-fit.js': ['./vendor/addon-fit.js', 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': ['./vendor/xterm.css', 'text/css; charset=utf-8'],
}

// Single source of truth: server/package.json.
export const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version } catch { return '0.0.0' }
})()
