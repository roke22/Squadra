<p align="center"><img src="branding/squadra-logo.svg" width="96" alt="Squadra logo"></p>

<h1 align="center">Squadra</h1>

<p align="center"><b>A coordinator agent that runs squads of Claude Code agents — fast, unattended, and visible live.</b></p>

<p align="center"><a href="README-es.md">Leer en español</a> · v0.0.4</p>

---

Squadra gives [Claude Code](https://claude.com/product/claude-code) a **coordinator**: you tell it what you want, and it splits the work among a squad of **workers** (other Claude Code sessions), follows their progress, approves their safe actions and only comes back to you for the decisions that matter.

A web dashboard shows the whole squad live, like a wall of terminals: what each agent is doing, what Claude is saying, and who is waiting for you. From there you also add your computers and open new sessions on them.

![Squadra dashboard: two squads side by side, each coordinator with its workers](docs/screenshots/mosaic-squads.jpg)

## What you can do with it

- **Build a feature across several repositories at once:** the backend, the web app and the mobile app, each with its own worker, kept in step by the coordinator.
- **Split a big job into parallel pieces:** a migration, a refactor or more tests, one worker per module.
- **Leave it working unattended:** workers decide the technical details and the coordinator approves their safe actions, so the squad keeps going while you are away.
- **Keep watch from anywhere:** every agent live in your browser, and a "Needs you" bar for whoever is waiting for an answer.
- **Use all your computers and accounts:** each agent runs on any machine you add, with that machine's Claude Code login.

## What you need

- **A Claude Code account** with a claude.ai plan (Pro, Max, Team or Enterprise) or an Anthropic Console API key. On Team and Enterprise, an Owner enables *Channels* in the organization settings.
- **A computer for the dashboard,** with [Node.js 22](https://nodejs.org) or Docker. It can be the same computer where your agents run.

The computers where the agents run get everything else installed for them when you add them (see step 2).

## 1. Install the dashboard

```bash
git clone https://github.com/roke22/Squadra.git squadra && cd squadra
node server/server.js
```

Open **http://127.0.0.1:7787** and sign in with the **server token** it prints when it starts (it is also saved in `data/server-token`).

**With Docker** instead:

```bash
docker build -f server/Dockerfile -t squadra-server .
docker run -d --name squadra-server -p 127.0.0.1:7787:7787 -e PUBLIC_URL=http://127.0.0.1:7787 -v squadra-data:/data squadra-server
docker logs squadra-server      # shows the server token
```

**To use it from other computers,** give it a domain: point the domain to this computer, open ports 80 and 443, and start it with

```bash
node server/server.js --domain squadra.example.com --acme-email you@example.com
```

It gets and renews its HTTPS certificate by itself, and the dashboard is at `https://squadra.example.com`. (On Linux, ports 80 and 443 need privileges: run it with `sudo`, or use the Docker image with `-p 80:80 -p 443:443 -e SQUADRA_DOMAIN=squadra.example.com`.)

## 2. Add your computers

In the dashboard, open **🖥️ Machines → + Add machine**, choose the computer's system (Linux, macOS or Windows) and **follow the instructions it shows**: it's a single command to run on that computer. It installs everything it needs and connects it to your dashboard.

Then, still in the dashboard:

1. **+ Folder** on the machine's card: choose the folders where agents may work (your projects).
2. **+ New session**: open a **coordinator**, then its **workers**. Each one opens in a live terminal in your browser. The first time, accept Claude Code's prompts (for the development channel, choose *"I am using this for local development"*).
3. **Talk to the coordinator** in its terminal and tell it what you want done.

## Good tips

- **Use HTTPS** (a domain, step 1) when other computers connect to your dashboard, and keep the server token to yourself: it's the key to the dashboard.
- **Give your coordinator its own repository** with a `CLAUDE.md` describing your team: which worker handles which repository, what counts as done, and what it must always ask you first. Every coordinator you open from it then works the same way.
- **Name workers after what they do** (`api`, `web`, `docs`): the coordinator uses the names to decide who gets each task.
- **One worker per repository or area,** so they don't edit the same files. For parallel work in one repository, give each worker its own [git worktree](https://git-scm.com/docs/git-worktree).
- **Open your own projects,** or repositories you trust, in the agents' folders.
- **Leave room in the context:** with 1M-context models, the dashboard's default of auto-compacting at 600K tokens keeps agents sharp.

## Updating

Update the dashboard (`git pull` and start it again, or rebuild the Docker image), then run `squadra-host update` on each computer. The dashboard tells you which ones are out of date.

## Learn more

- [docs/reference.md](docs/reference.md): setting agents up by hand without the dashboard, every server option, and how it all works.
- [PLAN.md](PLAN.md): the full technical guide (Spanish).

## License

[MIT](LICENSE) — free to use, copy, modify and distribute, for any purpose.
