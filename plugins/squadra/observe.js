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
}

// --- redaction ----------------------------------------------------------------

const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{16,})/g,                       // Anthropic/OpenAI style keys
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\b((?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16})\b/g, // AWS key ids
  /\b(AIza[0-9A-Za-z_-]{35})/g,                        // Google API key
  /\b((?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,})/g,  // Stripe
  /\b(xox[abprs]-[A-Za-z0-9-]{10,})/g,                 // Slack
  /\b(npm_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,})/g, // npm, GitLab
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, // JWT
  /\b((?:sq|sw|sh|sj)_[A-Za-z0-9_-]{20,})/g,           // Squadra secrets (identity, host, join)
]
// Private keys, whole block (or up to the end when the output is cut).
const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g
// user:password@ in URLs (postgres://, https://, …).
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi
// NAME=value where the name mentions a secret, with any prefix or suffix:
// password=…, DB_PASSWORD=…, SQUADRA_SERVER_TOKEN=…, AWS_SECRET_ACCESS_KEY=…
const KEY_VALUE = /(?<![A-Za-z0-9])([A-Za-z0-9_.-]{0,40}?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credentials?|auth)[A-Za-z0-9_.-]{0,40})(["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g

const REDACT_MAX = 100_000 // everything sent is clipped well below this anyway
export function redact(text) {
  if (typeof text !== 'string' || !text) return text
  let out = text.length > REDACT_MAX ? text.slice(0, REDACT_MAX) : text
  out = out.replace(PEM, '[REDACTED PRIVATE KEY]')
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]')
  out = out.replace(URL_CREDENTIALS, '$1$2:[REDACTED]@')
  out = out.replace(BEARER, '$1 [REDACTED]')
  out = out.replace(KEY_VALUE, (_, k, sep) => `${k}${sep}[REDACTED]`)
  return out
}

// Commands and files whose content is likely to be secrets: their output (or,
// for writes, their content) is not sent at all, whatever the level.
const SECRET_FILE = /(^|[\/\s'"=])(\.env(\.[\w.-]+)?|id_(rsa|dsa|ecdsa|ed25519)|[\w.-]+\.(pem|key|p12|pfx)|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.pgpass|credentials(\.json)?|\.aws\/|\.ssh\/|\.kube\/config)(?=$|[\s'";|&)])/i
const SECRET_COMMAND = /(^|[\s;|&(])(printenv|env|set|export\s+-p)(?=$|[\s;|&)])|\bsecurity\s+find-[a-z-]*password\b|\bgpg\b.*--export-secret|\bkubectl\s+get\s+secrets?\b/i
export function touchesSecrets(tool, toolInput) {
  const i = toolInput && typeof toolInput === 'object' ? toolInput : {}
  if (tool === 'Bash') {
    const cmd = String(i.command ?? '')
    return SECRET_FILE.test(cmd) || SECRET_COMMAND.test(cmd)
  }
  const path = String(i.file_path ?? i.notebook_path ?? i.path ?? '')
  return path !== '' && SECRET_FILE.test(path)
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

// contextProvider: () => text to give back to Claude right after a compaction
// (asked for by the SessionStart "compact" hook through the same socket).
export function createObserver({ level = 'full', send, log = () => {}, contextProvider = () => '' }) {
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
        // A turn started by a channel message: the dashboard already shows the
        // message itself.
        const fromChannel = /^\s*<channel\b/.test(prompt)
        return push({ ...base, kind: 'prompt', ...(fromChannel ? { channel: true } : {}), text: clip(redact(prompt), limits.prompt) })
      }
      case 'PreToolUse': {
        const tool = String(input.tool_name ?? '')
        return push({
          ...base,
          kind: 'tool_start',
          id: input.tool_use_id,
          tool,
          summary: clip(redact(summarizeTool(tool, input.tool_input, cwd)), limits.summary),
          // Writing a .env or a key: its content is not sent.
          ...(limits.detail && !(tool !== 'Bash' && touchesSecrets(tool, input.tool_input))
            ? { detail: clip(redact(JSON.stringify(input.tool_input ?? {}, null, 2)), limits.detail) } : {}),
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
            ? { detail: touchesSecrets(tool, input.tool_input) ? '(output not sent: this command or file may contain secrets)' : clipMiddle(redact(resultDetail(tool, input.tool_response)), limits.detail) }
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
          summary: clip(redact(error.split('\n')[0]), 200),
          ...(input.duration_ms != null ? { duration_ms: input.duration_ms } : {}),
          ...(limits.detail && !touchesSecrets(String(input.tool_name ?? ''), input.tool_input) ? { detail: clipMiddle(redact(error), limits.detail) } : {}),
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
          if (msg?.want === 'context') {
            let context = ''
            try { context = contextProvider() ?? '' } catch (err) { log(`observe: context provider failed: ${err.message}`) }
            conn.end(JSON.stringify({ context }))
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
