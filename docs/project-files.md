# Per-project files: `<project>/.kiln/`

Kiln reads three optional files from the root of each project it runs on. They live in **that project's
repository**, never in Kiln's. All are optional: without them Kiln uses a default agent prompt, runs no
checks, applies no path rules, and shows no environments.

Kiln also adds `.sandcastle/` to the project's `.git/info/exclude` (local only, nothing committed): agent
worktrees live in `.sandcastle/worktrees/kiln-issue-<n>/`.

## `prompt.md`: how agents should work in this repo

Prepended to every agent prompt, before the issue. Point the agent at the project's own conventions;
Kiln appends its own protocol (commit, don't push, how to finish or ask a question).

```markdown
Read CLAUDE.md and docs/contributing.md before changing code. Follow the existing patterns in the
package you touch. Run `make test` for the packages you change. Keep the change focused on the issue.
```

## `rules.yaml`: merge gate

```yaml
# Diffs touching these paths need your PR review, whatever the risk label says.
riskyPaths:
  - "infra/**"
  - "**/migrations/**"
  - "scripts/*deploy*"
  - "**/*secret*"

# Run by Kiln in a sandbox, on the branch rebased onto main, in order. Any failure sends the work back.
checks:
  - name: tests
    run: make test
    timeoutSeconds: 900
  - name: lint
    run: make lint

# How many times the gate may send work back to the agent before escalating to you. Default 1.
maxSendBacks: 1

# An agent producing no output for this long fails the run. Default 900.
idleTimeoutSeconds: 900

# GitHub projects: after opening the PR (and, for PRs that wait for you, after you approve), Kiln waits for
# the PR's CI checks before merging. All pass, or none reported after a 30 s grace period: merge.
# Any fails, or still pending after this many seconds: no merge, the task goes to "gate failed" with the
# check names and links. A poll, so it holds no agent slot and uses no usage. Default 1200 (20 minutes).
ciTimeoutSeconds: 1200

# Optional. The sandbox has a private home, so package caches start empty on every run. Give it
# read-only access to a host cache, and tell the tools where it is. `~` and $HOME are expanded.
sandbox:
  mounts:
    - path: ~/go/pkg/mod/cache/download   # read-only unless `readonly: false`
  env:
    # The host's module cache as a read-only proxy: fast, and agents cannot write to it.
    GOPROXY: "file://$HOME/go/pkg/mod/cache/download,https://proxy.golang.org,direct"
```

Checks run inside the same bubblewrap sandbox as agents, with the host's toolchain. They should not need
network services the sandbox cannot reach.

## `envs.yaml`: environments and deploys

```yaml
envs:
  - id: staging
    name: Staging
    url: staging.example.com
    # Prints the deployed version. If git can resolve it (a tag or a sha), Kiln knows which merged
    # tasks are on this environment.
    probe: curl -fsS https://staging.example.com/version
    health: curl -fsS -o /dev/null -w '%{http_code}' https://staging.example.com/health
    # Run from the project root when you press the button. Output streams into Kiln.
    # The pick reaches the script as $KILN_DEPLOY_CHOICE (validated against this list).
    deploy: ./scripts/deploy-staging.sh --"$KILN_DEPLOY_CHOICE"
    deployLabel: Deploy staging
    # Optional: a toggle next to the button; the first entry is the default.
    deployChoices: [patch, minor, major]
    candidate: git describe --tags --abbrev=0 origin/main

  - id: prod
    name: Prod
    url: example.com
    probe: curl -fsS https://example.com/version
    deploy: ./scripts/promote-prod.sh
    deployLabel: Promote prod
    candidate: curl -fsS https://staging.example.com/version
    # Every check must exit 0 (or be skipped) before the deploy button unlocks.
    gate:
      - name: security report says GO
        # The check: runs on every probe, so keep it fast (60 s cap).
        run: test -f "docs/security/releases/$(curl -fsS https://staging.example.com/version)-GO.md"
        # Optional: the step that produces what the check looks for, run from a button next to the
        # gate. Same rules as a deploy (host, your credentials, output in the history), no time limit;
        # a Stop button ends it (its whole process tree).
        # It gets $KILN_ENV and $KILN_CANDIDATE. It can be an agent run, e.g. claude -p "/security-scan".
        step: ./scripts/security-scan.sh --release
        stepLabel: Run scan
        # Optional: the deploy may go ahead with this gate failing. You tick "skip" and give a reason;
        # both are kept in the deploy history.
        skippable: true
```

Order matters: the first environment is "staging" for the board and the header, the one with id `prod`
(or the last one) is "prod". Commands run with your shell and credentials, on the host: only put commands
here you would run yourself. Kiln never deploys on its own; every deploy is a button press.

A task's manual test checklist (written by its agent) shows up in **Needs you** once the task's merge is
on the checklist's environment.
