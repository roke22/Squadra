// Joining the server and staying there.

import { rmSync } from 'node:fs'
import { proveKey } from '../signing.js'
import { agent } from './agent.js'
import { SERVER_TOKEN, log } from './settings.js'
import { newSession, setSession, S, active } from './session.js'
import { forgetCoordinatorPin, checkLinks } from './access.js'
import { loadIdentity, call, ApiError, releasePidFile } from './client.js'
import { syncGroups, checkApprovals } from './groups.js'
import { serverIdentity, loadSigningKey, ServerKeyError } from './signed.js'
import { checkCoordinator, handleInbound, RetryLater } from './inbound.js'

// Joins the server under this name (refused if another active session holds it).
// By the time it returns the session may have been logged out: the caller checks.
export async function connect({ name, role, coordinator, staticAccess, seedAllow, approved, confirmedApprovers, relayOff, persona }) {
  const seeds = [...seedAllow]
  if (coordinator && !seeds.includes(coordinator)) seeds.push(coordinator)
  const s = newSession({ name, role, coordinator, staticAccess, seedAllow: seeds })
  // A worker opened from the dashboard (launch.json) for this coordinator:
  // the user picked it there, so the coordinator with that name now is the
  // one to trust. A pin left by an earlier session with that name (deleted
  // and registered again, a machine added again) is forgotten, and the one
  // it has now is pinned at first contact.
  if (approved && role === 'worker' && coordinator) forgetCoordinatorPin(s, coordinator)
  s.confirmedApprovers = confirmedApprovers
  s.relayOff = relayOff
  // (Started by the machine: its links from the dashboard count, see linkedCoordinators.)
  s.fromLaunch = approved
  // (Only from launch.json: a login typed in the session has none.)
  s.persona = role === 'solo' ? null : persona
  s.approverPins = new Map() // approver -> created_at when confirmed (see verifiedApprovers)
  setSession(s)
  try {
    // Before any secret goes anywhere: is this our server?
    await serverIdentity()
    s.secret = await loadIdentity(s)
    s.signingKey = loadSigningKey(s)
    // First come, first served: refused if another active session holds the name.
    const claim = async () => {
      const proved = await serverIdentity()
      s.serverKey = proved?.key ?? null
      s.claimed = await call('claimSession', {
        instance: s.instance, role, coordinator, persona: s.persona,
        ...(proved ? { signing_key: s.signingKey.public, challenge: proved.challenge, proof: proveKey(s.signingKey, proved.key, 'claim', s.name, proved.challenge, s.instance) } : {}),
      }, { s })
    }
    try {
      await claim()
    } catch (err) {
      // The stored identity no longer exists on the server (deleted from the
      // dashboard): register the name again, once.
      if (!(err instanceof ApiError && err.code === 401) || !SERVER_TOKEN) throw err
      log(`identity "${name}" unknown to the server, registering it again`)
      rmSync(s.identityFile, { force: true })
      s.secret = await loadIdentity(s)
      await claim()
    }
    // The server just accepted us: we're connected, no need to wait for the
    // first long poll to come back (up to 30s) to say so.
    s.status = 'online'
  } catch (err) {
    if (S === s) setSession(null)
    if (err instanceof ApiError && err.reason === 'name_in_use') {
      throw new Error(
        `an ACTIVE session is already connected as "${name}" (${err.message.replace(/^Conflict: /, '')}). ` +
        'Pick another name. If that session is stuck, the dashboard admin can disconnect it (⋯ → Disconnect): a session opened from the dashboard can then be opened again from its machine; otherwise the name must be deleted before it can be used again.',
      )
    }
    throw err
  }
  return s
}

// What keeps a session going, once it is in: its groups, approvals, links and messages.
export function startLoops(s) {
  const { role } = s
  if (role !== 'solo') {
    s.timers.push(setInterval(() => syncGroups(s), 5000))
    if (!s.staticAccess) s.timers.push(setInterval(() => checkApprovals(s), 5000))
    if (role === 'coordinator') { s.timers.push(setInterval(() => checkLinks(s), 5000)); checkLinks(s) }
    syncGroups(s)
  }
  void pollLoop(s)
  if (role === 'worker') void checkCoordinator(s)
}

