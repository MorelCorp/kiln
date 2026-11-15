# Kiln roadmap

Each milestone should be usable on its own.

- [x] **M0: Skeleton.** Repo, architecture, config, provider seam, `kiln tasks <project>` reads the GitHub board.
- [ ] **M1: One agent, by hand.** `kiln run <project> <issue>` launches one sandcastle run (bwrap + branch
      `kiln/issue-<n>`), streams to the terminal, records tokens, opens a PR. Ctrl-C aborts.
- [ ] **M2: Daemon + loop.** Long-running process: poll, apply pace, run N agents, SQLite ledger, HTTP/SSE API.
- [ ] **M3: Command center.** Project picker, task board, live run view, stop button, pace controls, token panel.
- [ ] **M4: Redirect + chat.** Abort and resume with a message; chat panel (read-only Claude on the project).
- [ ] **M5: Hardening.** Rate-limit backoff, crash recovery (re-attach to worktrees), per-project Docker option.
- [ ] **Later:** second model provider / second subscription behind `ModelProvider`.
