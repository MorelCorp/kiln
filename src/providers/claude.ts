import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { homedir } from "node:os";
import { KILN_STATE } from "../config.ts";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { claudeCode, claudeHostSessionPath, findClaudeSessionOnHost, transferClaudeSession } from "@ai-hero/sandcastle";
import type { Effort, HostAskOptions, HostAskResult, ModelProvider, ModelTier, ProviderConfig } from "./types.ts";
import { StreamParser, type StreamSink } from "../runs/stream.ts";

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
      throw new Error(`${this.config.tokenEnv} is not set. Run \`claude setup-token\` and put it in $KILN_HOME/.env.`);
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

  private env(): Record<string, string> {
    return { CLAUDE_CODE_OAUTH_TOKEN: process.env[this.config.tokenEnv]! };
  }

  /**
   * The sandboxed CLI's config dir, on the host, bind-mounted into the sandbox at the same path.
   * Claude writes its session transcripts there as it goes, so a session survives an abort
   * (redirect, per-task override, extra-usage stop) and can be resumed. Without it the transcript
   * lives in the sandbox's private home and is lost when a run is aborted.
   */
  private configDir(): string {
    // Not under /tmp: bwrap gives the sandbox a private /tmp and sandcastle maps /tmp paths there,
    // so a session store under /tmp could not be captured or resumed.
    const root = KILN_STATE.startsWith("/tmp/") ? join(homedir(), ".local", "state", "kiln") : KILN_STATE;
    const dir = join(root, "claude", this.config.id);
    mkdirSync(join(dir, "projects"), { recursive: true, mode: 0o700 });
    return dir;
  }

  sandboxMounts() {
    return [{ hostPath: this.configDir(), sandboxPath: this.configDir() }];
  }

  /**
   * Make a session resumable after an aborted run. Sandcastle expects the transcript under the repo
   * path; normally it moves it there when a run ends, but an aborted run skips that step and the
   * transcript stays under the worktree path. Copy it across (rewriting its cwd) if needed.
   */
  async prepareResume(sessionId: string, repoPath: string, worktreePath: string): Promise<boolean> {
    const projects = join(this.configDir(), "projects");
    const want = claudeHostSessionPath(repoPath, sessionId, projects);
    if (existsSync(want)) return true;
    const found = await findClaudeSessionOnHost(sessionId, projects);
    if (!found.path) return false;
    mkdirSync(dirname(want), { recursive: true });
    writeFileSync(want, transferClaudeSession(readFileSync(found.path, "utf8"), worktreePath, repoPath), { mode: 0o600 });
    return true;
  }

  agent(tier: ModelTier, effort: Effort) {
    const dir = this.configDir();
    return claudeCode(this.modelFor(tier), {
      effort,
      env: { ...this.env(), CLAUDE_CONFIG_DIR: dir },
      sessionStorage: { hostProjectsDir: join(dir, "projects"), sandboxProjectsDir: join(dir, "projects") },
    });
  }

  /**
   * One read-only `claude -p` on the host (no sandbox): `--permission-mode plan` so it cannot edit.
   * Used for chat, triage drafts and quick-capture questions, which only read the project.
   */
  ask(opts: HostAskOptions): Promise<HostAskResult> {
    const args = [
      "-p", "--verbose", "--output-format", "stream-json",
      "--model", this.modelFor(opts.tier),
      "--effort", opts.effort,
      "--permission-mode", "plan",
    ];
    if (opts.resume) args.push("--resume", opts.resume);
    if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
    const env = { ...process.env, ...this.env() };
    delete env.ANTHROPIC_API_KEY;

    return new Promise((resolve, reject) => {
      const child = spawn("claude", args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let result: HostAskResult | undefined;
      let sessionId: string | undefined;
      let stderr = "";
      const sink: StreamSink = {
        event: (e) => opts.sink?.event(e),
        sessionId: (id) => {
          sessionId = id;
          opts.sink?.sessionId?.(id);
        },
        rateLimit: (i) => opts.sink?.rateLimit?.(i),
        callUsage: (u, id) => opts.sink?.callUsage?.(u, id),
        result: (r) => {
          result = { text: r.text, costUsd: r.costUsd, usage: r.usage, sessionId: r.sessionId ?? sessionId, isError: r.isError };
          opts.sink?.result?.(r);
        },
      };
      const parser = new StreamParser(sink);
      createInterface({ input: child.stdout }).on("line", (l) => parser.line(l));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGTERM"), (opts.timeoutSeconds ?? 300) * 1000);
      opts.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (result && !result.isError) resolve(result);
        else reject(new Error(result?.text || stderr.trim() || `claude exited with ${code}`));
      });
      child.stdin.end(opts.prompt);
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
