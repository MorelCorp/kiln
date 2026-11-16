import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamParser, extractJsonTag, extractTag, type RunEvent, type Usage } from "../src/runs/stream.ts";
import { globToRegExp, riskyMatches } from "../src/factory/gate.ts";
import { classify, labelsToClearOnPhase } from "../src/tasks/board.ts";
import { GitHubSource } from "../src/tasks/source.ts";
import { clampEffort, clampTier, DEFAULT_CONTEXT_WINDOW, type ProviderConfig } from "../src/providers/types.ts";
import { ClaudeCodeProvider } from "../src/providers/claude.ts";
import { repoFromRemote, type ProjectConfig } from "../src/config.ts";

test("repoFromRemote reads owner/repo from https and ssh remotes", () => {
  assert.equal(repoFromRemote("https://github.com/acme/kiln.git\n"), "acme/kiln");
  assert.equal(repoFromRemote("git@github.com:someone/kiln-fork.git"), "someone/kiln-fork");
  assert.equal(repoFromRemote("https://github.com/acme/kiln"), "acme/kiln");
  assert.equal(repoFromRemote("https://gitlab.com/acme/kiln.git"), undefined);
});

test("extractTag takes the last block", () => {
  assert.equal(extractTag("a <kiln-plan>one</kiln-plan> b <kiln-plan>\ntwo\n</kiln-plan>", "kiln-plan"), "two");
  assert.equal(extractTag("nothing here", "kiln-plan"), undefined);
});

test("extractJsonTag parses JSON, fenced or not, and tolerates garbage", () => {
  assert.deepEqual(extractJsonTag('<kiln-done>{"summary":"s","checklist":[]}</kiln-done>', "kiln-done"), { summary: "s", checklist: [] });
  assert.deepEqual(extractJsonTag('<kiln-review>```json\n{"verdict":"approve"}\n```</kiln-review>', "kiln-review"), { verdict: "approve" });
  assert.equal(extractJsonTag("<kiln-done>- [x] not json</kiln-done>", "kiln-done"), undefined);
});

test("path rules: ** crosses directories, * does not", () => {
  assert.ok(globToRegExp("infra/**").test("infra/k8s/app.yaml"));
  assert.ok(globToRegExp("**/migrations/**").test("backend/svc/migrations/001.sql"));
  assert.ok(globToRegExp("**/migrations/**").test("migrations/001.sql"));
  assert.ok(globToRegExp("scripts/*deploy*").test("scripts/deploy-staging.sh"));
  assert.ok(!globToRegExp("scripts/*deploy*").test("scripts/sub/deploy.sh"));
  assert.ok(globToRegExp("**/*secret*").test("a/b/my-secret.yaml"));
  assert.deepEqual(riskyMatches(["src/a.ts", "infra/x.tf"], ["infra/**", "docs/**"]), ["infra/**"]);
});

test("ceilings clamp automatic choices", () => {
  assert.equal(clampTier("large", "medium"), "medium");
  assert.equal(clampTier("small", "medium"), "small");
  assert.equal(clampEffort("max", "high"), "high");
});

const project = {
  id: "webapp", name: "Webapp", path: "/x", repo: "acme/webapp", provider: "p",
  labels: { triage: ["needs-triage", "idea"], ready: "ready-for-agent", human: "ready-for-human", running: "kiln:running", modelPrefix: "model:", priority: ["priority:next", "priority:later"] },
} satisfies ProjectConfig;

test("classify maps labels to board states", () => {
  const issue = (labels: string[], state: "OPEN" | "CLOSED" = "OPEN") => ({ number: 1, title: "t", url: "u", state, closedAt: null, labels });
  assert.equal(classify(issue(["ready-for-agent"]), project).state, "ready");
  assert.equal(classify(issue(["ready-for-agent", "idea"]), project).state, "triage");
  assert.equal(classify(issue(["ready-for-human"]), project).state, "human");
  assert.equal(classify(issue(["ready-for-agent", "kiln:running"]), project).state, "running");
  assert.equal(classify(issue(["ready-for-agent"], "CLOSED"), project).state, "done");
  // No Kiln label at all: Triage (flagged), never hidden.
  assert.equal(classify(issue([]), project).state, "triage");
  assert.equal(classify(issue([]), project).untriaged, true);
  assert.equal(classify(issue(["bug"]), project).untriaged, true);
  assert.equal(classify(issue(["idea"]), project).untriaged, undefined);
  assert.equal(classify(issue(["ready-for-agent", "parked"]), { ...project, labels: { ...project.labels, skip: ["parked"] } }).state, "other");
  assert.equal(classify(issue(["priority:later"]), project).priority, 1);
});

