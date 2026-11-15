/**
 * Model providers. Kiln ships with one (Claude Code on a Claude subscription), but every
 * launch goes through this interface so a second provider or a second subscription can be
 * added without touching the loop.
 */

/** Relative size of a model, used for the pace's ceiling. Providers map tiers to real model ids. */
export type ModelTier = "small" | "medium" | "large";
export const TIER_ORDER: ModelTier[] = ["small", "medium", "large"];

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_ORDER: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface ProviderConfig {
  /** Unique id, e.g. "claude-max". Several entries may share a kind (two subscriptions). */
  id: string;
  /** Which implementation. Only "claude-code" exists today. */
  kind: "claude-code";
  /** Env var holding this subscription's credential. */
  tokenEnv: string;
  /** Model id per tier. */
  models: Record<ModelTier, string>;
}

export interface ModelProvider {
  readonly config: ProviderConfig;
  /** Throws with a clear message if the provider cannot run (missing CLI, missing token, API key set, ...). */
  check(): Promise<void>;
  modelFor(tier: ModelTier): string;
  /**
   * The sandcastle agent for a run. Typed loosely here so this file does not depend on sandcastle;
   * the run manager passes it straight to `run({ agent })`.
   */
  agent(tier: ModelTier, effort: Effort): unknown;
}

export function clampTier(wanted: ModelTier, ceiling: ModelTier): ModelTier {
  return TIER_ORDER.indexOf(wanted) <= TIER_ORDER.indexOf(ceiling) ? wanted : ceiling;
}

export function clampEffort(wanted: Effort, ceiling: Effort): Effort {
  return EFFORT_ORDER.indexOf(wanted) <= EFFORT_ORDER.indexOf(ceiling) ? wanted : ceiling;
}
