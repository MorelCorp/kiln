/**
 * Model providers. Kiln ships with one (Claude Code on a Claude subscription), but every
 * launch goes through this interface so a second provider or a second subscription can be
 * added without touching the loop.
 */

import type { RunEvent, StreamSink, Usage } from "../runs/stream.ts";

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
  /**
   * Context size, in tokens, an agent works within: the CLI compacts the conversation before it
   * reaches this. Default 200000. Without a cap, 1M-context models only compact near 1M tokens,
   * long past the point where quality drops.
   */
  contextWindow?: number;
}

export const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface ModelProvider {
  readonly config: ProviderConfig;
  /** Throws with a clear message if the provider cannot run (missing CLI, missing token, API key set, ...). */
  check(): Promise<void>;
  modelFor(tier: ModelTier): string;
  /** Context size agents are held under (see `ProviderConfig.contextWindow`). */
  contextWindow(): number;
  /**
   * The sandcastle agent for a run. Typed loosely here so this file does not depend on sandcastle;
   * the run manager passes it straight to `run({ agent })`.
   */
  agent(tier: ModelTier, effort: Effort): unknown;
  /** Make `sessionId` resumable for a run in `worktreePath` of `repoPath`. False if the session is gone. */
  prepareResume(sessionId: string, repoPath: string, worktreePath: string): Promise<boolean>;
  /** Host paths the sandbox must see read-write at the same path (e.g. the CLI's session store). */
  sandboxMounts(): { hostPath: string; sandboxPath: string }[];
  /** A read-only one-shot on the host (chat, triage, quick capture). Never edits files. */
  ask(opts: HostAskOptions): Promise<HostAskResult>;
}

export interface HostAskOptions {
  cwd: string;
  prompt: string;
  tier: ModelTier;
  effort: Effort;
  resume?: string;
  appendSystemPrompt?: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  sink?: Partial<StreamSink> & { event(e: RunEvent): void };
}

export interface HostAskResult {
  text: string;
  costUsd: number;
  usage: Usage;
  sessionId?: string;
  isError: boolean;
}

export function clampTier(wanted: ModelTier, ceiling: ModelTier): ModelTier {
  return TIER_ORDER.indexOf(wanted) <= TIER_ORDER.indexOf(ceiling) ? wanted : ceiling;
}

export function clampEffort(wanted: Effort, ceiling: Effort): Effort {
  return EFFORT_ORDER.indexOf(wanted) <= EFFORT_ORDER.indexOf(ceiling) ? wanted : ceiling;
}
