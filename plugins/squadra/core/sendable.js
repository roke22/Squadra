// Which files a session may send: never the places where credentials live.

import { userInfo, homedir } from 'node:os'
import { join, isAbsolute, sep, basename, dirname } from 'node:path'
import {
  realpathSync, lstatSync, statSync, openSync, constants as FS, fstatSync, readSync, closeSync, existsSync,
} from 'node:fs'
import { claudeConfigDir } from '../paths.js'
import { maskOutgoing } from '../observe.js'
import { ROOT_DIR, STATE_BASE, MAX_ATTACHMENT_BYTES } from './settings.js'
import { S } from './session.js'

// reply's files: an absolute path to a regular file, never one of the places
// where credentials live. Another session asking for ~/.ssh/id_ed25519 or a
// .env is exactly what a prompt injection would do; if the user really wants
// to share such a file, they can copy it somewhere else first.
// The user's home from the user database: a project can't move it with $HOME.
const HOME = (() => { try { return userInfo().homedir || homedir() } catch { return homedir() } })()
const SECRET_DIRS = [
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.gcloud',
  join('.config', 'gh'), join('.config', 'gcloud'), join('.config', 'squadra-host'),
  '.claude', // Claude Code's own credentials and settings (the inbox is allowed, below)
  join('.local', 'share', 'keyrings'), '.password-store', '.mozilla', join('.config', 'google-chrome'), join('.config', 'chromium'),
  join('Library', 'Keychains'),
].map(d => join(HOME, d)).concat(
  // Claude Code's config folder when it is somewhere else (transcripts,
  // history), as set and as this plugin resolves it — blocking more is harmless.
  [process.env.CLAUDE_CONFIG_DIR, (() => { try { return claudeConfigDir() } catch { return null } })()].filter(d => d && isAbsolute(d)),
)
const SECRET_NAMES = [
  /^\.env(\..*)?$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /\.(pem|key|p12|pfx|jks|keystore|kdbx)(\.\w+)?$/i,
  /^\.(netrc|git-credentials|npmrc|pypirc|pgpass|vault-token)$/i, /credentials/i, /^\.claude\.json$/i, /secret/i,
  /\.(tfstate|tfvars)(\.\w+)?$/i, /^terraform\.tfstate/i,
  /^\.(yarnrc\.yml|htpasswd|gitconfig|pgpass|my\.cnf|s3cfg|boto)$/i, /^wp-config\.php$/i, /^settings\.local\.json$/i,
  /_history$/i, /^\.(bash|zsh|python|node_repl|psql|mysql)_history$/i, /\.keyring$/i,
  /\.env$/i, /^\.envrc$/i, /^\.dev\.vars$/i, /\.(p8|ppk|gpg|asc|ovpn|token)$/i, /^token$/i, /kubeconfig/i,
  /^service[-_]?account.*\.json$/i, /^auth\.json$/i, /^\.terraformrc$/i, /^rclone\.conf$/i, /^local\.settings\.json$/i, /^hgrc$/i,
  /^krb5cc/i, /^identity\.json$/i, /^signing-key\.json$/i, /^\.?mcp\.json$/i,
  // Squadra's own, on a machine that also runs its server, and its databases.
  /^(server|join)-token$/i, /^server-key$/i, /^(host-key|totp-key)(\.json)?$/i, /\.(db|sqlite3?)(-wal|-shm)?$/i,
  // Variants of the above, which a list of exact names misses.
  /^\.env[-_~.]/i, /^env\./i, /\.env\.\w+$/i, /^\.(npmrc|netrc|pgpass|pypirc|git-credentials)[.~]/i,
  /[_-]key$/i, /_(rsa|dsa|ecdsa|ed25519)(_key)?$/i, /passw(or)?d/i, /^\.dockercfg$/i,
]
// By the folder they are in: their names alone say nothing.
const SECRET_PAIRS = ['.docker/config.json', '.kube/config', '.aws/config']
// The start of a file, looked at for what is masked in messages too: enough to
// catch a key file by any name, without holding up the session on a big file.
// (A safety net, as the list of names is: neither can be complete.)
const SCANNED_BYTES = 64 * 1024

// Any path through a .git folder (its config can hold tokens in remote URLs).
const SECRET_PARTS = [/^\.git$/i]
const inside = (path, dir) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)

// Attachments come from the session's own folder, its inbox or its outbox
// (<state>/outbox): never from elsewhere on the machine — not even the shared
// temp folder, where other programs leave tickets and tokens.
// The session's folder only if it is a project folder: not your home or a
// folder that contains it (then everything in it would be sendable).
function sendableRoots() {
  const real = d => { try { return realpathSync.native(d) } catch { return d } }
  const cwd = real(process.cwd())
  const home = real(HOME)
  // (The inbox and outbox only as real folders: a symlink in their place
  // would make wherever it points sendable.)
  const plainDir = d => { try { const st = lstatSync(d); return st.isDirectory() && !st.isSymbolicLink() } catch { return false } }
  const roots = [S.inboxDir, join(S.stateDir, 'outbox')].filter(plainDir).map(real)
  // Nor a folder anyone can write to (a shared /tmp holds other programs' tickets).
  let shared = true
  try { shared = (statSync(cwd).mode & 0o002) !== 0 } catch {}
  if (!(home === cwd || inside(home, cwd)) && !shared) roots.unshift(cwd)
  return roots
}

