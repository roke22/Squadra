/**
 * Where a session's plugin listens for its hooks: a unix socket named after
 * the Claude Code process (the parent of both the plugin and its hooks).
 *
 * Unix socket paths are short: 104 bytes on macOS, 108 on Linux. The usual
 * place, ~/.claude/channels/squadra/run/, fits on most machines, but not with a
 * long home or CLAUDE_CONFIG_DIR (typical on macOS, where temporary folders
 * live under /var/folders/…). Then the socket goes to /tmp/squadra-<uid>-<tag>,
 * a private folder per user and per config dir, which must be ours: in a
 * shared /tmp anyone could create it first.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, lstatSync, statSync, realpathSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, userInfo, platform } from 'node:os'
import { join, isAbsolute, resolve, sep, dirname, basename } from 'node:path'

// Claude Code's configuration folder: CLAUDE_CONFIG_DIR, or ~/.claude in the
// home from the user database ($HOME can be changed by a project's settings).
// A CLAUDE_CONFIG_DIR that could belong to the project is ignored: a
// repository could otherwise bring its own Squadra settings (another server,
// other identities). That is anything inside the highest folder above the
// session's folder that doesn't contain the home folder (for a project in
// ~/code/app that is ~/code; for one in /tmp/x/app, all of /tmp).
// Why a CLAUDE_CONFIG_DIR was ignored (for the plugin's log), or null.
export let configDirNote = null
export function claudeConfigDir() {
  let home
  try { home = userInfo().homedir || homedir() } catch { home = homedir() }
  const c = process.env.CLAUDE_CONFIG_DIR
  configDirNote = null
  if (c && isAbsolute(c)) {
    const dir = realNearest(c), h = realNearest(home)
    // (Without a working folder — deleted — where the project is can't be
    // told: then it isn't used.)
    let cwd = null
    try { cwd = realNearest(process.cwd()) } catch {}
    let top = null
    if (cwd) {
      for (let d = cwd; !within(h, d); d = dirname(d)) {
        top = d
        if (dirname(d) === d) break
      }
    }
    // And only folders of this user that others can't write to: the folder,
    // channels/ and channels/squadra/ in it, and every folder above it (root's,
    // or sticky like /tmp, are fine above), judged by their real paths. A
    // missing one counts by the nearest folder above it that exists.
    const state = realNearest(join(dir, 'channels', 'squadra'))
    if (!cwd) configDirNote = `CLAUDE_CONFIG_DIR ${c} not used: the working folder is gone`
    else if (top && within(dir, top)) configDirNote = `CLAUDE_CONFIG_DIR ${c} not used: it is inside the project's folders`
    else if (!safeChain(state, within(state, dir) ? dir : state)) configDirNote = `CLAUDE_CONFIG_DIR ${c} not used: it (or a folder above it) isn't this user's or others can write to it`
    else return dir
  }
  return join(home, '.claude')
}

// Whether p is folder d or inside it: by its spelling, and by the folders'
// identity (device and inode) — on file systems that ignore case or Unicode
// normalization (macOS, WSL's /mnt/c, casefold folders) "~/CODE/x" and
// "~/code/x" are the same folder, spelled differently.
export function within(p, d) {
  if (p === d || p.startsWith(d.endsWith(sep) ? d : d + sep)) return true
  let id
  try { const st = statSync(d, { bigint: true }); id = `${st.dev}:${st.ino}` } catch { return false }
  for (let x = p; ; x = dirname(x)) {
    try { const st = statSync(x, { bigint: true }); if (`${st.dev}:${st.ino}` === id) return true } catch {}
    if (dirname(x) === x) return false
  }
}

// A path's real one: the nearest folder that exists, resolved, plus the
// part that doesn't exist yet.
export function realNearest(p) {
  const tail = []
  for (let d = resolve(p); ; d = dirname(d)) {
    try { return join(realpathSync(d), ...tail.reverse()) } catch {}
    if (dirname(d) === d) return resolve(p)
    tail.push(basename(d))
  }
}

// A group only this user is in (the same rule as squadra-host): named after
// the user, with no other member on any /etc/group line with that gid and no
// other account having it as its main group; for an account from a directory
// service, its gid must be its uid and getent must show no other member.
// On macOS (everyone's group is "staff") never.
let privateGroupMemo = null
export function privateGroup(gid) {
  if (typeof process.getgid !== 'function' || gid !== process.getgid() || platform() === 'darwin') return false
  if (privateGroupMemo && privateGroupMemo.gid === gid) return privateGroupMemo.ok
  let ok = false
  try {
    const me = userInfo().username
    const lines = text => text.split('\n').map(l => l.split(':')).filter(f => f.length > 3 && Number(f[2]) === gid)
    const alone = groups => groups.length > 0 && groups.every(f => f[0] === me && f[3].split(',').map(x => x.trim()).filter(Boolean).every(m => m === me))
    const local = lines(readFileSync('/etc/group', 'utf8'))
    const passwd = readFileSync('/etc/passwd', 'utf8').split('\n').map(l => l.split(':'))
    const others = passwd.filter(f => f.length > 3 && Number(f[3]) === gid && f[0] !== me)
    if (passwd.some(f => f[0] === me)) ok = alone(local) && others.length === 0
    else if (gid === process.getuid() && others.length === 0 && local.every(f => f[0] === me)) {
      const getent = ['/usr/bin/getent', '/bin/getent'].find(f => existsSync(f))
      if (getent) ok = alone(lines(execFileSync(getent, ['group', String(gid)], { encoding: 'utf8', timeout: 5000 })))
    }
  } catch {}
  privateGroupMemo = { gid, ok }
  return ok
}

// path and its parents up to `/` are fine for keeping private files: below
// `upTo` (included) ours and not writable by others; above it ours or root's,
// and not writable by others (anyone or a shared group) unless sticky.
export function safeChain(path, upTo) {
  const me = typeof process.getuid === 'function' ? process.getuid() : null
  let below = true
  for (let d = resolve(path); ; d = dirname(d)) {
    let st = null
    try { st = lstatSync(d) } catch (err) { if (err.code !== 'ENOENT') return false }
    if (st) {
      // (A symlink anywhere on the way is refused: callers pass real paths,
      // so one here means part of it doesn't exist yet and wasn't resolved.)
      if (st.isSymbolicLink() || !st.isDirectory()) return false
    }
    if (st) {
      if (below) {
        // Group-writable is fine only for this user's private group (umask 002 systems).
        const groupOk = !(st.mode & 0o020) || privateGroup(st.gid)
        if ((me !== null && st.uid !== me) || (st.mode & 0o002) || !groupOk) return false
      } else {
        // Above it: ours or root's, and nobody else can rename what is in it
        // (anyone, or a shared group, writing there without the sticky bit).
        // The same rule as squadra-host's (root's group and macOS's admin are fine).
        const sticky = !!(st.mode & 0o1000)
        const groupOk = !(st.mode & 0o020) || sticky || privateGroup(st.gid) || st.gid === 0 || (platform() === 'darwin' && st.gid === 80)
        if ((me !== null && st.uid !== me && st.uid !== 0) || ((st.mode & 0o002) && !sticky) || !groupOk) return false
      }
    }
    if (d === resolve(upTo)) below = false
    if (dirname(d) === d) return true
  }
}

const MAX_SOCKET_PATH = 100

export function socketDirFor(runDir) {
  if (Buffer.byteLength(join(runDir, '4194304.sock')) <= MAX_SOCKET_PATH) return runDir
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u'
  const tag = createHash('sha256').update(runDir).digest('hex').slice(0, 10)
  return join('/tmp', `squadra-${uid}-${tag}`)
}

export const socketPathFor = (runDir, pid) => join(socketDirFor(runDir), `${pid}.sock`)

// A folder only this user can use: owned by us, no access for group or others.
export function isPrivateDir(dir) {
  try {
    const st = lstatSync(dir)
    if (!st.isDirectory()) return false
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false
    return (st.mode & 0o077) === 0
  } catch {
    return false
  }
}

// Create the socket folder. The fallback in /tmp is refused unless it is private.
export function prepareSocketDir(runDir) {
  const dir = socketDirFor(runDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Ours either way (a run/ folder from an older version may be 0755: made private).
  try { const st = lstatSync(dir); if (st.isDirectory() && (typeof process.getuid !== 'function' || st.uid === process.getuid())) chmodSync(dir, 0o700) } catch {}
  return isPrivateDir(dir) ? dir : null
}
