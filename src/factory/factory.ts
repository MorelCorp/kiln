import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { run as sandcastleRun, type AgentProvider } from "@ai-hero/sandcastle";
import {
  KILN_STATE, getProject, loadConfig, loadProjectPrompt, loadRules, saveConfig, mainBranch,
  type KilnConfig, type Pace, type ProjectConfig,
} from "../config.ts";
import { createProvider } from "../providers/claude.ts";
import { clampEffort, clampTier, TIER_ORDER, type Effort, type ModelProvider, type ModelTier } from "../providers/types.ts";
import {
  Ledger, type ChecklistItem, type Phase, type RunKind, type RunRow, type TaskRow, type UsageSnapshot,
} from "../state/db.ts";
import { git, sourceFor, type CloseReason, type IssueDetail, type PullRequest, type Source } from "../tasks/source.ts";
import { classify, labelsToClearOnPhase, type Task } from "../tasks/board.ts";
import {
  StreamParser, extractJsonTag, extractTag, type ProgressItem, type RateLimitInfo, type RunEvent, type Usage,
} from "../runs/stream.ts";
import { DEFAULT_PROJECT_PROMPT, implementPrompt, planPrompt, protocolReminder, resumePrompt } from "../runs/prompts.ts";
import { awaitCi, CI_GRACE_MS, CI_POLL_MS, prBody, rebaseAndCheck, runGate, sandboxFor, worktreePath } from "./gate.ts";

export const RUNS_DIR = join(KILN_STATE, "runs");

/** Phases in which Kiln is holding the task (it is not "ready" any more). */
const HELD: Phase[] = [
  "planning", "plan_review", "implementing", "question", "gating", "pr_review", "gate_failed", "failed",
  "usage_paused", "interrupted", "stopped",
];
/** Phases in which the task is over for Kiln. */
const SETTLED: Phase[] = ["merged", "human", "dropped"];
/** Phases in which a run or the gate is working the task. */
const BUSY: Phase[] = ["planning", "implementing", "gating"];
/** Phases that need the human. */
export const NEEDS_YOU: Phase[] = ["plan_review", "question", "pr_review", "gate_failed", "failed", "usage_paused", "interrupted", "stopped"];
const AGENT_KINDS: RunKind[] = ["plan", "implement", "fix", "review"];

type AbortReason = "stop" | "redirect" | "override" | "overage" | "shutdown";

export interface LiveRun {
  row: RunRow;
  controller: AbortController;
  events: RunEvent[];
  progress: ProgressItem[];
  subagents: string[];
  calls: Map<string, Usage>;
  samples: { at: number; tokens: number }[];
  /** Prompt size of the latest main-agent call: how full the context is now (drops after a compaction). */
  context: number;
  /** The provider's context cap for this run. */
  contextWindow: number;
  activity: string;
  /** What to do after an abort: resume with this prompt. */
  then?: { prompt: string; kind: RunKind };
}

export interface BusEvent {
  type: "board" | "task" | "run" | "run:event" | "usage" | "pace" | "deploy" | "envs" | "chat" | "toast";
  project?: string;
  data: unknown;
}

export interface FinishedRun {
  text: string;
  sessionId: string | null;
  aborted?: AbortReason;
  error?: string;
}

const now = () => new Date().toISOString();
const tokensOf = (u: Usage) => u.inputTokens + u.cacheCreateTokens + u.cacheReadTokens + u.outputTokens;

export class Factory {
  readonly bus = new EventEmitter();
  readonly ledger = new Ledger();
  cfg: KilnConfig;
  readonly live = new Map<string, LiveRun>();
  private providers = new Map<string, ModelProvider>();
  private boards = new Map<string, { at: number; tasks: Task[] }>();
  private syncing = new Map<string, Promise<Task[]>>();
  private timer?: NodeJS.Timeout;
  private starting = new Set<string>();
  /** The CI waits in progress (a poll, not a run), so Stop and Drop can interrupt them. */
  private ciWaits = new Map<string, AbortController>();
  /** How often the CI wait polls, and its grace period for checks that have not appeared yet. */
  ciTiming = { pollMs: CI_POLL_MS, graceMs: CI_GRACE_MS };

  constructor() {
    this.bus.setMaxListeners(100);
    this.cfg = loadConfig();
    mkdirSync(RUNS_DIR, { recursive: true });
    this.ledger.markOrphanRuns(new Set());
    this.ledger.markOrphanDeploys(process.env.KILN_RUNNING_SHA);
    // Tasks whose run died with the previous daemon resume by themselves (sessions persist on disk).
    for (const p of this.cfg.projects) {
      for (const t of this.ledger.listTasks(p.id)) {
        if (["planning", "implementing", "gating"].includes(t.phase)) {
          this.ledger.updateTask(p.id, t.number, {
            phase: "interrupted", interruptedFrom: t.phase,
            note: "Kiln stopped while this task was running. It resumes when the loop runs, or press Resume.",
          });
        }
      }
    }
  }

  emit(e: BusEvent) {
    this.bus.emit("event", e);
  }

  toast(text: string, level: "info" | "error" = "info", project?: string) {
    this.emit({ type: "toast", project, data: { text, level } });
  }

  // ---- config / pace --------------------------------------------------------

  project(id?: string): ProjectConfig {
    return getProject(this.cfg, id ?? this.cfg.activeProject);
  }

  provider(p: ProjectConfig): ModelProvider {
    let pr = this.providers.get(p.provider);
    if (!pr) {
      const pc = this.cfg.providers.find((x) => x.id === p.provider);
      if (!pc) throw new Error(`Unknown provider ${p.provider}`);
      pr = createProvider(pc);
      this.providers.set(p.provider, pr);
    }
    return pr;
  }

  source(p: ProjectConfig): Source {
    return sourceFor(p, this.ledger);
  }

  setPace(patch: Partial<Pace>) {
    this.cfg.pace = { ...this.cfg.pace, ...patch };
    saveConfig(this.cfg);
    this.emit({ type: "pace", data: this.cfg.pace });
    this.tick();
  }

