import { createPlatform, guarded } from './platform/index.js'
import { createSessions } from './sessions/index.js'
import { createMessaging } from './messaging/index.js'
import { createObservation } from './observation/index.js'
import { createMachines } from './machines/index.js'
import { createOrganization } from './organization/index.js'
import { createDashboard } from './dashboard/index.js'
import { upgradeStoredData } from './data-upgrade.js'

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
export function createCompany(server, { dir }) {
  const platform = createPlatform(server, { dir })
  const sessions = createSessions(platform)
  const messaging = createMessaging(platform, { sessions })
  const observation = createObservation(platform)
  const machines = createMachines(platform, { sessions, observation })
  const organization = createOrganization(platform, { sessions, messaging, observation, machines })
  const dashboard = createDashboard(platform, { sessions, messaging, observation, machines, organization })

  function cleanup() {
    messaging.cleanupMessages()
    sessions.cleanupUpdates()
    observation.cleanupEvents()
    platform.cleanupLimits()
    platform.truncateLogHourly()
  }
  setInterval(guarded(cleanup), 60 * 1000).unref()
  cleanup()

  upgradeStoredData(platform, { messaging, observation, machines })
  observation.restoreActivity()

  // The server is stopping: everything open ends right away.
  function close() {
    for (const w of [...sessions.waiters.values()]) sessions.finishPoll(w, null, [])
    for (const res of platform.sseClients) { try { res.end() } catch {} }
    platform.sseClients.clear()
    for (const ws of machines.wsClients) ws.close(1001, 'server shutting down')
    try { platform.db.close() } catch {}
  }

  return { platform, sessions, messaging, observation, machines, organization, dashboard, close }
}
