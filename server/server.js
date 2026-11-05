#!/usr/bin/env node
/**
 * squadra-server — the "Telegram" for Squadra.
 *
 * A small subset of the Telegram Bot API, shaped closely enough that Squadra
 * plugin is a near-copy of the official Telegram channel plugin. Every Claude
 * Code session is an identity (a "bot" that also acts as a "user" for others).
 *
 * Auth:
 *   - Server token (admin): the dashboard, /admin/* and rotating identities.
 *   - Join token: registers new names, nothing else.
 *   - Machine secret: squadra-host's link (/host/connect).
 *   - Identity secret: returned once by /register; every other call uses it.
 *     The sender of a message is always derived from the secret, never from
 *     a request field: sending as another name takes that name's secret (and,
 *     while its session holds the name, that session's instance id).
 *
 * Only Node built-ins: node:http, node:sqlite (Node >= 22.13).
 */

// This file only joins the parts. Each one gets what is below it, so what
// depends on what can be read here (test/modules.test.mjs checks it stays so):
//   platform       configuration, HTTP, database, keys, limits
//   sessions       identities, their queues, who holds a name and who is online
//   messaging      messages, groups, attachments
//   observation    what each session is doing
//   machines       squadra-host: joining, its link, terminals
//   organization   squads, links between them, templates
//   dashboard      what the dashboard reads and does

import { cleanupLimits, createPlatform, guarded, logError, startListening } from './platform/index.js'
import { createSessions } from './sessions/index.js'
import { createMessaging } from './messaging/index.js'
import { createObservation } from './observation/index.js'
import { createMachines } from './machines/index.js'
import { createOrganization } from './organization/index.js'
import { createDashboard } from './dashboard/index.js'
import { createRoutes } from './routes.js'
import { upgradeStoredData } from './data-upgrade.js'

const platform = createPlatform()
const sessions = createSessions(platform)
const messaging = createMessaging(platform, { sessions })
const observation = createObservation(platform)
const machines = createMachines(platform, { sessions, observation })
const organization = createOrganization(platform, { sessions, messaging, observation, machines })
const dashboard = createDashboard(platform, { sessions, messaging, observation, machines, organization })
const { handle } = createRoutes(platform, { sessions, messaging, observation, machines, organization, dashboard })

function cleanup() {
  messaging.cleanupMessages()
  sessions.cleanupUpdates()
  observation.cleanupEvents()
  cleanupLimits()
  platform.truncateLogHourly()
}
setInterval(guarded(cleanup), 60 * 1000).unref()
cleanup()

upgradeStoredData(platform, { messaging, observation, machines })
observation.restoreActivity()

// A bug reached by some request must not take the whole server down: logged.
// (Rate limited like every error line: nothing a client causes fills the disk.
// Set before any server starts, also while waiting for a certificate.)
process.on('uncaughtException', err => logError(`uncaught: ${err?.stack ?? err}`))
process.on('unhandledRejection', err => logError(`unhandled rejection: ${err?.stack ?? err}`))

const { servers } = await startListening(platform, { handle, onUpgrade: machines.onUpgrade, nowServing: sessions.nowServing })

// Ctrl+C / SIGTERM: close right away. Dashboards keep a stream open (and
// reconnect), sessions keep a long poll open, and browsers keep idle
// keep-alive sockets: don't wait for any of them.
let stopping = false
function shutdown(signal) {
  if (stopping) {
    process.stderr.write('squadra-server: forced exit\n')
    process.exit(1)
  }
  stopping = true
  process.stderr.write(`\nsquadra-server: ${signal} received, shutting down…\n`)
  for (const w of [...sessions.waiters.values()]) sessions.finishPoll(w, null, [])
  for (const res of platform.sseClients) { try { res.end() } catch {} }
  platform.sseClients.clear()
  for (const ws of machines.wsClients) ws.close(1001, 'server shutting down')
  for (const srv of servers) { srv.close(); srv.closeAllConnections?.() }
  try { platform.db.close() } catch {}
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
