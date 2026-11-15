import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ProjectConfig } from "../config.ts";
import type { Effort, HostAskResult, ModelTier } from "../providers/types.ts";
import type { ChatAction, DraftRow, Risk, RunKind, RunRow } from "../state/db.ts";
import { extractJsonTag, type RunEvent } from "../runs/stream.ts";
import { chatSystem, draftPrompt, questionsPrompt, triagePrompt } from "../runs/prompts.ts";
import { NEEDS_YOU, RUNS_DIR, type Factory } from "./factory.ts";

/** A read-only host `claude -p`, recorded in the ledger so its tokens count. */
async function hostAsk(
  f: Factory, p: ProjectConfig, kind: RunKind, number: number | null, prompt: string,
  o: { tier: ModelTier; effort: Effort; resume?: string | null; system?: string; onEvent?: (e: RunEvent) => void },
): Promise<HostAskResult> {
  const provider = f.provider(p);
  await provider.check();
  const blocked = f.extraUsageBlock();
  if (blocked) throw new Error(`Not sent: ${blocked}, and extra usage is off (Pace → Allow extra usage).`);
  const row: RunRow = {
    id: `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${p.id}-${number ?? "x"}-${kind}-${randomUUID().slice(0, 6)}`,
    project: p.id, number, kind, status: "running", provider: provider.config.id, model: provider.modelFor(o.tier),
    tier: o.tier, effort: o.effort, overridden: false, startedAt: new Date().toISOString(), endedAt: null,
    sessionId: o.resume ?? null, inputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0,
    usedOverage: false, error: null, logPath: join(RUNS_DIR, "host"), summary: null,
  };
  f.ledger.putRun(row);
  try {
    const r = await provider.ask({
      cwd: p.path, prompt, tier: o.tier, effort: o.effort, resume: o.resume ?? undefined, appendSystemPrompt: o.system,
      sink: {
        event: (e) => o.onEvent?.(e),
        rateLimit: (i) => f.onRateLimit(i),
      },
    });
    Object.assign(row, {
      status: "done", endedAt: new Date().toISOString(), sessionId: r.sessionId ?? null, costUsd: r.costUsd,
      inputTokens: r.usage.inputTokens, cacheCreateTokens: r.usage.cacheCreateTokens,
      cacheReadTokens: r.usage.cacheReadTokens, outputTokens: r.usage.outputTokens,
    });
    return r;
  } catch (e) {
    row.status = "failed";
    row.error = e instanceof Error ? e.message : String(e);
    row.endedAt = new Date().toISOString();
    throw e;
  } finally {
    f.ledger.putRun(row);
  }
}

interface Draft {
  title: string;
  body: string;
  labels: string[];
  risk: Risk;
}

function labelHints(p: ProjectConfig): string[] {
  return [p.labels.reviewAuto ?? "review:auto", p.labels.reviewRequired ?? "review:required", ...p.labels.priority];
}

// ---- triage -------------------------------------------------------------------

export async function triageDraft(f: Factory, p: ProjectConfig, number: number): Promise<DraftRow> {
  const issue = await f.source(p).getIssue(number);
  const r = await hostAsk(
    f, p, "triage", number,
    triagePrompt(issue, {
      ready: p.labels.ready, reviewAuto: p.labels.reviewAuto ?? "review:auto",
      reviewRequired: p.labels.reviewRequired ?? "review:required", priority: p.labels.priority,
    }),
    { tier: "medium", effort: "medium" },
  );
  const d = extractJsonTag<Draft>(r.text, "kiln-draft");
  if (!d?.title) throw new Error("The triage agent returned no draft");
  for (const old of f.ledger.listDrafts(p.id).filter((x) => x.number === number)) f.ledger.putDraft({ ...old, status: "rejected" });
  const row = f.ledger.addDraft({ project: p.id, number, kind: "triage", title: d.title, body: d.body, labels: d.labels ?? [], risk: d.risk === "required" ? "required" : "auto" });
  f.emit({ type: "board", project: p.id, data: {} });
  return row;
}

