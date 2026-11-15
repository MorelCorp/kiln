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

- **See:** sandcastle's `onAgentStreamEvent` forwards every raw stream-json line. Kiln parses them
  (`src/runs/stream.ts`) into activity events, TodoWrite progress, subagents, per-call usage and
  `rate_limit_event`s, pushes them over SSE and appends them to `~/.local/state/kiln/runs/<id>.jsonl`.
- **Stop:** each run has its own `AbortController`. Aborting kills the agent process and
  keeps the worktree, so the work can be inspected or resumed.
- **Redirect:** abort the run, then start a new run with
  `resumeSession: <session id>` and your message as the prompt, on the same branch.
  The agent keeps its whole conversation and receives your instruction as the next turn.
- **Session store:** the sandboxed CLI runs with `CLAUDE_CONFIG_DIR=~/.local/state/kiln/claude/<provider>`,
  bind-mounted into bwrap, so transcripts are written to the host as the agent works. Sandcastle only
  copies a transcript out of the sandbox's private home when a run *ends*; without this an aborted
  session (redirect, override, extra-usage stop) could not be resumed. Before resuming, the provider
  moves the transcript from the worktree path to the repo path where sandcastle looks for it. If a
  session is gone anyway, Kiln starts a fresh session on the same branch with the message.

### Agent protocol

Agents end their final message with one tagged block, which the loop parses (no model involved):
`<kiln-done>{summary, checklist}</kiln-done>`, `<kiln-question>…</kiln-question>`,
`<kiln-plan>…</kiln-plan>` (risky tasks, plan first) or, for the reviewer,
`<kiln-review>{verdict, notes}</kiln-review>`. The protocol is restated on every resumed turn, because
a resumed session may never have seen it (a planning session resumed to implement). Human decisions
(answers, plan approvals, redirects) are kept on the task and given to the reviewer, which otherwise
only sees the issue text.

### Merge gate

Run by Kiln after `<kiln-done>`: (0) the branch has commits, (1) rebase on the current main on the
host with hooks disabled, (2) the project's checks inside the sandbox, (3) path rules (can only make
the task stricter), (4) a reviewer agent in a fresh session on the same worktree (any change it makes
is reset). Then Kiln pushes and opens the PR and, on GitHub projects, polls the PR's CI checks
(`src/factory/ci.ts`: no agent, no usage; a failed or timed-out check sends the task to `gate_failed`);
simple tasks are then squash-merged, risky ones wait for your
review. Approving a PR returns at once and continues in the background: it re-runs steps 1-2 against the current main first (and waits for CI again, on the pushed head only; Stop and Drop interrupt the wait), so a merge never lands on a
stale branch; a conflict sends the task back to its agent.

A PR merged outside Kiln (approved and merged on GitHub) ends its task as `merged`: the gate and
Approve check the PR first, and each board sync reconciles idle tasks (not during a run or the gate)
whose PR GitHub reports as merged.

### Chat

The chat panel runs `claude -p --resume <id>` on the host, read-only (`--permission-mode plan`),
with the active project as its working directory. It answers questions about the project and
the factory state. It does not edit code; work goes through issues and runs.

## Stack

- Node 24 + TypeScript, run with `tsx` (sandcastle is a TS library, so the daemon is too).
- `node:sqlite` for the ledger (no native build).
- `gh` CLI for GitHub, using your existing login.
- Web UI: Vite + React, served by the daemon on `127.0.0.1` only.

## Code map

| Path | What |
|---|---|
| `src/cli.ts` | `kiln daemon`, `kiln run`, `kiln tasks`, `kiln local add` |
| `src/factory/factory.ts` | Runs, task state machine, pace, usage guard, scheduler loop |
| `src/factory/gate.ts`, `ci.ts` | Merge gate; CI wait |
| `src/factory/envs.ts` | Version probes, merged PRs per environment, deploys |
| `src/factory/assist.ts` | Read-only host agents: triage, quick capture, chat, usage probe |
| `src/runs/stream.ts`, `prompts.ts` | Stream parser and the agent protocol / prompts |
| `src/tasks/source.ts`, `board.ts` | Issues and PRs (GitHub via `gh`, or local), board classification |
| `src/state/db.ts` | SQLite ledger |
| `src/server/` | HTTP + SSE API and view models |
| `web/` | Command center (React + Vite + Tailwind) |
| `.kiln/` | Kiln's own project files (Kiln works on itself) |
| `scripts/install-service.sh`, `deploy-self.sh` | systemd user service; update-and-restart from a deploy clone |

Per-project files (`.kiln/prompt.md`, `rules.yaml`, `envs.yaml`): see [project-files.md](project-files.md).

## Open questions

- **Worktree vs container:** start with `bwrap()` + worktree (light, uses host tools).
  Move to `docker()` per project if an agent needs services (Postgres, k8s) the host should not share.