test("stream parser: tools, progress, subagents, rate limit, result", () => {
  const events: RunEvent[] = [];
  const seen: Record<string, unknown> = {};
  const usage = new Map<string, Usage>();
  const p = new StreamParser({
    event: (e) => events.push(e),
    sessionId: (id) => (seen.session = id),
    progress: (items) => (seen.progress = items),
    subagents: (m) => (seen.subs = [...m.values()]),
    rateLimit: (i) => (seen.rate = i),
    callUsage: (u, id) => usage.set(id, u),
    result: (r) => (seen.result = r),
  });
  const line = (o: unknown) => p.line(JSON.stringify(o));
  line({ type: "system", subtype: "init", session_id: "s1" });
  line({ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: true, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1, status: "allowed" } } } });
  const msg = (id: string, content: unknown[], out: number) => ({ type: "assistant", message: { id, content, usage: { input_tokens: 5, output_tokens: out } } });
  line(msg("m1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }], 3));
  line(msg("m1", [{ type: "tool_use", id: "t2", name: "Task", input: { description: "explore", prompt: "look" } }], 9));
  assert.deepEqual(seen.subs, ["explore"]);
  line({ type: "assistant", parent_tool_use_id: "t2", message: { id: "m9", content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "ls" } }] } });
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } });
  assert.deepEqual(seen.subs, []);
  line(msg("m2", [{ type: "tool_use", id: "t3", name: "TodoWrite", input: { todos: [{ content: "a", status: "in_progress" }] } }], 1));
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", is_error: true, content: "boom" }] } });
  line(msg("m3", [{ type: "text", text: "all done" }], 2));
  line({ type: "result", result: "all done", total_cost_usd: 0.5, session_id: "s1", usage: { input_tokens: 10, output_tokens: 20 } });
  p.line("not json at all");

  assert.equal(seen.session, "s1");
  assert.equal((seen.rate as { isUsingOverage: boolean }).isUsingOverage, true);
  assert.deepEqual(seen.progress, [{ content: "a", status: "in_progress" }]);
  assert.equal(usage.get("m1")!.outputTokens, 9, "same message id keeps the last usage");
  assert.equal(usage.has("m9"), false, "subagent calls are not counted twice");
  assert.deepEqual(events.map((e) => e.k), ["read", "sub", "bash", "progress", "fail", "think", "result"]);
  assert.equal(events[2].sub, "explore");
  assert.equal(events.at(-1)!.text, "finished", "final text is not repeated");
  assert.equal((seen.result as { costUsd: number }).costUsd, 0.5);
});

test("a merged task drops the ready and running labels; other terminal phases only running", () => {
  assert.deepEqual(labelsToClearOnPhase("merged", project), ["ready-for-agent", "kiln:running"]);
  assert.deepEqual(labelsToClearOnPhase("human", project), ["kiln:running"]);
  assert.deepEqual(labelsToClearOnPhase("dropped", project), ["kiln:running"]);
});

function fakeGithub(failDelete: boolean) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "user") return "1+someone@users.noreply.github.com";
    if (args[0] === "api" && failDelete) throw new Error("HTTP 422: Reference does not exist");
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify([{
        number: 7, url: "u", headRefName: "kiln/issue-7", state: "MERGED", mergedAt: "t",
        mergeCommit: { oid: "abc1234" }, title: "t",
      }]);
    }
    return "";
  };
  const p = { id: "web", name: "web", path: "/tmp/none", repo: "acme/webapp" } as ProjectConfig;
  const src = new GitHubSource(p, run, async () => "deadbeef");
  const pr = { number: 7, url: "u", headRefName: "kiln/issue-7", state: "OPEN" as const, mergedAt: null, mergeCommit: null, title: "t" };
  return { calls, src, pr };
}

test("GitHubSource.mergePr deletes the remote head branch after merging", async () => {
  const { calls, src, pr } = fakeGithub(false);
  assert.equal(await src.mergePr(pr, "title", "/tmp/wt"), "abc1234");
  const merge = calls.findIndex((c) => c[0] === "pr" && c[1] === "merge");
  const del = calls.findIndex((c) => c[0] === "api" && c[2] === "DELETE");
  assert.ok(merge >= 0 && del > merge, "delete comes after the merge");
  assert.deepEqual(calls[del], ["api", "-X", "DELETE", "repos/acme/webapp/git/refs/heads/kiln/issue-7"]);
});

