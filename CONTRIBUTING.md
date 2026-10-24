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
npm test                         # end-to-end, host, security and upgrade tests (needs tmux)
```

Node 22.13 or newer. The tests run on Linux and macOS in CI; Windows is supported through WSL.

## Pull requests

- One change per pull request, with a short title that says what changed for the user, in the style of the existing commits (`Dashboard: reopen a session that ended`).
- Add or update a test in `test/` when you change behaviour.
- Keep both languages in step: the English and Spanish READMEs and `docs/reference.md` / `docs/referencia.md` describe the same thing.
- No new runtime dependencies in the server or the plugin without discussing it first.

## Code of conduct

Be kind and assume good faith. Harassment of any kind is not welcome here.