async function pollLoop(s) {
  let offset = 0
  let conflicts = 0
  for (let attempt = 1; active(s);) {
    try {
      // After a cut, the server first proves it is still ours.
      if (s.recheckServer) { await serverIdentity(); s.recheckServer = false }
      s.pollAbort = new AbortController()
      const updates = await call('getUpdates', { offset, timeout: 30, instance: s.instance }, { signal: s.pollAbort.signal, s, timeoutMs: 90_000 })
      if (!active(s)) return
      if (s.status !== 'online') { s.status = 'online'; s.error = '' }
      attempt = 1
      conflicts = 0
      // Photos are fetched inline within 8 seconds for the whole batch, not
      // each (the next poll waits for them all, and a session that doesn't
      // poll for 15 seconds is taken for gone).
      s.photoDeadline = Date.now() + 8000
      for (const u of updates) {
        offset = u.update_id + 1
        try {
          if (u.message) await handleInbound(s, u.message)
          else if (u.edited_message) await handleInbound(s, u.edited_message, { edited: true })
          // message_reaction: like the Telegram plugin, reactions never reach Claude.
        } catch (err) {
          if (err instanceof RetryLater) {
            // Keep this update (and the ones after it) for the next poll.
            offset = u.update_id
            log(`${err.message}: will try that message again shortly`)
            await new Promise(r => setTimeout(r, 3000))
            break
          }
          log(`handler error (polling continues): ${err.message}`)
        }
      }
    } catch (err) {
      if (!active(s)) return
      if (err instanceof ServerKeyError) {
        s.status = 'error'
        s.error = err.message
        log(err.message)
        stopSession(s)
        agent.deliver({
          content: `This session has been DISCONNECTED from Squadra: ${err.message} Tell the user; stop sending messages to Squadra.`,
          meta: { kind: 'squadra_notice' },
        })
        return
      }
      if (!(err instanceof ApiError)) s.recheckServer = true
      const is409 = err instanceof ApiError && err.code === 409
      if (is409 && err.reason === 'taken_over') {
        s.status = 'error'
        s.error = `this session was disconnected from Squadra (from the dashboard, or another session took the name "${s.name}"). Log in again with /squadra:login, with another name if needed.`
        log(`name "${s.name}" taken over by another session. Stopping.`)
        stopSession(s)
        agent.deliver({
          content: `This session has been DISCONNECTED from Squadra (from the dashboard, or another session took the name "${s.name}"). Tell the user; stop sending messages to Squadra.`,
          meta: { kind: 'squadra_notice' },
        })
        return
      }
      if (is409 && ++conflicts >= 8) {
        s.status = 'error'
        s.error = `another session is already connected as "${s.name}". Use another name with /squadra:login.`
        log(`409 Conflict persists after ${conflicts} attempts — another session is polling as "${s.name}". Stopping.`)
        stopSession(s)
        return
      }
      if (err instanceof ApiError && err.code === 401) {
        s.status = 'error'
        s.error = 'the server no longer accepts this session\'s identity (it was disconnected or deleted from the dashboard). Open it again from the dashboard, or run /squadra:configure reset-identity.'
        log('identity rejected by server (401). Stopping.')
        stopSession(s)
        return
      }
      const delay = Math.min(1000 * attempt++, 15000)
      log(`${is409 ? '409 Conflict — another instance is polling' : `polling error: ${err.message}`}, retrying in ${delay / 1000}s`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
}

// A session cut off by the server: nothing more is sent (timers, the
// observer's queue) and the hooks' socket is closed.
function stopSession(s) {
  for (const t of s.timers) clearInterval(t)
  s.timers.length = 0
  void s.observer?.stop()
  releasePidFile(s)
}