/** Accept a triage draft: update the issue, post the spec as a comment, relabel ready-for-agent. */
export async function acceptDraft(f: Factory, p: ProjectConfig, id: number, edited?: Partial<Draft>): Promise<number> {
  const d = f.ledger.getDraft(id);
  if (!d || d.status !== "open") throw new Error("Draft not found");
  const src = f.source(p);
  const final = { ...d, ...edited };
  const riskLabel = final.risk === "required" ? p.labels.reviewRequired ?? "review:required" : p.labels.reviewAuto ?? "review:auto";
  const labels = [...new Set([...final.labels.filter((l) => !p.labels.triage.includes(l)), riskLabel, p.labels.ready])];
  let number = d.number;
  if (number === null) {
    number = (await src.createIssue({ title: final.title, body: final.body, labels })).number;
  } else {
    await src.comment(number, `**Spec drafted by Kiln's triage agent, accepted by a human**\n\n## ${final.title}\n\n${final.body}`);
    await src.editLabels(number, labels, p.labels.triage);
  }
  f.ledger.putDraft({ ...final, status: "accepted" });
  await f.syncBoard(p.id, true);
  return number;
}

export function rejectDraft(f: Factory, id: number) {
  const d = f.ledger.getDraft(id);
  if (d) f.ledger.putDraft({ ...d, status: "rejected" });
}

// ---- new task (quick capture) ------------------------------------------------------

export async function quickQuestions(f: Factory, p: ProjectConfig, description: string) {
  const t0 = Date.now();
  const r = await hostAsk(f, p, "draft", null, questionsPrompt(description), { tier: "small", effort: "low" });
  const qs = extractJsonTag<{ q: string; options: string[] }[]>(r.text, "kiln-questions") ?? [];
  return { questions: qs.slice(0, 3), model: f.provider(p).modelFor("small"), seconds: Math.round((Date.now() - t0) / 1000) };
}

export async function quickDraft(f: Factory, p: ProjectConfig, description: string, answers: { q: string; a: string }[]) {
  const r = await hostAsk(f, p, "draft", null, draftPrompt(description, answers, labelHints(p)), { tier: "small", effort: "low" });
  const d = extractJsonTag<Draft>(r.text, "kiln-draft");
  if (!d?.title) throw new Error("No draft came back");
  return { ...d, risk: d.risk === "required" ? "required" : "auto" } as Draft;
}

export async function createTask(f: Factory, p: ProjectConfig, d: Draft & { as: "ready" | "triage" | "idea" }) {
  const riskLabel = d.risk === "required" ? p.labels.reviewRequired ?? "review:required" : p.labels.reviewAuto ?? "review:auto";
  const state = d.as === "ready" ? p.labels.ready : d.as === "idea" ? "idea" : p.labels.triage[0];
  const labels = [...new Set([...(d.labels ?? []).filter((l) => l !== p.labels.ready && !p.labels.triage.includes(l)), ...(d.as === "idea" ? [] : [riskLabel]), state])];
  const issue = await f.source(p).createIssue({ title: d.title, body: d.body, labels });
  await f.syncBoard(p.id, true);
  return issue;
}

// ---- chat -------------------------------------------------------------------------

function factoryContext(f: Factory, p: ProjectConfig): string {
  const board = f.cachedBoard(p.id);
  const tasks = f.ledger.listTasks(p.id);
  const by = (s: string) => board.filter((t) => t.state === s).map((t) => `#${t.number} ${t.title}`).slice(0, 15).join("; ");
  const kiln = tasks
    .filter((t) => t.phase !== "dropped" && t.phase !== "idle")
    .slice(0, 20)
    .map((t) => `#${t.number} ${t.title}: ${t.phase}${NEEDS_YOU.includes(t.phase) ? " (needs the human)" : ""}${t.question ? `, question: ${t.question.slice(0, 200)}` : ""}${t.note ? `, note: ${t.note.slice(0, 160)}` : ""}`)
    .join("\n");
  const u = f.ledger.lastUsage();
  return [
    `Project: ${p.name} (${p.repo}). Pace: ${JSON.stringify(f.cfg.pace)}.`,
    u ? `Subscription usage: 5h ${Math.round((u.fiveHour ?? 0) * 100)}%, 7d ${Math.round((u.sevenDay ?? 0) * 100)}%.` : "",
    `Ready: ${by("ready") || "none"}`,
    `Triage: ${by("triage") || "none"}`,
    `Kiln tasks:\n${kiln || "none"}`,
  ].join("\n");
}

