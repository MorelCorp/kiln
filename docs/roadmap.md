# Kiln roadmap

Each milestone should be usable on its own.

- [x] **M0: Skeleton.** Repo, architecture, config, provider seam, `kiln tasks <project>` reads the GitHub board.
- [x] **M1: One agent by hand.** `kiln run <project> <issue>`: one sandcastle run (bwrap, branch `kiln/issue-<n>`,
      project prompt from `<project>/.kiln/prompt.md` or a default), events streamed to the terminal and to
      JSONL in `~/.local/state/kiln/runs/`, usage and `rate_limit_event` captured, abort on extra usage,
      Ctrl-C aborts (worktree kept), Kiln (not the agent) pushes the branch and opens the PR, `kiln:running` label.
- [x] **M2: Merge gate + daemon.** Gate: rebase on main, project checks (in the sandbox), path rules,
      reviewer agent (fresh session) with approve / revise / escalate. Plan-then-approve for risky tasks.
      Daemon loop with pace and usage headroom; SQLite ledger (`node:sqlite`); HTTP + SSE API on 127.0.0.1.
- [x] **M3: Command center.** React + Vite + Tailwind. Board + Agents at work, Runs (live activity, stop,
      redirect, per-task model/effort override), Needs you, Review (plan / diff / gates / issue), Pace and
      Chat popups.
- [x] **M4: Humans in the loop.** Agent questions (pause, answer resumes the session), test checklists
      (a failure starts a fix run on a fresh branch), triage agent drafts, New task quick capture
      (questions, draft, create), chat with proposed actions.
- [x] **M5: Environments, tokens, hardening.** Version probes, merged PRs per environment, deploy / promote
      buttons with release gates and streamed logs; tokens page (windows, live rate, 14-day chart, per task);
      extra-usage guard with automatic resume after the window resets; rate-limit backoff (5 → 40 min, or
      the window reset); tasks interrupted by a Kiln restart resume by themselves (sessions persist on disk);
      `copyToWorktree` and sandbox mounts/env per project; systemd user service and self-deploy script.
- [x] **M6: Kiln improves Kiln.** Kiln is always one of its own projects (its checkout's `origin`, so a fork
      works on the fork), with its own `.kiln/` gate (typecheck, tests, web build, privacy scan).
- [ ] **Later:** per-project Docker sandbox (for agents that need services such as a database); second
      provider / second subscription behind `ModelProvider`; phone access via Tailscale + auth.

## Known limits

- A task merged by Kiln is matched to an environment by git ancestry: the version probe must print
  something `git rev-parse` resolves (a tag or a sha) for the board's Staging / Prod columns to fill.
- The local source (`"source": "local"`) exists for trying Kiln on a scratch repo; it has no PR review UI
  outside Kiln.
