import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSandbox } from "@ai-hero/sandcastle";
import { bwrap } from "@ai-hero/sandcastle/sandboxes/bwrap";
import { loadRules, type ProjectConfig } from "../config.ts";
import type { GateState, TaskRow } from "../state/db.ts";
import { git, type IssueDetail } from "../tasks/source.ts";
import { extractJsonTag } from "../runs/stream.ts";
import { reviewPrompt } from "../runs/prompts.ts";
import type { Factory } from "./factory.ts";

export type GateOutcome =
  | { kind: "merged"; sha: string }
  | { kind: "pr_review"; note: string }
  | { kind: "send_back"; note: string }
  | { kind: "escalate"; note: string }
  | { kind: "error"; note: string };

/** Host git without running any of the project's hooks (the branch is agent-written). */
const safeGit = (cwd: string, args: string[]) => git(cwd, ["-c", "core.hooksPath=/dev/null", ...args]);

/**
 * The bubblewrap sandbox for a project: the provider's session store plus whatever the project's
 * rules.yaml adds (a read-only package cache, env vars).
 */
export function sandboxFor(f: Factory, p: ProjectConfig) {
  const { sandbox } = loadRules(p);
  return bwrap({
    mounts: [
      ...f.provider(p).sandboxMounts(),
      ...sandbox.mounts.map((m) => ({ hostPath: m.path, sandboxPath: m.path, readonly: m.readonly ?? true })),
    ],
    env: sandbox.env,
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
    gate.rebase = "pass";
    save();
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
    const body = prBody(issue, t, gate, hits);
    const pr = await src.openPr(task.branch, issue.title, body);
    f.emitTask(f.ledger.updateTask(p.id, task.number, { prNumber: pr.number, prUrl: pr.url }));

    if (verdict.verdict === "escalate") return { kind: "escalate", note: `The reviewer escalated to you:\n\n${verdict.notes ?? ""}` };
    if (needsHuman) {
      return { kind: "pr_review", note: hits.length ? `Touches ${hits.join(", ")}: your review is required.` : "Risky task: your review is required." };
    }
    const sha = await src.mergePr(pr, issue.title, wt3);
    if (p.source === "local") await src.closeIssue(issue.number, `Merged by Kiln (${sha.slice(0, 7)}).`);
    return { kind: "merged", sha };
  } catch (e) {
    return { kind: "error", note: `Gate error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function prBody(issue: IssueDetail, t: TaskRow, gate: GateState, hits: string[]): string {
  const checks = (gate.checks ?? []).map((c) => `- ${c.status === "pass" ? "✅" : "❌"} ${c.name}`).join("\n");
  const list = (t.checklist ?? []).map((c) => `- [ ] **${c.title}** (${c.env}): ${c.steps}. Expected: ${c.expected}`).join("\n");
  return [
    `Closes #${issue.number}`,
    t.note ? `## Summary\n\n${t.note}` : "",
    `## Kiln gate\n\n- ✅ rebased on main\n${checks}\n- reviewer: **${gate.reviewer}**${gate.reviewerNotes ? `: ${gate.reviewerNotes}` : ""}`,
    hits.length ? `Risky paths touched: ${hits.join(", ")}` : "",
    list ? `## Manual checks after deploy\n\n${list}` : "",
    "_Opened by Kiln._",
  ]
    .filter(Boolean)
    .join("\n\n");
}
