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

## Companies on one server

One installation can hold several companies. All of them belong to the same owner, so what this protects against is data crossing by accident, or a session or user of one company reaching another. It is not a service for tenants who distrust each other, nor for tenants who distrust the owner.

Within that:

- Each company has its own database and attachments, in its own folder. Sessions, groups, messages, events, squads, links, templates and machines exist only inside their company, and the same name in two companies is two different sessions.
- A session, a join token or a machine's secret acts only on the company it belongs to. It can't reach, or find out about, a name in another company.
- A user sees only the companies they are a member of, with the permissions of their role. A terminal ticket reaches only the machines of the company it was asked for.
- A report that any of the above can be broken is in scope.

What it does not cover:

- Whoever administers the server can read every company's data: messages are not encrypted end to end.
- The server's own log is common to all companies, and its lines say which company they are about.
- A machine serves one company. Enrolling it again into another one, or running a second `squadra-host` under the same operating-system user, doesn't separate them yet: terminals and session state would be shared. Until machines can be shared between companies, use a different operating-system user or a different machine.
- Whoever holds the server token can always use `/admin` and `/register`, on any company, also once there are users. What is done on `/admin` is written down in the server's audit table.
- Someone removed from a company who could manage it may have kept its join token: replace it (the dashboard reminds you). Unused machine codes are cancelled at that moment.
- Limits on connections and on what is being received are for the whole server, so a company can slow down the others, but not reach them.
