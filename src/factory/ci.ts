import type { CheckRun, PullRequest, Source } from "../tasks/source.ts";

export interface CiOptions {
  /** Give up waiting for pending checks after this long. */
  timeoutMs: number;
  /** "No checks yet" is not "no checks" until this long has passed since the push. */
  graceMs: number;
  pollMs: number;
  /** Injected by tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called after each poll (to show progress). */
  onPoll?: (checks: CheckRun[]) => void;
  signal?: AbortSignal;
}

export type CiResult =
  | { status: "pass"; checks: CheckRun[]; note: string }
  | { status: "none"; checks: CheckRun[]; note: string }
  | { status: "fail"; checks: CheckRun[]; note: string }
  | { status: "timeout"; checks: CheckRun[]; note: string };

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const failing = (c: CheckRun) => c.bucket === "fail" || c.bucket === "cancel";
const pending = (c: CheckRun) => c.bucket === "pending";

function describe(c: CheckRun): string {
  return c.link ? `${c.name} (${c.link})` : c.name;
}

/**
 * Wait for the CI checks on a PR's head commit. Plain polling: no agent slot and no model call.
 * Resolves as soon as a check fails, all checks pass, or (after the grace period) there are none;
 * on timeout it reports the checks still pending.
 */
export async function waitForCi(src: Pick<Source, "prChecks">, pr: PullRequest, o: CiOptions): Promise<CiResult> {
  const sleep = o.sleep ?? sleepMs;
  const now = o.now ?? Date.now;
  const start = now();
  let errors = 0;
  for (;;) {
    let checks: CheckRun[] = [];
    try {
      checks = await src.prChecks(pr);
      errors = 0;
    } catch (e) {
      // A flaky network or a rate limit should not fail the gate on the first try.
      if (++errors >= 3) throw e;
    }
    if (!errors) {
      o.onPoll?.(checks);
      const bad = checks.filter(failing);
      if (bad.length) {
        return { status: "fail", checks, note: `CI failed on ${pr.url}:\n${bad.map((c) => `- ${describe(c)}`).join("\n")}` };
      }
      const waiting = checks.filter(pending);
      const elapsed = now() - start;
      if (checks.length && !waiting.length) {
        return { status: "pass", checks, note: `${checks.length} CI check${checks.length > 1 ? "s" : ""} passed.` };
      }
      if (!checks.length && elapsed >= o.graceMs) {
        return { status: "none", checks, note: "The repository reports no CI checks for this PR." };
      }
      if (elapsed >= o.timeoutMs) {
        const names = waiting.length ? waiting.map(describe).join(", ") : "none reported yet";
        return {
          status: "timeout", checks,
          note: `CI did not finish within ${Math.round(o.timeoutMs / 60_000)} min on ${pr.url}. Still pending: ${names}.`,
        };
      }
    }
    if (o.signal?.aborted) throw new Error("CI wait aborted");
    await sleep(o.pollMs);
  }
}

/** A short line per check for the gate box and the PR body. */
export function ciSummary(checks: CheckRun[]): string {
  return checks
    .filter((c) => c.bucket !== "skipping")
    .map((c) => `${failing(c) ? "❌" : pending(c) ? "⏳" : "✅"} ${describe(c)}`)
    .join("\n");
}
