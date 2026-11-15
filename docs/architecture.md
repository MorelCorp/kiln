# Kiln architecture

Kiln is a local software factory. It reads a project's GitHub issues, decides what
is ready, and launches sandboxed coding agents to work on them, under a pace that
you set from a local command center.

## Principles

1. **The loop is plain software.** The scheduler is ordinary TypeScript: it polls,
   compares, and launches. No LLM decides what runs next. Agents are leaves the loop
   launches; they never orchestrate one another.
2. **Use the subscription, not the API.** Agents are Claude Code CLI processes in
   print mode (`claude -p --output-format stream-json`), authenticated with
   `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). `ANTHROPIC_API_KEY` must
   **not** be set in Kiln's environment, or the CLI bills the API instead.
3. **Isolation by default.** Every agent runs through
   [sandcastle](https://github.com/mattpocock/sandcastle) in a bubblewrap sandbox
   (`bwrap()`), on its own git worktree and branch (`branchStrategy: { type: "branch" }`).
   Your checkout is never touched.
4. **One provider today, many later.** Model access goes through a `ModelProvider`
   interface (`src/providers/types.ts`). Only `claude-code` exists now. Places that
   assume Claude are marked `// PROVIDER-SEAM:`, so they are easy to find when a
   second provider or subscription is added.

## Components

```
┌───────────────────────── Command center (web UI, localhost) ─────────────────────────┐
│ project picker │ task board (triage / ready / running / done) │ pace │ tokens │ chat │
└───────────────────────────────▲──────────────────────────────────────────────────────┘
                                │ HTTP + SSE (localhost only)
┌───────────────────────────────┴────────────── kiln daemon ───────────────────────────┐
│ Loop (scheduler)   polls GitHub, applies pace, launches/stops runs                   │
│ Task source        GitHub issues via `gh` → triage / ready / human / done            │
│ Run manager        one sandcastle run() per task, AbortController per run            │
│ Event bus          agent stream events → SSE to UI + JSONL log per run               │
│ Ledger (SQLite)    runs, token usage per iteration, chat sessions                     │
│ Provider registry  claude-code (subscription)  [future: others]                       │
└───────────────────────────────┬──────────────────────────────────────────────────────┘
                                │ sandcastle.run({ agent, sandbox: bwrap(), branchStrategy })
                     ┌──────────┴──────────┐
                     │ claude -p (sandbox) │  × N, on worktree `kiln/issue-<n>`
                     └─────────────────────┘
```

### Task states (from GitHub labels)

The label names are configured per project. Defaults follow a common triage vocabulary:

| Kiln state | Rule |
|---|---|
| triage | open, has `needs-triage`, `needs-info` or `idea` |
| ready | open, has `ready-for-agent`, no triage label |
| human | open, has `ready-for-human` (shown, never run by agents) |
| running | Kiln has a live run for it (Kiln also adds the `kiln:running` label) |
| done | closed recently, or has an open PR from a `kiln/*` branch |

Ready tasks are ordered by `priority:next` before `priority:later`, then by issue number.

### Pace ("rhythm of work")

Set in the UI and kept in the config:

- `maxConcurrentAgents`: how many runs at once.
- `modelCeiling`: the largest model the loop may pick (`haiku` < `sonnet` < `opus`).
  A task can ask for less through a `model:sonnet`-style label, but never more than the ceiling.
- `effortCeiling`: `low` … `max`, passed as `--effort`.
- `tokenBudget`: a soft limit per rolling window. The loop stops starting new runs once
  Kiln's own usage passes it. Runs already going are left to finish.
- `paused`: stop launching. Running agents continue unless stopped.

On tokens: the subscription limits by usage window, not by cost. Kiln counts the tokens its own
runs use (sandcastle reports `usage` per iteration), and reads the whole subscription's state from
the CLI's `rate_limit_event` stream events (`five_hour` / `seven_day` utilization, `isUsingOverage`).
Extra usage is refused by default: see [product.md](product.md#usage-allowance-and-extra-usage).

### Seeing, stopping and redirecting agents

- **See:** `onAgentStreamEvent` (text, tool calls) is pushed over SSE to the UI and appended
  to `~/.local/state/kiln/runs/<id>.jsonl`.
- **Stop:** each run has its own `AbortController`. Aborting kills the agent process and
  keeps the worktree, so the work can be inspected or resumed.
- **Redirect:** abort the run, then start a new run with
  `resumeSession: <captured session id>` and your message as the prompt, on the same branch.
  The agent keeps its whole conversation and receives your instruction as the next turn.

### Chat

The chat panel runs `claude -p --resume <id>` on the host, read-only (`--permission-mode plan`),
with the active project as its working directory. It answers questions about the project and
the factory state. It does not edit code; work goes through issues and runs.

## Stack

- Node 24 + TypeScript, run with `tsx` (sandcastle is a TS library, so the daemon is too).
- `node:sqlite` for the ledger (no native build).
- `gh` CLI for GitHub, using your existing login.
- Web UI: Vite + React, served by the daemon on `127.0.0.1` only.

## Open questions

- **Worktree vs container:** start with `bwrap()` + worktree (light, uses host tools).
  Move to `docker()` per project if an agent needs services (Postgres, k8s) the host should not share.
- **Merging:** agents push their branch and open a PR. Kiln never merges to `main` by itself.
- **Per-project agent prompt:** read from `<project>/.kiln/prompt.md` if present, otherwise Kiln's default.
