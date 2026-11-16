import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSandbox } from "@ai-hero/sandcastle";
import { bwrap } from "@ai-hero/sandcastle/sandboxes/bwrap";
import { KILN_STATE, loadRules, type ProjectConfig, type ProjectRules } from "../config.ts";
import type { GateState, TaskRow } from "../state/db.ts";
import { git, type IssueDetail, type PullRequest } from "../tasks/source.ts";
import { ciSummary, waitForCi } from "./ci.ts";
import { extractJsonTag } from "../runs/stream.ts";
import { reviewPrompt } from "../runs/prompts.ts";
import type { Factory } from "./factory.ts";

export type GateOutcome =
  | { kind: "merged"; sha: string; /** The PR, when it was merged outside Kiln */ outside?: PullRequest }
  | { kind: "pr_review"; note: string }
  | { kind: "send_back"; note: string }
  | { kind: "escalate"; note: string }
  | { kind: "ci_failed"; note: string }
  /** You stopped or dropped the task during the CI wait: its phase is already set. */
  | { kind: "aborted" }
  | { kind: "error"; note: string };

/** Host git without running any of the project's hooks (the branch is agent-written). */
const safeGit = (cwd: string, args: string[], env?: Record<string, string>) =>
  git(cwd, ["-c", "core.hooksPath=/dev/null", ...args], env ? { env } : {});

/**
 * Re-authors every commit in `base..HEAD` that does not carry `email` as both author and committer.
 * Agents commit with the project clone's git identity, which can be a private address that GitHub
 * refuses to receive (GH007, "push would publish a private email address"). Trees and messages are
 * unchanged; the author name is kept from HEAD. Returns whether anything was rewritten.
 */
