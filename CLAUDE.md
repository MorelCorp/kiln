# Kiln

A local software factory: a plain-software loop that reads a project's GitHub issues and
launches sandboxed Claude Code agents (via sandcastle) under a pace set from a local
command center. Read [docs/architecture.md](docs/architecture.md) before changing anything
structural, [docs/product.md](docs/product.md) for the decided behaviour, and
[docs/roadmap.md](docs/roadmap.md) for what is built.

## THIS REPO IS PUBLIC

Nothing about the people or projects using Kiln goes in this repo: no project names, repo
names, hostnames, local paths, emails, tokens, version numbers of real deployments, or
excerpts of real issues. Use neutral examples (`acme/webapp`, `/home/you/src/webapp`).

- **All real configuration lives in `$KILN_HOME`** (default `~/.config/kiln/`):
  `config.json` (projects, pace, providers), `.env` (tokens), `private-terms.txt`
  (words the pre-commit hook blocks), `notes/` (project-specific design notes).
  Kiln never writes into its own checkout at runtime; state goes to `~/.local/state/kiln/`.
- **Per-project files live in that project's repo** (`<project>/.kiln/`), not here. The one
  exception is Kiln's own `.kiln/`: Kiln is always one of its own projects (so it can improve itself),
  and those files must stay generic like the rest of the repo.
- **Pre-commit hook is mandatory:** `git config core.hooksPath .githooks` (run once per clone).
  It runs gitleaks and the private-terms check on staged changes. Never bypass it with `--no-verify`.
- Before any push, run `npm run check:private -- --all` (scans every tracked file).
- Commits use the GitHub noreply address, never a personal email.

## Rules

- **Subscription only.** Agents are `claude -p` processes using `CLAUDE_CODE_OAUTH_TOKEN`.
  Never set or require `ANTHROPIC_API_KEY`; fail loudly at startup if it is set.
- **The loop stays deterministic.** No LLM call in the scheduler. Agents are launched, never launch.
- **Provider seam.** Anything Claude-specific outside `src/providers/claude.ts` gets a
  `// PROVIDER-SEAM:` comment explaining what a second provider would need there.
- **Never merge to a project's main branch without the gate.** Agents push `kiln/*` branches and open PRs.
- **Localhost only.** The daemon binds `127.0.0.1`; there is no auth layer yet.

## Commands

```bash
. ~/.nvm/nvm.sh
npm install
git config core.hooksPath .githooks
npm run typecheck                      # backend + web
npm test                               # unit tests (protocol, stream parser, path rules, board)
npm run build:web                      # build the command center into web/dist (served by the daemon)
npm start                              # daemon + loop + UI on 127.0.0.1 (port from config)
npm run kiln -- run <project> <issue>  # one task by hand, foreground
npm run kiln -- tasks [project-id]     # show a project's task board (uses $KILN_HOME/config.json)
npm run check:private -- --all         # privacy + secret scan of all tracked files
```

Run Kiln for real from a separate deploy clone, not from this checkout:
`scripts/install-service.sh` in that clone installs a systemd user service; Kiln's Environments page
(project "kiln") updates and restarts it with `scripts/deploy-self.sh`.

To test without real projects, point `KILN_HOME` and `KILN_STATE` at scratch dirs with a
`"source": "local"` project on a throwaway git repo (`npm run kiln -- local add ...` creates issues).
Never test against a real project's GitHub without asking.

## Agent skills

### Issue tracker

GitHub Issues on `MorelCorp/kiln`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical vocabulary: `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`, as GitHub labels (`ready-for-agent` is what Kiln picks up). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root (created lazily). See `docs/agents/domain.md`.
