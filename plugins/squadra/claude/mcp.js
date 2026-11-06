// MCP over stdio (newline-delimited JSON-RPC 2.0).

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  log, VERSION, NAME_RE, DEFAULT_COORDINATOR, stateDirFor, shuttingDown, readLaunch, readApproved,
} from '../core/index.js'
import { instructionsFor, personaRule } from './instructions.js'
import { login } from './login.js'
import { TOOLS, callTool } from './tools.js'
import { onPermissionRequest } from './permissions.js'

// Ask the user to confirm, through Claude Code (MCP elicitation). Returns
// true or false, or null when this Claude Code can't ask.
let CLIENT_CAPS = {}
const clientRequests = new Map() // id -> resolve
let clientRequestSeq = 0
export function confirmWithUser(message) {
  if (!CLIENT_CAPS?.elicitation) return Promise.resolve(null)
  const id = `sq-${++clientRequestSeq}`
  return new Promise(resolve => {
    const timer = setTimeout(() => { clientRequests.delete(id); resolve(false) }, 10 * 60_000)
    clientRequests.set(id, r => {
      clearTimeout(timer)
      resolve(r?.action === 'accept' && r?.content?.confirm === true)
    })
    writeMessage({
      jsonrpc: '2.0', id, method: 'elicitation/create',
      params: {
        message: `Squadra: ${message}`,
        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Confirm', description: message } }, required: ['confirm'] },
      },
    })
  })
}

// Claude Code doesn't register a channel server that negotiates protocol
// revision 2026-07-28, so never offer it. Echo the client's version when it's
// one we know, otherwise fall back to a stable one.
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const FALLBACK_PROTOCOL = '2025-06-18'

function writeMessage(obj) {
  if (shuttingDown) return
  try {
    process.stdout.write(JSON.stringify(obj) + '\n')
  } catch (err) {
    log(`stdout write failed: ${err}`)
  }
}

function notify(method, params) {
  writeMessage({ jsonrpc: '2.0', method, params })
}

// What core asks of this agent (see core/agent.js).
export const deliver = params => notify('notifications/claude/channel', params)
export const givePermission = verdict => notify('notifications/claude/channel/permission', verdict)

async function handleRequest(msg) {
  const { id, method, params } = msg
  const respond = result => writeMessage({ jsonrpc: '2.0', id, result })
  const fail = (code, message) => writeMessage({ jsonrpc: '2.0', id, error: { code, message } })

  switch (method) {
    case 'initialize': {
      CLIENT_CAPS = params?.capabilities && typeof params.capabilities === 'object' ? params.capabilities : {}
      const requested = params?.protocolVersion
      return respond({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : FALLBACK_PROTOCOL,
        capabilities: {
          tools: {},
          experimental: {
            // Always declared: Claude Code only registers the channel when the
            // session is launched naming this plugin, and the session may log
            // in later with /squadra:login.
            'claude/channel': {},
            // Permission-relay opt-in. Declaring this asserts we authenticate the
            // replier — we do: gate() drops non-allowlisted senders before
            // handleInbound runs, and the server authenticates every sender.
            'claude/channel/permission': {},
          },
        },
        serverInfo: { name: 'squadra', version: VERSION },
        instructions: (SOLO = startsSolo()) ? '' : startupInstructions(),
      })
    }
    case 'ping':
      return respond({})
    case 'tools/list':
      return respond({ tools: SOLO ? [] : TOOLS })
    case 'tools/call': {
      const name = params?.name
      try {
        const text = await callTool(name, params?.arguments ?? {})
        return respond({ content: [{ type: 'text', text }] })
      } catch (err) {
        return respond({ content: [{ type: 'text', text: `${name} failed: ${err.message}` }], isError: true })
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`)
  }
}

let autoLoginDone = false

// A standalone session ("solo", opened from the dashboard outside any squad):
// a plain Claude Code session. No Squadra instructions and no tools; the
// plugin only logs in, so the dashboard sees what it does.
function startsSolo() {
  const name = process.env.SQUADRA_NAME
  if (!name || !NAME_RE.test(name)) return false
  return (readLaunch(name) ?? readApproved(name))?.role === 'solo'
}
let SOLO = false

// Sessions opened with SQUADRA_NAME set (for example from the dashboard, by
// squadra-host) log in on their own: tell Claude its role from the start.
// The instructions at startup: the common rules, and those of the role it
// logs in with on its own (if it does).
function startupInstructions() {
  const name = process.env.SQUADRA_NAME
  const cfg = name && NAME_RE.test(name) ? readLaunch(name) ?? readApproved(name) : null
  if (!cfg || cfg.role === 'solo') return instructionsFor(null)
  return instructionsFor(cfg.role) + '\n\nAUTOMATIC LOGIN. This session joins Squadra on its own at startup: ' +
    (cfg.role === 'coordinator'
      ? `its name is "${name}" and its role is COORDINATOR.`
      : `its name is "${name}", its role is WORKER and its coordinator is "${cfg.coordinator ?? DEFAULT_COORDINATOR}".`) +
    ' If it fails, status says why: tell the user.' +
    (cfg.persona ? `\n\n${personaRule(cfg.persona)}` : '')
}

function handleNotification(msg) {
  switch (msg.method) {
    case 'notifications/initialized':
      // SQUADRA_NAME logs in automatically. Role and coordinator come from
      // <state>/launch.json (written by squadra-host for this start) or
      // from what the user approved before — never from environment
      // variables, which a project's settings could set.
      if (!autoLoginDone && process.env.SQUADRA_NAME) {
        autoLoginDone = true
        const name = process.env.SQUADRA_NAME
        if (!NAME_RE.test(name)) { log('auto-login skipped: SQUADRA_NAME is not a valid name'); return }
        const launch = readLaunch(name)
        // launch.json is for one start: consumed here, so a later decision of
        // the user (approved) is what counts next time.
        if (launch) { try { rmSync(join(stateDirFor(name), 'launch.json'), { force: true }) } catch {} }
        const approved = launch ?? readApproved(name)
        if (!approved) { log(`auto-login as "${name}" skipped: no launch.json and nothing approved for this name yet; use /squadra:login`); return }
        // Without launch.json the name is all there is, and a project's
        // settings could have set it: the user confirms.
        void login({
          name,
          role: approved.role,
          coordinator: approved.coordinator ?? undefined,
          staticAccess: launch?.staticAccess ?? false,
          seedAllow: launch?.allowFrom ?? [],
          approved: !!launch,
          mustAsk: !launch,
          relayOff: launch?.relayOff ?? false,
          persona: launch?.persona ?? null,
        }).catch(err => log(`auto-login as "${name}" failed: ${err.message}`))
      }
      return
    case 'notifications/claude/channel/permission_request':
      return void onPermissionRequest(msg.params ?? {})
    default:
      return
  }
}

export function startMcp() {
  const rl = createInterface({ input: process.stdin })
  rl.on('line', line => {
    if (!line.trim()) return
    let msg
    try { msg = JSON.parse(line) } catch { return log('ignoring non-JSON line on stdin') }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return log('ignoring a non-object line on stdin')
    try {
      if (msg.method && msg.id !== undefined) void handleRequest(msg)
      else if (msg.method) handleNotification(msg)
      else if (msg.id !== undefined && clientRequests.has(msg.id)) {
        // An answer to one of our requests (a confirmation).
        const done = clientRequests.get(msg.id)
        clientRequests.delete(msg.id)
        done(msg.result ?? null)
      }
    } catch (err) { log(`stdin: ${err.message}`) }
  })
}
