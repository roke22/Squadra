/**
 * Live observation of a Claude Code session for Squadra dashboard.
 *
 * Two sources:
 *  - Hook events, forwarded by hook.js over a unix socket: prompts, tool
 *    start/end, notifications, turn end, compaction. Immediate.
 *  - The session transcript (JSONL), tailed as it grows: Claude's own text and
 *    token usage. One entry per completed assistant message.
 *
 * Levels:
 *  - off:       nothing is sent.
 *  - activity:  what the session is doing (tool names and short arguments,
 *               state changes, context size). No Claude text, no tool output.
 *  - full:      plus Claude's text, prompts in full, tool inputs and outputs
 *               (trimmed).
 * Obvious secrets (API keys, tokens, passwords) are masked in everything sent.
 */

import { createServer } from 'node:net'
import { mkdirSync, rmSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { relative, isAbsolute, dirname } from 'node:path'

export const LEVELS = ['off', 'activity', 'full']

// Older Spanish names keep working.
const ALIASES = { actividad: 'activity', completo: 'full' }
export function normalizeLevel(v) {
  if (v == null || v === '') return null
  const l = String(v).toLowerCase()
  const n = ALIASES[l] ?? l
  return LEVELS.includes(n) ? n : null
}

const LIMITS = {
  activity: { summary: 200, prompt: 200, detail: 0, text: 0 },
  full: { summary: 400, prompt: 4000, detail: 2000, text: 8000 },
  off: { summary: 0, prompt: 0, detail: 0, text: 0 }, // (nothing is sent; this only keeps the handlers from throwing)
}

// --- redaction ----------------------------------------------------------------

// Every quantifier is bounded, so no input can make these run long (ReDoS).
const SECRET_PATTERNS = [
  /\b(sk-(?=[A-Za-z_-]{0,300}\d)[A-Za-z0-9_-]{16,300})/g, // Anthropic/OpenAI style keys (they have digits)
  /\b(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g,
  /\b((?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16})\b/g, // AWS key ids
  /\b(AIza[0-9A-Za-z_-]{35})/g,                        // Google API key
  /\b((?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,200})/g, // Stripe
  /\b(xox[abprs]-[A-Za-z0-9-]{10,200})/g,              // Slack
  /\b(npm_[A-Za-z0-9]{30,100}|glpat-[A-Za-z0-9_-]{20,100})/g, // npm, GitLab
  /\b(hf_[A-Za-z0-9]{30,100}|SG\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{16,128})/g, // Hugging Face, SendGrid
  /\b(eyJ[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096})/g, // JWT
  /\b((?:sq|sw|sh|sj)_[A-Za-z0-9_-]{20,100})/g,        // Squadra secrets (identity, host, join)
  /\b(ya29\.[A-Za-z0-9_-]{20,2000})/g,                 // Google OAuth access tokens
  /\b(\d{6,12}:AA[A-Za-z0-9_-]{30,40})\b/g,            // Telegram bot tokens
  /([?&]sig=)[A-Za-z0-9%+/=]{20,500}/g,                 // Azure SAS signatures
  /\b(dop_v1_[a-f0-9]{40,100}|pypi-AgE[A-Za-z0-9_-]{30,300}|glsa_[A-Za-z0-9_]{20,100})/g, // DigitalOcean, PyPI, Grafana
  /(AccountKey=)[A-Za-z0-9+/=]{20,200}/g,               // Azure storage connection strings
  /(https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9/]{10,200}/g, // Slack webhooks
  /(https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/)[A-Za-z0-9/_-]{10,200}/g, // Discord webhooks
]
// Private keys, whole block (or up to the end when the output is cut).
const PEM = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY( BLOCK)?-----[\s\S]{0,20000}?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY( BLOCK)?-----|$)|PuTTY-User-Key-File-[\s\S]{0,20000}?(?:Private-MAC: [0-9a-f]{0,128}|$)/g
// user:password@ in URLs (postgres://, https://, …).
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)([^\s:/@]{1,200}):([^\s@/]{1,200})@/gi
// NAME=value where the name mentions a secret, with any prefix or suffix:
// password=…, DB_PASSWORD=…, SQUADRA_SERVER_TOKEN=…, AWS_SECRET_ACCESS_KEY=…
const KEY_VALUE = /(?<![A-Za-z0-9])([A-Za-z0-9_.-]{0,40}?(?:password|passwd|passphrase|pwd|pw|pass|secret|hmac|token|api[_-]?key|access[_-]?key|private[_-]?key|signing[_-]?key|license[_-]?key|account[_-]?key|authorization|credentials?|auth|cookie|contrase(?:ñ|n)a|clave)[A-Za-z0-9_.-]{0,40})(["']?\s{0,5}[:=]\s{0,5})("[^"\n]{1,500}"|'[^'\n]{1,500}'|[^\s"',;]{4,500})/gi
const BEARER = /\b(Bearer|bearer|BEARER|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,1000}/g
// Secrets in command lines: --password x, --token=x, mysql -pX, curl -u user:pass.
const CLI_FLAGS = /(--(?:password|passwd|token|secret|api-?key|access-?key|auth)(?:=|\s+))(["']?)[^\s"']{3,500}\2/gi
const CLI_SHORT = /(\bmysql(?:dump)?\b[^\n|;&]{0,200}?\s-p)([^\s]{3,200})|(\bcurl\b[^\n|;&]{0,200}?\s(?:-u|--user)\s+)([^\s:]{1,100}):([^\s]{1,200})/gi
// netrc lines, sshpass -p X, openssl -pass pass:X / -k X, docker/az/mongosh
// -p X, redis-cli -a X, htpasswd -b file user X, smbclient -U user%X,
// wget --http-password X, mysqldump -p X, kubectl --from-literal=k=X.
const OTHER_CLI = /(\bmachine\s+\S{1,200}\s+login\s+\S{1,200}\s+password\s+|\bsshpass\s+-p\s*|\s-pass(?:in|out)?\s+pass:|\bopenssl\b[^\n|;&]{0,200}?\s-k\s+|\b(?:docker|podman)\s+login\b[^\n|;&]{0,200}?\s(?:-p|--password)\s+|\baz\s+login\b[^\n|;&]{0,200}?\s-p\s+|\bmongo(?:sh)?\b[^\n|;&]{0,200}?\s-p\s+|\bredis-cli\b[^\n|;&]{0,200}?\s-a\s+|\bhtpasswd\s+-b\w*\s+\S{1,200}\s+\S{1,200}\s+|\bsmbclient\b[^\n|;&]{0,200}?\s-U\s+[^\s%]{1,100}%|--http-password[=\s]+|\bmysql(?:dump)?\b[^\n|;&]{0,200}?\s-p\s+|--from-literal=[^=\s]{1,100}=)([^\s'"]{1,500})/gi
// Cookie headers.
const COOKIE = /\b((?:Set-)?Cookie:\s{0,5})[^\n]{1,4000}/gi

// The text is cut before matching: what is sent is clipped well below this.
const REDACT_MAX = 25_000
export function redact(text) {
  if (typeof text !== 'string' || !text) return text
  let out = text.length > REDACT_MAX ? text.slice(0, REDACT_MAX) : text
  out = out.replace(PEM, '[REDACTED PRIVATE KEY]')
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]')
  out = out.replace(URL_CREDENTIALS, '$1$2:[REDACTED]@')
  out = out.replace(BEARER, '$1 [REDACTED]')
  out = out.replace(COOKIE, '$1[REDACTED]')
  out = out.replace(CLI_FLAGS, '$1[REDACTED]')
  out = out.replace(OTHER_CLI, '$1[REDACTED]')
  out = out.replace(CLI_SHORT, (m, a, _p, c, user) => (a ? `${a}[REDACTED]` : `${c}${user}:[REDACTED]`))
  out = out.replace(KEY_VALUE, (_, k, sep) => `${k}${sep}[REDACTED]`)
  return out
}

// A tool's input, masked value by value before it becomes JSON text (once
// quoted inside JSON, "password": "x" reads \"password\": \"x\", which the
// patterns can't see): every string as text, and a string or number under a
// secret-looking key (a string) as a whole. `mask` is redact or maskOutgoing's text.
const SECRET_KEY = /^(?:[A-Za-z0-9_.-]{0,40}?(?:password|passwd|passphrase|(?<![A-Za-z])(?:pw|pwd|pass|hmac)(?![a-z])|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|signing[_-]?key|account[_-]?key|credentials?|authorization|cookie|contrase(?:ñ|n)a|clave))[A-Za-z0-9_.-]{0,40}$/i
export function maskDeep(value, mask, depth = 0) {
  let masked = 0
  const walk = (v, d) => {
    if (typeof v === 'string') { const r = mask(v); if (r !== v) masked++; return r }
    if (!v || typeof v !== 'object' || d > 20) return v
    if (Array.isArray(v)) return v.map(x => walk(x, d + 1))
    const out = Object.create(null) // ("__proto__" is a field like any other here)
    for (const [k, x] of Object.entries(v)) {
      // (Counts of tokens — max_tokens, tokens — aren't secrets; a number
      // under a password, secret or PIN key is.)
      const secretKey = SECRET_KEY.test(k) && !/tokens$/i.test(k)
      const numberSecret = typeof x === 'number' && Number.isFinite(x) && /pass|secret|^pin$|[_-]pin$/i.test(k) && String(x).length >= 4
      if ((secretKey && typeof x === 'string' && x.length >= 4 && !/^\[REDACTED/.test(x)) || numberSecret) { masked++; out[k] = '[REDACTED]' } else out[k] = walk(x, d + 1)
    }
    return out
  }
  return { value: walk(value, depth), masked }
}

// For text a session sends to others (reply, edit): only what is clearly a
// secret — known key formats, private keys, passwords in URLs, Authorization
// values, and NAME=value / NAME: value where the value looks like a secret
// (no spaces, brackets or code). Ordinary code such as
// `const token = getToken(req)` stays as written. The whole text is checked.
const OUT_KEY_VALUE = /(?<![A-Za-z0-9])([A-Za-z0-9_.-]{0,40}?(?:password|passwd|passphrase|(?<![A-Za-z])(?:pw|pwd|pass|hmac)(?![a-z])|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key|credentials?)[A-Za-z0-9_.-]{0,40})(["']?\s{0,5}[:=]\s{0,5})(["']?)([A-Za-z0-9+/_~.@#$%^&*!-]{8,500})\3(?![A-Za-z0-9(])/gi
const NOT_SECRET = /^(true|false|null|none|undefined|required|optional|string|number|boolean|redacted|\[redacted\]|example|changeme|xxx+|\*+)$/i
export function maskOutgoing(text) {
  if (typeof text !== 'string' || !text) return { text, masked: 0 }
  let masked = 0
  const count = f => (...a) => { masked++; return f(...a) }
  let out = text.replace(PEM, count(() => '[REDACTED PRIVATE KEY]'))
  for (const re of SECRET_PATTERNS) out = out.replace(re, count(() => '[REDACTED]'))
  out = out.replace(URL_CREDENTIALS, count((_, a, b) => `${a}${b}:[REDACTED]@`))
  out = out.replace(BEARER, count((_, k) => `${k} [REDACTED]`))
  out = out.replace(OUT_KEY_VALUE, (m, k, sep, q, v) => {
    // A secret has letters and digits; names in code don't (process.env.API_KEY,
    // os.environ["X"], my-tls-secret, /auth/reset-password).
    if (NOT_SECRET.test(v) || !/\d/.test(v) || !/[A-Za-z]/.test(v) || (!q && /^[/#]/.test(v))) return m
    masked++
    return `${k}${sep}${q}[REDACTED]${q}`
  })
  return { text: out, masked }
}

// Commands and files whose content is likely to be secrets: their output (or,
// for writes, their content) is not sent at all, whatever the level.
const SECRET_FILE = /(^|[\/\s'"=~<])(\.env(\.[\w.*?{},-]{0,40})?|\.envrc|id_(rsa|dsa|ecdsa|ed25519)[\w.-]{0,20}|[\w.-]{1,100}\.(pem|key|p12|pfx|tfvars|tfstate)|\.netrc|\.git-credentials|\.git\/config|\.npmrc|\.pypirc|\.pgpass|\.vault-token|[\w.-]{0,60}credentials(\.(json|ya?ml|toml|ini|csv|txt|xml|conf|cfg|env|enc))?|\.aws\/|\.ssh\/|\.kube\/config|\.docker\/config\.json|[\w-]{0,60}secrets?\.(json|ya?ml|toml|ini|txt|env|enc|conf|cfg|properties|xml)|\.claude\.json|\.claude\/settings\.local\.json|\.yarnrc\.yml|\.htpasswd|wp-config\.php|\.gitconfig|[\w.-]{0,40}_history|\.local\/share\/keyrings\/|\.password-store\/|\/proc\/[\w]{1,10}\/environ|vault\.ya?ml|master\.key|[\w.-]{1,100}\.(asc|gpg|ppk|ovpn)|\.my\.cnf|\.s3cfg|\.boto|auth\.json|rclone\.conf|\.terraformrc|\.secrets|client_secret[\w.-]{0,120}\.json|[\w.-]{1,60}\.env|\.dev\.vars|kubeconfig|[\w.-]{1,60}\.p8|service[-_]?account[\w.-]{0,40}\.json|channels\/squadra\/[^\s'";|&)]{0,200}identity\.json)(?=$|[\s'";|&)*?[{,>:`$~\\/])/i
const SECRET_COMMAND = /(^|[\s;|&(])(printenv|env|set|export|export\s+-p|declare\s+-[xp])(?=\s*($|[;|&)>]))|(^|[\s;|&(])printenv\s|\/proc\/[^\s\/]{1,20}\/environ|\bprocess\.env\b|\bos\.environ\b|\bENV\b\s*\[|\bps\s+[a-z-]{0,10}e[a-z]{0,10}w|\becho\s[^\n;|&]{0,200}\$\{?[A-Za-z0-9_]{0,40}(SECRET|TOKEN|PASS|KEY|PWD)|\b(op|bw)\s+(item\s+)?get\b|\bpass\s+show\b|\bkeyring\s+get\b|\bgit\s+credential\b|\bgh\s+auth\s+status\b[^\n]{0,100}--show-token|\bgcloud\s+auth\s+(print-access-token|print-identity-token|application-default\s+print-access-token)\b|\baz\s+account\s+get-access-token\b|\baws\s+(sts\s+get-session-token|configure\s+(export-credentials|list)|ecr\s+get-login-password)\b|\bgit\s+config\b[^\n]{0,100}remote\.[^\n\s]{1,100}\.url|\bkubectl\s+config\s+view\b|\bterraform\s+(output|show)\b|\bsops\s+(-d|--decrypt)\b|\bansible-vault\s+(view|decrypt)\b|\bdirenv\s+export\b|\bnpm\s+config\s+get\s+[^\n]{0,100}_auth|\bsecurity\s+find-[a-z-]{1,40}password\b|\bgpg\b[^\n]{0,200}--export-secret|\bkubectl\s+get\s+secrets?\b|\bgh\s+auth\s+token\b|\baws\s+configure\s+get\b|\bdocker\s+inspect\b|\bsource\s+[^\s;|&]*\.env/i
// Folders whose files are all secrets (keyrings, password stores, keys).
const SECRET_DIR = /(^|[\/\s'"=~])(\.local\/share\/keyrings|secrets|\.secrets|run\/secrets|\.config\/gh|\.config\/squadra-host|\.password-store|\.gnupg|\.ssh|\.aws|\.azure|\.config\/gcloud|Library\/Keychains)\//i
// Whose output may hold secrets: what touchesSecrets says, plus output read
// later from a background shell (which command it was isn't known here) and
// shell-like MCP tools, judged by their command as Bash would be.
function outputMaySecrets(tool, toolInput) {
  if (/^(BashOutput|TaskOutput)$/.test(tool)) return true
  const i = toolInput && typeof toolInput === 'object' ? toolInput : {}
  if (/^mcp__/.test(tool) && /shell|exec|terminal|bash|command|run/i.test(tool)) {
    // (Every string in its input, whatever the field is called: args, argv…)
    const strings = []
    const walk = (v, d) => { if (strings.length > 200 || d > 10) return; if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, d + 1) }
    walk(i, 0)
    return !strings.length || strings.length > 200 || strings.some(cmd => touchesSecrets('Bash', { command: cmd }))
  }
  return touchesSecrets(tool, toolInput)
}
export function touchesSecrets(tool, toolInput) {
  const i = toolInput && typeof toolInput === 'object' ? toolInput : {}
  if (tool === 'Bash') {
    const cmd = String(i.command ?? '').slice(0, 10_000)
    return SECRET_FILE.test(cmd) || SECRET_DIR.test(cmd) || SECRET_COMMAND.test(cmd)
  }
  const path = String(i.file_path ?? i.notebook_path ?? i.path ?? '').slice(0, 4096)
  // Grep and Glob also by their pattern (".env*", "**/*.pem").
  const glob = String(i.glob ?? i.pattern ?? '').slice(0, 4096)
  // (Glob characters read as letters: "*.pem" is a key file name.)
  const hit = v => v !== '' && [v, ' ' + v.replace(/[*?{}[\]]/g, 'x')].some(x => SECRET_FILE.test(x) || SECRET_DIR.test(x))
  return hit(path) || ((tool === 'Grep' || tool === 'Glob') && hit(glob))
}

function clip(text, max) {
  if (typeof text !== 'string') return text
  if (!max) return undefined
  return text.length > max ? `${text.slice(0, max)}… (+${text.length - max})` : text
}

// Keep the start and the end of long outputs: errors are usually at the end.
function clipMiddle(text, max) {
  if (typeof text !== 'string' || !max) return undefined
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n… (${text.length - max} characters omitted) …\n${text.slice(-half)}`
}

// --- tool summaries -----------------------------------------------------------

function rel(path, cwd) {
  if (typeof path !== 'string') return path
  if (cwd && isAbsolute(path)) {
    const r = relative(cwd, path)
    if (r && !r.startsWith('..')) return r
  }
  return path
}

const lines = s => (typeof s === 'string' && s ? s.split('\n').length : 0)

export function summarizeTool(name, input = {}, cwd) {
  const i = input ?? {}
  switch (name) {
    case 'Bash': return String(i.command ?? '').split('\n')[0]
    case 'Read': return rel(i.file_path, cwd) + (i.offset ? ` (from line ${i.offset})` : '')
    case 'Write': return `${rel(i.file_path, cwd)} (${lines(i.content)} lines)`
    case 'Edit': return `${rel(i.file_path, cwd)} (+${lines(i.new_string)} −${lines(i.old_string)})`
    case 'MultiEdit': return `${rel(i.file_path, cwd)} (${(i.edits ?? []).length} edits)`
    case 'NotebookEdit': return rel(i.notebook_path, cwd)
    case 'Grep': return `"${i.pattern ?? ''}"${i.path ? ` in ${rel(i.path, cwd)}` : ''}${i.glob ? ` (${i.glob})` : ''}`
    case 'Glob': return `${i.pattern ?? ''}${i.path ? ` in ${rel(i.path, cwd)}` : ''}`
    case 'WebFetch': return String(i.url ?? '')
    case 'WebSearch': return String(i.query ?? '')
    case 'Task':
    case 'Agent': return `${i.subagent_type ?? 'agente'}: ${i.description ?? ''}`
    case 'TodoWrite': return `${(i.todos ?? []).length} todos`
    case 'Skill': return String(i.skill ?? i.name ?? '')
    default: {
      // MCP and anything else: first short string argument.
      const first = Object.entries(i).find(([, v]) => typeof v === 'string' && v.length < 200)
      return first ? `${first[0]}: ${first[1]}` : ''
    }
  }
}

function summarizeResult(name, response) {
  const r = response ?? {}
  if (name === 'Bash') {
    if (r.interrupted) return 'interrupted'
    const out = `${r.stdout ?? ''}`.trim()
    const n = out ? out.split('\n').length : 0
    return n ? `${n} lines of output` : 'no output'
  }
  if (typeof r === 'string') return `${r.length} characters`
  return ''
}

function resultDetail(name, response) {
  const r = response ?? {}
  if (name === 'Bash') return [r.stdout, r.stderr].filter(Boolean).join('\n--- stderr ---\n')
  if (typeof r === 'string') return r
  if (typeof r.content === 'string') return r.content
  if (Array.isArray(r.content)) return r.content.map(c => c?.text ?? '').join('\n')
  return ''
}

// --- context window -----------------------------------------------------------
//
// Claude Code compacts automatically near the model's context limit: about
// 967K tokens on the 1M-context models (Fable, Sonnet 5+, Haiku 5.5, Opus 4.7+,
// or a "[1m]" model), the 200K window otherwise. CLAUDE_CODE_AUTO_COMPACT_WINDOW
// sets an earlier point, and CLAUDE_AUTOCOMPACT_PCT_OVERRIDE a percentage of it.

export function contextWindowFor(model) {
  const m = String(model ?? '').toLowerCase()
  if (m.includes('[1m]') || m.includes('fable')) return 1_000_000
  const v = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(m)
  if (v) {
    const [, family, major, minor = '0'] = v
    const ver = Number(major) + Number(minor) / 10
    if (family === 'opus' && ver >= 4.7) return 1_000_000
    if ((family === 'sonnet' || family === 'haiku') && ver >= 5) return 1_000_000
  }
  return 200_000
}

export function compactPointFor(model, env = process.env) {
  const window = contextWindowFor(model)
  let point = window === 1_000_000 ? 967_000 : window
  const override = Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  if (Number.isInteger(override) && override > 0) point = Math.min(override, window)
  const pct = Number(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)
  if (pct > 0 && pct <= 100) point = Math.round(point * pct / 100)
  return { window, point }
}

// --- observer -----------------------------------------------------------------

// contextProvider(source): text (or a promise of it) to give Claude right
// after a compaction or a /clear (source "compact" or "clear", from the
// SessionStart hook), or with a prompt ("prompt", from UserPromptSubmit),
// asked for through the same socket.
// onToolInput(tool, input): the exact input of each tool call, at every level
// (kept in memory by the plugin to show the coordinator exactly what will run).
// onPrompt(prompt): each prompt about to be sent, whole (a worker's tasks start).
// stopCheck(active): when the turn is about to end, a reason to go on, or ''
// (asked for by the Stop hook through the same socket).
export function createObserver({ level = 'full', send, log = () => {}, contextProvider = () => '', onToolInput = null, onPrompt = null, stopCheck = null }) {
  level = normalizeLevel(level) ?? 'full'
  const limits = LIMITS[level]
  let server = null
  let socketPath = null
  let outbox = []
  let flushing = false
  let flushTimer = null
  let tail = null // { path, offset, rest, timer }
  let cwd = process.cwd()
  let stopped = false

  const push = ev => {
    if (stopped || level === 'off') return
    outbox.push(ev)
    if (outbox.length > 2000) outbox = outbox.slice(-2000) // server unreachable for long: keep the latest
  }

  async function flush() {
    if (flushing || outbox.length === 0) return
    flushing = true
    const batch = outbox.slice(0, 200)
    try {
      await send(batch)
      outbox = outbox.slice(batch.length)
    } catch (err) {
      log(`observe: send failed (${err.message}), will retry`)
    } finally {
      flushing = false
    }
  }

  // --- transcript tail -------------------------------------------------------

  function setTranscript(path) {
    if (!path || tail?.path === path || !existsSync(path)) return
    if (tail) clearInterval(tail.timer)
    let offset = 0
    // Start at the current end: this is a live view, not a replay.
    try { offset = statSync(path).size } catch {}
    tail = { path, offset, rest: '', timer: setInterval(readTail, 700) }
  }

  function readTail() {
    if (!tail) return
    let size
    try { size = statSync(tail.path).size } catch { return }
    if (size < tail.offset) tail.offset = 0 // rewritten
    if (size === tail.offset) return
    const len = Math.min(size - tail.offset, 4 * 1024 * 1024)
    const buf = Buffer.alloc(len)
    let fd
    try {
      fd = openSync(tail.path, 'r')
      readSync(fd, buf, 0, len, tail.offset)
    } catch { return } finally { if (fd !== undefined) closeSync(fd) }
    tail.offset += len
    const chunk = tail.rest + buf.toString('utf8')
    const parts = chunk.split('\n')
    tail.rest = parts.pop() ?? ''
    for (const line of parts) {
      if (!line.trim()) continue
      let entry
      try { entry = JSON.parse(line) } catch { continue }
      onTranscriptEntry(entry)
    }
  }

  function onTranscriptEntry(e) {
    if (e.type !== 'assistant' || e.isSidechain || !e.message) return
    const ts = Date.parse(e.timestamp) || Date.now()
    const usage = e.message.usage
    if (usage) {
      const context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      if (context > 0) {
        const { window, point } = compactPointFor(e.message.model)
        push({ ts, kind: 'usage', context_tokens: context, model: e.message.model, context_window: window, compact_at: point, context_pct: Math.min(100, Math.round(context / point * 100)) })
      }
    }
    if (!limits.text) return
    for (const block of e.message.content ?? []) {
      if (block?.type === 'text' && block.text?.trim()) {
        push({ ts, kind: 'text', text: clip(redact(block.text.trim()), limits.text) })
      }
    }
  }

  // --- hook events -----------------------------------------------------------

  function onHook({ ts, input }) {
    if (!input || typeof input !== 'object') return
    if (input.hook_event_name === 'PreToolUse' && onToolInput) { try { onToolInput(String(input.tool_name ?? ''), input.tool_input) } catch {} }
    // Claude Code's working directory (it can change during a session).
    const cwdChanged = typeof input.cwd === 'string' && input.cwd !== cwd
    if (cwdChanged) cwd = input.cwd
    if (input.transcript_path && !input.agent_id) setTranscript(input.transcript_path)
    const base = {
      ts: Number(ts) || Date.now(),
      ...(input.agent_type ? { agent: String(input.agent_type) } : {}),
      ...(cwdChanged ? { cwd } : {}),
    }

    switch (input.hook_event_name) {
      case 'SessionStart':
        return push({ ...base, kind: 'session_start', source: input.source, model: input.model, cwd })
      case 'UserPromptSubmit': {
        const prompt = String(input.prompt ?? '')
        try { onPrompt?.(prompt) } catch (err) { log(`observe: prompt callback failed: ${err.message}`) }
        // A turn started by a channel message: the dashboard already shows the
        // message itself.
        const fromChannel = /^\s*<channel\b/.test(prompt)
        return push({ ...base, kind: 'prompt', ...(fromChannel ? { channel: true } : {}), text: clip(redact(prompt), limits.prompt) })
      }
      case 'PreToolUse': {
        const tool = String(input.tool_name ?? '')
        // A command or file that touches secrets: only what it is (the
        // command's name, the tool), never its arguments or content.
        const secret = touchesSecrets(tool, input.tool_input)
        // (Not even the command's name: a quoted value before it could split into it.)
        const summary = secret && tool === 'Bash'
          ? 'command … (touches secrets: not shown)'
          : summarizeTool(tool, input.tool_input, cwd)
        return push({
          ...base,
          kind: 'tool_start',
          id: input.tool_use_id,
          tool,
          summary: clip(redact(summary), limits.summary),
          ...(limits.detail && !secret ? { detail: clip(redact(JSON.stringify(maskDeep(input.tool_input ?? {}, redact).value, null, 2)), limits.detail) } : {}),
        })
      }
      case 'PostToolUse': {
        const tool = String(input.tool_name ?? '')
        return push({
          ...base,
          kind: 'tool_end',
          id: input.tool_use_id,
          tool,
          ok: true,
          summary: summarizeResult(tool, input.tool_response),
          ...(input.duration_ms != null ? { duration_ms: input.duration_ms } : {}),
          ...(limits.detail
            ? { detail: outputMaySecrets(tool, input.tool_input) ? '(output not sent: this command or file may contain secrets)' : clipMiddle(redact(resultDetail(tool, input.tool_response)), limits.detail) }
            : {}),
        })
      }
      case 'PostToolUseFailure': {
        const error = String(input.error ?? '')
        return push({
          ...base,
          kind: 'tool_end',
          id: input.tool_use_id,
          tool: String(input.tool_name ?? ''),
          ok: false,
          interrupted: input.is_interrupt === true,
          summary: outputMaySecrets(String(input.tool_name ?? ''), input.tool_input) ? '(error not shown: the command may touch secrets)' : clip(redact(error.split('\n')[0]), 200),
          ...(input.duration_ms != null ? { duration_ms: input.duration_ms } : {}),
          ...(limits.detail && !outputMaySecrets(String(input.tool_name ?? ''), input.tool_input) ? { detail: clipMiddle(redact(error), limits.detail) } : {}),
        })
      }
      case 'Notification':
        return push({ ...base, kind: 'notification', type: input.notification_type, text: clip(redact(String(input.message ?? '')), 300) })
      case 'SubagentStart':
        return push({ ...base, kind: 'subagent_start', id: input.agent_id })
      case 'SubagentStop':
        return push({
          ...base,
          kind: 'subagent_stop',
          id: input.agent_id,
          ...(limits.text ? { text: clip(redact(String(input.last_assistant_message ?? '')), limits.text) } : {}),
        })
      case 'Stop':
        // The final text already arrives from the transcript; read it once more
        // so it shows before the turn closes.
        readTail()
        return push({ ...base, kind: 'stop', background_tasks: Array.isArray(input.background_tasks) ? input.background_tasks.length : 0 })
      case 'PreCompact':
        return push({ ...base, kind: 'compact', trigger: input.trigger })
      case 'PostCompact':
        return push({
          ...base,
          kind: 'compacted',
          trigger: input.trigger,
          ...(limits.text && input.compact_summary ? { summary: clip(redact(String(input.compact_summary)), limits.text) } : {}),
        })
      case 'SessionEnd':
        return push({ ...base, kind: 'session_end', reason: input.reason })
      default:
        return undefined
    }
  }

  return {
    level,
    // The socket also serves the post-compaction context, so it runs even with
    // observation off (then hook events are simply not sent anywhere).
    start(path) {
      socketPath = path
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      try { rmSync(path, { force: true }) } catch {}
      server = createServer({ allowHalfOpen: true }, conn => {
        const chunks = []
        conn.on('data', c => chunks.push(c))
        conn.on('end', () => {
          let msg = null
          try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
          if (msg?.want === 'stop') {
            Promise.resolve().then(() => stopCheck?.(msg.active === true))
              .catch(err => { log(`observe: stop check failed: ${err.message}`); return '' })
              .then(block => conn.end(JSON.stringify({ block: typeof block === 'string' ? block : '' })))
            return
          }
          if (msg?.want === 'context') {
            // (What it is for: "compact" or "clear", the session starting
            // again; "prompt", a prompt about to be sent.)
            const source = ['clear', 'prompt'].includes(msg.source) ? msg.source : 'compact'
            Promise.resolve().then(() => contextProvider(source))
              .catch(err => { log(`observe: context provider failed: ${err.message}`); return '' })
              .then(context => conn.end(JSON.stringify({ context: typeof context === 'string' ? context : '' })))
            return
          }
          conn.end()
          if (msg) try { onHook(msg) } catch {}
        })
        conn.on('error', () => {})
      })
      server.on('error', err => log(`observe: socket error ${err.message}`))
      server.listen(path)
      flushTimer = setInterval(() => void flush(), 400)
      push({ ts: Date.now(), kind: 'observe_start', level, cwd })
    },
    async stop() {
      if (stopped) return
      readTail()
      stopped = true
      if (tail) clearInterval(tail.timer)
      clearInterval(flushTimer)
      try { server?.close() } catch {}
      if (socketPath) try { rmSync(socketPath, { force: true }) } catch {}
      await flush().catch(() => {})
    },
    // for tests
    _onHook: onHook,
  }
}
