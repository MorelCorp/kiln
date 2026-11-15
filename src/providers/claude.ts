import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claudeCode } from "@ai-hero/sandcastle";
import type { Effort, ModelProvider, ModelTier, ProviderConfig } from "./types.ts";

const exec = promisify(execFile);

/** Claude Code CLI on a Claude subscription (OAuth token from `claude setup-token`). */
export class ClaudeCodeProvider implements ModelProvider {
  constructor(readonly config: ProviderConfig) {}

  async check(): Promise<void> {
    if (process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is set: Claude Code would bill the API instead of the subscription. Unset it.",
      );
    }
    if (!process.env[this.config.tokenEnv]) {
      throw new Error(`${this.config.tokenEnv} is not set. Run \`claude setup-token\` and put it in kiln/.env.`);
    }
    try {
      await exec("claude", ["--version"]);
    } catch {
      throw new Error("`claude` is not on PATH. Install the Claude Code CLI on the host (the bwrap sandbox uses host tools).");
    }
  }

  modelFor(tier: ModelTier): string {
    return this.config.models[tier];
  }

  agent(tier: ModelTier, effort: Effort) {
    return claudeCode(this.modelFor(tier), {
      effort,
      env: { CLAUDE_CODE_OAUTH_TOKEN: process.env[this.config.tokenEnv]! },
    });
  }
}

export function createProvider(config: ProviderConfig): ModelProvider {
  switch (config.kind) {
    case "claude-code":
      return new ClaudeCodeProvider(config);
    // PROVIDER-SEAM: add new kinds here (e.g. "codex", "opencode"); sandcastle has agents for them.
  }
}
