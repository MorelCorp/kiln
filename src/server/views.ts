import type { ProjectConfig } from "../config.ts";
import type { Factory } from "../factory/factory.ts";
import { NEEDS_YOU } from "../factory/factory.ts";
import { cachedEnvs } from "../factory/envs.ts";
import type { ChecklistItem, RunRow, TaskRow } from "../state/db.ts";

export type Tone = "orange" | "peach" | "lavender" | "lilac" | "salmon" | "gold" | "sky" | "red" | "dim";

export interface Card {
  number: number;
  title: string;
  url: string;
  labels: string[];
  priority: string | null;
  risk: "auto" | "required" | null;
  phase: string | null;
  tags: { text: string; tone: Tone }[];
  /** For "Needs you" cards: what kind of attention. */
  need?: string;
  needTone?: Tone;
  draftId?: number;
  testEnv?: string;
  override?: string | null;
  runId?: string | null;
  note?: string | null;
  human?: boolean;
}

const TIER_NAME: Record<string, string> = { small: "Haiku", medium: "Sonnet", large: "Opus" };
export const tierName = (t: string | null | undefined) => (t ? TIER_NAME[t] ?? t : "");

const NEED: Record<string, { text: string; tone: Tone; rank: number }> = {
  question: { text: "question", tone: "red", rank: 0 },
  plan_review: { text: "approve plan", tone: "red", rank: 1 },
  pr_review: { text: "review PR", tone: "red", rank: 2 },
  test: { text: "test", tone: "red", rank: 3 },
  gate_failed: { text: "gate failed", tone: "red", rank: 4 },
  failed: { text: "run failed", tone: "red", rank: 5 },
  usage_paused: { text: "usage paused", tone: "gold", rank: 6 },
  interrupted: { text: "interrupted", tone: "gold", rank: 6 },
  stopped: { text: "stopped", tone: "gold", rank: 7 },
  triage: { text: "triage draft", tone: "lilac", rank: 8 },
};

function priorityOf(p: ProjectConfig, labels: string[]): string | null {
  const l = p.labels.priority.find((x) => labels.includes(x));
  return l ? l.split(":").pop()! : null;
}

function riskOf(p: ProjectConfig, labels: string[], t?: TaskRow): "auto" | "required" | null {
  if (t) return t.risk;
  if (labels.includes(p.labels.reviewRequired ?? "review:required")) return "required";
  if (labels.includes(p.labels.reviewAuto ?? "review:auto")) return "auto";
  return null;
}

/** Tests are due once the merge is deployed to the checklist's environment. */
export function pendingTests(f: Factory, p: ProjectConfig, t: TaskRow): { env: string; items: ChecklistItem[] }[] {
  if (t.phase !== "merged" || !t.checklist?.length) return [];
  const envs = cachedEnvs(p);
  const on = envs?.merged.find((m) => m.issue === t.number && m.mergeCommit === t.mergedSha)?.on ?? [];
  const out = new Map<string, ChecklistItem[]>();
  for (const c of t.checklist) {
    if (c.result) continue;
    const env = (c.env || "staging").toLowerCase();
    const known = envs?.envs.some((e) => e.id === env);
    if (on.includes(env) || (!known && p.source === "local")) out.set(env, [...(out.get(env) ?? []), c]);
  }
  return [...out].map(([env, items]) => ({ env, items }));
}

