# Security policy

Squadra relays messages between Claude Code sessions and exposes a web dashboard, so security matters to us. Thank you for looking.

## Reporting a vulnerability

Please do **not** open a public issue. Use [GitHub private vulnerability reporting](https://github.com/roke22/Squadra/security/advisories/new) or email the address on the [maintainer's profile](https://github.com/roke22). You will get an answer within a few days, and a fix in a release before any public disclosure.

## Supported versions

Only the latest release gets fixes. Update the dashboard (`git pull`) and run `squadra-host update` on each machine.

## What is in scope

- `squadra-server`: authentication with the server token, the dashboard, the web terminal, the message relay and ACME/HTTPS handling.
- The `squadra` plugin: pairing, allowlists, access policy and what it sends to the server.
- `squadra-host` and the install scripts.

Prompt-injection through channel messages is a known class of risk; the plugin's access control and the coordinator's instructions are designed around it, and reports of bypasses are very welcome.
