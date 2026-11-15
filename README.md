# Kiln

A local software factory. Pick a project, see its GitHub board (triage / ready / running / done),
set the pace, and let sandboxed Claude Code agents work the ready issues, with you in the loop
for plans, reviews and tests that need a human.

Status: early. See [docs/roadmap.md](docs/roadmap.md).

## How it works

- A plain TypeScript loop (no LLM in the scheduler) polls a project's GitHub issues.
- Each task runs as a `claude -p` agent on your Claude subscription, inside a
  [sandcastle](https://github.com/mattpocock/sandcastle) sandbox, on its own git worktree and branch.
- Simple tasks merge themselves after a gate (rebase, the project's checks, a reviewer agent);
  risky ones wait for your plan approval and PR review.
- A local web command center shows the board, live agents, what needs you, environments and usage.

Details: [docs/architecture.md](docs/architecture.md), [docs/product.md](docs/product.md).

## Setup

```bash
npm install
git config core.hooksPath .githooks       # secret + privacy pre-commit check

mkdir -p ~/.config/kiln && chmod 700 ~/.config/kiln
cp examples/kiln.config.example.json ~/.config/kiln/config.json   # then edit
cp .env.example ~/.config/kiln/.env                               # then add your token
claude setup-token                                                # paste into ~/.config/kiln/.env

npm run build:web
npm start                     # daemon + command center on http://127.0.0.1:7420
```

Other commands:

```bash
npm run kiln -- run <project> <issue>   # one task by hand in the foreground (Ctrl-C aborts, worktree kept)
npm run kiln -- tasks [project]         # print a project's board
npm run dev:web                         # Vite dev server for the UI (proxies the API)
```

Per-project settings (agent prompt, merge-gate checks, risky paths, environments and deploy scripts)
live in the project's own `.kiln/` folder: see [docs/project-files.md](docs/project-files.md).

## Running it for real

Run the daemon from a dedicated clone, not the checkout you develop in (an edit or branch switch there
would change the code the daemon runs):

```bash
git clone https://github.com/<you>/kiln.git ~/kiln-deploy && cd ~/kiln-deploy
npm ci && npm run build:web
scripts/install-service.sh        # systemd user service, logs: journalctl --user -u kiln -f
```

## Kiln improves Kiln

Kiln is always one of its own projects: the project "kiln" points at the clone it runs from and at that
clone's GitHub `origin`, so a fork works on the fork. File issues on your Kiln repo, label them
`ready-for-agent`, and Kiln works them through its own gate (`.kiln/rules.yaml`: typecheck, tests, web
build, privacy scan). Its Environments page then updates and restarts the running Kiln. Set
`"self": false` in `config.json` to turn this off.

To try Kiln without touching GitHub, add a project with `"source": "local"` pointing at a scratch git
repo, then `npm run kiln -- local add <project> "<title>" "<body>"` to create issues.

Set `KILN_HOME` to use another config directory. Your configuration never lives in this repo.

Requirements: Node 24+, git, the GitHub CLI (`gh`, logged in), the Claude Code CLI, and a
sandbox (bubblewrap on Linux, or Docker/Podman).

## License

MIT, see [LICENSE](LICENSE).
