// What every module of the server can use. The configuration goes first: a
// wrong option or --help ends here, before anything is opened.
import { EventEmitter } from 'node:events'

export * from './config.js'
export * from './errors.js'
export * from './basics.js'
export * from './text.js'
export * from './files.js'
export * from './limits.js'
export * from './http.js'
export { acceptWebSocket } from './ws.js'
export { startListening } from './listen.js'

import { openCredentials } from './credentials.js'
import { openDatabase } from './database.js'
import { createStream } from './stream.js'

// What modules share while the server runs. The bus is how a module tells the
// ones above it what happened, without knowing them:
//   session-changed (name)   what the dashboard shows of it changed
//   notice (worker, text)    its coordinator should hear this
//   context-cleared (name)   /clear took effect in that session
export function createPlatform() {
  return { ...openCredentials(), ...openDatabase(), ...createStream(), bus: new EventEmitter() }
}
