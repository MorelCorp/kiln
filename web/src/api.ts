import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

// ---- types (mirror the daemon's JSON) ------------------------------------------------

export type Tier = "small" | "medium" | "large";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Tone = "orange" | "peach" | "lavender" | "lilac" | "salmon" | "gold" | "sky" | "red" | "dim";

export interface Pace {
  paused: boolean;
  maxConcurrentAgents: number;
  modelCeiling: Tier;
  effortCeiling: Effort;
  tokenBudget: number;
  tokenWindowHours: number;
  allowExtraUsage: boolean;
  stopAt5h: number;
  stopAt7d: number;
}

export interface Usage {
  at: string;
  fiveHour: number | null;
  fiveHourResetsAt: number | null;
  sevenDay: number | null;
  sevenDayResetsAt: number | null;
  status: string;
  overageStatus: string | null;
  isUsingOverage: boolean;
}

export interface AppState {
  version: string;
  activeProject: string;
  projects: { id: string; name: string; repo: string; source: string }[];
  pace: Pace;
  hold: string | null;
  usage: Usage | null;
  rate: number;
  tiers: Record<Tier, { name: string; model: string }>;
}

export interface Card {
  number: number;
  title: string;
  url: string;
  labels: string[];
  priority: string | null;
  risk: "auto" | "required" | null;
  phase: string | null;
  tags: { text: string; tone: Tone }[];
  need?: string;
  needTone?: Tone;
  draftId?: number;
  testEnv?: string;
  override?: string | null;
  runId?: string | null;
  note?: string | null;
  human?: boolean;
}

export interface Board {
  project: { id: string; name: string; repo: string; source: string };
  syncedAt: number | null;
  columns: Record<"triage" | "ready" | "running" | "needs" | "merged" | "staging" | "prod", Card[]>;
}

export interface ChecklistItem {
  title: string;
  steps: string;
  expected: string;
  env: string;
  result?: "pass" | "fail" | "skip";
  note?: string;
}

export interface GateState {
  rebase?: "pending" | "pass" | "fail";
  checks?: { name: string; status: "pending" | "pass" | "fail"; output?: string }[];
  ci?: { status: "pending" | "pass" | "fail"; output?: string };
  reviewer?: "pending" | "approve" | "revise" | "escalate";
  reviewerNotes?: string;
}

export interface TaskRow {
  project: string;
  number: number;
  title: string;
  phase: string;
  risk: "auto" | "required";
  riskReason: string;
  branch: string;
  worktree: string | null;
  sessionId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  plan: string | null;
  question: string | null;
  checklist: ChecklistItem[] | null;
  gate: GateState | null;
  overrideModel: Tier | null;
  overrideEffort: Effort | null;
  allowExtra: boolean;
  sendBacks: number;
  queuedMessage: string | null;
  note: string | null;
  mergedSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunEvent {
  t: string;
  k: string;
  text: string;
  sub?: string;
}

export interface RunView {
  id: string;
  project: string;
  number: number | null;
  kind: string;
  status: string;
  model: string;
  tier: Tier;
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
  title?: string;
  live: boolean;
  activity: string | null;
  progress: { content: string; status: "pending" | "in_progress" | "completed" }[];
  subagents: string[];
  rate: number;
}

export interface IssueDetail {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: string[];
  body: string;
  comments: { body: string; author: string; at: string }[];
}

export interface TaskDetail {
  issue: IssueDetail;
  task: TaskRow | null;
  runs: RunView[];
  current: RunView | null;
  events: RunEvent[];
  changes: { status: string; file: string; add: number; del: number }[];
  pace: Pace;
  rules: { riskyPaths: string[] };
  worktree: string | null;
}

export interface IssueThread {
  issue: IssueDetail;
  task: TaskDetail["task"];
  current: RunView | null;
  events: RunEvent[];
}

export interface Draft {
  id: number;
  project: string;
  number: number | null;
  kind: "triage" | "new";
  title: string;
  body: string;
  labels: string[];
  risk: "auto" | "required";
  status: string;
  createdAt: string;
}

export interface InboxItem {
  kind: string;
  rank: number;
  since: string;
  task?: TaskRow;
  draft?: Draft;
  env?: string;
  items?: ChecklistItem[];
  lastRun?: RunView | null;
}

export interface ChatAction {
  id: string;
  label: string;
  kind: string;
  args: Record<string, unknown>;
  status?: "done" | "failed" | "dismissed";
}

export interface ChatState {
  sessionId: string | null;
  messages: { role: "user" | "assistant"; text: string; at: string; actions?: ChatAction[] }[];
}

export interface EnvView {
  id: string;
  name: string;
  url?: string;
  version: string | null;
  sha: string | null;
  health: string | null;
  error: string | null;
  checkedAt: string;
  deployLabel?: string;
  canDeploy: boolean;
  candidate: string | null;
  gates: { name: string; ok: boolean; output: string }[];
}

export interface Deploy {
  id: number;
  env: string;
  version: string | null;
  status: "running" | "done" | "failed";
  startedAt: string;
  endedAt: string | null;
}

export interface EnvsView {
  main: { sha: string | null; branch: string };
  envs: EnvView[];
  merged: { number: number; url: string; title: string; headRefName: string; mergedAt: string | null; mergeCommit: string | null; issue: number | null; on: string[] }[];
  checkedAt: string;
  deploys: Deploy[];
}

export interface TokensView {
  usage: Usage | null;
  kiln5h: number;
  costToday: number;
  rate: number;
  days: { day: string; small: number; medium: number; large: number }[];
  perTask: { project: string; number: number; title: string; runs: number; models: string[]; input: number; output: number; cost: number; extra: boolean; overridden: boolean; state: string }[];
  pace: Pace;
  hold: string | null;
}

// ---- fetch ---------------------------------------------------------------------------------

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

export const post = <T = unknown>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body });

