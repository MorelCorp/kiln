// Factory-level tests of the approve-and-merge flow with a faked source. KILN_HOME/KILN_STATE point at
// scratch dirs, set before the factory module is imported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "kiln-ci-"));
process.env.KILN_HOME = join(root, "home");
process.env.KILN_STATE = join(root, "state");
mkdirSync(process.env.KILN_HOME, { recursive: true });

const repo = join(root, "webapp");
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();
mkdirSync(repo);
sh(repo, "init", "-q", "-b", "main");
writeFileSync(join(repo, "a.txt"), "a\n");
sh(repo, "add", "."); sh(repo, "commit", "-q", "-m", "init");
sh(repo, "checkout", "-q", "-b", "kiln/issue-1");
writeFileSync(join(repo, "b.txt"), "b\n");
sh(repo, "add", "."); sh(repo, "commit", "-q", "-m", "work");
sh(repo, "checkout", "-q", "main");
const headSha = sh(repo, "rev-parse", "kiln/issue-1");

writeFileSync(join(process.env.KILN_HOME, "config.json"), JSON.stringify({
  self: false, port: 0, activeProject: "webapp", pace: {},
  providers: [{ id: "p", kind: "claude-code" }],
  projects: [{
    id: "webapp", name: "Webapp", path: repo, repo: "acme/webapp", provider: "p",
    labels: { triage: [], ready: "ready-for-agent", human: "ready-for-human", running: "kiln:running", modelPrefix: "model:", priority: [] },
  }],
}));

const { Factory } = await import("../src/factory/factory.ts");
import type { PrChecks, PullRequest, Source } from "../src/tasks/source.ts";

const pr: PullRequest = { number: 5, url: "https://github.com/acme/webapp/pull/5", headRefName: "kiln/issue-1", state: "OPEN", mergedAt: null, mergeCommit: null, title: "t" };

function setup(prChecks: () => Promise<PrChecks>, opts: { findPr?: () => Promise<PullRequest>; phase?: string; commitEmail?: string } = {}) {
  const f = new Factory();
  f.ciTiming = { pollMs: 5, graceMs: 0 };
  const merged: string[] = [];
  const fake = {
    fetch: async () => {}, baseRef: () => "main", findPr: opts.findPr ?? (async () => pr), pushBranch: async () => {},
    getIssue: async () => ({ number: 1, title: "t", url: "u", state: "OPEN", closedAt: null, labels: [], body: "", comments: [] }),
    editLabels: async () => {}, listIssues: async () => [], editPrBody: async () => {}, closeIssue: async () => {},
    prChecks, mergePr: async () => (merged.push("x"), "deadbeefcafe"), commitEmail: async () => opts.commitEmail ?? null,
  } as unknown as Source;
  (f as unknown as { source: () => Source }).source = () => fake;
  const number = 1;
  f.ledger.createTask({
    project: "webapp", number, title: "t", phase: (opts.phase ?? "pr_review") as "pr_review", risk: "required", riskReason: "risk label", branch: "kiln/issue-1",
    worktree: null, sessionId: null, prNumber: 5, prUrl: pr.url, plan: null, question: null, checklist: null, gate: null,
    overrideModel: null, overrideEffort: null, allowExtra: false, sendBacks: 0, queuedMessage: null, note: null, mergedSha: null, mergedAt: null,
  });
  return { f, merged, task: () => f.ledger.getTask("webapp", number)! };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), "condition not reached in time");
};

test("approvePr returns at once and the CI wait reports through the phase", async () => {
  let release!: () => void;
  const gateOpen = new Promise<void>((r) => (release = r));
  const { f, merged, task } = setup(async () => {
    await gateOpen;
    return { head: headSha, checks: [{ name: "build", bucket: "pass", link: "l" }] };
  });
  await f.approvePr("webapp", 1); // does not wait for CI
  assert.equal(task().phase, "gating");
  assert.equal(merged.length, 0);
  release();
  await until(() => task().phase === "merged");
  assert.equal(merged.length, 1);
  assert.equal(task().gate?.ci?.status, "pass");
});

test("approvePr: a CI wait that throws puts the task in gate_failed, not gating", async () => {
  const { f, merged, task } = setup(async () => { throw new Error("gh exploded"); });
  await f.approvePr("webapp", 1);
  await until(() => task().phase !== "gating");
  assert.equal(task().phase, "gate_failed");
  assert.match(task().note ?? "", /gh exploded/);
  assert.equal(merged.length, 0);
});