test("GitHubSource.mergePr authors the squash commit with the account's noreply address", async () => {
  const { calls, src, pr } = fakeGithub(false);
  await src.mergePr(pr, "title", "/tmp/wt");
  const merge = calls.find((c) => c[0] === "pr" && c[1] === "merge")!;
  assert.equal(merge[merge.indexOf("--author-email") + 1], "1+someone@users.noreply.github.com");
});

test("GitHubSource.mergePr: a failed branch delete does not fail the merge", async () => {
  const { src, pr } = fakeGithub(true);
  const warn = console.warn;
  const logged: string[] = [];
  console.warn = (m: string) => void logged.push(m);
  try {
    assert.equal(await src.mergePr(pr, "title", "/tmp/wt"), "abc1234");
  } finally {
    console.warn = warn;
  }
  assert.ok(logged.some((m) => m.includes("kiln/issue-7")));
});

// ---- CI wait ------------------------------------------------------------------------------

import { waitForCi } from "../src/factory/ci.ts";
import type { CheckRun, PullRequest } from "../src/tasks/source.ts";

const fakePr = { number: 7, url: "https://github.com/acme/webapp/pull/7", headRefName: "kiln/issue-7", state: "OPEN", mergedAt: null, mergeCommit: null, title: "t" } satisfies PullRequest;
const chk = (name: string, bucket: CheckRun["bucket"]): CheckRun => ({ name, bucket, link: `https://ci.example/${name}` });

/** A fake source returning successive polls, and a fake clock that sleeping advances. */
function ciHarness(polls: CheckRun[][]) {
  let t = 0, n = 0;
  return {
    src: { prChecks: async () => ({ head: "abc", checks: polls[Math.min(n++, polls.length - 1)] }) },
    polls: () => n,
    opts: { head: "abc", timeoutMs: 20 * 60_000, graceMs: 30_000, pollMs: 15_000, now: () => t, sleep: async (ms: number) => void (t += ms) },
  };
}

test("CI wait: passes once every check has passed", async () => {
  const h = ciHarness([[chk("build", "pending"), chk("lint", "pass")], [chk("build", "pass"), chk("lint", "pass"), chk("docs", "skipping")]]);
  const r = await waitForCi(h.src, fakePr, h.opts);
  assert.equal(r.status, "pass");
  assert.equal(h.polls(), 2);
});

test("CI wait: a failing check fails at once, naming it with its link", async () => {
  const h = ciHarness([[chk("build", "pending"), chk("lint", "fail")]]);
  const r = await waitForCi(h.src, fakePr, h.opts);
  assert.equal(r.status, "fail");
  assert.match(r.note, /lint \(https:\/\/ci\.example\/lint\)/);
  assert.doesNotMatch(r.note, /build/);
});

test("CI wait: still pending after the timeout names the pending checks", async () => {
  const h = ciHarness([[chk("build", "pending"), chk("lint", "pass")]]);
  const r = await waitForCi(h.src, fakePr, { ...h.opts, timeoutMs: 60_000 });
  assert.equal(r.status, "timeout");
  assert.match(r.note, /Still pending: build/);
  assert.doesNotMatch(r.note, /lint/);
});

test("CI wait: no checks is only accepted after the grace period", async () => {
  const h = ciHarness([[], [], [chk("build", "pass")]]);
  const late = await waitForCi(h.src, fakePr, h.opts);
  assert.equal(late.status, "pass"); // checks appeared within the grace period

  const none = ciHarness([[]]);
  const r = await waitForCi(none.src, fakePr, none.opts);
  assert.equal(r.status, "none");
  assert.ok(none.polls() >= 3, "kept polling through the 30 s grace period");
});

test("CI wait: tolerates a transient gh error but not a persistent one", async () => {
  let n = 0;
  const flaky = { prChecks: async () => { if (++n === 1) throw new Error("boom"); return { head: "abc", checks: [chk("build", "pass")] }; } };
  const h = ciHarness([]);
  assert.equal((await waitForCi(flaky, fakePr, h.opts)).status, "pass");
  const broken = { prChecks: async () => { throw new Error("down"); } };
  await assert.rejects(waitForCi(broken, fakePr, h.opts), /down/);
});

