import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
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
}

export interface ProjectConfig {
  id: string;
  name: string;
  /** Absolute path to the local checkout. */
  path: string;
  /** owner/repo on GitHub. */
  repo: string;
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
}

export interface KilnConfig {
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

/** Loads $KILN_HOME/.env into process.env (existing variables win). */
export function loadEnv(): void {
  const file = join(KILN_HOME, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

export function loadConfig(path = join(KILN_HOME, "config.json")): KilnConfig {
  if (!existsSync(path)) {
    throw new Error(
      `No Kiln config at ${path}. Copy examples/kiln.config.example.json there and edit it (see README).`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as KilnConfig;
}

export function getProject(cfg: KilnConfig, id: string): ProjectConfig {
  const p = cfg.projects.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown project "${id}". Known: ${cfg.projects.map((x) => x.id).join(", ")}`);
  return p;
}
