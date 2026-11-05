// /squadra:login, /squadra:logout and /squadra:status.

import { join } from 'node:path'
import { hostname } from 'node:os'
import { normalizeLevel, createObserver } from '../observe.js'
import { prepareSocketDir, socketDirFor } from '../paths.js'
import { keyFingerprint } from '../signing.js'
import {
  COORDINATOR_WORDS, defaultObserve, SERVER_URL, transportProblem, DEFAULT_COORDINATOR, NAME_RE,
  log, OBSERVE_ORDER, RUN_DIR, VERSION, SERVER_TOKEN, ROOT_ENV_FILE, S, setSession, readApproved,
  listedApprovers, prepareAccess, writeApproved, personaLabel, linkedCoordinators, loadAccess, call,
  claimPidFile, releasePidFile, nameOrQ, readPeerKey, checkCoordinator, connect, startLoops,
} from '../core/index.js'
import { WINDOWS_HINT, channelLaunchStatus, LAUNCH_HINT } from './launch.js'
import { roleRules } from './instructions.js'
import {
  briefOnPrompt, withBrief, clearedContext, recoveryContext, fetchBrief, briefKey, briefText,
} from './context.js'
import { tasksStarting, channelIds, stopCheck } from './tasks.js'
import { ping } from './tools.js'
import { pinApprovers, TOOL_INPUT_KEEP_MS, withdrawIfAmbiguous, pendingPermissions } from './permissions.js'
import { confirmWithUser } from './mcp.js'

function parseRole(role) {
  const r = String(role ?? '').toLowerCase()
  if (COORDINATOR_WORDS.has(r)) return 'coordinator'
  if (r === 'solo') return 'solo'
  if (r === 'worker' || r === '') return 'worker'
  throw new Error(`unknown role "${role}": use "coordinator" or "worker"`)
}