export async function chat(f: Factory, p: ProjectConfig, text: string) {
  const state = f.ledger.getChat(p.id);
  state.messages.push({ role: "user", text, at: new Date().toISOString() });
  f.ledger.putChat(p.id, state);
  f.emit({ type: "chat", project: p.id, data: state });
  try {
    let r: HostAskResult;
    const system = chatSystem(factoryContext(f, p));
    try {
      r = await hostAsk(f, p, "chat", null, text, { tier: "medium", effort: "low", resume: state.sessionId, system });
    } catch (e) {
      if (!state.sessionId) throw e;
      r = await hostAsk(f, p, "chat", null, text, { tier: "medium", effort: "low", system }); // session gone: start fresh
    }
    const actions = (extractJsonTag<Omit<ChatAction, "id">[]>(r.text, "kiln-actions") ?? []).map((a) => ({ ...a, id: randomUUID().slice(0, 8) }));
    const reply = r.text.replace(/<kiln-actions>[\s\S]*?<\/kiln-actions>/g, "").trim();
    state.sessionId = r.sessionId ?? state.sessionId;
    state.messages.push({ role: "assistant", text: reply, at: new Date().toISOString(), actions });
  } catch (e) {
    state.messages.push({ role: "assistant", text: `Chat failed: ${e instanceof Error ? e.message : String(e)}`, at: new Date().toISOString() });
  }
  state.messages = state.messages.slice(-60);
  f.ledger.putChat(p.id, state);
  f.emit({ type: "chat", project: p.id, data: state });
  return state;
}

/** You confirmed a proposed chat action. Never merges or deploys. */
export async function runChatAction(f: Factory, p: ProjectConfig, actionId: string, dismiss = false) {
  const state = f.ledger.getChat(p.id);
  const a = state.messages.flatMap((m) => m.actions ?? []).find((x) => x.id === actionId);
  if (!a) throw new Error("Unknown action");
  if (dismiss) a.status = "dismissed";
  else {
    try {
      const g = a.args as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      switch (a.kind) {
        case "create_issue":
          await createTask(f, p, { title: g.title, body: g.body ?? "", labels: g.labels ?? [], risk: g.risk ?? "auto", as: "triage" });
          break;
        case "relabel":
          await f.source(p).editLabels(Number(g.number), g.add ?? [], g.remove ?? []);
          await f.syncBoard(p.id, true);
          break;
        case "close_issue": {
          const n = Number(g.number);
          if (!Number.isInteger(n) || n <= 0) throw new Error(`Bad issue number ${String(g.number)}`);
          await f.closeIssue(p.id, n, g.comment ? String(g.comment) : undefined, g.reason === "not planned" ? "not planned" : "completed");
          break;
        }
        case "pace":
          f.setPace(g);
          break;
        case "message_agent": {
          const t = f.ledger.getTask(p.id, Number(g.number));
          if (t?.phase === "question") await f.answer(p.id, t.number, String(g.message));
          else await f.redirect(p.id, Number(g.number), String(g.message));
          break;
        }
        case "stop_run":
          await f.stop(p.id, Number(g.number));
          break;
        case "open":
          break; // handled by the UI
      }
      a.status = "done";
    } catch (e) {
      a.status = "failed";
      f.toast(`Action failed: ${e instanceof Error ? e.message : String(e)}`, "error", p.id);
    }
  }
  f.ledger.putChat(p.id, state);
  f.emit({ type: "chat", project: p.id, data: state });
  return state;
}

/** A tiny Haiku request, only to read the subscription's current usage windows. */
export async function probeUsage(f: Factory, p: ProjectConfig) {
  await hostAsk(f, p, "chat", null, "Reply with the single word OK.", { tier: "small", effort: "low" });
  return f.ledger.lastUsage() ?? null;
}
