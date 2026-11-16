import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Effort, ModelTier, ProviderConfig } from "./providers/types.ts";

export interface LabelMap {
  triage: string[];
  ready: string;
  human: string;
  running: string;
  /** Label prefix a task can use to ask for a smaller model, e.g. "model:" → "model:small". */
  modelPrefix: string;
  /** Priority labels, highest first. */
  priority: string[];
  /** Issues carrying any of these are never picked up, whatever else they have (e.g. "parked"). */
  skip?: string[];
  /** Risk-tier labels set at triage. */
  reviewAuto?: string;
  reviewRequired?: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  /** Absolute path to the local checkout. */
  path: string;
  /** owner/repo on GitHub. Ignored when `source` is "local". */
  repo: string;
  /**
   * Where issues and PRs live. "github" (default) uses `gh`. "local" keeps issues in
   * Kiln's state dir and merges branches into the checkout's main locally: for trying
   * Kiln on a scratch repo without touching GitHub.
   */
  source?: "github" | "local";
  /** Main branch name. Default "main". */
  mainBranch?: string;
  /** Provider id from `providers`. */
  provider: string;
  labels: LabelMap;
}

export interface Pace {
  paused: boolean;
  maxConcurrentAgents: number;
  modelCeiling: ModelTier;
  effortCeiling: Effort;
  /** Soft cap on Kiln's own tokens (input + output) per window; 0 = no cap. */
  tokenBudget: number;
  tokenWindowHours: number;
  /** Let agents use the account's extra usage (overage). Off by default. */
  allowExtraUsage?: boolean;
  /** Stop starting runs above this 5-hour utilization (0..1). Default 0.9. */
  stopAt5h?: number;
  /** Stop starting runs above this 7-day utilization (0..1). Default 0.95. */
  stopAt7d?: number;
}

export interface KilnConfig {
  /**
   * Kiln is always one of its own projects, so it can keep improving itself. Its repo is whatever
   * this checkout's `origin` is (your fork if you forked it). `false` turns that off; an object
   * overrides fields of the generated project.
   */
  self?: false | Partial<ProjectConfig>;
  port: number;
  activeProject: string;
  pace: Pace;
  providers: ProviderConfig[];
  projects: ProjectConfig[];
}

export const KILN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where all user-specific configuration lives. Never inside the Kiln checkout: the repo is public.
 * Holds config.json, .env (tokens), private-terms.txt and notes/.
 */
export const KILN_HOME = process.env.KILN_HOME ?? join(homedir(), ".config", "kiln");

/** Runtime state (ledger, run logs). Never inside the checkout either. */
export const KILN_STATE =
  process.env.KILN_STATE ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "kiln");

export const CONFIG_PATH = join(KILN_HOME, "config.json");