export async function reauthorCommits(wt: string, base: string, email: string): Promise<boolean> {
  const idents = (await safeGit(wt, ["log", "--format=%ae%n%ce", `${base}..HEAD`])).split("\n").filter(Boolean);
  if (idents.every((e) => e === email)) return false;
  const name = await safeGit(wt, ["log", "-1", "--format=%an"]);
  const amend = "git -c core.hooksPath=/dev/null commit --amend --no-edit --no-verify --allow-empty --reset-author --quiet";
  try {
    await safeGit(wt, ["rebase", "--quiet", base, "--exec", amend], { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
  } catch (e) {
    await safeGit(wt, ["rebase", "--abort"]).catch(() => undefined);
    throw e;
  }
  return true;
}

/** Go's caches are safe for concurrent use, so every agent and gate check shares this one. */
export const GO_CACHE_DIR = join(KILN_STATE, "go");

/** Mounts and env for `sandbox.go`: a writable cache dir and the variables that point Go at it. */
export function goSandbox(dir = GO_CACHE_DIR) {
  return {
    mounts: [{ path: dir, readonly: false }],
    env: {
      GOPATH: dir,
      GOMODCACHE: join(dir, "mod"),
      GOCACHE: join(dir, "build"),
      // The toolchain dir is read-only inside the sandbox: never try to download another one.
      GOTOOLCHAIN: "local",
    } as Record<string, string>,
  };
}

/** The project's own mounts and env, plus the Go environment when it asks for one (its own values win). */
export function projectSandbox(sandbox: ProjectRules["sandbox"], goDir = GO_CACHE_DIR) {
  const go = sandbox.go ? goSandbox(goDir) : { mounts: [], env: {} };
  if (sandbox.go) mkdirSync(goDir, { recursive: true });
  return {
    mounts: [...go.mounts, ...sandbox.mounts],
    env: { ...go.env, ...sandbox.env },
  };
}

/**
 * The bubblewrap sandbox for a project: the provider's session store plus whatever the project's
 * rules.yaml adds (a Go environment, a read-only package cache, env vars).
 */
export function sandboxFor(f: Factory, p: ProjectConfig) {
  const { sandbox } = loadRules(p);
  const extra = projectSandbox(sandbox);
  if (sandbox.go && !process.env.PATH?.split(":").some((d) => d && existsSync(join(d, "go")))) {
    console.warn(`[kiln] ${p.id}: sandbox.go is set but \`go\` is not on Kiln's PATH; the sandbox will not have it`);
  }
  return bwrap({
    mounts: [
      ...f.provider(p).sandboxMounts(),
      ...extra.mounts.map((m) => ({ hostPath: m.path, sandboxPath: m.path, readonly: m.readonly ?? true })),
    ],
    env: extra.env,
  });
}

export function worktreePath(p: ProjectConfig, branch: string): string {
  return join(p.path, ".sandcastle", "worktrees", branch.replaceAll("/", "-"));
}

/** `**` matches across directories, `*` within one. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

export function riskyMatches(files: string[], globs: string[]): string[] {
  const res = globs.map((g) => [g, globToRegExp(g)] as const);
  const hits = new Set<string>();
  for (const f of files) for (const [g, r] of res) if (r.test(f)) hits.add(g);
  return [...hits];
}

export async function ensureWorktree(p: ProjectConfig, branch: string): Promise<string> {
  const wt = worktreePath(p, branch);
  if (!existsSync(wt)) {
    mkdirSync(dirname(wt), { recursive: true });
    await safeGit(p.path, ["worktree", "prune"]);
    await safeGit(p.path, ["worktree", "add", wt, branch]);
  }
  return wt;
}

const tail = (s: string, n = 3000) => (s.length > n ? "…" + s.slice(-n) : s);

/**
 * Gate steps 0-2: commits exist, rebase on the current base, project checks in the sandbox.
 * Also used when you approve a PR, so a merge always lands on an up-to-date, checked branch.
 */
export async function rebaseAndCheck(
  f: Factory, p: ProjectConfig, task: TaskRow, gate: GateState, save: () => void,
): Promise<{ ok: true; wt: string } | { ok: false; note: string }> {
  const src = f.source(p);
  const rules = loadRules(p);
  const base = src.baseRef();
  await src.fetch();
  const wt = await ensureWorktree(p, task.branch);
  f.ledger.updateTask(p.id, task.number, { worktree: wt });

  // 0. Did the agent commit anything?
  const ahead = Number(await safeGit(wt, ["rev-list", "--count", `${base}..HEAD`]));
  if (!ahead) {
    gate.rebase = "fail";
    save();
    return { ok: false, note: `There are no commits on ${task.branch} ahead of ${base}. Commit your work.` };
  }
  if ((await safeGit(wt, ["status", "--porcelain"])) !== "") {
    await safeGit(wt, ["stash", "push", "--include-untracked", "-m", "kiln: uncommitted leftovers before gate"]);
  }

  // 1. Rebase on current main.
  try {
    await safeGit(wt, ["rebase", base]);
  } catch {
    const conflicts = await safeGit(wt, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
    await safeGit(wt, ["rebase", "--abort"]).catch(() => undefined);
    gate.rebase = "fail";
    save();
    return {
      ok: false,
      note: `Your branch does not rebase cleanly on ${base}${conflicts ? ` (conflicts in: ${conflicts.split("\n").join(", ")})` : ""}. Run \`git rebase ${base}\`, resolve the conflicts, re-run the tests and commit.`,
    };
  }
  // Before anything reads HEAD (the CI wait and the merge match on it): give the commits the
  // identity the source accepts. No fallback: if it cannot be read, the gate fails.
  const email = await src.commitEmail();
  if (email) await reauthorCommits(wt, base, email);
  gate.rebase = "pass";
  save();

  // 2. Project checks, inside the sandbox (the code is agent-written).
  gate.checks = rules.checks.map((c) => ({ name: c.name, status: "pending" as const }));
  if (rules.checks.length) {
    const sb = await createSandbox({
      branch: task.branch, sandbox: sandboxFor(f, p), cwd: p.path,
      copyToWorktree: rules.copyToWorktree.length ? rules.copyToWorktree : undefined,
    });
    try {
      for (const [i, c] of rules.checks.entries()) {
        let out = "";
        const timeout = (c.timeoutSeconds ?? 900) * 1000;
        const res = await Promise.race([
          sb.exec(c.run, { onLine: (l) => (out += l + "\n") }),
          new Promise<{ exitCode: number; stderr: string }>((r) => setTimeout(() => r({ exitCode: 124, stderr: "timed out" }), timeout)),
        ]);
        const ok = res.exitCode === 0;
        gate.checks[i] = { name: c.name, status: ok ? "pass" : "fail", output: tail(out + (res.stderr ?? ""), 4000) };
        save();
        if (!ok) {
          return {
            ok: false,
            note: `The check "${c.name}" (\`${c.run}\`) failed after rebasing on ${base} (exit ${res.exitCode}):\n\n${tail(out + (res.stderr ?? ""), 2500)}`,
          };
        }
      }
    } finally {
      await sb.close().catch(() => undefined);
    }
  }
  return { ok: true, wt: await ensureWorktree(p, task.branch) };
}

/** How often to poll, and how long "no checks yet" may last, while waiting for CI. */
export const CI_POLL_MS = 15_000;
export const CI_GRACE_MS = 30_000;

/**
 * Gate step 5b (GitHub projects): wait for the PR's CI checks before merging. A poll, not an agent:
 * it holds no agent slot and uses no model. Records a "CI" step on the gate and in the PR body.
 */
export async function awaitCi(
  f: Factory, p: ProjectConfig, task: TaskRow, pr: PullRequest, head: string, gate: GateState, save: () => void,
  body?: (g: GateState) => string,
  opts: { pollMs?: number; graceMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: true } | { ok: false; note: string; aborted?: boolean }> {
  const src = f.source(p);
  gate.ci = { status: "pending" };
  save();
  const ctl = f.registerCiWait(p.id, task.number);
  let res;
  try {
    res = await waitForCi(src, pr, {
      head,
      signal: ctl.signal,
      timeoutMs: loadRules(p).ciTimeoutSeconds * 1000,
      graceMs: opts.graceMs ?? f.ciTiming.graceMs,
      pollMs: opts.pollMs ?? f.ciTiming.pollMs,
      sleep: opts.sleep,
      onPoll: (checks) => {
        const out = ciSummary(checks);
        if (out !== (gate.ci?.output ?? "")) {
          gate.ci = { status: "pending", output: out };
          save();
        }
      },
    });
  } finally {
    f.clearCiWait(p.id, task.number, ctl);
  }
  if (res.status === "aborted") return { ok: false, note: res.note, aborted: true };
  const out = ciSummary(res.checks) || res.note;
  const ok = res.status === "pass" || res.status === "none";
  gate.ci = { status: ok ? "pass" : "fail", output: out };
  save();
  if (body) await src.editPrBody(pr, body(gate)).catch(() => undefined);
  return ok ? { ok: true } : { ok: false, note: res.note };
}

export async function runGate(f: Factory, p: ProjectConfig, issue: IssueDetail, task: TaskRow): Promise<GateOutcome> {
  const src = f.source(p);
  const rules = loadRules(p);
  const base = src.baseRef();
  const gate: GateState = {
    rebase: "pending",
    checks: rules.checks.map((c) => ({ name: c.name, status: "pending" as const })),
    reviewer: "pending",
  };
  const save = () => f.emitTask(f.ledger.updateTask(p.id, task.number, { gate: { ...gate } }));
  save();

  try {
    // Merged meanwhile outside Kiln (on GitHub): nothing left to gate.
    const merged = await f.mergedPr(p, task);
    if (merged) return { kind: "merged", sha: merged.mergeCommit ?? "", outside: merged };

    const rc = await rebaseAndCheck(f, p, task, gate, save);
    if (!rc.ok) return { kind: "send_back", note: rc.note };

    // 3. Path rules can only make the task stricter.
    const wt2 = await ensureWorktree(p, task.branch);
    const files = (await safeGit(wt2, ["diff", "--name-only", `${base}...HEAD`])).split("\n").filter(Boolean);
    const hits = riskyMatches(files, rules.riskyPaths);
    let needsHuman = task.risk === "required";
    if (hits.length) {
      needsHuman = true;
      f.ledger.updateTask(p.id, task.number, { risk: "required", riskReason: `path rule: ${hits.join(", ")}` });
    }

    // 4. Reviewer agent, fresh session, same worktree. It must not change anything.
    const head = await safeGit(wt2, ["rev-parse", "HEAD"]);
    const fresh = f.ledger.getTask(p.id, task.number)!;
    const rev = await f.agentRun({ p, task: fresh, kind: "review", prompt: reviewPrompt(issue, base, task.branch, fresh.decisions ?? []), labels: issue.labels });
    const wt3 = await ensureWorktree(p, task.branch);
    if ((await safeGit(wt3, ["rev-parse", "HEAD"])) !== head || (await safeGit(wt3, ["status", "--porcelain"])) !== "") {
      await safeGit(wt3, ["reset", "--hard", head]);
      await safeGit(wt3, ["clean", "-fd"]);
    }
    if (rev.aborted) return { kind: "error", note: `Reviewer stopped (${rev.aborted}). Retry the gate.` };
    if (rev.error) return { kind: "error", note: `Reviewer failed: ${rev.error}` };
    const verdict = extractJsonTag<{ verdict: "approve" | "revise" | "escalate"; notes?: string }>(rev.text, "kiln-review");
    if (!verdict) return { kind: "error", note: "The reviewer finished without a <kiln-review> block." };
    gate.reviewer = verdict.verdict;
    gate.reviewerNotes = verdict.notes ?? "";
    save();

    if (verdict.verdict === "revise") return { kind: "send_back", note: `The reviewer asks for changes:\n\n${verdict.notes ?? ""}` };

    // 5. Push and open (or update) the PR.
    await src.pushBranch(wt3, task.branch, true);
    const t = f.ledger.getTask(p.id, task.number)!;
    const waitCi = p.source !== "local" && verdict.verdict !== "escalate" && !needsHuman;
    if (waitCi) gate.ci = { status: "pending" };
    const body = prBody(issue, t, gate, hits);
    const pr = await src.openPr(task.branch, issue.title, body);
    f.emitTask(f.ledger.updateTask(p.id, task.number, { prNumber: pr.number, prUrl: pr.url }));

    if (verdict.verdict === "escalate") return { kind: "escalate", note: `The reviewer escalated to you:\n\n${verdict.notes ?? ""}` };
    if (needsHuman) {
      return { kind: "pr_review", note: hits.length ? `Touches ${hits.join(", ")}: your review is required.` : "Risky task: your review is required." };
    }
    if (waitCi) {
      const ci = await awaitCi(f, p, task, pr, head, gate, save, (g) => prBody(issue, f.ledger.getTask(p.id, task.number)!, g, hits));
      if (!ci.ok) return ci.aborted ? { kind: "aborted" } : { kind: "ci_failed", note: ci.note };
    }
    const sha = await src.mergePr(pr, issue.title, wt3);
    if (p.source === "local") await src.closeIssue(issue.number, `Merged by Kiln (${sha.slice(0, 7)}).`);
    return { kind: "merged", sha };
  } catch (e) {
    return { kind: "error", note: `Gate error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function prBody(issue: IssueDetail, t: TaskRow, gate: GateState, hits: string[]): string {
  const ci = gate.ci
    ? `\n- ${gate.ci.status === "pass" ? "✅" : gate.ci.status === "fail" ? "❌" : "⏳"} CI${gate.ci.output ? `:\n${gate.ci.output.split("\n").map((l) => `  - ${l}`).join("\n")}` : ""}`
    : "";
  const checks = (gate.checks ?? []).map((c) => `- ${c.status === "pass" ? "✅" : "❌"} ${c.name}`).join("\n");
  const list = (t.checklist ?? []).map((c) => `- [ ] **${c.title}** (${c.env}): ${c.steps}. Expected: ${c.expected}`).join("\n");
  return [
    `Closes #${issue.number}`,
    t.note ? `## Summary\n\n${t.note}` : "",
    `## Kiln gate\n\n- ✅ rebased on main\n${checks}${ci}\n- reviewer: **${gate.reviewer}**${gate.reviewerNotes ? `: ${gate.reviewerNotes}` : ""}`,
    hits.length ? `Risky paths touched: ${hits.join(", ")}` : "",
    list ? `## Manual checks after deploy\n\n${list}` : "",
    "_Opened by Kiln._",
  ]
    .filter(Boolean)
    .join("\n\n");
}
