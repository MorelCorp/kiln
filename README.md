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

npm run kiln -- tasks
```

Set `KILN_HOME` to use another config directory. Your configuration never lives in this repo.

Requirements: Node 24+, git, the GitHub CLI (`gh`, logged in), the Claude Code CLI, and a
sandbox (bubblewrap on Linux, or Docker/Podman).

## License

MIT, see [LICENSE](LICENSE).