/** Loads $KILN_HOME/.env into process.env (existing variables win). */
export function loadEnv(): void {
  const file = join(KILN_HOME, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

export const PACE_DEFAULTS: Required<Pace> = {
  paused: true,
  maxConcurrentAgents: 2,
  modelCeiling: "medium",
  effortCeiling: "high",
  tokenBudget: 0,
  tokenWindowHours: 5,
  allowExtraUsage: false,
  stopAt5h: 0.9,
  stopAt7d: 0.95,
};

export function loadConfig(path = CONFIG_PATH): KilnConfig {
  if (!existsSync(path)) {
    throw new Error(
      `No Kiln config at ${path}. Copy examples/kiln.config.example.json there and edit it (see README).`,
    );
  }
  const cfg = JSON.parse(readFileSync(path, "utf8")) as KilnConfig;
  cfg.pace = { ...PACE_DEFAULTS, ...cfg.pace };
  const self = selfProject(cfg);
  if (self) cfg.projects = [...cfg.projects, self];
  return cfg;
}

export const DEFAULT_LABELS: LabelMap = {
  triage: ["needs-triage", "needs-info", "idea"],
  ready: "ready-for-agent",
  human: "ready-for-human",
  running: "kiln:running",
  modelPrefix: "model:",
  priority: ["priority:next", "priority:later"],
  skip: ["parked"],
  reviewAuto: "review:auto",
  reviewRequired: "review:required",
};

/** owner/repo from a git remote URL (https or ssh), or undefined. */
export function repoFromRemote(url: string): string | undefined {
  const m = url.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  return m?.[1];
}

/** The project entry for Kiln's own checkout, unless disabled or already configured. */
function selfProject(cfg: KilnConfig): ProjectConfig | undefined {
  if (cfg.self === false) return undefined;
  const over = cfg.self ?? {};
  const path = over.path ?? KILN_ROOT;
  if (cfg.projects.some((p) => p.id === (over.id ?? "kiln") || resolve(p.path) === resolve(path))) return undefined;
  let repo = over.repo;
  if (!repo) {
    try {
      repo = repoFromRemote(execFileSync("git", ["-C", path, "remote", "get-url", "origin"], { encoding: "utf8" }));
    } catch {
      /* not a clone of a GitHub repo */
    }
  }
  if (!repo || !cfg.providers.length) return undefined;
  return {
    id: "kiln", name: "Kiln", path, repo, provider: cfg.providers[0].id, mainBranch: "main",
    ...over,
    labels: { ...DEFAULT_LABELS, ...(over.labels ?? {}) },
  };
}

/** Writes the config back atomically (used when the UI changes pace or the active project). */
export function saveConfig(cfg: KilnConfig, path = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const onDisk = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as KilnConfig) : undefined;
  const ids = new Set((onDisk?.projects ?? cfg.projects).map((p) => p.id));
  const out = { ...cfg, projects: cfg.projects.filter((p) => ids.has(p.id)) };
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function getProject(cfg: KilnConfig, id: string): ProjectConfig {
  const p = cfg.projects.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown project "${id}". Known: ${cfg.projects.map((x) => x.id).join(", ")}`);
  return p;
}

export function mainBranch(p: ProjectConfig): string {
  return p.mainBranch ?? "main";
}

// ---------------------------------------------------------------------------
// Per-project files: <project>/.kiln/
// ---------------------------------------------------------------------------

export interface ProjectRules {
  /** Globs (relative to the repo root) that make a task review:required whatever its label says. */
  riskyPaths: string[];
  /** Commands the merge gate runs in the rebased worktree, in order. */
  checks: { name: string; run: string; timeoutSeconds?: number }[];
  /** Max reviewer send-backs before escalating to the human. Default 1. */
  maxSendBacks: number;
  /** An agent producing no output for this long fails the run. */
  idleTimeoutSeconds: number;
  /** GitHub projects: how long the gate waits for the PR's CI checks before merging. Default 1200. */
  ciTimeoutSeconds: number;
  /** Paths (relative to the repo root) copied into each worktree before a run, e.g. node_modules. */
  copyToWorktree: string[];
  /** Extra things the sandbox may see: host paths (at the same path) and environment variables. */
  sandbox: {
    mounts: { path: string; readonly?: boolean }[];
    env: Record<string, string>;
    /** A working Go environment: a shared, writable module and build cache, wired through GOPATH, GOMODCACHE and GOCACHE. */
    go: boolean;
  };
}

export interface EnvProbe {
  id: string;
  name: string;
  /** Shown next to the name, e.g. a hostname. */
  url?: string;
  /** Shell command printing the deployed version (run in the project dir). */
  probe?: string;
  /** Shell command printing a health word, e.g. "healthy". Optional. */
  health?: string;
  /** Deploy (staging) or promote (prod) script, run in the project dir. */
  deploy?: string;
  deployLabel?: string;
  /**
   * Options picked next to the deploy button, e.g. `[patch, minor, major]`; the first is the default.
   * The pick reaches the deploy command as `$KILN_DEPLOY_CHOICE` (an env var, never spliced into the command).
   */
  deployChoices?: string[];
  /** Checks that must all pass (or be skipped) before `deploy` is allowed (release gate). */
  gate?: GateDef[];
  /** Command that prints the candidate version this deploy would ship. */
  candidate?: string;
}

export interface GateDef {
  name: string;
  /** The check: passes when it exits 0. Runs on every probe, so keep it fast (60 s cap). */
  run: string;
  /**
   * Optional step that produces what the check looks for (a scan, a report, an agent run), started
   * from a button next to the gate. Runs on the host in the project dir like a deploy, with no time
   * limit; its output streams into the deploy history. Gets `$KILN_ENV` and `$KILN_CANDIDATE`.
   */
  step?: string;
  stepLabel?: string;
  /** The deploy may go ahead with this gate failing, after you give a reason (kept in the history). */
  skippable?: boolean;
}

export interface ProjectEnvs {
  envs: EnvProbe[];
}

/** `~/x`, `$HOME/x`, `$KILN_HOME/x` → absolute. The sandbox has its own home, so paths must be spelled out. */
function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, homedir()).replaceAll("$KILN_HOME", KILN_HOME).replaceAll("$HOME", homedir());
}

function readYaml<T>(file: string): Partial<T> {
  if (!existsSync(file)) return {};
  return (parseYaml(readFileSync(file, "utf8")) ?? {}) as Partial<T>;
}

export function loadRules(p: ProjectConfig): ProjectRules {
  const r = readYaml<ProjectRules>(join(p.path, ".kiln", "rules.yaml"));
  return {
    riskyPaths: r.riskyPaths ?? [],
    checks: r.checks ?? [],
    maxSendBacks: r.maxSendBacks ?? 1,
    idleTimeoutSeconds: r.idleTimeoutSeconds ?? 900,
    ciTimeoutSeconds: r.ciTimeoutSeconds ?? 1200,
    copyToWorktree: r.copyToWorktree ?? [],
    sandbox: {
      mounts: (r.sandbox?.mounts ?? []).map((m) => ({ ...m, path: expandHome(m.path) })),
      env: Object.fromEntries(Object.entries(r.sandbox?.env ?? {}).map(([k, v]) => [k, expandHome(String(v))])),
      go: r.sandbox?.go === true,
    },
  };
}

export function loadEnvs(p: ProjectConfig): ProjectEnvs {
  const e = readYaml<ProjectEnvs>(join(p.path, ".kiln", "envs.yaml"));
  return { envs: e.envs ?? [] };
}

/** The project's own agent prompt (`.kiln/prompt.md`), or undefined to use Kiln's default. */
export function loadProjectPrompt(p: ProjectConfig): string | undefined {
  const f = join(p.path, ".kiln", "prompt.md");
  return existsSync(f) ? readFileSync(f, "utf8") : undefined;
}
