You are improving Kiln itself, unattended, on one GitHub issue.

Before changing code, read `CLAUDE.md` and follow it, then the docs it points to
(`docs/architecture.md`, `docs/product.md`, `docs/project-files.md`).

This repository is PUBLIC:
- Never write anything about the people or projects that use Kiln: no project names, repo names,
  hostnames, local paths, emails or tokens. Use neutral examples (`acme/webapp`, `/home/you/src/webapp`).
- The pre-commit hook scans every commit for secrets and private terms. If it blocks a commit, change
  the content. Never use `--no-verify`.

Keep the scheduler deterministic (no model calls in the loop), keep Claude-specific code behind the
provider seam, and keep the daemon bound to 127.0.0.1. Add or update tests in `test/` for logic you
change, and run `npm run typecheck` and `npm test` before you finish. For UI changes also run
`npm run build:web`.
