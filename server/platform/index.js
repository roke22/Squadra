// What every module of the server can use. The configuration goes first: a
// wrong option or --help ends here, before anything is opened.
import { EventEmitter } from 'node:events'

export * from './config.js'
export * from './errors.js'
export * from './basics.js'
export * from './text.js'
export * from './files.js'
export { ipKey, allowServerWide, cleanupServerLimits } from './limits.js'
export * from './http.js'
export { acceptWebSocket } from './ws.js'
export { startListening } from './listen.js'
export { openServerCredentials } from './credentials.js'

import { openCompanyCredentials } from './credentials.js'
import { openDatabase } from './database.js'
import { createLimits } from './limits.js'
import { createStream } from './stream.js'

// What the modules of one company share while the server runs: its data, its
// budgets, its dashboards, and what is the whole server's. The bus is how a
// module tells the ones above it what happened, without knowing them:
//   session-changed (name)   what the dashboard shows of it changed
//   notice (worker, text)    its coordinator should hear this
//   context-cleared (name)   /clear took effect in that session
export function createPlatform(server, { dir }) {
  return {
    ...server, dataDir: dir, ...openCompanyCredentials(dir, server), ...openDatabase(dir), ...createStream(),
    ...createLimits(), bus: new EventEmitter(),
  }
}
