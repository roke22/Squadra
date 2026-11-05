#!/usr/bin/env node
/**
 * Squadra channel for Claude Code.
 *
 * A port of the official Telegram channel plugin
 * (anthropics/claude-plugins-official/external_plugins/telegram) where
 * Telegram is replaced by squadra-server and the human on the other side is
 * another Claude Code session. One session plays the coordinator.
 *
 * Self-contained MCP server (stdio, no dependencies) with full access control:
 * pairing, allowlists, group support with mention-triggering, permission relay.
 *
 * The session joins Squadra with /squadra:login (login tool) and leaves with
 * /squadra:logout. Setting SQUADRA_NAME logs in automatically at startup. Until
 * then the plugin is idle, so having it installed doesn't affect normal
 * sessions. State lives in ~/.claude/channels/squadra/<name>/ and is managed by
 * the /squadra:access skill.
 *
 * core/ is what any agent could reuse; claude/ is what is Claude Code's. This
 * file joins them.
 */

import { log, shutdown, useAgent } from './core/index.js'
import { startMcp, deliver, givePermission, takePermissionReply } from './claude/index.js'

// Last-resort safety net — without these the process dies silently on any
// unhandled promise rejection. With them it logs and keeps serving tools.
process.on('unhandledRejection', err => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', err => log(`uncaught exception: ${err}`))

useAgent({ deliver, givePermission, takePermissionReply })
startMcp()

// When Claude Code closes the MCP connection, stdin gets EOF. Without this the
// poller keeps running forever as a zombie, holding the name and blocking the
// next session with 409 Conflict.
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

// Orphan watchdog: belt-and-suspenders for the stdin handlers above.
setInterval(() => {
  if (process.stdin.destroyed || process.stdin.readableEnded) shutdown()
}, 5000).unref()
