# Squadra demo (Docker)

The dashboard and one machine that runs Claude Code, in a single container: the quickest way to try Squadra on one computer. For real use, the dashboard and the machines run apart: see the [main README](../../README.md).

## Start it

From the repository root:

```bash
docker compose -f deploy/demo/docker-compose.yml up -d --build
docker compose -f deploy/demo/docker-compose.yml logs    # the sign-in token
```

1. Open **http://localhost:7787** and sign in with the token from the logs (also in `deploy/demo/squadra/data/server-token`).
2. **+ New session**: folder `/squadra/projects/demo`, role *Coordinator*, persona `project-lead`.
3. The first time, Claude Code asks in the session's terminal for its theme, your Claude login (`/login`: open the link, paste the code back) and whether you trust the folder. The login is kept for every later session.
4. From the squad (👥), **+ Worker**: one with the persona `developer`, another with `designer`. Then ask the coordinator for something small.

## Where everything is

All of it lives in `deploy/demo/squadra/`, owned by you:

| Folder | What |
|---|---|
| `data/` | The dashboard: its tokens, sessions, messages and templates |
| `home/` | The container's home: Claude Code's login and settings, the Squadra plugin, the machine's credential |
| `projects/` | Where sessions can be opened. `demo/` is an example project with three personas in `.claude/skills/` |

Put your own projects in `projects/` (or mount another folder there). Delete `deploy/demo/squadra/` to start from scratch.

## Good to know

- Only this computer reaches it (`127.0.0.1:7787`). The server's warning about plain HTTP is about the network: with this setup nothing leaves the computer.
- Claude Code works only on what is in `projects/`: the rest of your computer is not in the container.
- Updating: `git pull`, then the same `up -d --build`. The plugin is the one in this repository, installed again when the image changes; restart open sessions to use it.
- Another port: change `127.0.0.1:7787:7787` to, say, `127.0.0.1:8080:7787` and open http://localhost:8080.
- To stop it: `docker compose -f deploy/demo/docker-compose.yml down` (the folder stays).