  setActiveProject(id: string) {
    getProject(this.cfg, id);
    this.cfg.activeProject = id;
    saveConfig(this.cfg);
  }

  // ---- board ----------------------------------------------------------------

  async syncBoard(projectId: string, force = false): Promise<Task[]> {
    const cached = this.boards.get(projectId);
    if (cached && !force && Date.now() - cached.at < 60_000) return cached.tasks;
    const inflight = this.syncing.get(projectId);
    if (inflight) return inflight;
    const p = this.project(projectId);
    const job = (async () => {
      try {
        const issues = await this.source(p).listIssues();
        const tasks = issues.map((i) => classify(i, p)).sort((a, b) => a.priority - b.priority || a.number - b.number);
        this.boards.set(projectId, { at: Date.now(), tasks });
        this.emit({ type: "board", project: projectId, data: { at: now() } });
        void this.reconcile(p).catch((e) => console.warn(`[${p.id}] reconcile: ${e instanceof Error ? e.message : String(e)}`));
        return tasks;
      } finally {
        this.syncing.delete(projectId);
      }
    })();
    this.syncing.set(projectId, job);
    return job;
  }

  /** The task's own PR, when GitHub says it is merged (by Kiln or by someone on GitHub). */
  async mergedPr(p: ProjectConfig, task: TaskRow): Promise<PullRequest | undefined> {
    if (!task.prNumber) return undefined;
    const pr = await this.source(p).findPr(task.branch);
    return pr && pr.number === task.prNumber && pr.state === "MERGED" ? pr : undefined;
  }

  private reconciling = new Set<string>();

  /**
   * Catches up with merges done outside Kiln (e.g. a PR approved and merged on GitHub): an idle task
   * whose PR is merged becomes `merged`. Busy tasks are left alone; the gate checks for itself.
   */
  async reconcile(p: ProjectConfig) {
    if (this.reconciling.has(p.id)) return;
    this.reconciling.add(p.id);
    try {
      for (const t of this.ledger.listTasks(p.id)) {
        if (!t.prNumber || SETTLED.includes(t.phase) || BUSY.includes(t.phase)) continue;
        if (this.liveFor(p.id, t.number) || this.starting.has(`${p.id}#${t.number}`)) continue;
        const pr = await this.mergedPr(p, t);
        const cur = this.ledger.getTask(p.id, t.number);
        if (!pr || !cur || cur.phase !== t.phase || this.liveFor(p.id, t.number)) continue;
        this.markMergedOutside(cur, pr);
      }
    } finally {
      this.reconciling.delete(p.id);
    }
  }

  markMergedOutside(t: TaskRow, pr: PullRequest) {
    this.setPhase(t, "merged", { mergedSha: pr.mergeCommit, mergedAt: pr.mergedAt ?? now(), note: `PR #${pr.number} was merged outside Kiln.` });
    this.toast(`#${t.number} merged outside Kiln (PR #${pr.number})`, "info", t.project);
  }

  boardSyncedAt(projectId: string): number | undefined {
    return this.boards.get(projectId)?.at;
  }

  cachedBoard(projectId: string): Task[] {
    return this.boards.get(projectId)?.tasks ?? [];
  }

  // ---- usage guard ----------------------------------------------------------

  /** Why the loop may not start a run right now, or undefined if it may. */
  holdReason(forTask?: TaskRow): string | undefined {
    const pace = this.cfg.pace;
    const u = this.ledger.lastUsage();
    const extraOk = pace.allowExtraUsage || forTask?.allowExtra;
    if (u) {
      const fresh = (resetsAt: number | null) => resetsAt === null || resetsAt * 1000 > Date.now();
      if (u.fiveHour !== null && fresh(u.fiveHourResetsAt)) {
        if (u.fiveHour >= 1 && !extraOk) return "5-hour window exhausted";
        if (u.fiveHour >= pace.stopAt5h!) return `5-hour window above ${Math.round(pace.stopAt5h! * 100)}%`;
      }
      if (u.sevenDay !== null && fresh(u.sevenDayResetsAt)) {
        if (u.sevenDay >= 1 && !extraOk) return "7-day window exhausted";
        if (u.sevenDay >= pace.stopAt7d!) return `7-day window above ${Math.round(pace.stopAt7d! * 100)}%`;
      }
      if (u.status === "rejected" && !extraOk && fresh(u.fiveHourResetsAt)) return "subscription rate limit reached";
      if (u.isUsingOverage && !extraOk && fresh(u.fiveHourResetsAt ?? u.sevenDayResetsAt)) {
        return "extra usage would be used until the window resets";
      }
    }
    if (pace.tokenBudget > 0) {
      const used = this.kilnTokensSince(Date.now() - pace.tokenWindowHours * 3600_000);
      if (used >= pace.tokenBudget) return "Kiln token budget reached";
    }
    return undefined;
  }