test("CI wait: ignores checks of an older head and waits for the pushed commit", async () => {
  const h = ciHarness([]);
  const seq = [
    { head: "old", checks: [chk("build", "pass")] },
    { head: "old", checks: [chk("build", "pass")] },
    { head: "abc", checks: [chk("build", "pending")] },
    { head: "abc", checks: [chk("build", "fail")] },
  ];
  let n = 0;
  const src = { prChecks: async () => seq[Math.min(n++, seq.length - 1)] };
  const r = await waitForCi(src, fakePr, h.opts);
  assert.equal(r.status, "fail", "the old head's passing checks did not count");
  assert.equal(n, 4);
});

test("CI wait: a head that never matches times out instead of passing", async () => {
  const h = ciHarness([]);
  const src = { prChecks: async () => ({ head: "old1234", checks: [chk("build", "pass")] }) };
  const r = await waitForCi(src, fakePr, { ...h.opts, timeoutMs: 60_000 });
  assert.equal(r.status, "timeout");
  assert.match(r.note, /old1234/);
});

test("CI wait: an abort signal interrupts the wait, even mid-sleep", async () => {
  const ctl = new AbortController();
  const src = { prChecks: async () => ({ head: "abc", checks: [chk("build", "pending")] }) };
  // Real timers: without the signal this would sleep a minute.
  const started = Date.now();
  const p = waitForCi(src, fakePr, { head: "abc", timeoutMs: 600_000, graceMs: 30_000, pollMs: 60_000, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 20);
  assert.equal((await p).status, "aborted");
  assert.ok(Date.now() - started < 5_000);
  // Already aborted: no poll at all.
  let polls = 0;
  const r = await waitForCi({ prChecks: async () => (polls++, { head: "abc", checks: [] }) }, fakePr, { head: "abc", timeoutMs: 1, graceMs: 1, pollMs: 1, signal: ctl.signal });
  assert.equal(r.status, "aborted");
  assert.equal(polls, 0);
});

// ---- merge commits after a rewrite of main ------------------------------------------------

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { execFileSync } from "node:child_process";
import { blockingGates, deployChoice, localMergeCommit, mainSubjects } from "../src/factory/envs.ts";

test("localMergeCommit finds a squash commit on main after its history was rewritten", async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "kiln-rewrite-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  g("-c", "user.name=a", "-c", "user.email=a@example.com", "commit", "-q", "--allow-empty", "-m", "base");
  g("-c", "user.name=a", "-c", "user.email=a@example.com", "commit", "-q", "--allow-empty", "-m", "Fix the thing");
  const old = g("rev-parse", "HEAD");
  g("-c", "user.name=a", "-c", "user.email=b@example.com", "commit", "-q", "--amend", "--allow-empty", "--reset-author", "-m", "Fix the thing");
  const rewritten = g("rev-parse", "HEAD");
  assert.notEqual(old, rewritten);
  const p = { id: "x", name: "x", path: dir, repo: "acme/webapp" } as ProjectConfig;
  const pr = { number: 3, url: "u", headRefName: "kiln/issue-3", state: "MERGED" as const, mergedAt: "t", mergeCommit: old, title: "Fix the thing" };
  assert.equal(await localMergeCommit(p, pr, "main", mainSubjects(p, "main")), rewritten);
  // A merge commit that is on main is used as is.
  assert.equal(await localMergeCommit(p, { ...pr, mergeCommit: rewritten }, "main", mainSubjects(p, "main")), rewritten);
});

import { readIssueThread } from "../src/server/thread.ts";

test("GitHubSource.getIssue reads body and comments through gh, read-only", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify({
      number: 18, title: "t", url: "https://github.com/acme/webapp/issues/18", state: "OPEN", closedAt: null,
      labels: [{ name: "ready-for-agent" }], body: "## Context\nbody",
      comments: [
        { body: "second", author: { login: "bob" }, createdAt: "2026-01-02T00:00:00Z" },
        { body: "first", author: null, createdAt: "2026-01-01T00:00:00Z" },
      ],
    });
  };
  const p = { id: "web", name: "web", path: "/tmp/none", repo: "acme/webapp" } as ProjectConfig;
  const src = new GitHubSource(p, run);
  const issue = await readIssueThread(src, 18);
  assert.equal(issue.body, "## Context\nbody");
  assert.deepEqual(issue.labels, ["ready-for-agent"]);
  assert.deepEqual(issue.comments.map((c) => [c.author, c.body]), [["unknown", "first"], ["bob", "second"]], "oldest first, missing author tolerated");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ["issue", "view", "18"], "only a read call goes to gh");
});

