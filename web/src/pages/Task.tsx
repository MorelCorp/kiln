import { useEffect, useMemo, useRef, useState } from "react";
import {
  contextTone, elapsed, fmtTok, money, post, TIER_LABEL, useApi, useBus, useNow,
  type Effort, type RunEvent, type TaskDetail, type Tier,
} from "../api.ts";
import { EffortSeg, Loading, Md, PageTitle, Pill, Sec, Tag, TierSeg, useApp } from "../ui.tsx";

export const KCOLOR: Record<string, string> = {
  read: "var(--sky)", think: "var(--lavender)", sub: "var(--lilac)", edit: "var(--gold)", bash: "var(--peach)",
  fail: "var(--red)", error: "var(--red)", search: "var(--sky)", tool: "var(--peach)", progress: "var(--lavender)",
  result: "var(--orange)", kiln: "var(--orange)",
};

export const PHASE_LABEL: Record<string, string> = {
  idle: "not started", planning: "planning", plan_review: "plan waits for you", implementing: "implementing",
  question: "question for you", gating: "merge gate", pr_review: "PR waits for you", gate_failed: "gate failed",
  failed: "failed", usage_paused: "usage paused", interrupted: "interrupted", stopped: "stopped", merged: "merged", human: "human", dropped: "dropped",
};

type Filter = "all" | "tools" | "subagents" | "raw";

