/**
 * Turns Claude Code `--output-format stream-json --verbose` lines into Kiln events.
 *
 * PROVIDER-SEAM: this parser knows Claude Code's stream format (system/assistant/user/result
 * messages, rate_limit_event, TodoWrite and Task tools). A second provider needs its own parser
 * producing the same `RunEvent`s.
 */

export type EventKind =
  | "read" | "edit" | "bash" | "search" | "sub" | "think" | "tool" | "fail" | "progress"
  | "kiln" | "error" | "result";

export interface RunEvent {
  t: string;
  k: EventKind;
  text: string;
  /** Set when the event comes from a subagent (Task tool). */
  sub?: string;
}

export interface ProgressItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface RateLimitInfo {
  status: string;
  overageStatus?: string;
  isUsingOverage?: boolean;
  unifiedWindows?: {
    five_hour?: { utilization: number; resetsAt: number; status: string };
    seven_day?: { utilization: number; resetsAt: number; status: string };
  };
  resetsAt?: number;
  rateLimitType?: string;
}

export interface Usage {
  inputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface StreamSink {
  event(e: RunEvent): void;
  sessionId?(id: string): void;
  progress?(items: ProgressItem[]): void;
  rateLimit?(info: RateLimitInfo): void;
  /** Per model call usage (for live token rate). The same message id may repeat; keep the last. */
  callUsage?(u: Usage, messageId: string): void;
  /** Final result of one `claude -p` invocation. */
  result?(r: { text: string; costUsd: number; usage: Usage; sessionId?: string; isError: boolean }): void;
  /** Subagents currently running (Task tool ids → description). */
  subagents?(active: Map<string, string>): void;
}

const short = (s: string, n = 220) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function toolEvent(name: string, input: Json): { k: EventKind; text: string } {
  switch (name) {
    case "Read":
      return { k: "read", text: String(input.file_path ?? "") };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return { k: "edit", text: `${name === "Write" ? "write " : ""}${input.file_path ?? input.notebook_path ?? ""}` };
    case "Bash":
      return { k: "bash", text: short(String(input.command ?? ""), 300) };
    case "Grep":
      return { k: "search", text: `grep ${input.pattern ?? ""}${input.path ? ` in ${input.path}` : ""}` };
    case "Glob":
      return { k: "search", text: `glob ${input.pattern ?? ""}` };
    case "Task":
    case "Agent":
      return { k: "sub", text: `Subagent "${input.description ?? input.subagent_type ?? "task"}": ${short(String(input.prompt ?? ""), 160)}` };
    case "TodoWrite":
      return { k: "progress", text: "updated progress" };
    case "WebFetch":
    case "WebSearch":
      return { k: "tool", text: `${name} ${input.url ?? input.query ?? ""}` };
    default:
      return { k: "tool", text: `${name} ${short(JSON.stringify(input), 160)}` };
  }
}

export class StreamParser {
  private subs = new Map<string, string>();
  private lastText = "";

  constructor(private sink: StreamSink) {}

  line(raw: string, at = new Date()) {
    let m: Json;
    try {
      m = JSON.parse(raw);
    } catch {
      return; // not JSON (sandcastle status lines etc.)
    }
    const t = at.toISOString();
    const parent: string | null = m.parent_tool_use_id ?? null;
    const sub = parent ? this.subs.get(parent) ?? "subagent" : undefined;

    switch (m.type) {
      case "system":
        if (m.subtype === "init" && m.session_id) this.sink.sessionId?.(m.session_id);
        break;

      case "rate_limit_event":
        if (m.rate_limit_info) this.sink.rateLimit?.(m.rate_limit_info as RateLimitInfo);
        break;

      case "assistant": {
        const msg = m.message ?? {};
        if (msg.usage && !parent) {
          this.sink.callUsage?.({
            inputTokens: msg.usage.input_tokens ?? 0,
            cacheCreateTokens: msg.usage.cache_creation_input_tokens ?? 0,
            cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
            outputTokens: msg.usage.output_tokens ?? 0,
          }, String(msg.id ?? Math.random()));
        }
        for (const c of msg.content ?? []) {
          if (c.type === "text" && c.text?.trim()) {
            if (!parent) this.lastText = c.text.trim();
            this.sink.event({ t, k: "think", text: short(c.text.trim(), 600), sub });
          } else if (c.type === "tool_use") {
            const ev = toolEvent(c.name, c.input ?? {});
            if (c.name === "Task" || c.name === "Agent") {
              this.subs.set(c.id, String(c.input?.description ?? c.input?.subagent_type ?? "subagent"));
              this.sink.subagents?.(new Map(this.subs));
            }
            if (c.name === "TodoWrite" && Array.isArray(c.input?.todos) && !parent) {
              this.sink.progress?.(c.input.todos as ProgressItem[]);
            }
            this.sink.event({ t, ...ev, sub });
          }
        }
        break;
      }

      case "user": {
        for (const c of m.message?.content ?? []) {
          if (c.type !== "tool_result") continue;
          if (this.subs.has(c.tool_use_id)) {
            this.subs.delete(c.tool_use_id);
            this.sink.subagents?.(new Map(this.subs));
          }
          if (c.is_error) {
            const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
            this.sink.event({ t, k: "fail", text: short(text, 400), sub });
          }
        }
        break;
      }

      case "result": {
        const u = m.usage ?? {};
        const usage: Usage = {
          inputTokens: u.input_tokens ?? 0,
          cacheCreateTokens: u.cache_creation_input_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
        };
        const text = typeof m.result === "string" ? m.result : "";
        this.sink.result?.({
          text,
          costUsd: m.total_cost_usd ?? 0,
          usage,
          sessionId: m.session_id,
          isError: !!m.is_error,
        });
        // The final message usually repeats the last text block: show it once.
        const same = text.trim() === this.lastText;
        this.sink.event({ t, k: m.is_error ? "error" : "result", text: same ? "finished" : short(text || m.subtype || "done", 600) });
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Kiln's agent protocol: tagged blocks at the end of the agent's final message.
// ---------------------------------------------------------------------------

export function extractTag(text: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let last: string | undefined;
  for (const m of text.matchAll(re)) last = m[1].trim();
  return last;
}

export function extractJsonTag<T>(text: string, tag: string): T | undefined {
  const s = extractTag(text, tag);
  if (!s) return undefined;
  const body = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}
