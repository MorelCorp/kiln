import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { KILN_STATE } from "../config.ts";
import type { Effort, ModelTier } from "../providers/types.ts";

/**
 * Where a task is in Kiln's own pipeline. GitHub labels say whether a task is triage/ready;
 * this says what Kiln is doing with it once it picked it up.
 */
export type Phase =
  | "idle" // known to Kiln (e.g. an override set before its first run) but not picked up
  | "planning" // risky: plan run going
  | "plan_review" // risky: plan waits for you
  | "implementing" // agent run going
  | "question" // agent paused with a question for you
  | "gating" // merge gate running (rebase, checks, reviewer)
  | "pr_review" // risky: PR waits for your review
  | "gate_failed" // reviewer escalated / checks failed too often
  | "failed" // a run crashed
  | "usage_paused" // stopped because of extra usage, a window exhausted or a rate limit; resumes later
  | "interrupted" // Kiln stopped (crash, restart) while it ran; resumes by itself
  | "stopped" // you stopped it
  | "merged" // PR merged into main
  | "human" // handed to a human (ready-for-human)
  | "dropped";

export type Risk = "auto" | "required";

export interface ChecklistItem {
  title: string;
  steps: string;
  expected: string;
  env: string;
  result?: "pass" | "fail" | "skip";
  note?: string;
}

export interface TaskRow {
  project: string;
  number: number;
  title: string;
  phase: Phase;
  risk: Risk;
  /** Why the risk is what it is ("label", "path rule: infra/**"). */
  riskReason: string;
  branch: string;
  worktree: string | null;
  sessionId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  plan: string | null;
  question: string | null;
  checklist: ChecklistItem[] | null;
  /** Gate results as shown in the UI. */
  gate: GateState | null;
  overrideModel: ModelTier | null;
  overrideEffort: Effort | null;
  allowExtra: boolean;
  sendBacks: number;
  /** What the human decided along the way (answers, plan notes, redirects): shown to the reviewer. */
  decisions?: string[];
  /** For "interrupted": the phase to resume. */
  interruptedFrom?: Phase;
  /** For "usage_paused": do not resume before this time (ISO), e.g. after a rate-limit error. */
  retryAt?: string | null;
  /** A message to deliver to the agent at its next turn. */
  queuedMessage: string | null;
  /** Free text: why it is in its current phase (error, reviewer notes, ...). */
  note: string | null;
  mergedSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GateState {
  rebase?: "pending" | "pass" | "fail";
  checks?: { name: string; status: "pending" | "pass" | "fail"; output?: string }[];
  /** The PR's CI checks (GitHub projects). `output` lists the checks and their links. */
  ci?: { status: "pending" | "pass" | "fail"; output?: string };
  reviewer?: "pending" | "approve" | "revise" | "escalate";
  reviewerNotes?: string;
}

export type RunKind = "plan" | "implement" | "fix" | "review" | "triage" | "draft" | "chat";
export type RunStatus = "running" | "done" | "failed" | "stopped" | "overage";

export interface RunRow {
  id: string;
  project: string;
  number: number | null;
  kind: RunKind;
  status: RunStatus;
  provider: string;
  model: string;
  tier: ModelTier;
  effort: Effort;
  overridden: boolean;
  startedAt: string;
  endedAt: string | null;
  sessionId: string | null;
  inputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  usedOverage: boolean;
  error: string | null;
  logPath: string;
  summary: string | null;
}

export interface UsageSnapshot {
  at: string;
  fiveHour: number | null;
  fiveHourResetsAt: number | null;
  sevenDay: number | null;
  sevenDayResetsAt: number | null;
  status: string;
  overageStatus: string | null;
  isUsingOverage: boolean;
}

export interface DraftRow {
  id: number;
  project: string;
  number: number | null;
  kind: "triage" | "new";
  title: string;
  body: string;
  labels: string[];
  risk: Risk;
  status: "open" | "accepted" | "rejected";
  createdAt: string;
}

export interface DeployRow {
  id: number;
  project: string;
  env: string;
  version: string | null;
  /** "step": a gate's step, not a deploy. Absent on rows written before steps existed. */
  kind?: "deploy" | "step";
  /** The gate a step ran for. */
  gate?: string;
  /** Gates this deploy went ahead without, and why. */
  skipped?: { gates: string[]; reason: string };
  /** "restarted": Kiln stopped while it ran (a deploy of Kiln itself restarts Kiln). */
  /** "stopped": a gate step stopped from Kiln. */
  status: "running" | "done" | "failed" | "restarted" | "stopped";
  startedAt: string;
  endedAt: string | null;
  logPath: string;
}

const now = () => new Date().toISOString();

export class Ledger {
  readonly db: DatabaseSync;