export function boardView(f: Factory, p: ProjectConfig) {
  const board = f.cachedBoard(p.id);
  const tasks = new Map(f.ledger.listTasks(p.id).map((t) => [t.number, t]));
  const drafts = f.ledger.listDrafts(p.id);
  const envs = cachedEnvs(p);
  const cols: Record<"triage" | "ready" | "running" | "needs" | "merged" | "staging" | "prod", Card[]> = {
    triage: [], ready: [], running: [], needs: [], merged: [], staging: [], prod: [],
  };
  const seen = new Set<number>();
  const envOrder = envs?.envs.map((e) => e.id) ?? [];
  const stagingId = envOrder.find((e) => e !== "prod") ?? "staging";
  const prodId = envOrder.includes("prod") ? "prod" : envOrder[envOrder.length - 1] ?? "prod";

  const base = (n: number, title: string, url: string, labels: string[]): Card => {
    const t = tasks.get(n);
    const live = f.liveFor(p.id, n);
    const tags: Card["tags"] = [];
    const risk = riskOf(p, labels, t);
    if (risk) tags.push({ text: risk === "required" ? "review" : "auto", tone: risk === "required" ? "red" : "sky" });
    const pr = priorityOf(p, labels);
    if (pr) tags.push({ text: pr, tone: "gold" });
    return {
      number: n, title, url, labels, priority: pr, risk, phase: t?.phase ?? null, tags,
      override: t && (t.overrideModel || t.overrideEffort) ? `${tierName(t.overrideModel ?? f.cfg.pace.modelCeiling)} · ${t.overrideEffort ?? f.cfg.pace.effortCeiling}` : null,
      runId: live?.row.id ?? null, note: t?.note ?? null,
    };
  };

  for (const i of board) {
    const t = tasks.get(i.number);
    const card = base(i.number, i.title, i.url, i.labels);
    const live = f.liveFor(p.id, i.number);
    if (live || (t && ["planning", "implementing", "gating"].includes(t.phase))) {
      cols.running.push(card);
    } else if (t && NEEDS_YOU.includes(t.phase)) {
      const n = NEED[t.phase];
      cols.needs.push({ ...card, need: n.text, needTone: n.tone });
    } else if (t?.phase === "merged" && i.state !== "triage") {
      const on = envs?.merged.find((m) => m.issue === i.number)?.on ?? [];
      const tests = pendingTests(f, p, t);
      for (const x of tests) cols.needs.push({ ...card, need: `test · ${x.env}`, needTone: "red", testEnv: x.env });
      const c = { ...card, tags: [{ text: tests.length ? "awaiting your test" : t.checklist?.some((x) => x.result === "fail") ? "test failed" : "merged", tone: "dim" as Tone }] };
      if (on.includes(prodId)) cols.prod.push(c);
      else if (on.includes(stagingId)) cols.staging.push(c);
      else cols.merged.push(c);
    } else if (i.state === "triage") {
      cols.triage.push(i.untriaged ? { ...card, tags: [{ text: "untriaged", tone: "dim" }, ...card.tags] } : card);
    } else if (i.state === "ready" || i.state === "running") {
      cols.ready.push(card);
    } else if (i.state === "human") {
      cols.ready.push({ ...card, human: true, tags: [{ text: "human", tone: "dim" }, ...card.tags] });
    } else if (i.state === "done") {
      cols.prod.push({ ...card, tags: [{ text: "closed", tone: "dim" }] });
    } else continue;
    seen.add(i.number);
  }
  for (const t of tasks.values()) {
    if (seen.has(t.number) || ["idle", "dropped", "human"].includes(t.phase)) continue;
    const card = base(t.number, t.title, "", []);
    if (f.liveFor(p.id, t.number) || ["planning", "implementing", "gating"].includes(t.phase)) cols.running.push(card);
    else if (NEEDS_YOU.includes(t.phase)) cols.needs.push({ ...card, need: NEED[t.phase].text, needTone: NEED[t.phase].tone });
    else if (t.phase === "merged") cols.merged.push({ ...card, tags: [{ text: "merged", tone: "dim" }] });
  }
  for (const d of drafts) {
    cols.needs.push({
      number: d.number ?? 0, title: d.title, url: "", labels: d.labels, priority: null, risk: d.risk, phase: null, tags: [],
      need: NEED.triage.text, needTone: NEED.triage.tone, draftId: d.id,
    });
  }
  cols.needs.sort((a, b) => rank(a.need) - rank(b.need));
  return {
    project: { id: p.id, name: p.name, repo: p.repo, source: p.source ?? "github" },
    syncedAt: f.boardSyncedAt(p.id) ?? null,
    columns: cols,
  };
}

