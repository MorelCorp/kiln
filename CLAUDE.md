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
- **Per-project files live in that project's repo** (`<project>/.kiln/`), not here.
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
npm run typecheck
npm run kiln -- tasks [project-id]     # show a project's task board (uses $KILN_HOME/config.json)
npm run check:private -- --all         # privacy + secret scan of all tracked files
```
