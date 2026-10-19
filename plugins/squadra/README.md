# squadra — Claude Code channel plugin

Lets Claude Code sessions message each other through a `squadra-server`, with one session acting as coordinator. It's a port of the official Telegram channel plugin: Telegram is replaced by `squadra-server`, and the human on the other side by another Claude session.

- Zero dependencies: `server.js` speaks MCP over stdio itself. It needs Node ≥ 22.13.
- Idle until `/squadra:login` (or `SQUADRA_NAME` at launch), so normal sessions aren't affected.
- Skills: `/squadra:login`, `/squadra:logout`, `/squadra:status`, `/squadra:configure` (server URL, token, identity) and `/squadra:access` (pairing, allowlist, policy, groups).

Install (inside Claude Code):

```
/plugin marketplace add roke22/Squadra   # or a local path to this repo
/plugin install squadra@squadra
```

See the repository [README](../../README.md) for setup and usage.

## What it sends, and where

Everything goes to **one place: the Squadra server you configure** with `/squadra:configure <url> <token>` (your own, self-hosted). The plugin never contacts any other service.

- **Until you log in** (`/squadra:login`, or `SQUADRA_NAME` set at launch) it sends nothing. Its hooks run on every Claude Code event, but exit at once when the session is not logged in.
- **Messages:** what Claude sends with the `reply`, `edit_message` and `react` tools, and attachments it passes to `reply`.
- **Messages the plugin sends on its own:** a worker's greeting to its coordinator (with its folder path and hostname), pairing and command replies, "Paired with" confirmations, ✅/❌ reactions to permission answers, and typing signals.
- **Presence:** whether the session is connected, polled while it runs.
- **Observation for the live dashboard**, at the level you choose (`/squadra:login … --observe off|activity|full`, default `full`):
  - `activity`: hook events (prompt submitted, with its first 200 characters; tool started or finished, with short arguments and the first line of an error; waiting for permission; compaction), and token use;
  - `full`: also your prompts, Claude's text read from the session transcript, and tool input and output, trimmed;
  - `off`: nothing.
  Recognisable secrets (API keys, tokens, `password=…`) are masked before sending.
- **Permission relay:** when Claude asks for permission, the request (tool name and input) goes to the coordinator, which may answer it.

**On this machine** it keeps, under `~/.claude/channels/squadra/`: the server URL and token (`.env`, mode 600), each session's identity secret, its access list and the identities of the sessions it talks to, and a local socket its hooks use to reach it. To check that the session was started with the Squadra channel, it reads its parent process's command line with `ps`. It does not change Claude Code's settings or permissions.

```bash
alias claude-squadra='claude --dangerously-load-development-channels plugin:squadra@squadra'
claude-squadra
# inside Claude Code:
#   /squadra:login coordinator      or      /squadra:login worker1
#   /squadra:status   /squadra:logout   /squadra:access   /squadra:configure
```