  constructor(file = join(KILN_STATE, "kiln.db")) {
    mkdirSync(KILN_STATE, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        project TEXT NOT NULL, number INTEGER NOT NULL, data TEXT NOT NULL,
        phase TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (project, number)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, number INTEGER, kind TEXT NOT NULL,
        status TEXT NOT NULL, started_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_task ON runs(project, number);
      CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
      CREATE TABLE IF NOT EXISTS usage (
        at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, status TEXT NOT NULL,
        data TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deploys (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, env TEXT NOT NULL,
        status TEXT NOT NULL, data TEXT NOT NULL, started_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat (
        project TEXT PRIMARY KEY, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_issues (
        project TEXT NOT NULL, number INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (project, number)
      );
    `);
  }

  // ---- tasks --------------------------------------------------------------

  getTask(project: string, number: number): TaskRow | undefined {
    const r = this.db.prepare("SELECT data FROM tasks WHERE project = ? AND number = ?").get(project, number) as
      | { data: string }
      | undefined;
    return r ? (JSON.parse(r.data) as TaskRow) : undefined;
  }

  listTasks(project: string): TaskRow[] {
    return (this.db.prepare("SELECT data FROM tasks WHERE project = ? ORDER BY updated_at DESC").all(project) as {
      data: string;
    }[]).map((r) => JSON.parse(r.data) as TaskRow);
  }

  createTask(t: Omit<TaskRow, "createdAt" | "updatedAt">): TaskRow {
    const row: TaskRow = { ...t, createdAt: now(), updatedAt: now() };
    this.putTask(row);
    return row;
  }

  updateTask(project: string, number: number, patch: Partial<TaskRow>): TaskRow {
    const cur = this.getTask(project, number);
    if (!cur) throw new Error(`No task ${project}#${number}`);
    const row = { ...cur, ...patch, updatedAt: now() };
    this.putTask(row);
    return row;
  }

  private putTask(t: TaskRow) {
    this.db
      .prepare(
        "INSERT INTO tasks (project, number, data, phase, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(project, number) DO UPDATE SET data = excluded.data, phase = excluded.phase, updated_at = excluded.updated_at",
      )
      .run(t.project, t.number, JSON.stringify(t), t.phase, t.updatedAt);
  }

  deleteTask(project: string, number: number) {
    this.db.prepare("DELETE FROM tasks WHERE project = ? AND number = ?").run(project, number);
  }

  // ---- runs ---------------------------------------------------------------

  putRun(r: RunRow) {
    this.db
      .prepare(
        "INSERT INTO runs (id, project, number, kind, status, started_at, data) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data",
      )
      .run(r.id, r.project, r.number, r.kind, r.status, r.startedAt, JSON.stringify(r));
  }

  getRun(id: string): RunRow | undefined {
    const r = this.db.prepare("SELECT data FROM runs WHERE id = ?").get(id) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as RunRow) : undefined;
  }

  listRuns(filter: { project?: string; number?: number; since?: string; limit?: number } = {}): RunRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.project) (where.push("project = ?"), args.push(filter.project));
    if (filter.number !== undefined) (where.push("number = ?"), args.push(filter.number));
    if (filter.since) (where.push("started_at >= ?"), args.push(filter.since));
    const sql =
      "SELECT data FROM runs" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY started_at DESC" +
      (filter.limit ? ` LIMIT ${Math.floor(filter.limit)}` : "");
    return (this.db.prepare(sql).all(...args) as { data: string }[]).map((r) => JSON.parse(r.data) as RunRow);
  }

  /** Runs marked running in the ledger but not alive in this process (after a crash/restart). */
  markOrphanRuns(alive: Set<string>) {
    for (const r of this.listRuns({ limit: 500 })) {
      if (r.status === "running" && !alive.has(r.id)) {
        this.putRun({ ...r, status: "stopped", endedAt: now(), error: r.error ?? "Kiln restarted during the run" });
      }
    }
  }

  // ---- usage --------------------------------------------------------------

  addUsage(u: UsageSnapshot) {
    const last = this.lastUsage();
    // Keep the history small: one row per minute unless something material changed.
    if (
      last &&
      Date.parse(u.at) - Date.parse(last.at) < 60_000 &&
      last.isUsingOverage === u.isUsingOverage &&
      last.status === u.status
    ) {
      this.db.prepare("UPDATE usage SET at = ?, data = ? WHERE at = ?").run(u.at, JSON.stringify(u), last.at);
      return;
    }
    this.db.prepare("INSERT INTO usage (at, data) VALUES (?, ?)").run(u.at, JSON.stringify(u));
  }

  lastUsage(): UsageSnapshot | undefined {
    const r = this.db.prepare("SELECT data FROM usage ORDER BY at DESC LIMIT 1").get() as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as UsageSnapshot) : undefined;
  }

