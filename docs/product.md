# Kiln product decisions

Decided in the design session of 2026-11-15. Kiln targets projects that have GitHub issues,
a local dev setup, a staging and a prod environment. Everything project-specific lives in
config outside this repo (`$KILN_HOME/config.json`, default `~/.config/kiln/`) and in the
project's own `.kiln/` folder, never in Kiln's source.

## Task lifecycle

```
Triage → Ready → [Plan → Plan approval]¹ → Running → Gates → [PR review]¹ → Merged
       → On staging → [Test on staging]² → On prod → [Test on prod]² → Done
```
¹ risky tasks only. ² only when the agent's test checklist asks for that environment.

At any step an agent may **pause with a question**; the answer resumes the same session.

## Risk tiers

- Set by a label at triage: `review:auto` or `review:required` (names in config).
- **Path rules** in project config can only make it stricter: a diff touching e.g. `infra/`,
  `**/migrations/**`, auth, secrets is treated as `review:required`, whatever the label says.
- **Simple (auto):** the agent's PR is squash-merged by Kiln once the merge gate passes.
- **Risky (required):** the agent writes a plan and stops; you approve or redirect; it implements;
  you review the PR in Kiln; Kiln merges on your approval.

## Merge gate (all must pass, run by Kiln, not by the agent)

1. Branch rebases cleanly on current `main`.
2. Project check commands (from config: test, lint, typecheck) pass on the rebased branch.
3. A reviewer agent (fresh session) reviews the diff against the issue and can veto: send back
   to the agent with notes, or escalate to you.

Work always goes through a `kiln/issue-<n>` branch and a PR. Nothing is committed to `main` directly.

## Deploys

- Kiln shows, per environment (dev, staging, prod), the deployed version and the merged PRs
  not yet deployed there. Version probes are config (a shell command or URL per env, e.g. reading
  a version ConfigMap with `kubectl`, or a `/version` endpoint).
- **Deploy staging** and **Promote prod** are buttons that run the project's own scripts.
  Promote prod can require a release gate (e.g. a security-scan GO report for the candidate),
  configured per project. Never automatic. A deploy can offer a few options picked next to its
  button (e.g. a patch / minor / major version bump), passed to the script as an env var.

## You in the loop: the "Needs you" inbox

One inbox, in the web app, ordered by how much work it unblocks:
- plan approvals and PR reviews (risky tasks)
- questions from paused agents
- test checklists (env, steps, expected result; tick pass/fail; a fail with a note sends it back)
- gate failures the reviewer escalated, failed runs, rate-limit pauses
- triage drafts to accept

Notifications: in-app only for now.

## Triage

Kiln lists triage issues. A **triage agent** button drafts a spec, risk tier and labels as an issue
comment; you accept or edit in Kiln, which relabels the issue `ready-for-agent`.

## New task (quick capture)

A "+ New task" button on the board (shortcut `N`, or "new task: …" in chat):
1. Describe it in a sentence or two (or save it straight away as an `idea`).
2. A light grill: a small model reads the repo and asks up to 3 multiple-choice questions
   (skippable) about scope and ambiguities it actually found.
3. Kiln drafts the issue (title, body with acceptance criteria, labels, risk-tier guess);
   you create it as `ready-for-agent` or `needs-triage`. Several tasks can be captured in a row.

## Agents

- An agent follows **the project's own workflow**: Kiln's prompt comes from `<project>/.kiln/prompt.md`,
  which typically points the agent at the project's CLAUDE.md, skills and plans.
- **Redirect:** from a running agent's view, send a message; Kiln aborts and resumes the same session
  with it. **Stop:** abort, worktree kept.

## Pace

- Live knobs in the side rail: pause, max concurrent agents, model ceiling, effort ceiling, token budget.
- Per-task override of model and effort from the task's Runs page (or its card). Because you chose it
  by hand, it may go above the ceilings (which cap the loop's automatic choices). On a running
  task it applies at the next step by resuming the same session with the new setting, and it
  sticks for that task's later runs.

## Usage allowance and extra usage

Claude Code emits a `rate_limit_event` in its stream with the **whole subscription's** state
(not only Kiln's): `five_hour` and `seven_day` utilization and reset times, `overageStatus`
(whether the account permits extra usage) and `isUsingOverage`.

- **Extra usage is off by default.** Kiln does not start runs when a subscription window is
  exhausted, and aborts a run as soon as an event shows `isUsingOverage: true`. The worktree and
  session are kept, so the task resumes when the window resets. A few requests' worth of extra
  usage can slip through before the abort lands; the setting is a guard, not a hard cap.
- **Allowing it:** a global switch in Pace (off by default), and a per-task "may use extra usage"
  override. Every run that used extra usage is flagged in the token views.
- **Headroom thresholds:** Kiln stops *starting* runs above a configurable utilization
  (default 90% of the 5-hour window, 95% of the 7-day), leaving room for your own Claude sessions.

## Tokens

Per run and per task; the subscription's 5-hour and 7-day utilization (from `rate_limit_event`)
next to Kiln's own share; daily/weekly trend by model; live tokens-per-minute while agents run.

**Context cap.** A provider's `contextWindow` (default 200000 tokens) is the size an agent's
conversation is held under: the CLI compacts it before it gets there, so long runs never drift into
a huge context where quality drops (1M-context models would otherwise only compact near 1M). Each
live agent shows `ctx <now> / <cap>`, the size of its latest prompt, turning orange at 60% and red
at 85%. This is separate from the token total, which counts every call's input (cache reads included)
and so grows much faster than the context itself.

## Chat

Asks about the project and factory state, and **proposes actions** (create issue, relabel, close an issue
with a comment, change pace, message an agent, stop a run) as buttons you confirm. It never merges or deploys.

## UI

- React + Vite + Tailwind. Home screen per project is a **pipeline board**:
  Triage → Ready → Running → Needs you → Merged → On staging → On prod, with "Needs you" highlighted.
  Side rail: pace, tokens, environment versions, chat.
- Clicking a board card opens a detail modal over the board (issue body, comments, Kiln's state,
  log and PR link); Escape or × closes it and the board keeps its scroll. A GitHub icon in the top right of
  each card and of the modal opens the issue in a new tab. "Needs you" cards still go to their action page.
  An open issue has a **Close issue** button under its description: a box for an optional closing comment
  (posted on the issue) and GitHub's reason (completed / not planned). Closing stops a running agent and
  drops the task.
- Localhost only for now, but responsive and with room for auth so phone access (Tailscale) can come later.
- The UI is validated as a wireframe artifact before it is coded.