export function TaskPage({ number }: { number: number }) {
  const { pid, act, toast } = useApp();
  const [d, err, reload, setD] = useApi<TaskDetail>(`/api/p/${pid}/tasks/${number}`, ["task", "run"], 700);
  const [filter, setFilter] = useState<Filter>("all");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const feed = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useNow(1000);

  useBus((e) => {
    if (e.type !== "run:event" || !d?.current || e.data.runId !== d.current.id) return;
    setD((x) => (x ? { ...x, events: [...x.events, e.data.event as RunEvent].slice(-1500) } : x));
  });
  useEffect(() => {
    if (stick.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [d?.events.length]);

  const events = useMemo(() => {
    const ev = d?.events ?? [];
    if (filter === "tools") return ev.filter((e) => !["think", "result"].includes(e.k) && !e.sub);
    if (filter === "subagents") return ev.filter((e) => e.sub || e.k === "sub");
    return ev;
  }, [d?.events, filter]);

  if (!d) return <Loading error={err} />;
  const { issue, task, current } = d;
  const live = !!current?.live;
  const call = async (path: string, body: unknown = {}, ok?: string) => {
    setBusy(path);
    await act(() => post(`/api/p/${pid}/tasks/${number}/${path}`, body), ok);
    setBusy(null);
    reload();
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 22, alignItems: "flex-start" }}>
      <div style={{ flex: "999 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <span className="num" style={{ color: "var(--sky)", fontSize: 28 }}>#{number}</span>
          <PageTitle>{issue.title}</PageTitle>
          {task && <Tag tone={live ? "sky" : "gold"}>{PHASE_LABEL[task.phase] ?? task.phase}</Tag>}
          {task && <Tag tone={task.risk === "required" ? "red" : "sky"}>{task.risk === "required" ? "review" : "auto"}</Tag>}
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
            {d.worktree && task && (
              <Pill tone="lavender" sm onClick={() => navigator.clipboard.writeText(d.worktree!).then(() => toast("Worktree path copied"))} title={d.worktree}>Copy worktree path</Pill>
            )}
            <Pill tone="dim" sm href={issue.url}>Issue</Pill>
            {task?.prUrl?.startsWith("http") && <Pill tone="dim" sm href={task.prUrl}>PR</Pill>}
            {!task || ["idle", "human", "dropped"].includes(task.phase) ? (
              <Pill tone="gold" sm busy={busy === "start"} onClick={() => call("start", {}, "Started")}>Run now</Pill>
            ) : live ? (
              <Pill tone="red" sm busy={busy === "stop"} onClick={() => call("stop", {}, "Stopping")}>Stop</Pill>
            ) : ["failed", "stopped", "usage_paused", "interrupted", "gate_failed"].includes(task.phase) ? (
              <Pill tone="orange" sm busy={busy === "retry"} onClick={() => call("retry", {}, "Resumed")}>{task.sessionId ? "Resume" : "Retry"}</Pill>
            ) : null}
          </div>
        </div>
        <div className="lbl" style={{ color: "var(--lavender)" }}>
          {task ? `${task.branch} · bwrap sandbox` : "not picked up yet"}
          {current ? ` · ${current.kind}${live ? ` · ${elapsed(current.startedAt)} elapsed` : ` · ${current.status}`}` : ""}
          {task?.sendBacks ? ` · sent back ${task.sendBacks}×` : ""}
        </div>
        {task?.note && !live && (
          <div style={{ background: "var(--panel)", borderRadius: "0 14px 14px 0", borderLeft: "6px solid var(--gold)", padding: "8px 12px", maxHeight: 200, overflow: "auto" }} className="thin-scroll">
            <Md text={task.note} />
          </div>
        )}
        {task?.question && (
          <div style={{ background: "#1a0c0b", borderRadius: "0 14px 14px 0", borderLeft: "6px solid var(--red)", padding: "8px 12px" }}>
            <span className="lbl" style={{ color: "var(--redsoft)" }}>Question · answer it in Needs you</span>
            <Md text={task.question} />
          </div>
        )}

        <section aria-label="Live activity" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Sec tone="sky" right={
            <span style={{ display: "flex", gap: 3 }}>
              {(["all", "tools", "subagents", "raw"] as Filter[]).map((f) => (
                <Pill key={f} sm tone={filter === f ? "sky" : "dim"} onClick={() => setFilter(f)}>{f}</Pill>
              ))}
            </span>
          }>Live activity</Sec>
          <div ref={feed} className="thin-scroll" onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }} style={{ maxHeight: "55vh", overflowY: "auto", paddingRight: 6 }}>
            {!events.length && <div className="lbl" style={{ color: "var(--muted)" }}>No activity yet.</div>}
            {events.map((e, i) => (
              <div className="ev" key={i}>
                <span className="t">{new Date(e.t).toLocaleTimeString([], { hour12: false })}</span>
                <span className="k" style={{ color: KCOLOR[e.k] ?? "var(--peach)" }}>{e.k}</span>
                <span className="x" style={{ color: e.sub ? "var(--lilac)" : undefined }}>
                  {e.sub ? `[${e.sub}] ` : ""}
                  {filter === "raw" ? e.text : e.text.split("\n").slice(0, 4).join("\n")}
                </span>
              </div>
            ))}
            {live && <div className="ev"><span className="t" /><span className="k" /><span className="x"><span className="cursor" /></span></div>}
          </div>
        </section>

        {task && !["merged", "dropped"].includes(task.phase) && (
          <section aria-label="Redirect" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Sec tone="orange">Redirect</Sec>
            <span style={{ color: "var(--peach)" }}>
              {live ? "Kiln stops the run and resumes the same session with your message. Nothing is lost." : "Resumes the task's session with your message."}
            </span>
            <label>
              <span style={{ position: "absolute", left: -9999 }}>Redirect message</span>
              <textarea className="ta" rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="What should the agent do differently?" />
            </label>
            {task.queuedMessage && <span className="lbl" style={{ color: "var(--gold)" }}>Queued for next turn: {task.queuedMessage.slice(0, 120)}</span>}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Pill tone="orange" disabled={!msg.trim()} busy={busy === "redirect"} onClick={() => call("redirect", { message: msg }, live ? "Redirecting" : "Resumed").then(() => setMsg(""))}>Redirect now</Pill>
              {live && <Pill tone="dim" disabled={!msg.trim()} onClick={() => call("redirect", { message: msg, queue: true }).then(() => setMsg(""))}>Queue for next turn</Pill>}
            </div>
          </section>
        )}
      </div>

      <aside style={{ flex: "1 1 300px", minWidth: 260, maxWidth: 440, display: "flex", flexDirection: "column", gap: 18 }}>
        <ThisTask d={d} number={number} live={live} />
        {current && current.progress.length > 0 && (
          <section aria-label="Progress" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Sec tone="lavender">Progress</Sec>
            {current.progress.map((p, i) => (
              <span key={i} style={{ color: p.status === "completed" ? "var(--lavender)" : p.status === "in_progress" ? "var(--gold)" : "var(--muted)" }}>
                {p.status === "completed" ? "✓" : p.status === "in_progress" ? "▸" : "○"} {p.content}
              </span>
            ))}
            <span className="lbl" style={{ color: "var(--muted)" }}>then gates: rebase · checks · reviewer · CI</span>
          </section>
        )}
        {task?.gate && <GateBox t={task} />}
        {current && (
          <section aria-label="Tokens for this run" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Sec tone="gold">Tokens</Sec>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 12px", fontSize: 16 }}>
              <span className="lbl" style={{ color: "var(--gold)" }}>Input</span><b>{fmtTok(current.inputTokens + current.cacheCreateTokens)}</b>
              <span className="lbl" style={{ color: "var(--gold)" }}>Cache read</span><b>{fmtTok(current.cacheReadTokens)}</b>
              <span className="lbl" style={{ color: "var(--gold)" }}>Output</span><b>{fmtTok(current.outputTokens)}</b>
              {live && current.contextWindow > 0 && (
                <><span className="lbl" style={{ color: "var(--gold)" }}>Context</span><b style={{ color: contextTone(current.context, current.contextWindow) }}>{fmtTok(current.context)} / {fmtTok(current.contextWindow)}</b></>
              )}
              {live && <><span className="lbl" style={{ color: "var(--gold)" }}>Rate</span><b>{fmtTok(current.rate)}/min</b></>}
              <span className="lbl" style={{ color: "var(--gold)" }}>≈ Cost</span><b>{current.costUsd ? money(current.costUsd) : "after the run"}</b>
              <span className="lbl" style={{ color: "var(--gold)" }}>Extra usage</span><b style={{ color: current.usedOverage ? "var(--red)" : undefined }}>{current.usedOverage ? "USED" : "NONE"}</b>
              <span className="lbl" style={{ color: "var(--gold)" }}>Model</span><b>{TIER_LABEL[current.tier]} · {current.effort}{current.overridden ? "*" : ""}</b>
            </div>
          </section>
        )}
        {d.changes.length > 0 && (
          <section aria-label="Changes" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Sec tone="peach">Changes</Sec>
            <div style={{ fontSize: 15, lineHeight: 1.5, overflowWrap: "anywhere" }}>
              {d.changes.slice(0, 30).map((c) => (
                <div key={c.file}><b style={{ color: "var(--peach)" }}>{c.status}</b> {c.file} <span style={{ color: "#9be59b" }}>+{c.add}</span> <span style={{ color: "var(--redsoft)" }}>−{c.del}</span></div>
              ))}
              {d.changes.length > 30 && <div className="lbl">+{d.changes.length - 30} more files</div>}
            </div>
            <Pill tone="peach" sm href={`#/review/${number}/diff`} style={{ alignSelf: "flex-start" }}>View diff</Pill>
          </section>
        )}
        {d.runs.length > 0 && (
          <section aria-label="Run history" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <Sec tone="lilac">Runs</Sec>
            {d.runs.map((r) => (
              <div key={r.id} style={{ display: "flex", gap: 8, fontSize: 14, alignItems: "baseline" }}>
                <span style={{ color: "var(--lilac)", minWidth: 64, textTransform: "uppercase" }}>{r.kind}</span>
                <span style={{ color: r.status === "failed" ? "var(--redsoft)" : "var(--ink)", minWidth: 56 }}>{r.status}</span>
                <span className="lbl" style={{ color: "var(--muted)" }}>{elapsed(r.startedAt, r.endedAt ?? undefined)} · {fmtTok(r.inputTokens + r.cacheCreateTokens + r.cacheReadTokens + r.outputTokens)}</span>
              </div>
            ))}
          </section>
        )}
      </aside>
    </div>
  );
}