// approved: the role and coordinator come from launch.json (the machine wrote
// it for this start). mustAsk: the user is asked even for the setup approved
// before, and without a way to ask there is no login (an automatic login
// that only has SQUADRA_NAME, which a project could set).
export async function login({ name, role, coordinator, staticAccess = false, seedAllow = [], observe, approved = false, mustAsk = false, relayOff = false, persona = null } = {}) {
  if (process.platform === 'win32') throw new Error(WINDOWS_HINT)
  const level = observe == null || observe === '' ? defaultObserve() : normalizeLevel(observe)
  if (!level) throw new Error(`invalid observation level "${observe}": use off, activity or full`)
  observe = level
  if (!SERVER_URL) throw new Error('the server URL is missing: run /squadra:configure <url> <token>')
  const problem = transportProblem()
  if (problem) throw new Error(problem)
  role = parseRole(role)
  name = String(name ?? '').trim()
  if (!name) name = role === 'coordinator' ? DEFAULT_COORDINATOR : ''
  if (!NAME_RE.test(name)) throw new Error(`invalid name "${name}": use letters, digits, "_" or "-" (max 32)`)
  coordinator = role === 'worker' ? String(coordinator ?? '').trim() || DEFAULT_COORDINATOR : null
  if (coordinator && !NAME_RE.test(coordinator)) throw new Error(`invalid coordinator name "${coordinator}"`)
  if (coordinator === name) throw new Error('a worker cannot have the same name as its coordinator')

  const launch = role === 'solo' ? { ok: true } : channelLaunchStatus()
  if (launch.ok === false) {
    throw new Error(`this session was not started with the Squadra channel enabled, so it could not receive messages.\n${LAUNCH_HINT}`)
  }

  // Which role and coordinator this name runs with is the user's decision:
  // the coordinator gets to answer this session's permission prompts. Every
  // login typed in the session is confirmed by the user, asked by Claude Code
  // itself (MCP elicitation) — a channel message or a file can't give it.
  // Without elicitation, only the role and coordinator approved before.
  const stored = readApproved(name)
  const same = stored && stored.role === role && (stored.coordinator ?? null) === (coordinator ?? null)
  // A coordinator's prompts go only to approvers the user confirmed (listed
  // in its access.json AND shown in this confirmation).
  const listed = role === 'coordinator' ? listedApprovers(name) : []
  // Only ever what the user confirmed in this very login (the list on disk
  // is a file Claude could write).
  let confirmedApprovers = []
  let asked = false
  if (!approved) {
    const seen = { off: 'nothing', activity: 'its activity: tools with short arguments, state, context size, the first 200 characters of your prompts and the first line of tool errors (secrets masked)', full: 'its activity, your prompts, Claude\'s text and tool input and output (secrets masked)' }[observe]
    const question = (role === 'coordinator'
      ? `Join Squadra as "${name}", COORDINATOR?${listed.length ? ` Its permission prompts will be sent to: ${listed.join(', ')}.` : ''}`
      : `Join Squadra as "${name}", a WORKER coordinated by "${coordinator}"? "${coordinator}" will be able to give this session tasks and answer its permission prompts.`) +
      ` Server: ${SERVER_URL}. The dashboard will see ${seen}.`
    const answer = await confirmWithUser(question)
    asked = answer === true
    if (answer === false) throw new Error('the user did not confirm this login')
    if (answer === null && (mustAsk || !same)) {
      throw new Error(mustAsk
        ? `an automatic login (SQUADRA_NAME) without launch.json needs the user's confirmation, which this Claude Code can't show. Log in with /squadra:login.`
        : stored
          ? `"${name}" is set up as ${stored.role}${stored.coordinator ? ` of "${stored.coordinator}"` : ''}; changing that needs the user's confirmation, which this Claude Code can't show. The user can change it with /squadra:access coordinator <name>.`
          : `a first login needs the user's confirmation, which this Claude Code can't show. Update Claude Code, or open the session from the Squadra dashboard.`)
    }
    if (answer === true) confirmedApprovers = listed
  }
  // Not asked (started from the dashboard, or a Claude Code that can't ask):
  // approvers listed for a coordinator are confirmed on their own, or not used.
  if (!asked && listed.length) {
    const ok = await confirmWithUser(`Send the permission prompts of "${name}" (coordinator) to: ${listed.join(', ')}? They will be able to approve its tool calls.`)
    confirmedApprovers = ok === true ? listed : []
    if (ok !== true) log(`permission approvers for "${name}" not confirmed: its prompts stay in its terminal`)
  }
  // Not asked: what the dashboard sees is never more than the user set.
  if (!asked) observe = [observe, defaultObserve()].sort((a, b) => OBSERVE_ORDER.indexOf(a) - OBSERVE_ORDER.indexOf(b))[0]

  if (S) await logout()

  const s = await connect({ name, role, coordinator, staticAccess, seedAllow, approved, confirmedApprovers, relayOff, persona })
  // Logged out (or logged in again) while this was connecting: stop here.
  if (S !== s) {
    void call('releaseSession', { instance: s.instance, reason: 'logout' }, { s }).catch(() => {})
    throw new Error('login cancelled')
  }
  claimPidFile(s)
  prepareAccess(s)
  writeApproved(s)
  void pinApprovers(s)
  startLoops(s)
  s.observer = createObserver({
    level: observe,
    send: events => call('observe', { events }, { s }),
    log,
    contextProvider: source => (S !== s ? '' : source === 'prompt' ? briefOnPrompt(s) : withBrief(s, source === 'clear' ? clearedContext(s) : recoveryContext(s))),
    onPrompt: prompt => { if (S === s) tasksStarting(s, channelIds(prompt)) },
    onChannelSeen: ids => { if (S === s) tasksStarting(s, ids) },
    stopCheck: active => stopCheck(s, active),
    onToolInput: (tool, input) => {
      const now = Date.now()
      s.toolInputs.push({ tool, input, at: now })
      // Kept for a minute (what a relay compares against); a flood past the
      // cap is remembered, so a request it could hide falls back.
      while (s.toolInputs.length && (now - s.toolInputs[0].at > TOOL_INPUT_KEEP_MS || s.toolInputs.length > 500)) {
        s.toolInputsDroppedAt = Math.max(s.toolInputsDroppedAt ?? 0, s.toolInputs.shift().at)
      }
      withdrawIfAmbiguous(s, tool, input)
    },
  })
  const sockDir = prepareSocketDir(RUN_DIR)
  if (sockDir) s.observer.start(join(sockDir, `${process.ppid}.sock`))
  else log(`observation off: ${socketDirFor(RUN_DIR)} exists but is not a private folder of this user; remove it and log in again`)
  log(`logged in to ${SERVER_URL} as "${name}" (${role})`)

  // A worker introduces itself to its coordinator. This is the plugin talking,
  // not Claude; if they aren't paired yet it triggers the pairing flow.
  if (role === 'worker') {
    const where = `${process.cwd()} (${hostname()})`
    // Only to the coordinator this worker knows (after checking its pin).
    void checkCoordinator(s).then(ok => {
      if (!ok || S !== s) return
      return call('sendMessage', { chat_id: coordinator, text: `👋 ${name} connected as a worker in ${where}.${s.persona ? ` Persona: ${personaLabel(s.persona)}: give it the tasks that fit.` : ''}`, squadra_hello: true }, { s })
    }).catch(err => log(`intro to ${coordinator} failed: ${err.message}`))
  }

  if (role === 'solo') return `Connected to Squadra as "${name}", a standalone session (outside any squad): the dashboard shows what it does.`
  // (Whether it has workers is told with its first prompt: they connect after it.)
  const info = role === 'coordinator' ? await fetchBrief(s) : undefined
  if (info) s.briefKey = briefKey(info.brief)
  const brief = info?.brief ?? null
  const lines = [
    `Connected to Squadra as "${name}", role ${role === 'coordinator' ? 'COORDINATOR' : 'WORKER'} (server ${SERVER_URL}).`,
    ...(s.claimed?.approval_pending ? ['⚠️ Not approved yet: until the user approves this session in the dashboard (open it there: Approve as coordinator), it can\'t write to its workers. Tell the user.'] : []),
    ...(s.claimed?.coordinator_pending ? [`⚠️ "${coordinator}" isn't approved as a coordinator yet: until the user approves it in the dashboard (open it there: Approve as coordinator), it can't reach this session, nor this session it. Tell the user.`] : []),
    role === 'coordinator'
      ? 'Follow the COORDINATOR ROLE rules below. When a worker connects for the first time you will receive a pairing request: tell the user so they can approve it with /squadra:access pair <code>.'
      : `Follow the WORKER ROLE rules below. Your coordinator is "${coordinator}": an automatic greeting has been sent to it. If you are not paired yet, you will get a message with a code that the user must approve in the coordinator's terminal.`,
    // (The server instructions may not have had them: they only carry a role's
    // rules when the session logs in on its own.)
    ...(role === 'coordinator' && linkedCoordinators(s).length ? [`Linked coordinators (other squads): ${linkedCoordinators(s).join(', ')}.`] : []),
    '',
    roleRules(role),
    ...(brief ? ['', briefText(brief)] : []),
    '',
    observe === 'off'
      ? 'Observation off: the web dashboard will not see this session\'s activity.'
      : `Observation: ${observe} (the server's web dashboard shows this session's activity live${observe === 'activity' ? ': tools with short arguments, state, the first 200 characters of prompts and the first line of errors, without Claude\'s text or tool output' : ''}).`,
  ]
  if (launch.ok === null) lines.push('Note: could not check whether the session was started with the channel enabled. If no messages arrive, restart with: claude --dangerously-load-development-channels plugin:squadra@squadra')
  return lines.join('\n')
}

