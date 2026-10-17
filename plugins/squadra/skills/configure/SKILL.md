---
name: configure
description: Set up the Squadra channel — save the Squadra server URL and token, check identity and review access policy. Use when the user pastes a Squadra server URL or token, asks to configure Squadra, asks "how do I set this up" or "who can reach me", or wants to check channel status.
user-invocable: true
disable-model-invocation: true
allowed-tools:
  - Read
  - Glob
  - Write(~/.claude/channels/squadra/**)
  - Edit(~/.claude/channels/squadra/**)
---

# /squadra:configure — Squadra Channel Setup

Writes the Squadra server URL and token to the shared `.env` and orients the
user on identity and access policy. The channel server reads them at boot.

**Find the directories first:** call the Squadra MCP server's `status`
tool. Its `Files:` line gives `config <root>/.env` and, when logged in,
`state <state>`.

`<root>` holds `.env` (shared by every session on this machine). `<state>`
holds this session's `identity.json` and `access.json`. This skill only edits
files under `~/.claude/channels/squadra/`; elsewhere Claude Code asks first.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read the files and give the user a complete picture:

1. **Server** — check `<root>/.env` for `SQUADRA_URL` and `SQUADRA_SERVER_TOKEN`.
   Show the URL, and the token as set/not-set (if set, only its first 4 chars).
2. **Session** — call Squadra MCP server's `status` tool: it tells whether
   the channel is enabled in this session and whether it's logged in, with
   which name and role. If it isn't logged in, the user joins with
   `/squadra:login coordinator` or `/squadra:login <worker-name>`.
3. **Identity** — if logged in, check `<state>/identity.json` exists (never
   print the secret). Missing = it will be registered on the next login.
4. **Access** — read `<state>/access.json` (missing file = defaults:
   `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed sessions: count and names
   - Pending pairings: count, with codes and session names if any
5. **What next** — end with a concrete next step based on state:
   - No URL or token → *"Run `/squadra:configure <url> <server-token>`."*
   - URL and token set, not logged in → *"Join with `/squadra:login
     coordinator` or `/squadra:login <worker-name>`."*
   - Coordinator with nobody allowed → *"Start the workers and log them in;
     each one greets you and you'll see a pairing request here. Approve with
     `/squadra:access pair <code>`."*
   - Everyone paired → *"Ready."*

**Push toward lockdown — always.** `pairing` is a temporary way to let new
sessions in. Once every expected session is paired, offer to run
`/squadra:access policy allowlist`. Never frame `pairing` as the correct
long-term choice.

Launch command to show when useful. Channels can only be enabled when Claude
Code starts, so every Squadra session must be launched like this (an alias makes
it one word):

```bash
alias claude-squadra='claude --dangerously-load-development-channels plugin:squadra@squadra'
claude-squadra          # then, inside: /squadra:login coordinator   or   /squadra:login worker1
```

### `<url> <token>` — save them

1. The first argument is the URL (`http://` or `https://`, no trailing
   slash). The second is the **join token** the server printed at startup
   (it starts with `sj_`). Trim whitespace. Refuse values with spaces or line
   breaks.
2. If the token is the server's admin token instead (the one used to sign in
   to the dashboard), say that it works but should stay in the browser: a
   machine only needs the join token.
3. Warn if the URL is plain `http://` to anything other than `localhost` /
   `127.0.0.1`: the token and every message would travel unencrypted.
4. Read existing `<root>/.env` if present; update/add the `SQUADRA_URL=` and
   `SQUADRA_SERVER_TOKEN=` lines, preserve other keys. Write back, no quotes.
   (The channel server makes the file private, mode 600, when it starts.)
5. Confirm, then show the no-args status.

### `observe <off|activity|full>` — default observation level

What Squadra's web dashboard sees of the sessions on this machine, unless
`/squadra:login … --observe` says otherwise:
- `off`: nothing.
- `activity`: what each session is doing (tool names with short arguments,
  state, context size). No Claude text, no tool output.
- `full` (default): also Claude's text, prompts in full, and tool inputs
  and outputs, trimmed. Obvious secrets are masked, but code and command
  output do reach the server.

Update/add the `SQUADRA_OBSERVE=` line in `<root>/.env` (preserve other
keys). Applies to the next `/squadra:login`.

### `clear` — remove the server settings

Delete the `SQUADRA_URL=` and `SQUADRA_SERVER_TOKEN=` lines (or the file if those
are the only lines).

### `reset-identity` — forget this session's identity

Use when the server answers 409 ("identity already registered") or 401 for
this name, e.g. after moving to a new machine without copying
`<state>/identity.json`.

1. Explain: a name belongs to whoever registered it first, and only the
   server's admin can free it. Any other machine still using the old secret
   for this name stops working.
2. Tell the user to do two things themselves (do not do them for them):
   - in the dashboard, open the session's ⋯ menu and **Delete** it (it must
     be disconnected);
   - delete this machine's copy: `rm <state>/identity.json`.
3. Then restart this session and log in again: the name is registered anew.

---

## Implementation notes

- Missing files = not configured, not an error.
- The channel server reads `.env` and `identity.json` once at boot. Changes
  need a session restart or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/squadra:access` take effect immediately, no restart (unless static mode).
- Never print the server token or the identity secret in full.
