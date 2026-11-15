import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamParser, extractJsonTag, extractTag, type RunEvent, type Usage } from "../src/runs/stream.ts";
import { globToRegExp, riskyMatches } from "../src/factory/gate.ts";
import { classify } from "../src/tasks/board.ts";
import { clampEffort, clampTier } from "../src/providers/types.ts";
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
  assert.equal(classify(issue([]), project).state, "other");
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