  /**
   * Why any model call would be extra usage right now (window exhausted or overage in use, reset still
   * ahead), unless extra usage is allowed. Guards the interactive helpers too, not only agent runs.
   */
  extraUsageBlock(): string | undefined {
    if (this.cfg.pace.allowExtraUsage) return undefined;
    const u = this.ledger.lastUsage();
    if (!u) return undefined;
    const ahead = (t: number | null) => (t ?? 0) * 1000 > Date.now();
    const at = (t: number | null) => new Date((t ?? 0) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    if ((u.fiveHour ?? 0) >= 1 && ahead(u.fiveHourResetsAt)) return `5-hour window exhausted until ${at(u.fiveHourResetsAt)}`;
    if ((u.sevenDay ?? 0) >= 1 && ahead(u.sevenDayResetsAt)) return `7-day window exhausted until ${at(u.sevenDayResetsAt)}`;
    if (u.isUsingOverage && ahead(u.fiveHourResetsAt)) return `extra usage in use until ${at(u.fiveHourResetsAt)}`;
    return undefined;
  }

  kilnTokensSince(ms: number): number {
    const since = new Date(ms).toISOString();
    let sum = 0;
    for (const r of this.ledger.listRuns({ since })) sum += r.inputTokens + r.outputTokens + r.cacheCreateTokens;
    return sum;
  }

  onRateLimit(info: RateLimitInfo, live?: LiveRun) {
    const w = info.unifiedWindows ?? {};
    const snap: UsageSnapshot = {
      at: now(),
      fiveHour: w.five_hour?.utilization ?? null,
      fiveHourResetsAt: w.five_hour?.resetsAt ?? (info.rateLimitType === "five_hour" ? info.resetsAt ?? null : null),
      sevenDay: w.seven_day?.utilization ?? null,
      sevenDayResetsAt: w.seven_day?.resetsAt ?? null,
      status: info.status,
      overageStatus: info.overageStatus ?? null,
      isUsingOverage: !!info.isUsingOverage,
    };
    this.ledger.addUsage(snap);
    this.emit({ type: "usage", data: snap });
    if (live && snap.isUsingOverage) {
      live.row.usedOverage = true;
      const task = live.row.number !== null ? this.ledger.getTask(live.row.project, live.row.number) : undefined;
      if (!this.cfg.pace.allowExtraUsage && !task?.allowExtra) {
        this.abort(live, "overage");
      }
    }
  }

  // ---- model choice -----------------------------------------------------------

  /** Model tier and effort for a task: per-task override wins (even above ceilings), else label, else ceiling. */
  choose(p: ProjectConfig, t: TaskRow | undefined, labels: string[], kind: RunKind): { tier: ModelTier; effort: Effort; overridden: boolean } {
    const pace = this.cfg.pace;
    if (t?.overrideModel || t?.overrideEffort) {
      return { tier: t.overrideModel ?? pace.modelCeiling, effort: t.overrideEffort ?? pace.effortCeiling, overridden: true };
    }
    let wanted: ModelTier = pace.modelCeiling;
    const aliases: Record<string, ModelTier> = { haiku: "small", sonnet: "medium", opus: "large", small: "small", medium: "medium", large: "large" };
    for (const l of labels) {
      if (l.startsWith(p.labels.modelPrefix)) {
        const tier = aliases[l.slice(p.labels.modelPrefix.length).toLowerCase()];
        if (tier) wanted = tier;
      }
    }
    // The reviewer does not need the biggest model.
    if (kind === "review" && TIER_ORDER.indexOf(wanted) > 1) wanted = "medium";
    return { tier: clampTier(wanted, pace.modelCeiling), effort: clampEffort(pace.effortCeiling, pace.effortCeiling), overridden: false };
  }

  // ---- runs -----------------------------------------------------------------

  registerCiWait(project: string, number: number): AbortController {
    const ctl = new AbortController();
    this.ciWaits.set(`${project}#${number}`, ctl);
    return ctl;
  }

  clearCiWait(project: string, number: number, ctl: AbortController) {
    if (this.ciWaits.get(`${project}#${number}`) === ctl) this.ciWaits.delete(`${project}#${number}`);
  }

  /** Interrupt a task's CI wait, if any. Returns whether there was one. */
  abortCiWait(project: string, number: number): boolean {
    const ctl = this.ciWaits.get(`${project}#${number}`);
    ctl?.abort();
    return !!ctl;
  }

  liveFor(project: string, number: number): LiveRun | undefined {
    for (const r of this.live.values()) if (r.row.project === project && r.row.number === number) return r;
    return undefined;
  }

  agentRunsActive(): number {
    let n = 0;
    for (const r of this.live.values()) if (AGENT_KINDS.includes(r.row.kind)) n++;
    return n;
  }

  /** Live tokens per minute across Kiln's runs (last 60 s). */
  liveRate(): number {
    const cutoff = Date.now() - 60_000;
    let sum = 0;
    for (const r of this.live.values()) sum += this.rateOf(r, cutoff);
    return sum;
  }

  rateOf(r: LiveRun, cutoff = Date.now() - 60_000): number {
    const s = r.samples.filter((x) => x.at >= cutoff);
    if (s.length < 2) return 0;
    const spanMin = Math.max((s[s.length - 1].at - s[0].at) / 60_000, 1 / 6);
    return Math.round((s[s.length - 1].tokens - s[0].tokens) / spanMin);
  }

  private ensureExcluded(p: ProjectConfig) {
    const f = join(p.path, ".git", "info", "exclude");
    try {
      const cur = existsSync(f) ? readFileSync(f, "utf8") : "";
      if (!cur.split("\n").includes(".sandcastle/")) appendFileSync(f, `${cur.endsWith("\n") || !cur ? "" : "\n"}.sandcastle/\n`);
    } catch {
      /* not a plain .git dir: fine */
    }
  }

  /**
   * One sandcastle run on the task's branch. Resolves when the agent exits (or is aborted).
   * PROVIDER-SEAM: sandcastle's `run()` takes the provider's agent; the bwrap sandbox and
   * session resume are provider-neutral in sandcastle, but session capture exists only for Claude.
   */
  async agentRun(opts: {
    p: ProjectConfig;
    task: TaskRow;
    kind: RunKind;
    prompt: string;
    resume?: string | null;
    labels?: string[];
    readOnly?: boolean;
  }): Promise<FinishedRun> {
    const { p, task, kind } = opts;
    const provider = this.provider(p);
    const choice = this.choose(p, task, opts.labels ?? [], kind);
    const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${p.id}-${task.number}-${kind}-${randomUUID().slice(0, 6)}`;
    const logPath = join(RUNS_DIR, `${id}.log`);
    const eventsPath = join(RUNS_DIR, `${id}.jsonl`);
    const row: RunRow = {
      id, project: p.id, number: task.number, kind, status: "running", provider: provider.config.id,
      model: provider.modelFor(choice.tier), tier: choice.tier, effort: choice.effort, overridden: choice.overridden,
      startedAt: now(), endedAt: null, sessionId: opts.resume ?? null, inputTokens: 0, cacheCreateTokens: 0,
      cacheReadTokens: 0, outputTokens: 0, costUsd: 0, usedOverage: false, error: null, logPath, summary: null,
    };
    const live: LiveRun = {
      row, controller: new AbortController(), events: [], progress: [], subagents: [], calls: new Map(),
      samples: [], context: 0, contextWindow: provider.contextWindow(), activity: kind === "review" ? "Reviewer reading the diff" : "Starting sandbox",
    };
    this.live.set(id, live);
    this.ledger.putRun(row);
    this.emit({ type: "run", project: p.id, data: this.runView(live) });

    let resultText = "";
    let resultCost = 0;
    let lastPush = 0;
    const push = (force = false) => {
      if (!force && Date.now() - lastPush < 1000) return;
      lastPush = Date.now();
      this.ledger.putRun(row);
      this.emit({ type: "run", project: p.id, data: this.runView(live) });
    };
    const addEvent = (e: RunEvent) => {
      live.events.push(e);
      if (live.events.length > 1000) live.events.splice(0, live.events.length - 1000);
      appendFileSync(eventsPath, JSON.stringify(e) + "\n");
      if (e.k !== "result" && !e.sub) live.activity = e.k === "think" ? e.text.split("\n")[0] : `${e.k}: ${e.text}`;
      this.emit({ type: "run:event", project: p.id, data: { runId: id, event: e } });
      push();
    };
    const parser = new StreamParser({
      event: addEvent,
      sessionId: (sid) => {
        row.sessionId = sid;
        push(true);
      },
      progress: (items) => {
        live.progress = items;
        push(true);
      },
      subagents: (m) => {
        live.subagents = [...m.values()];
        push(true);
      },
      rateLimit: (info) => this.onRateLimit(info, live),
      callUsage: (u, mid) => {
        live.calls.set(mid, u);
        live.context = u.inputTokens + u.cacheCreateTokens + u.cacheReadTokens;
        let tot: Usage = { inputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
        for (const c of live.calls.values()) {
          tot = {
            inputTokens: tot.inputTokens + c.inputTokens,
            cacheCreateTokens: tot.cacheCreateTokens + c.cacheCreateTokens,
            cacheReadTokens: tot.cacheReadTokens + c.cacheReadTokens,
            outputTokens: tot.outputTokens + c.outputTokens,
          };
        }
        Object.assign(row, tot);
        live.samples.push({ at: Date.now(), tokens: tokensOf(tot) });
        if (live.samples.length > 400) live.samples.splice(0, 200);
        push();
      },
      result: (r) => {
        resultText = r.text;
        resultCost += r.costUsd;
        row.costUsd = resultCost;
        // The result event carries the invocation's totals; per-message usage undercounts output.
        if (tokensOf(r.usage) >= tokensOf(row)) Object.assign(row, r.usage);
        if (r.sessionId) row.sessionId = r.sessionId;
      },
    });

    this.ensureExcluded(p);
    const rules = loadRules(p);
    let finished: FinishedRun;
    try {
      await provider.check();
      if (opts.resume) await provider.prepareResume(opts.resume, p.path, worktreePath(p, task.branch));
      const res = await sandcastleRun({
        agent: provider.agent(choice.tier, choice.effort) as AgentProvider,
        sandbox: sandboxFor(this, p),
        cwd: p.path,
        prompt: opts.prompt,
        name: `${p.id}#${task.number} ${kind}`,
        branchStrategy: { type: "branch", branch: task.branch, baseBranch: this.source(p).baseRef() },
        resumeSession: opts.resume ?? undefined,
        maxIterations: 1,
        idleTimeoutSeconds: rules.idleTimeoutSeconds,
        completionSignal: ["</kiln-done>", "</kiln-question>", "</kiln-plan>", "</kiln-review>"],
        copyToWorktree: rules.copyToWorktree.length ? rules.copyToWorktree : undefined,
        signal: live.controller.signal,
        logging: {
          type: "file",
          path: logPath,
          onAgentStreamEvent: (ev) => {
            if (ev.type === "raw") parser.line(ev.line, ev.timestamp);
          },
        },
      });
      const it = res.iterations[res.iterations.length - 1];
      if (it?.sessionId) row.sessionId = it.sessionId;
      const iu = it?.usage;
      if (iu && iu.inputTokens + iu.cacheCreationInputTokens + iu.cacheReadInputTokens + iu.outputTokens > tokensOf(row)) {
        Object.assign(row, {
          inputTokens: iu.inputTokens, cacheCreateTokens: iu.cacheCreationInputTokens,
          cacheReadTokens: iu.cacheReadInputTokens, outputTokens: iu.outputTokens,
        });
      }
      if (res.preservedWorktreePath) this.ledger.updateTask(p.id, task.number, { worktree: res.preservedWorktreePath });
      row.status = "done";
      finished = { text: resultText || res.stdout.slice(-20_000), sessionId: row.sessionId };
    } catch (err) {
      const reason = live.controller.signal.aborted ? (live.controller.signal.reason as AbortReason) : undefined;
      if (reason) {
        row.status = reason === "overage" ? "overage" : "stopped";
        row.error = reason === "overage" ? "Stopped: the account started using extra usage" : `Aborted (${reason})`;
        finished = { text: resultText, sessionId: row.sessionId, aborted: reason };
      } else {
        row.status = "failed";
        row.error = err instanceof Error ? err.message : String(err);
        finished = { text: resultText, sessionId: row.sessionId, error: row.error };
      }
    }
    row.endedAt = now();
    const summary = extractJsonTag<{ summary?: string }>(finished.text, "kiln-done")?.summary;
    row.summary = summary ?? live.activity;
    this.live.delete(id);
    this.ledger.putRun(row);
    this.emit({ type: "run", project: p.id, data: this.runView(live) });
    return finished;
  }

  abort(live: LiveRun, reason: AbortReason) {
    if (!live.controller.signal.aborted) live.controller.abort(reason);
  }

  runView(r: LiveRun) {
    return {
      ...r.row,
      title: r.row.number !== null ? this.ledger.getTask(r.row.project, r.row.number)?.title ?? "" : "",
      live: this.live.has(r.row.id),
      activity: r.activity,
      progress: r.progress,
      subagents: r.subagents,
      rate: this.rateOf(r),
      context: r.context,
      contextWindow: r.contextWindow,
    };
  }

  // ---- task lifecycle -------------------------------------------------------

  /** Start (or restart) a ready task. `manual` bypasses pace and the usage guard (you clicked Run now). */
  async startTask(projectId: string, number: number, manual = false): Promise<void> {
    const key = `${projectId}#${number}`;
    if (this.starting.has(key) || this.liveFor(projectId, number)) return;
    this.starting.add(key);
    try {
      const p = this.project(projectId);
      const src = this.source(p);
      const issue = await src.getIssue(number);
      let task = this.ledger.getTask(p.id, number);
      const hold = manual ? undefined : this.holdReason(task);
      if (hold) throw new Error(`Not starting: ${hold}`);
      const risky = issue.labels.includes(p.labels.reviewRequired ?? "review:required");
      const fields = {
        title: issue.title,
        risk: risky ? ("required" as const) : ("auto" as const),
        riskReason: risky ? "risk label" : "",
      };
      if (!task) {
        task = this.ledger.createTask({
          project: p.id, number, ...fields, phase: risky ? "planning" : "implementing",
          branch: `kiln/issue-${number}`, worktree: null, sessionId: null, prNumber: null, prUrl: null, plan: null,
          question: null, checklist: null, gate: null, overrideModel: null, overrideEffort: null, allowExtra: false,
          sendBacks: 0, queuedMessage: null, note: null, mergedSha: null, mergedAt: null,
        });
      } else {
        task = this.ledger.updateTask(p.id, number, { ...fields, phase: risky && !task.plan ? "planning" : "implementing", note: null });
      }
      await src.editLabels(number, [p.labels.running], []).catch((e) => this.toast(`Label: ${e.message}`, "error", p.id));
      this.emitTask(task);
      this.syncBoard(p.id, true).catch(() => undefined);
      // Fire and forget: the run lives on in the background.
      void this.drive(p, issue, task.phase === "planning" ? "plan" : "implement");
    } finally {
      this.starting.delete(key);
    }
  }

  emitTask(t: TaskRow) {
    this.emit({ type: "task", project: t.project, data: t });
  }

  setPhase(t: TaskRow, phase: Phase, patch: Partial<TaskRow> = {}): TaskRow {
    const row = this.ledger.updateTask(t.project, t.number, { ...patch, phase });
    this.emitTask(row);
    if (["merged", "human", "dropped"].includes(phase)) {
      const p = this.project(t.project);
      void this.source(p).editLabels(t.number, [], labelsToClearOnPhase(phase, p)).catch(() => undefined);
      this.syncBoard(t.project, true).catch(() => undefined);
    }
    return row;
  }

  /**
   * Runs one agent step for a task and moves it to its next phase. `resumeWith` resumes the task's
   * session with a message (answer, redirect, approval, fix notes).
   */
  async drive(p: ProjectConfig, issue: IssueDetail, kind: RunKind, resumeWith?: string): Promise<void> {
    let task = this.ledger.getTask(p.id, issue.number)!;
    const projectPrompt = loadProjectPrompt(p) ?? DEFAULT_PROJECT_PROMPT;
    const prompt = resumeWith
      ? `${resumeWith}\n\n${protocolReminder(kind === "plan" ? "plan" : "work", task.branch)}`
      : kind === "plan"
        ? planPrompt(projectPrompt, issue, task.branch, task.riskReason || "risky", task.note)
        : implementPrompt(projectPrompt, issue, task.branch, task.plan, task.queuedMessage);
    task = this.setPhase(task, kind === "plan" ? "planning" : "implementing", { queuedMessage: resumeWith ? task.queuedMessage : null });
    const res = await this.agentRun({ p, task, kind, prompt, resume: resumeWith ? task.sessionId : undefined, labels: issue.labels });
    task = this.ledger.getTask(p.id, issue.number)!;
    if (res.sessionId) task = this.ledger.updateTask(p.id, task.number, { sessionId: res.sessionId });

    if (res.aborted) {
      const then = this.pendingResume.get(`${p.id}#${task.number}`);
      this.pendingResume.delete(`${p.id}#${task.number}`);
      if (then && (res.aborted === "redirect" || res.aborted === "override")) {
        return this.drive(p, issue, then.kind, then.prompt);
      }
      if (res.aborted === "overage") {
        this.setPhase(task, "usage_paused", { note: "Stopped when the account started using extra usage. Resumes when you retry after the window resets." });
      } else if (res.aborted === "stop") {
        this.setPhase(task, "stopped", { note: "Stopped by you. The worktree and session are kept." });
      }
      return;
    }
    if (res.error && resumeWith && /resumeSession .* not found/.test(res.error)) {
      this.toast(`#${task.number}: session not found, continuing in a fresh session on the same branch`, "info", p.id);
      this.ledger.updateTask(p.id, task.number, {
        sessionId: null,
        queuedMessage: `A previous session on this branch was interrupted; its work is in the worktree (check \`git status\` and \`git log\`). Continue from there.\n\n${resumeWith}`,
      });
      return this.drive(p, issue, kind === "plan" ? "plan" : "implement");
    }
    if (res.error && /rate.?limit|\b429\b|overloaded|usage limit|too many requests/i.test(res.error)) {
      const u = this.ledger.lastUsage();
      const reset = u?.fiveHourResetsAt && u.fiveHourResetsAt * 1000 > Date.now() && (u.fiveHour ?? 0) >= 1 ? u.fiveHourResetsAt * 1000 : 0;
      const backoff = Math.min(60, 5 * 2 ** Math.min(task.sendBacks, 3)) * 60_000; // 5, 10, 20, 40 min
      const retryAt = new Date(Math.max(reset + 30_000, Date.now() + backoff)).toISOString();
      this.setPhase(task, "usage_paused", { retryAt, note: `Rate limited (${res.error.split("\n")[0].slice(0, 160)}). Retrying at ${retryAt.slice(11, 16)} UTC.` });
      return;
    }
    if (res.error) {
      this.setPhase(task, "failed", { note: res.error });
      return;
    }

    const question = extractTag(res.text, "kiln-question");
    if (question) {
      this.setPhase(task, "question", { question });
      return;
    }
    if (kind === "plan") {
      const plan = extractTag(res.text, "kiln-plan");
      if (!plan) {
        this.setPhase(task, "failed", { note: "The agent finished without a <kiln-plan> block." });
        return;
      }
      this.setPhase(task, "plan_review", { plan, note: null });
      return;
    }
    const done = extractJsonTag<{ summary?: string; checklist?: ChecklistItem[] }>(res.text, "kiln-done");
    if (!done && !extractTag(res.text, "kiln-done")) {
      this.setPhase(task, "failed", { note: "The agent finished without a <kiln-done> block. Check its log, then retry or redirect." });
      return;
    }
    const checklist = (Array.isArray(done?.checklist) ? done.checklist : []).filter((c) => c && c.title);
    const summary = done?.summary ?? (done ? null : extractTag(res.text, "kiln-done")?.slice(0, 2000) ?? null);
    task = this.setPhase(task, "gating", { checklist: checklist.length ? checklist : task.checklist, note: summary, question: null });

    // A queued message ("queue for next turn") goes back to the agent before the gate.
    if (task.queuedMessage) {
      const msg = task.queuedMessage;
      this.ledger.updateTask(p.id, task.number, { queuedMessage: null });
      return this.drive(p, issue, "fix", resumePrompt(msg, "redirect"));
    }
    await this.gate(p, issue);
  }

  private pendingResume = new Map<string, { prompt: string; kind: RunKind }>();

  async gate(p: ProjectConfig, issue: IssueDetail): Promise<void> {
    let task = this.ledger.getTask(p.id, issue.number)!;
    const outcome = await runGate(this, p, issue, task);
    task = this.ledger.getTask(p.id, issue.number)!;
    switch (outcome.kind) {
      case "merged":
        if (outcome.outside) return void this.markMergedOutside(task, outcome.outside);
        this.setPhase(task, "merged", { mergedSha: outcome.sha, mergedAt: now(), note: task.note });
        this.toast(`#${task.number} merged`, "info", p.id);
        return;
      case "pr_review":
        this.setPhase(task, "pr_review", { note: outcome.note });
        return;
      case "send_back":
        if (task.sendBacks < loadRules(p).maxSendBacks) {
          this.ledger.updateTask(p.id, task.number, { sendBacks: task.sendBacks + 1 });
          return this.drive(p, issue, "fix", resumePrompt(outcome.note, "fix"));
        }
        this.setPhase(task, "gate_failed", { note: outcome.note });
        return;
      case "escalate":
      case "ci_failed":
        this.setPhase(task, "gate_failed", { note: outcome.note });
        return;
      case "aborted":
        return; // stopped or dropped during the CI wait: that action already set the phase
      case "error":
        this.setPhase(task, "failed", { note: outcome.note });
        return;
    }
  }

  // ---- human actions ---------------------------------------------------------

  private async withIssue(projectId: string, number: number) {
    const p = this.project(projectId);
    const issue = await this.source(p).getIssue(number);
    const task = this.ledger.getTask(p.id, number);
    if (!task) throw new Error(`Kiln has no task #${number}`);
    return { p, issue, task };
  }

  async stop(projectId: string, number: number) {
    this.abortCiWait(projectId, number);
    const live = this.liveFor(projectId, number);
    if (live) this.abort(live, "stop");
    else {
      const t = this.ledger.getTask(projectId, number);
      if (t) this.setPhase(t, "stopped", { note: "Stopped by you." });
    }
  }

  /** Abort the running agent and resume the same session with your message. */
  async redirect(projectId: string, number: number, message: string, queue = false) {
    const live = this.liveFor(projectId, number);
    const t = this.ledger.getTask(projectId, number);
    if (!t) throw new Error(`Kiln has no task #${number}`);
    this.ledger.updateTask(projectId, number, { decisions: [...(t.decisions ?? []), `Human redirected the agent: ${message}`] });
    if (queue || !live || !AGENT_KINDS.includes(live.row.kind) || live.row.kind === "review") {
      if (live || t.phase === "gating") {
        this.ledger.updateTask(projectId, number, { queuedMessage: message });
        this.toast(`Queued for #${number}'s next turn`, "info", projectId);
        return;
      }
      // Not running: resume now.
      const { p, issue } = await this.withIssue(projectId, number);
      void this.drive(p, issue, "fix", resumePrompt(message, "redirect"));
      return;
    }
    this.pendingResume.set(`${projectId}#${number}`, {
      prompt: resumePrompt(message, "redirect"),
      kind: live.row.kind === "plan" ? "plan" : "fix",
    });
    this.abort(live, "redirect");
  }

  /** Per-task model/effort. On a running task: applied at the next step by resuming the same session. */
  async override(projectId: string, number: number, o: { model: ModelTier | null; effort: Effort | null; allowExtra?: boolean }, applyNow = true) {
    const t = this.ledger.getTask(projectId, number);
    if (!t) {
      // Not picked up yet: remember the override for when it starts ("idle" is not held by the loop).
      const p = this.project(projectId);
      const issue = await this.source(p).getIssue(number);
      const row = this.ledger.createTask({
        project: projectId, number, title: issue.title, phase: "idle", risk: "auto", riskReason: "",
        branch: `kiln/issue-${number}`, worktree: null, sessionId: null, prNumber: null, prUrl: null, plan: null,
        question: null, checklist: null, gate: null, overrideModel: o.model, overrideEffort: o.effort,
        allowExtra: !!o.allowExtra, sendBacks: 0, queuedMessage: null, note: null, mergedSha: null, mergedAt: null,
      });
      this.emitTask(row);
      return;
    }
    const row = this.ledger.updateTask(projectId, number, {
      overrideModel: o.model, overrideEffort: o.effort, allowExtra: o.allowExtra ?? t.allowExtra,
    });
    this.emitTask(row);
    const live = this.liveFor(projectId, number);
    if (applyNow && live && live.row.kind !== "review" && row.sessionId) {
      this.pendingResume.set(`${projectId}#${number}`, {
        prompt: "Continue exactly where you left off.",
        kind: live.row.kind === "plan" ? "plan" : "fix",
      });
      this.abort(live, "override");
    }
  }

  async answer(projectId: string, number: number, text: string) {
    const { p, issue, task } = await this.withIssue(projectId, number);
    if (task.phase !== "question") throw new Error(`#${number} is not waiting for an answer`);
    this.ledger.updateTask(p.id, number, { question: null, decisions: [...(task.decisions ?? []), `Asked: ${task.question}\nHuman answered: ${text}`] });
    void this.drive(p, issue, task.plan || task.risk === "auto" ? "fix" : "plan", resumePrompt(text, "answer"));
  }

  async approvePlan(projectId: string, number: number, note?: string) {
    const { p, issue, task } = await this.withIssue(projectId, number);
    if (task.phase !== "plan_review") throw new Error(`#${number} has no plan waiting`);
    this.ledger.updateTask(p.id, number, { decisions: [...(task.decisions ?? []), `Human approved the plan${note ? ` with this note: ${note}` : ""}:\n${task.plan}`] });
    void this.drive(p, issue, "implement", resumePrompt(note ? `Note: ${note}` : "Go ahead.", "approve"));
  }

  async revisePlan(projectId: string, number: number, note: string) {
    const { p, issue, task } = await this.withIssue(projectId, number);
    if (task.phase !== "plan_review") throw new Error(`#${number} has no plan waiting`);
    void this.drive(p, issue, "plan", `The human wants a revised plan:\n\n${note}\n\nEnd with a new <kiln-plan> block.`);
  }

  /** Resume a task the loop paused (usage) or that Kiln's restart interrupted, at the step it was at. */
  async resumeHeld(t: TaskRow) {
    const p = this.project(t.project);
    const issue = await this.source(p).getIssue(t.number);
    const from = t.phase === "interrupted" ? t.interruptedFrom : undefined;
    this.toast(`#${t.number}: resuming${t.phase === "usage_paused" ? " after the usage pause" : " after a Kiln restart"}`, "info", p.id);
    const row = this.setPhase(t, from === "gating" ? "gating" : from === "planning" ? "planning" : "implementing", { retryAt: null, interruptedFrom: undefined });
    if (from === "gating") return this.gate(p, issue);
    if (row.sessionId) return this.drive(p, issue, from === "planning" ? "plan" : "fix", resumePrompt("Continue exactly where you left off.", "redirect"));
    return this.drive(p, issue, from === "planning" || (row.risk === "required" && !row.plan) ? "plan" : "implement");
  }

  /** Retry a failed/stopped/paused task: resume its session if it has one. */
  async retry(projectId: string, number: number, note?: string) {
    const { p, issue, task } = await this.withIssue(projectId, number);
    if (this.liveFor(projectId, number)) return;
    if ((task.phase === "interrupted" || task.phase === "usage_paused") && !note) return this.resumeHeld(task);
    if (task.phase === "gate_failed" || (task.phase === "gating" && !note)) {
      if (note) return this.drive(p, issue, "fix", resumePrompt(note, "fix"));
      return this.gate(p, issue);
    }
    if (task.sessionId) {
      const kind = task.risk === "required" && !task.plan ? "plan" : "fix";
      return this.drive(p, issue, kind, resumePrompt(note || "Continue where you left off.", "redirect"));
    }
    return this.drive(p, issue, task.risk === "required" && !task.plan ? "plan" : "implement");
  }

  async handToHuman(projectId: string, number: number) {
    const p = this.project(projectId);
    const t = this.ledger.getTask(projectId, number);
    this.abortCiWait(projectId, number);
    await this.source(p).editLabels(number, [p.labels.human], [p.labels.ready, p.labels.running]);
    if (t) this.setPhase(t, "human", { note: "Handed to a human." });
    await this.syncBoard(projectId, true);
  }

  async drop(projectId: string, number: number) {
    const p = this.project(projectId);
    const t = this.ledger.getTask(projectId, number);
    this.abortCiWait(projectId, number);
    const live = this.liveFor(projectId, number);
    if (live) this.abort(live, "stop");
    await this.source(p).editLabels(number, [], [p.labels.ready, p.labels.running]).catch(() => undefined);
    if (t) this.setPhase(t, "dropped", { note: "Dropped by you." });
  }

  /**
   * You closed the issue from Kiln (its page or a confirmed chat action): stop its run, post your
   * comment, close it on GitHub, and settle an unsettled task as dropped so the loop leaves it alone.
   */
  async closeIssue(projectId: string, number: number, comment?: string, reason: CloseReason = "completed") {
    const p = this.project(projectId);
    this.abortCiWait(projectId, number);
    const live = this.liveFor(projectId, number);
    if (live) this.abort(live, "stop");
    await this.source(p).closeIssue(number, comment?.trim() || undefined, reason);
    await this.source(p).editLabels(number, [], [p.labels.ready, p.labels.running]).catch(() => undefined);
    const t = this.ledger.getTask(projectId, number);
    if (t && !SETTLED.includes(t.phase)) this.setPhase(t, "dropped", { note: `Issue closed from Kiln (${reason}).` });
    await this.syncBoard(projectId, true);
    this.toast(`#${number} closed`, "info", projectId);
  }

  /**
   * You approved a PR in Kiln: merge it. Returns once the flow has started; it then runs in the
   * background (rebase, checks, push, CI wait, merge) and reports through the task's phase
   * (`gating`, then `merged` or `gate_failed`).
   */
  async approvePr(projectId: string, number: number) {
    const { p, issue, task } = await this.withIssue(projectId, number);
    if (task.phase !== "pr_review" && !(task.phase === "gate_failed" && task.prNumber)) {
      throw new Error(`#${number} has no PR waiting for review`);
    }
    const pr = await this.source(p).findPr(task.branch);
    if (!pr) throw new Error("PR not found");
    if (pr.state === "MERGED" && pr.number === task.prNumber) return void this.markMergedOutside(task, pr);
    const running = this.setPhase(task, "gating", { note: "Approved: rebasing, then waiting for CI before merging." });
    void this.mergeApproved(p, issue, running, pr).catch((e) => {
      const cur = this.ledger.getTask(p.id, number);
      if (cur?.phase === "gating") this.setPhase(cur, "gate_failed", { note: `Could not merge after your approval: ${e instanceof Error ? e.message : String(e)}` });
    });
  }

  private async mergeApproved(p: ProjectConfig, issue: IssueDetail, task: TaskRow, pr: PullRequest) {
    const number = task.number;
    const src = this.source(p);
    // Stopped or dropped meanwhile: do not touch the task or merge.
    const stillGating = () => this.ledger.getTask(p.id, number)?.phase === "gating";
    const fail = (note: string) => this.setPhase(this.ledger.getTask(p.id, number)!, "gate_failed", { note: `Could not merge after your approval: ${note}` });
    // Main may have moved since the gate ran: rebase and re-run the checks before merging.
    const gate = { ...(task.gate ?? {}), rebase: "pending" as const };
    const save = () => this.emitTask(this.ledger.updateTask(p.id, number, { gate: { ...gate } }));
    const rc = await rebaseAndCheck(this, p, task, gate, save);
    if (!stillGating()) return;
    if (!rc.ok) return void fail(rc.note);
    await src.pushBranch(rc.wt, task.branch, true);
    if (p.source !== "local") {
      // Wait for the repo's CI on the pushed head before merging (a poll: no agent, no usage).
      const head = await git(rc.wt, ["rev-parse", "HEAD"]);
      const hits = task.riskReason?.startsWith("path rule: ") ? task.riskReason.slice(11).split(", ") : [];
      const ci = await awaitCi(this, p, task, pr, head, gate, save, (g) => prBody(issue, this.ledger.getTask(p.id, number)!, g, hits));
      if (!ci.ok) return ci.aborted || !stillGating() ? undefined : void fail(ci.note);
    }
    if (!stillGating()) return;
    const sha = await src.mergePr(pr, issue.title, rc.wt);
    if (p.source === "local") await src.closeIssue(number, `Merged by Kiln (${sha.slice(0, 7)}).`);
    this.setPhase(this.ledger.getTask(p.id, number)!, "merged", { mergedSha: sha, mergedAt: now() });
  }

  async submitTests(projectId: string, number: number, results: ChecklistItem[], final: boolean) {
    const { p, issue, task } = await this.withIssue(projectId, number);
    const row = this.ledger.updateTask(p.id, number, { checklist: results });
    this.emitTask(row);
    if (!final) return;
    const failed = results.filter((r) => r.result === "fail");
    if (!failed.length) {
      this.ledger.updateTask(p.id, number, { checklist: results.map((r) => ({ ...r, result: r.result ?? "skip" })) });
      this.emitTask(this.ledger.getTask(p.id, number)!);
      return;
    }
    // The branch is merged: start a follow-up branch from main with the failure notes.
    const n = (task.branch.match(/-fix(\d+)$/)?.[1] ?? "0");
    const branch = `kiln/issue-${number}-fix${Number(n) + 1}`;
    const notes = failed.map((f) => `- ${f.title} (${f.env}): expected ${f.expected}. What happened: ${f.note ?? "failed"}`).join("\n");
    this.ledger.updateTask(p.id, number, {
      branch, sessionId: null, prNumber: null, prUrl: null, mergedSha: null, mergedAt: null, sendBacks: 0, gate: null,
      queuedMessage: `A human tested the previous change for this issue (already merged) and these checks failed:\n${notes}\nFix them on this new branch.`,
    });
    await this.source(p).editLabels(number, [p.labels.running], []).catch(() => undefined);
    void this.drive(p, issue, "implement");
  }

  // ---- loop -----------------------------------------------------------------

  startLoop() {
    this.timer = setInterval(() => this.tick(), 5000);
    this.tick();
  }

  /** Set once the daemon is shutting down: work it kills on the way out is not a failure. */
  stopping = false;

  stopLoop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const r of this.live.values()) this.abort(r, "shutdown");
  }

  lastHold?: string;

  /** The scheduler. Plain code: no model decides what runs. */
  tick() {
    for (const p of this.cfg.projects) {
      this.syncBoard(p.id).catch((e) => this.toast(`Sync ${p.id}: ${e.message}`, "error", p.id));
    }
    const pace = this.cfg.pace;
    if (pace.paused) return;
    const hold = this.holdReason();
    if (hold !== this.lastHold) {
      this.lastHold = hold;
      this.emit({ type: "pace", data: { ...pace, hold } });
    }
    if (hold) return;
    let slots = pace.maxConcurrentAgents - this.agentRunsActive() - this.starting.size;
    if (slots <= 0) return;
    for (const p of this.cfg.projects) {
      for (const t of this.ledger.listTasks(p.id)) {
        if (slots <= 0) return;
        if (!["usage_paused", "interrupted"].includes(t.phase) || this.liveFor(p.id, t.number) || this.holdReason(t)) continue;
        if (t.retryAt && Date.parse(t.retryAt) > Date.now()) continue;
        slots--;
        void this.resumeHeld(t).catch((e) => this.setPhase(t, "failed", { note: `Could not resume: ${e.message}` }));
      }
    }
    for (const p of this.cfg.projects) {
      const held = new Set(this.ledger.listTasks(p.id).filter((t) => HELD.includes(t.phase) || t.phase === "merged").map((t) => t.number));
      for (const t of this.cachedBoard(p.id)) {
        if (slots <= 0) return;
        if (t.state !== "ready" || held.has(t.number) || this.liveFor(p.id, t.number)) continue;
        slots--;
        this.startTask(p.id, t.number).catch((e) => this.toast(`#${t.number}: ${e.message}`, "error", p.id));
      }
    }
  }

  mainBranchOf(p: ProjectConfig) {
    return mainBranch(p);
  }

  async gitIn(cwd: string, args: string[]) {
    return git(cwd, args);
  }
}