// Case-insensitive filesystems exist everywhere (macOS, /mnt/c in WSL, casefold
// mounts): compare paths case-insensitively always. Refusing a bit too much is harmless.
const fold = p => p.toLowerCase()

function sendablePath(f) {
  if (!isAbsolute(f)) throw new Error(`files must be absolute paths: ${f}`)
  let real
  try { real = realpathSync.native(f) } catch { throw new Error(`file not found: ${f}`) }
  if (/^\/(proc|sys|dev)\//.test(real)) throw new Error(`refusing to send a system file: ${f}`)
  // Where it may come from: compared exactly (the real, canonical paths), so
  // a differently-cased folder is never taken for the session's own. What it
  // may NOT be (below) is compared ignoring case: refusing too much is harmless.
  if (!sendableRoots().some(r => inside(real, r))) {
    throw new Error(`refusing to send a file outside this session's folder (${process.cwd()}), its inbox or its outbox (${join(S.stateDir, 'outbox')}): ${f}. Copy it there first if the user wants it shared`)
  }
  // (Hard links — a second name that could hide a key in the project — are
  // refused on the open file, in openSendable.)
  // (Every session's state, not just this one's: a custom state folder can be
  // inside the project, next to the other names' identities.)
  const roots = [ROOT_DIR, STATE_BASE ?? ROOT_DIR, S.stateDir].map(d => { try { return realpathSync(d) } catch { return d } })
  const own = d => { try { return realpathSync(d) } catch { return d } }
  // The inbox and the outbox are the shareable parts of the session's state.
  const plainDir = d => { try { const st = lstatSync(d); return st.isDirectory() && !st.isSymbolicLink() } catch { return false } }
  const inInbox = [S.inboxDir, join(S.stateDir, 'outbox')].filter(plainDir).some(d => inside(fold(real), fold(own(d))))
  if (!inInbox && roots.some(r => inside(fold(real), fold(r)))) throw new Error(`refusing to send channel state: ${f}`)
  const secretDirs = SECRET_DIRS.map(d => { try { return realpathSync(d) } catch { return d } })
  if (!inInbox && secretDirs.some(d => inside(fold(real), fold(d)))) throw new Error(`refusing to send a file from a credentials folder: ${f}`)
  if (SECRET_NAMES.some(re => re.test(basename(real)))) throw new Error(`refusing to send what looks like a credentials file: ${f}`)
  if (real.split(sep).some(part => SECRET_PARTS.some(re => re.test(part)))) throw new Error(`refusing to send a file from a .git folder: ${f}`)
  if (SECRET_PAIRS.includes(real.split(sep).slice(-2).join('/').toLowerCase())) throw new Error(`refusing to send what looks like a credentials file: ${f}`)
  // A server's data folder, wherever it is: its key says so.
  for (let d = dirname(real); dirname(d) !== d; d = dirname(d)) {
    if (existsSync(join(d, 'server-key'))) throw new Error(`refusing to send a file from a Squadra server's data folder: ${f}`)
  }
  return real
}

// Open a file for reply: check where it is (sendablePath), open it without
// following a final symlink, check the open file itself (regular, one link,
// size), confirm the path still leads to that same file, and read it now.
export function openSendable(f) {
  const real = sendablePath(f)
  let fd
  // O_NONBLOCK: a named pipe can't hold this process waiting for a writer.
  try { fd = openSync(real, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0)) } catch { throw new Error(`cannot open ${f} (is it a symlink?)`) }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error(`not a regular file: ${f}`)
    if (st.nlink > 1) throw new Error(`refusing to send a file with several hard links: ${f}`)
    if (st.size > MAX_ATTACHMENT_BYTES) throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
    // A folder on the way swapped for a symlink after the check would land
    // elsewhere: the checked path must still resolve to this very file.
    let again
    try { again = realpathSync(real) } catch { again = null }
    const now = again ? statSync(again) : null
    if (again !== real || !now || now.dev !== st.dev || now.ino !== st.ino) throw new Error(`file changed while sending: ${f}`)
    // Exactly the size checked above, even if the file keeps growing.
    const data = Buffer.alloc(st.size)
    let got = 0
    while (got < st.size) {
      const n = readSync(fd, data, got, st.size - got, got)
      if (n <= 0) break
      got += n
    }
    if (maskOutgoing(data.subarray(0, Math.min(got, SCANNED_BYTES)).toString('utf8')).masked) {
      throw new Error(`refusing to send a file that seems to hold a credential: ${f}. If it doesn't, copy what is needed into the message instead`)
    }
    return { real, data: data.subarray(0, got) }
  } finally {
    closeSync(fd)
  }
}