  // ---- drafts -------------------------------------------------------------

  addDraft(d: Omit<DraftRow, "id" | "createdAt" | "status">): DraftRow {
    const createdAt = now();
    const res = this.db
      .prepare("INSERT INTO drafts (project, status, data, created_at) VALUES (?, 'open', ?, ?)")
      .run(d.project, JSON.stringify(d), createdAt);
    const row: DraftRow = { ...d, id: Number(res.lastInsertRowid), status: "open", createdAt };
    this.putDraft(row);
    return row;
  }

  putDraft(d: DraftRow) {
    this.db.prepare("UPDATE drafts SET status = ?, data = ? WHERE id = ?").run(d.status, JSON.stringify(d), d.id);
  }

  getDraft(id: number): DraftRow | undefined {
    const r = this.db.prepare("SELECT data FROM drafts WHERE id = ?").get(id) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as DraftRow) : undefined;
  }

  listDrafts(project: string, status: DraftRow["status"] = "open"): DraftRow[] {
    return (this.db.prepare("SELECT data FROM drafts WHERE project = ? AND status = ? ORDER BY id DESC").all(
      project,
      status,
    ) as { data: string }[]).map((r) => JSON.parse(r.data) as DraftRow);
  }

  // ---- deploys ------------------------------------------------------------

  addDeploy(d: Omit<DeployRow, "id">): DeployRow {
    const res = this.db
      .prepare("INSERT INTO deploys (project, env, status, data, started_at) VALUES (?, ?, ?, ?, ?)")
      .run(d.project, d.env, d.status, JSON.stringify(d), d.startedAt);
    const row = { ...d, id: Number(res.lastInsertRowid) };
    this.putDeploy(row);
    return row;
  }

  putDeploy(d: DeployRow) {
    this.db.prepare("UPDATE deploys SET status = ?, data = ? WHERE id = ?").run(d.status, JSON.stringify(d), d.id);
  }

  /**
   * Settles deploys the previous daemon left running. `runningSha` is the commit this daemon runs
   * from: a deploy of that version is a self-update that worked ("done"); anything else was cut
   * short by the restart ("restarted").
   */
  markOrphanDeploys(runningSha?: string) {
    const same = (v: string | null) =>
      !!v && !!runningSha && (v.startsWith(runningSha) || runningSha.startsWith(v));
    for (const r of this.db.prepare("SELECT data FROM deploys WHERE status = 'running'").all() as { data: string }[]) {
      const d = JSON.parse(r.data) as DeployRow;
      this.putDeploy({ ...d, status: same(d.version) ? "done" : "restarted", endedAt: now() });
    }
  }

  listDeploys(project: string, limit = 20): DeployRow[] {
    return (this.db
      .prepare("SELECT data FROM deploys WHERE project = ? ORDER BY id DESC LIMIT ?")
      .all(project, limit) as { data: string }[]).map((r) => JSON.parse(r.data) as DeployRow);
  }

  // ---- chat ---------------------------------------------------------------

  getChat(project: string): ChatState {
    const r = this.db.prepare("SELECT data FROM chat WHERE project = ?").get(project) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as ChatState) : { sessionId: null, messages: [] };
  }

  putChat(project: string, c: ChatState) {
    this.db
      .prepare("INSERT INTO chat (project, data) VALUES (?, ?) ON CONFLICT(project) DO UPDATE SET data = excluded.data")
      .run(project, JSON.stringify(c));
  }

  // ---- local issues (source: "local") --------------------------------------

  localIssues(project: string): LocalIssue[] {
    return (this.db.prepare("SELECT data FROM local_issues WHERE project = ? ORDER BY number").all(project) as {
      data: string;
    }[]).map((r) => JSON.parse(r.data) as LocalIssue);
  }

  putLocalIssue(project: string, i: LocalIssue) {
    this.db
      .prepare(
        "INSERT INTO local_issues (project, number, data) VALUES (?, ?, ?) ON CONFLICT(project, number) DO UPDATE SET data = excluded.data",
      )
      .run(project, i.number, JSON.stringify(i));
  }
}

export interface ChatAction {
  id: string;
  label: string;
  kind: "create_issue" | "relabel" | "close_issue" | "pace" | "message_agent" | "stop_run" | "open";
  args: Record<string, unknown>;
  status?: "done" | "failed" | "dismissed";
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
  actions?: ChatAction[];
}

export interface ChatState {
  sessionId: string | null;
  messages: ChatMessage[];
}

export interface LocalIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "OPEN" | "CLOSED";
  closedAt: string | null;
  comments: { body: string; at: string }[];
  createdAt: string;
}