function ThisTask({ d, number, live }: { d: TaskDetail; number: number; live: boolean }) {
  const { pid, act, state } = useApp();
  const t = d.task;
  const [tier, setTier] = useState<Tier | null>(t?.overrideModel ?? null);
  const [effort, setEffort] = useState<Effort | null>(t?.overrideEffort ?? null);
  const [extra, setExtra] = useState(!!t?.allowExtra);
  useEffect(() => {
    setTier(d.task?.overrideModel ?? null);
    setEffort(d.task?.overrideEffort ?? null);
    setExtra(!!d.task?.allowExtra);
  }, [d.task?.overrideModel, d.task?.overrideEffort, d.task?.allowExtra]);
  const pace = d.pace;
  const tiers = ["small", "medium", "large"];
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  const above =
    (tier && tiers.indexOf(tier) > tiers.indexOf(pace.modelCeiling)) || (effort && efforts.indexOf(effort) > efforts.indexOf(pace.effortCeiling));
  const save = (applyNow: boolean, reset = false) =>
    act(
      () => post(`/api/p/${pid}/tasks/${number}/override`, reset ? { model: null, effort: null, allowExtra: extra, applyNow } : { model: tier, effort, allowExtra: extra, applyNow }),
      reset ? "Back to pace defaults" : live ? "Applies at the next step" : "Saved for this task",
    );
  return (
    <section aria-label="Effort and model for this task" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Sec tone="orange">This task</Sec>
      <span className="lbl" style={{ color: "var(--orange)" }}>Effort</span>
      <EffortSeg value={effort ?? pace.effortCeiling} dflt={pace.effortCeiling} onChange={setEffort} hot />
      <span className="lbl" style={{ color: "var(--orange)" }}>Model</span>
      <TierSeg value={tier ?? pace.modelCeiling} dflt={pace.modelCeiling} onChange={setTier} hot />
      <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
        <span className="lbl" style={{ color: "var(--orange)" }}>May use extra usage</span>
        <input type="checkbox" checked={extra} onChange={(e) => setExtra(e.target.checked)} style={{ width: 20, height: 20, accentColor: "var(--orange)" }} />
      </label>
      <span className="lbl" style={{ color: "var(--muted)", lineHeight: 1.4 }}>
        Dashed = pace default ({pace.effortCeiling} · {state.tiers[pace.modelCeiling].name}).
        {above ? " Above your ceiling: allowed because you chose it for this task." : ""}
      </span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Pill tone="orange" sm onClick={() => save(true)}>{live ? "Apply at next step" : "Save for this task"}</Pill>
        <Pill tone="dim" sm onClick={() => save(false, true)}>Reset to default</Pill>
      </div>
      <span className="lbl" style={{ color: "var(--muted)", lineHeight: 1.4 }}>
        Applies by resuming the same session with the new setting. Kept for later runs of #{number} (gates, fixes).
      </span>
    </section>
  );
}