export async function logout({ ask = false } = {}) {
  const s = S
  if (!s) return 'You were not connected to Squadra.'
  if (ask && (await confirmWithUser(`Leave Squadra (session "${s.name}")?`)) === false) throw new Error('the user did not confirm leaving')
  setSession(null)
  pendingPermissions.clear()
  for (const t of s.timers) clearInterval(t)
  try { s.pollAbort?.abort() } catch {}
  await s.observer?.stop()
  // The server tells a worker's coordinator that it left.
  if (s.secret) await call('releaseSession', { instance: s.instance, reason: 'logout' }, { s }).catch(err => log(`release failed: ${err.message}`))
  releasePidFile(s)
  log(`logged out "${s.name}"`)
  return `Disconnected from Squadra ("${s.name}"). Other sessions will see you as DOWN until you run /squadra:login again.`
}

export async function status() {
  const lines = []
  lines.push(`Plugin Squadra v${VERSION}`)
  lines.push(`Server: ${SERVER_URL || '(not configured: /squadra:configure <url> <token>)'}${SERVER_TOKEN ? '' : ' — no server token'}`)
  lines.push(`Files: config ${ROOT_ENV_FILE}${S ? ` · state ${S.stateDir}` : ''}`)
  const launch = channelLaunchStatus()
  lines.push(`Channel in this session: ${launch.ok === true ? 'enabled' : launch.ok === false ? 'NOT enabled (no messages will arrive)' : 'could not be checked'}`)
  if (!S) {
    lines.push('Session: not connected. Use /squadra:login coordinator  or  /squadra:login <worker-name>.')
    if (launch.ok === false) lines.push(LAUNCH_HINT)
    return lines.join('\n')
  }
  const st = S.status === 'online' ? 'connected' : S.status === 'connecting' ? 'connecting…' : `ERROR: ${S.error}`
  lines.push(`Session: "${S.name}", role ${S.role === 'coordinator' ? 'coordinator' : `worker (coordinator: ${S.coordinator})`} — ${st}`)
  if (S.persona) lines.push(`Persona: ${personaLabel(S.persona)}`)
  if (S.serverKey) lines.push(`Server key: ${keyFingerprint(S.serverKey)} (should match what the server prints when it starts)`)
  if (S.signingKey) lines.push(`Signing key: ${keyFingerprint(S.signingKey.public)}`)
  if (S.role === 'worker') {
    const k = readPeerKey(S.coordinator)
    lines.push(`Coordinator's key: ${k ? `${keyFingerprint(k)} (should match the "Signing key" in its status)` : 'not known yet (taken from its first signed message)'}`)
  }
  const access = loadAccess()
  lines.push(`Access: ${access.dmPolicy}${S.staticAccess ? ' (static)' : ''}; allowed: ${access.allowFrom.join(', ') || '(none)'}`)
  if (S.role === 'coordinator') {
    lines.push(`Linked coordinators (other squads): ${linkedCoordinators().join(', ') || '(none)'}`)
    const info = await fetchBrief(S)
    const b = info?.brief
    if (b) lines.push(`Your squad (from the dashboard): ${[b.title && JSON.stringify(b.title), b.goal && `goal ${JSON.stringify(b.goal)}`, b.description && `you are for ${JSON.stringify(b.description)}`].filter(Boolean).join('; ')}`)
    if (info) lines.push(info.workers ? `Workers connected: ${info.workers}` : 'Workers connected: none: do your squad\'s work yourself')
  }
  lines.push(`Web dashboard observation: ${S.observer?.level ?? 'off'}`)
  const pending = Object.entries(access.pending)
  if (pending.length) lines.push(`Pending pairings: ${pending.map(([c, p]) => `${p.senderId} (/squadra:access pair ${c})`).join(', ')}`)
  if (Object.keys(access.groups).length) {
    const info = g => { const r = S.groupInfo?.get(g); return r ? ` (owner ${nameOrQ(r.owner)}; members: ${(Array.isArray(r.members) ? r.members : []).map(nameOrQ).join(', ')})` : S.joinedGroups.has(g) ? '' : ' (not joined yet: waiting for an invitation)' }
    lines.push(`Groups: ${Object.keys(access.groups).map(g => g + info(g)).join(', ')}`)
  }
  if (S.status === 'online') {
    lines.push('', await ping(null))
  }
  return lines.join('\n')
}
