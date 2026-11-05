// The one session of this process, and how the process ends.

import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { stateDirFor, log } from './settings.js'
import { releasePidFile, call } from './client.js'

// S is null while logged out. login() builds it, logout() tears it down. Every
// async loop captures its own S and stops as soon as S changes, so a stale
// poll from a previous identity can never deliver into the current one.
export let S = null

// (Everyone reads S; it changes only through this.)
export const setSession = s => { S = s }

export function newSession({ name, role, coordinator, staticAccess, seedAllow }) {
  const dir = stateDirFor(name)
  return {
    name,
    role,
    coordinator,
    staticAccess,
    seedAllow,
    stateDir: dir,
    accessFile: join(dir, 'access.json'),
    approvedDir: join(dir, 'approved'),
    identityFile: join(dir, 'identity.json'),
    coordinatorPinFile: join(dir, 'coordinator-pin.json'),
    allowPinsFile: join(dir, 'allow-pins.json'),
    signingKeyFile: join(dir, 'signing-key.json'),
    sigSeenFile: join(dir, 'signatures-seen.json'),
    inboxDir: join(dir, 'inbox'),
    pidFile: join(dir, 'server.pid'),
    // Identifies this login on the server, which lets only one session hold a
    // name at a time (first come, first served).
    instance: randomBytes(12).toString('base64url'),
    secret: '',
    signingKey: null,
    fileHashes: new Map(), // file_id -> sha256 its sender signed (null: an unsigned sender), for each attachment received
    bootAccess: null,
    recent: [], // last messages received, restored to Claude after a compaction
    tasks: new Map(), // worker: its coordinator's messages awaiting a final report (id -> {at, started})
    stopAsked: false, // the Stop hook already asked for that report once
    joinedGroups: new Set(),
    relayIds: new Set(), // message ids of the permission requests this session sent
    toolInputs: [], // the last tool calls' exact inputs (from the hooks), for the relay
    timers: [],
    pollAbort: null,
    status: 'connecting', // connecting | online | error
    error: '',
    since: Date.now(),
  }
}

export const active = s => S === s && s !== null && !shuttingDown

export let shuttingDown = false
export function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down')
  const s = S
  if (s) {
    for (const t of s.timers) clearInterval(t)
    try { s.pollAbort?.abort() } catch {}
    releasePidFile(s)
    void s.observer?.stop()
    if (s.secret) void call('releaseSession', { instance: s.instance, reason: 'exit' }, { s }).catch(() => {})
  }
  setTimeout(() => process.exit(0), 500)
}