test("approvePr: a failing check lands in gate_failed with the check link", async () => {
  const { f, merged, task } = setup(async () => ({ head: headSha, checks: [{ name: "lint", bucket: "fail", link: "https://ci.example/lint" }] }));
  await f.approvePr("webapp", 1);
  await until(() => task().phase !== "gating");
  assert.equal(task().phase, "gate_failed");
  assert.match(task().note ?? "", /lint \(https:\/\/ci\.example\/lint\)/);
  assert.equal(merged.length, 0);
});

test("Stop and Drop interrupt the CI wait without merging", async () => {
  for (const action of ["stop", "drop"] as const) {
    const { f, merged, task } = setup(async () => ({ head: headSha, checks: [{ name: "build", bucket: "pending", link: "l" }] }));
    await f.approvePr("webapp", 1);
    await until(() => (f as unknown as { ciWaits: Map<string, unknown> }).ciWaits.size > 0);
    await f[action]("webapp", 1);
    await until(() => (f as unknown as { ciWaits: Map<string, unknown> }).ciWaits.size === 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(task().phase, action === "stop" ? "stopped" : "dropped");
    assert.equal(merged.length, 0);
  }
});

// ---- merged outside Kiln (on GitHub) --------------------------------------------------

const mergedOnGitHub: PullRequest = { ...pr, state: "MERGED", mergedAt: "2030-01-01T00:00:00Z", mergeCommit: "feedface0001" };
const noChecks = async (): Promise<PrChecks> => ({ head: headSha, checks: [] });

test("approvePr on a PR already merged on GitHub marks the task merged without merging again", async () => {
  const { f, merged, task } = setup(noChecks, { findPr: async () => mergedOnGitHub });
  await f.approvePr("webapp", 1);
  assert.equal(task().phase, "merged");
  assert.equal(task().mergedSha, "feedface0001");
  assert.equal(merged.length, 0);
});

test("the gate finds a PR merged on GitHub and stops there instead of sending the task back", async () => {
  const { f, merged, task } = setup(noChecks, { findPr: async () => mergedOnGitHub, phase: "gate_failed" });
  await f.retry("webapp", 1);
  assert.equal(task().phase, "merged");
  assert.equal(task().mergedSha, "feedface0001");
  assert.equal(merged.length, 0);
});

test("reconcile marks an idle task merged when its PR was merged on GitHub, and leaves busy tasks alone", async () => {
  for (const [phase, expected] of [["gate_failed", "merged"], ["pr_review", "merged"], ["interrupted", "merged"], ["gating", "gating"]] as const) {
    const { f, task } = setup(noChecks, { findPr: async () => mergedOnGitHub, phase });
    await f.reconcile(f.project("webapp"));
    assert.equal(task().phase, expected, `from ${phase}`);
  }
});

test("board sync runs the reconcile", async () => {
  const { f, task } = setup(noChecks, { findPr: async () => mergedOnGitHub, phase: "gate_failed" });
  await f.syncBoard("webapp", true);
  await until(() => task().phase === "merged");
});

test("board sync ignores another PR on the same branch", async () => {
  const { f, task } = setup(noChecks, { findPr: async () => ({ ...mergedOnGitHub, number: 4 }), phase: "gate_failed" });
  await f.reconcile(f.project("webapp"));
  assert.equal(task().phase, "gate_failed");
});

// Last: it rewrites kiln/issue-1, which the tests above match by its original sha.
test("approvePr: commits with another email are re-authored to the source's commit email before the push", async () => {
  const noreply = "1+acme@users.noreply.github.com";
  const branchHead = () => sh(repo, "rev-parse", "kiln/issue-1");
  const { f, merged, task } = setup(async () => ({ head: branchHead(), checks: [{ name: "build", bucket: "pass", link: "l" }] }), { commitEmail: noreply });
  await f.approvePr("webapp", 1);
  await until(() => task().phase !== "gating");
  assert.equal(task().phase, "merged", task().note ?? "");
  assert.equal(merged.length, 1);
  assert.notEqual(branchHead(), headSha);
  assert.equal(sh(repo, "log", "--format=%ae %ce %an %s", "main..kiln/issue-1"), `${noreply} ${noreply} t work`);
  assert.equal(sh(repo, "rev-parse", "kiln/issue-1^{tree}"), sh(repo, "rev-parse", `${headSha}^{tree}`));
});