export function GateBox({ t }: { t: NonNullable<TaskDetail["task"]> }) {
  const g = t.gate!;
  const mark = (s?: string) => (s === "pass" || s === "approve" ? "✓" : s === "pending" || !s ? "…" : "✗");
  const color = (s?: string) => (s === "pass" || s === "approve" ? "var(--sky)" : s === "pending" || !s ? "var(--muted)" : "var(--red)");
  return (
    <section aria-label="Gates" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Sec tone="sky">Gates</Sec>
      <div className="gate"><i style={{ borderColor: color(g.rebase), background: g.rebase === "pass" ? "var(--sky)" : undefined }} /> <span>{mark(g.rebase)} Rebase on main</span></div>
      {(g.checks ?? []).map((c) => (
        <details key={c.name}>
          <summary className="gate"><i style={{ borderColor: color(c.status), background: c.status === "pass" ? "var(--sky)" : undefined }} /> <span>{mark(c.status)} {c.name}</span></summary>
          {c.output && <pre className="log">{c.output}</pre>}
        </details>
      ))}
      {g.ci && (
        <details>
          <summary className="gate"><i style={{ borderColor: color(g.ci.status), background: g.ci.status === "pass" ? "var(--sky)" : undefined }} /> <span>{mark(g.ci.status)} CI</span></summary>
          {g.ci.output && <pre className="log">{g.ci.output}</pre>}
        </details>
      )}
      <div className="gate"><i style={{ borderColor: color(g.reviewer), background: g.reviewer === "approve" ? "var(--sky)" : undefined }} /> <span>{mark(g.reviewer)} Reviewer {g.reviewer && g.reviewer !== "pending" ? `· ${g.reviewer}` : ""}</span></div>
      {g.reviewerNotes && <div style={{ color: "var(--peach)", fontSize: 15 }}><Md text={g.reviewerNotes} /></div>}
    </section>
  );
}