test("readIssueThread tolerates an issue with no comments and only calls getIssue", async () => {
  const source = {
    getIssue: async (n: number) => ({ number: n, title: "t", url: "u", state: "CLOSED" as const, closedAt: null, labels: [], body: undefined as unknown as string, comments: undefined as unknown as [] }),
  };
  const issue = await readIssueThread(source, 3);
  assert.equal(issue.body, "");
  assert.deepEqual(issue.comments, []);
});

import { Ledger } from "../src/state/db.ts";

test("deploys cut short by a restart: done when the daemon now runs that version, else restarted", () => {
  const l = new Ledger(joinPath(mkdtempSync(joinPath(tmpdir(), "kiln-deploys-")), "kiln.db"));
  const base = { project: "kiln", env: "prod", status: "running" as const, startedAt: new Date().toISOString(), endedAt: null, logPath: "/dev/null" };
  const self = l.addDeploy({ ...base, version: "abc1234" });
  const other = l.addDeploy({ ...base, version: "def5678" });
  const unknown = l.addDeploy({ ...base, version: null });
  const finished = l.addDeploy({ ...base, version: "abc1234", status: "failed" });
  l.markOrphanDeploys("abc1234");
  const status = new Map(l.listDeploys("kiln").map((d) => [d.id, d.status]));
  assert.equal(status.get(self.id), "done");
  assert.equal(status.get(other.id), "restarted");
  assert.equal(status.get(unknown.id), "restarted");
  assert.equal(status.get(finished.id), "failed");
});

test("deployChoice defaults to the first option and refuses one the env does not list", () => {
  const env = { id: "staging", name: "Staging", deploy: "./deploy.sh", deployChoices: ["patch", "minor", "major"] };
  assert.equal(deployChoice(env), "patch");
  assert.equal(deployChoice(env, ""), "patch");
  assert.equal(deployChoice(env, "minor"), "minor");
  assert.throws(() => deployChoice(env, "major; rm -rf /"), /Unknown deploy option/);
  // An env without options ignores whatever was sent.
  assert.equal(deployChoice({ id: "prod", name: "Prod", deploy: "./promote.sh" }, "minor"), undefined);
});

test("claude provider caps the auto-compact window at contextWindow", () => {
  const base: ProviderConfig = {
    id: "sub", kind: "claude-code", tokenEnv: "KILN_TEST_TOKEN",
    models: { small: "s", medium: "m", large: "l" },
  };
  const def = new ClaudeCodeProvider(base);
  assert.equal(def.contextWindow(), DEFAULT_CONTEXT_WINDOW);
  assert.equal(def["env"]().CLAUDE_CODE_AUTO_COMPACT_WINDOW, String(DEFAULT_CONTEXT_WINDOW));
  const set = new ClaudeCodeProvider({ ...base, contextWindow: 150000 });
  assert.equal(set["env"]().CLAUDE_CODE_AUTO_COMPACT_WINDOW, "150000");
  assert.equal(new ClaudeCodeProvider({ ...base, contextWindow: 0 }).contextWindow(), DEFAULT_CONTEXT_WINDOW);
});

test("blockingGates: a failing gate blocks unless it is skippable, skipped and given a reason", () => {
  const defs = [
    { name: "scan says GO", run: "true", step: "./scan.sh", skippable: true },
    { name: "staging healthy", run: "true" },
  ];
  const results = [{ name: "scan says GO", ok: false }, { name: "staging healthy", ok: true }];
  assert.deepEqual(blockingGates(defs, results), { blocking: ["scan says GO"], skipped: [] });
  assert.deepEqual(blockingGates(defs, results, ["scan says GO"], "docs-only release"), { blocking: [], skipped: ["scan says GO"] });
  assert.throws(() => blockingGates(defs, results, ["scan says GO"], "  "), /why/);
  assert.throws(() => blockingGates(defs, results, ["staging healthy"], "x"), /cannot be skipped/);
  assert.throws(() => blockingGates(defs, results, ["nope"], "x"), /Unknown gate/);
  // Skipping a gate that passes is a no-op and needs no reason.
  assert.deepEqual(blockingGates(defs, [{ name: "scan says GO", ok: true }], ["scan says GO"]), { blocking: [], skipped: [] });
});
