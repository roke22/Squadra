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

// This file only starts what is the whole server's. server/companies.js keeps
// the companies, and server/company.js joins the parts of one.

import { cleanupServerLimits, guarded, logError, openServerCredentials, startListening } from './platform/index.js'
import { createCompanies } from './companies.js'
import { createAccounts } from './accounts/index.js'
import { createRoutes } from './routes.js'

const credentials = openServerCredentials()
const companies = createCompanies(credentials)
const accounts = createAccounts(credentials, { control: companies.control, companyName: companies.nameOf, dropClients: companies.dropClients })
const { handle, onUpgrade } = createRoutes(credentials, companies, accounts)

setInterval(guarded(cleanupServerLimits), 60 * 1000).unref()

// A bug reached by some request must not take the whole server down: logged.
// (Rate limited like every error line: nothing a client causes fills the disk.
// Set before any server starts, also while waiting for a certificate.)
// Before it is serving, a failure means it didn't start: it ends, with an
// error, so that whatever started it (systemd, Docker) knows.
let serving = false
const failed = what => err => { logError(`${what}: ${err?.stack ?? err}`); if (!serving) process.exit(1) }
process.on('uncaughtException', failed('uncaught'))
process.on('unhandledRejection', failed('unhandled rejection'))

const { servers } = await startListening(credentials, { handle, onUpgrade, nowServing: companies.nowServing, joinToken: companies.first().platform.joinToken })
serving = true

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
  companies.close()
  for (const srv of servers) { srv.close(); srv.closeAllConnections?.() }
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
