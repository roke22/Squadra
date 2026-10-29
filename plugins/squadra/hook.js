#!/usr/bin/env node
/**
 * Squadra observation hook.
 *
 * Claude Code runs this (in the background, "async": true) for every hook
 * event. It forwards the event to this session's squadra plugin process, which
 * filters it by the observation level and sends it to the Squadra server.
 *
 * The plugin listens on a unix socket named after its parent process, which is
 * the Claude Code process (see paths.js for where it lives). This hook walks up its own ancestors to find that
 * socket, so each event reaches the plugin of the session it came from. No
 * socket = the session isn't logged in to Squadra: exit silently.
 *
 * Must never fail or slow anything down: every error is swallowed, exit 0.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync as psExists } from 'node:fs'
// ps from the system, never from a PATH a project's settings could change.
const PS_BIN = ['/bin/ps', '/usr/bin/ps'].find(p => psExists(p)) ?? 'ps'
import { connect } from 'node:net'
import { socketDirFor, isPrivateDir, claudeConfigDir } from './paths.js'

const ts = Date.now()
const RUN_DIR = join(claudeConfigDir(), 'channels', 'squadra', 'run')

const SOCK_DIR = socketDirFor(RUN_DIR)

// A process's parent pid and command line.
function procInfo(pid) {
  try {
    // Linux: /proc/<pid>/stat → "pid (comm) state ppid ...". comm may contain spaces/parens.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ')
    return { ppid, args }
  } catch {}
  try {
    // macOS (no /proc).
    const out = execFileSync(PS_BIN, ['-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const m = out.match(/^(\d+)\s+(.*)$/s)
    if (m) return { ppid: Number(m[1]), args: m[2] }
  } catch {}
  return { ppid: 0, args: '' }
}

// A Claude Code process (the CLI, however it was installed).
const isClaude = args => /(^|[\s/])claude(\s|$)|@anthropic-ai\/claude-code|claude-code[\\/]cli|[\\/]claude[\\/]versions[\\/][^\s\\/]+(\s|$)/.test(args)

function findSocket() {
  if (!existsSync(SOCK_DIR)) return null
  // Never send events to a socket in a /tmp folder someone else controls.
  if (!isPrivateDir(SOCK_DIR)) return null
  // Walk up to the nearest Claude Code process: its socket, or none. Never
  // past it — a claude started from inside a session (e.g. by its Bash tool)
  // must not report its events to, or get the context of, the outer session.
  let pid = process.ppid
  for (let i = 0; i < 6 && pid > 1; i++) {
    const sock = join(SOCK_DIR, `${pid}.sock`)
    if (existsSync(sock)) return sock
    const { ppid, args } = procInfo(pid)
    if (isClaude(args)) return null
    pid = ppid
  }
  return null
}

function readStdin() {
  return new Promise(resolve => {
    const chunks = []
    process.stdin.on('data', c => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => resolve(''))
  })
}

const CONTEXT_MODE = process.argv.includes('--context')

// --context (SessionStart "compact" and "clear" hooks, synchronous): ask the
// plugin for the Squadra context and hand it back to Claude Code as
// additionalContext, so the session still knows its name, role and task
// after compacting (or who it is after a /clear).
function askContext(sock, source) {
  return new Promise(resolve => {
    const chunks = []
    const c = connect(sock, () => c.end(JSON.stringify({ want: 'context', source })))
    c.on('data', d => chunks.push(d))
    c.on('close', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).context ?? '') } catch { resolve('') }
    })
    c.on('error', () => resolve(''))
    setTimeout(() => { c.destroy(); resolve('') }, 3000).unref()
  })
}

async function main() {
  const sock = findSocket()
  if (!sock) return
  const raw = await readStdin()
  if (CONTEXT_MODE) {
    let source = 'compact'
    try { if (JSON.parse(raw)?.source === 'clear') source = 'clear' } catch {}
    const context = await askContext(sock, source)
    if (context) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }))
    }
    return
  }
  if (!raw.trim()) return
  let input
  try { input = JSON.parse(raw) } catch { return }
  await new Promise(resolve => {
    const c = connect(sock, () => c.end(JSON.stringify({ ts, input })))
    c.on('close', resolve)
    c.on('error', resolve)
    setTimeout(() => { c.destroy(); resolve() }, 2000).unref()
  })
}

main().catch(() => {}).finally(() => process.exit(0))
