import { createPlatform, guarded } from './platform/index.js'
import { createSessions } from './sessions/index.js'
import { createMessaging } from './messaging/index.js'
import { createObservation } from './observation/index.js'
import { createMachines } from './machines/index.js'
import { createOrganization } from './organization/index.js'
import { createDashboard } from './dashboard/index.js'
import { upgradeStoredData } from './data-upgrade.js'
import { cleanExports } from './company-export.js'

// One company: its data and every module working on it, with nothing shared
// with any other but what is the whole server's (see server/server.js).
// Each part gets what is below it, so what depends on what can be read here
// (test/modules.test.mjs checks it stays so):
//   platform       configuration, HTTP, database, keys, limits
//   sessions       identities, their queues, who holds a name and who is online
//   messaging      messages, groups, attachments
//   observation    what each session is doing
//   machines       squadra-host: joining, its link, terminals
//   organization   squads, links between them, templates
//   dashboard      what the dashboard reads and does
export function createCompany(server, options) {
  const platform = createPlatform(server, options)
  const sessions = createSessions(platform)
  const messaging = createMessaging(platform, { sessions })
  const observation = createObservation(platform)
  const machines = createMachines(platform, { sessions, observation })
  const organization = createOrganization(platform, { sessions, messaging, observation, machines })
  const dashboard = createDashboard(platform, { sessions, messaging, observation, machines, organization })

  // What a session can ask for, by its name in the request.
  const methods = {
    ...observation.observationMethods, ...machines.machineMethods, ...organization.organizationMethods,
    ...sessions.sessionMethods, ...messaging.messagingMethods,
  }

  function cleanup() {
    messaging.cleanupMessages()
    sessions.cleanupUpdates()
    observation.cleanupEvents()
    platform.cleanupLimits()
    platform.cleanupAudit()
    platform.truncateLogHourly()
  }
  platform.every(60 * 1000, guarded(cleanup))
  cleanup()
  cleanExports(options.dir)

  upgradeStoredData(platform, { messaging, observation, machines })
  observation.restoreActivity()

  // Someone lost access: what they have open closes now, not at their next request.
  function dropClients(match) {
    machines.dropTickets(match)
    for (const res of [...platform.sseClients]) if (res.actor && match(res.actor)) { platform.sseClients.delete(res); try { res.end() } catch {} }
    for (const ws of [...machines.wsClients]) if (ws.actor && match(ws.actor)) ws.close(4403, 'access changed')
  }

  // The server is stopping: everything open ends right away.
  function close() {
    platform.stopTimers()
    for (const w of [...sessions.waiters.values()]) sessions.finishPoll(w, null, [])
    for (const res of platform.sseClients) { try { res.end() } catch {} }
    platform.sseClients.clear()
    for (const ws of machines.wsClients) ws.close(1001, 'server shutting down')
    try { platform.db.close() } catch {}
  }

  return { id: options.id, platform, sessions, messaging, observation, machines, organization, dashboard, methods, dropClients, close }
}