const rank = (need?: string) => (need ? NEED[Object.keys(NEED).find((k) => NEED[k].text === need) ?? (need.startsWith("test") ? "test" : "")]?.rank ?? 9 : 9);

export function inboxView(f: Factory, p: ProjectConfig) {
  const items: Record<string, unknown>[] = [];
  for (const t of f.ledger.listTasks(p.id)) {
    if (NEEDS_YOU.includes(t.phase)) {
      const runs = f.ledger.listRuns({ project: p.id, number: t.number, limit: 1 });
      items.push({ kind: t.phase, rank: NEED[t.phase].rank, task: t, since: t.updatedAt, lastRun: runs[0] ?? null });
    }
    for (const x of pendingTests(f, p, t)) {
      items.push({ kind: "test", rank: NEED.test.rank, task: t, env: x.env, items: x.items, since: t.mergedAt ?? t.updatedAt });
    }
  }
  for (const d of f.ledger.listDrafts(p.id)) items.push({ kind: "triage", rank: NEED.triage.rank, draft: d, since: d.createdAt });
  items.sort((a, b) => (a.rank as number) - (b.rank as number) || String(a.since).localeCompare(String(b.since)));
  return { items };
}

export function runSummary(f: Factory, r: RunRow) {
  const live = f.live.get(r.id);
  return live ? f.runView(live) : { ...r, live: false, activity: r.summary, progress: [], subagents: [], rate: 0, context: 0, contextWindow: 0 };
}

export function tokensView(f: Factory, projectId?: string) {
  const since14 = new Date(Date.now() - 14 * 86400_000);
  since14.setHours(0, 0, 0, 0);
  const runs = f.ledger.listRuns({ project: projectId, since: since14.toISOString() });
  const days: { day: string; small: number; medium: number; large: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000);
    days.push({ day: d.toISOString().slice(0, 10), small: 0, medium: 0, large: 0 });
  }
  const tok = (r: RunRow) => r.inputTokens + r.cacheCreateTokens + r.cacheReadTokens + r.outputTokens;
  for (const r of runs) {
    const d = days.find((x) => x.day === r.startedAt.slice(0, 10));
    if (d) d[r.tier] += tok(r);
  }
  const perTask = new Map<string, { project: string; number: number; title: string; runs: number; models: Set<string>; input: number; output: number; cost: number; extra: boolean; overridden: boolean }>();
  for (const r of f.ledger.listRuns({ project: projectId, limit: 2000 })) {
    if (r.number === null) continue;
    const key = `${r.project}#${r.number}`;
    const t = f.ledger.getTask(r.project, r.number);
    const e = perTask.get(key) ?? { project: r.project, number: r.number, title: t?.title ?? "", runs: 0, models: new Set(), input: 0, output: 0, cost: 0, extra: false, overridden: false };
    e.runs++;
    e.models.add(`${tierName(r.tier)} · ${r.effort}`);
    e.input += r.inputTokens + r.cacheCreateTokens + r.cacheReadTokens;
    e.output += r.outputTokens;
    e.cost += r.costUsd;
    e.extra ||= r.usedOverage;
    e.overridden ||= r.overridden;
    perTask.set(key, e);
  }
  const fiveH = Date.now() - 5 * 3600_000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const all = f.ledger.listRuns({ since: today.toISOString() });
  return {
    usage: f.ledger.lastUsage() ?? null,
    kiln5h: f.kilnTokensSince(fiveH),
    costToday: all.reduce((s, r) => s + r.costUsd, 0),
    rate: f.liveRate(),
    days,
    perTask: [...perTask.values()].slice(0, 50).map((e) => ({
      ...e, models: [...e.models], state: f.ledger.getTask(e.project, e.number)?.phase ?? "",
    })),
    pace: f.cfg.pace,
    hold: f.holdReason() ?? null,
  };
}