// ---- server-sent events ----------------------------------------------------------------------

export interface BusEvent {
  type: string;
  project?: string;
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

type Listener = (e: BusEvent) => void;
const listeners = new Set<Listener>();
let connected = false;
const connListeners = new Set<() => void>();
let es: EventSource | null = null;

function connect() {
  if (es) return;
  es = new EventSource("/api/events");
  const types = ["board", "task", "run", "run:event", "usage", "pace", "deploy", "envs", "chat", "toast", "tick"];
  for (const t of types) {
    es.addEventListener(t, (m) => {
      const e = JSON.parse((m as MessageEvent).data);
      const ev: BusEvent = t === "tick" ? { type: "tick", data: e } : e;
      for (const l of listeners) l(ev);
    });
  }
  // The daemon greets each stream with its boot id. A new id means it restarted (e.g. "Update and
  // restart Kiln"): reload the page, so it runs the new command center on fresh state.
  let boot: string | null = null;
  es.addEventListener("hello", (m) => {
    const id = (JSON.parse((m as MessageEvent).data) as { boot?: string }).boot ?? null;
    if (boot && id && id !== boot) return void window.location.reload();
    if (boot) for (const l of listeners) l({ type: "reconnect", data: null }); // same daemon, link dropped: events were missed
    boot = id;
  });
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
}

function setConn(v: boolean) {
  if (connected === v) return;
  connected = v;
  for (const l of connListeners) l();
}

export function useConnected(): boolean {
  connect();
  return useSyncExternalStore(
    (cb) => (connListeners.add(cb), () => connListeners.delete(cb)),
    () => connected,
  );
}

export function useBus(fn: Listener) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    connect();
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
}

/**
 * GET `path`, and refetch (debounced) whenever a bus event of one of `on` arrives, and after the
 * event stream reconnects.
 * Returns [data, error, reload, setData].
 */
export function useApi<T>(path: string | null, on: string[] = [], debounceMs = 400) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const load = useCallback(() => {
    if (!path) return;
    api<T>(path).then(
      (d) => (setData(d), setError(null)),
      (e: Error) => setError(e.message),
    );
  }, [path]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  useBus((e) => {
    if (e.type !== "reconnect" && !on.includes(e.type)) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(load, debounceMs);
  });
  return [data, error, load, setData] as const;
}

// ---- formatting -----------------------------------------------------------------------------

export const TIER_LABEL: Record<Tier, string> = { small: "Haiku", medium: "Sonnet", large: "Opus" };
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const EFFORT_LABEL: Record<Effort, string> = { low: "Low", medium: "Med", high: "High", xhigh: "XHi", max: "Max" };
export const TIERS: Tier[] = ["small", "medium", "large"];

export function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

export const pct = (x: number | null | undefined) => (x === null || x === undefined ? "--" : `${String(Math.round(x * 100)).padStart(2, "0")}%`);
export const money = (x: number) => (x > 0 && x < 0.01 ? "<$0.01" : `$${x.toFixed(2)}`);
export const pad2 = (n: number) => String(n).padStart(2, "0");

export function elapsed(fromIso: string, to?: string | null): string {
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(fromIso)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`;
}

export function ago(iso: string | number | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - (typeof iso === "number" ? iso : Date.parse(iso))) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

export function resetTime(epochSec: number | null | undefined): string {
  if (!epochSec) return "--";
  const d = new Date(epochSec * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Ticks every `ms` so elapsed timers re-render. */
export function useNow(ms = 1000): number {
  const [n, setN] = useState(Date.now());
  useEffect(() => {
    const iv = window.setInterval(() => setN(Date.now()), ms);
    return () => window.clearInterval(iv);
  }, [ms]);
  return n;
}
