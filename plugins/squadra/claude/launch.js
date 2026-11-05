// Whether Claude Code was started so that it delivers this channel.

import { execFileSync } from 'node:child_process'
import { PS_BIN } from '../core/index.js'

// Claude Code only delivers channel notifications if the session was started
// with --dangerously-load-development-channels (or --channels) naming this
// plugin. Without it, login would "work" but nothing would ever reach Claude.
// Look at the parent process command line to tell the user up front.
export function channelLaunchStatus() {
  if (process.env.SQUADRA_ASSUME_CHANNEL === '1') return { ok: true }
  try {
    let pid = process.ppid
    for (let i = 0; i < 3 && pid > 1; i++) {
      const out = execFileSync(PS_BIN, ['-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      const m = out.match(/^(\d+)\s+(.*)$/s)
      if (!m) break
      const args = m[2]
      if (/--(dangerously-load-development-)?channels\b/.test(args)) {
        return /squadra/.test(args) ? { ok: true } : { ok: false, args }
      }
      if (/\bclaude\b/.test(args)) return { ok: false, args }
      pid = Number(m[1])
    }
  } catch {}
  return { ok: null } // couldn't tell (e.g. no ps): allow, with a warning
}

export const WINDOWS_HINT =
  'Squadra does not support native Windows. Run Claude Code inside WSL (Windows Subsystem for Linux), ' +
  'for example Ubuntu, and install the plugin there: everything then works as on Linux. See "Windows (WSL)" in docs/reference.md.'

export const LAUNCH_HINT =
  'Start the session with:\n' +
  '  claude --dangerously-load-development-channels plugin:squadra@squadra\n' +
  'An alias makes it easy: alias claude-squadra=\'claude --dangerously-load-development-channels plugin:squadra@squadra\''
