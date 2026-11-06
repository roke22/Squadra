# Contributing to Squadra

Thanks for helping. Squadra is small on purpose: one Node.js server with no dependencies, one Claude Code plugin, one installer. Keep changes in that spirit.

## Before you start

- **Bugs:** open an [issue](https://github.com/roke22/Squadra/issues/new/choose) with the bug template. Include your OS, Node version, how you run the server (node or Docker) and the relevant lines of `squadra-server` or `squadra-host` output.
- **Ideas:** open an issue with the feature template, or start a [discussion](https://github.com/roke22/Squadra/discussions) if it is still vague.
- **Security:** do not open a public issue. Email the address on the [GitHub profile](https://github.com/roke22) instead.

## Running it locally

```bash
git clone https://github.com/roke22/Squadra.git squadra && cd squadra
node server/server.js            # dashboard at http://127.0.0.1:7787
npm test                         # module rules, end-to-end, host, security and upgrade tests (needs tmux)
npm install && npm run test:ui   # the dashboard in a browser (uses your Chrome)
```

Node 22.13 or newer. The tests run on Linux and macOS in CI; Windows is supported through WSL. `npm install` only brings Playwright, for `test:ui`: the server, the plugin and `squadra-host` need nothing from npm. With another browser, set `PLAYWRIGHT_CHANNEL`, or run `npx playwright install chromium` and set `CI=1`.

## How the code is divided

The server and the plugin are divided into modules by subject (`server/messaging/`, `plugins/squadra/core/`…). `test/modules.test.mjs` holds the list and checks the rules on every `npm test`:

- A module uses another only through its `index.js`, and only if the list allows it. Dependencies go one way, with no circles.
- A new folder has to be added to the list, with what it may use.
- A server module is a factory that receives what it uses (`createMessaging(platform, { sessions })`), keeps its state inside and tells the others what happened through the internal bus. `server/company.js` calls them once per company, so nothing about sessions or machines is kept at the top of a file: names mean nothing outside their company. What is the whole server's (the server token and key, limits per address, the log) is in `server/platform/`, and `server/companies.js` keeps the companies and says which one a credential belongs to. A plugin process is one session, so the plugin uses plain modules instead.
- `plugins/squadra/core/` is what any agent could reuse: it doesn't use `plugins/squadra/claude/`, and asks the agent for what it needs through `core/agent.js`. `observe.js`, `paths.js` and `signing.js` stay at the plugin's top, because `hook.js` and the tests use them too.
- `host/squadra-host.mjs` stays a single file, because that is what machines download and verify. What it knows about Claude Code is in one section, and the rest uses it through the `claudeCode` object.
- There is no shared folder: the host can't import anything and the plugin installs from its own folder. The few security checks both need are written twice, and a test in `test/modules.test.mjs` keeps them the same. If you change one, change the other.

## Pull requests

- One change per pull request, with a short title that says what changed for the user, in the style of the existing commits (`Dashboard: reopen a session that ended`).
- Add or update a test in `test/` when you change behaviour.
- Keep both languages in step: the English and Spanish READMEs and `docs/reference.md` / `docs/referencia.md` describe the same thing.
- No new runtime dependencies in the server or the plugin without discussing it first.

## Releases

The steps are in [RELEASE.md](RELEASE.md). `squadra-host update` only installs a program signed with the key in `RELEASE_PUBLIC_KEY`, so a change to `host/squadra-host.mjs` needs no signature in its own pull request: it gets one when the next release is prepared.

Docker images and GitHub Actions are fixed by digest. Dependabot opens a pull request when there is a new one; don't merge those without reading them, that review is the point of fixing them.

## Code of conduct

Be kind and assume good faith. Harassment of any kind is not welcome here.
