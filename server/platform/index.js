// What every module of the server can use. The configuration goes first: a
// wrong option or --help ends here, before anything is opened.
import { EventEmitter } from 'node:events'

export * from './config.js'
export * from './errors.js'
export * from './basics.js'
export * from './text.js'
export * from './files.js'
export { ipKey, allowServerWide, countedServerWide, cleanupServerLimits } from './limits.js'
export * from './http.js'
export { acceptWebSocket } from './ws.js'
export { startListening } from './listen.js'
export { openServerCredentials } from './credentials.js'
export { openControl } from './control.js'
export * from './roles.js'

import { openCompanyCredentials } from './credentials.js'
import { openDatabase } from './database.js'
import { createLimits, whyNoRoom } from './limits.js'
import { ApiError } from './errors.js'
import { createStream } from './stream.js'

export const FIRST_COMPANY = 'default'

// What the modules of one company share while the server runs: its data, its
// budgets, its dashboards, and what is the whole server's. The bus is how a
// module tells the ones above it what happened, without knowing them:
//   session-changed (name)   what the dashboard shows of it changed
//   notice (worker, text)    its coordinator should hear this
//   context-cleared (name)   /clear took effect in that session
export function createPlatform(server, { id, dir, quotas, routeEnrollment }) {
  // What repeats while this company runs, and stops with it.
  const timers = new Set()
  const every = (ms, fn) => { const t = setInterval(fn, ms); t.unref(); timers.add(t) }
  const stopTimers = () => { for (const t of timers) clearInterval(t); timers.clear() }
  // The first company's credentials have no prefix, as they always were.
  const credentialPrefix = id === FIRST_COMPANY ? '' : `${id}_`
  // (The credentials first: they make the company's folder.)
  const credentials = openCompanyCredentials(dir, server, { id, credentialPrefix })
  const opened = openDatabase(dir)
  // Looked at every few seconds, not on every write.
  let roomUntil = 0, noRoom = null
  function ensureRoom() {
    const t = Date.now()
    if (t >= roomUntil) { noRoom = whyNoRoom(opened.db, dir, quotas.max_db_mb); roomUntil = t + 5000 }
    if (noRoom) throw new ApiError(507, `Insufficient Storage: ${noRoom}`)
  }
  return {
    ...server, companyId: id, dataDir: dir, credentialPrefix, routeEnrollment, every, stopTimers,
    quota: (what, otherwise) => quotas[what] ?? otherwise,
    setQuotas: limits => { quotas = limits; roomUntil = 0 },
    ensureRoom,
    log: text => process.stderr.write(`squadra-server: ${credentialPrefix && `[${id}] `}${text}\n`),
    ...credentials, ...opened, ...createStream(every),
    ...createLimits(), bus: new EventEmitter(),
  }
}
