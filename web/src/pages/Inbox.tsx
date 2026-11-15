import { useState, type ReactNode } from "react";
import { ago, post, useApi, type Draft, type InboxItem, type TaskRow } from "../api.ts";
import { Empty, Loading, Md, Pill, Tag, useApp } from "../ui.tsx";

const KIND: Record<string, { label: string; color: string }> = {
  question: { label: "Question", color: "var(--red)" },
  plan_review: { label: "Approve plan", color: "var(--red)" },
  pr_review: { label: "Review PR", color: "var(--orange)" },
  test: { label: "Test", color: "var(--gold)" },
  triage: { label: "Triage draft", color: "var(--lilac)" },
  gate_failed: { label: "Gate failed", color: "var(--salmon)" },
  failed: { label: "Run failed", color: "var(--salmon)" },
  usage_paused: { label: "Usage paused", color: "var(--peach)" },
  interrupted: { label: "Interrupted", color: "var(--peach)" },
  stopped: { label: "Stopped", color: "var(--lavender)" },
};

export function InboxPage() {
  const { pid } = useApp();
  const [data, err] = useApi<{ items: InboxItem[] }>(`/api/p/${pid}/inbox`, ["task", "board", "run"], 600);
  if (!data) return <Loading error={err} />;
  const waitingSlots = data.items.filter((i) => i.kind === "question").length;
  return (
    <>
      <span className="lbl" style={{ color: "var(--peach)" }}>
        Ordered by how much work each unblocks{waitingSlots ? ` · ${waitingSlots} agent${waitingSlots > 1 ? "s" : ""} waiting on you` : ""}
      </span>
      {!data.items.length && <Empty>Nothing needs you. The factory is either busy or idle.</Empty>}
      {data.items.map((it) => (
        <Item key={`${it.kind}-${it.task?.number ?? ""}-${it.draft?.id ?? ""}-${it.env ?? ""}`} it={it} />
      ))}
    </>
  );
}

function Item({ it }: { it: InboxItem }) {
  const k = KIND[it.kind] ?? { label: it.kind, color: "var(--lavender)" };
  const meta = it.kind === "test" ? it.env : it.kind === "plan_review" ? (it.task?.riskReason || "risky") : `waiting ${ago(it.since)}`;
  return (
    <article className="item">
      <div className="kind" style={{ background: k.color }}>
        {k.label}
        <span className="lbl" style={{ fontWeight: 400 }}>{meta}</span>
      </div>
      <div className="body">
        {it.draft ? <DraftBody d={it.draft} /> : it.task ? <TaskBody it={it} t={it.task} /> : null}
      </div>
    </article>
  );
}

const Title = ({ n, children }: { n: number | null; children: ReactNode }) => (
  <span style={{ textTransform: "uppercase", letterSpacing: ".04em" }}>{n ? <b>#{n} </b> : null}{children}</span>
);

function TaskBody({ it, t }: { it: InboxItem; t: TaskRow }) {
  const { pid, act } = useApp();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const call = async (path: string, body: unknown = {}, ok?: string) => {
    setBusy(true);
    await act(() => post(`/api/p/${pid}/tasks/${t.number}/${path}`, body), ok);
    setBusy(false);
  };
  const base = <Title n={t.number}>{t.title}</Title>;

  switch (it.kind) {
    case "question":
      return (
        <>
          {base}
          <div style={{ color: "var(--peach)", fontSize: 17, lineHeight: 1.4 }}><Md text={t.question ?? ""} /></div>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="lbl" style={{ color: "var(--peach)" }}>Your answer · resumes the same session</span>
            <textarea className="ta" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <Pill tone="orange" busy={busy} disabled={!text.trim()} onClick={() => call("answer", { text }, `#${t.number} resumed`)}>Answer and resume</Pill>
            <Pill tone="lavender" href={`#/task/${t.number}`}>Open run</Pill>
            <Pill tone="dim" onClick={() => confirm(`Drop #${t.number}? The worktree is kept.`) && call("drop")}>Stop task</Pill>
          </div>
        </>
      );
    case "plan_review": {
      const steps = (t.plan ?? "").split("\n").filter((l) => /^\s*\d+[.)]/.test(l)).length;
      return (
        <>
          {base}
          <span>Plan: {steps || "?"} steps{t.riskReason ? ` · ${t.riskReason}` : ""}</span>
          <div><Pill tone="orange" href={`#/review/${t.number}`}>Review plan</Pill></div>
        </>
      );
    }
    case "pr_review":
      return (
        <>
          {base}
          <span>{t.note ?? "Gates passed. Your review is required before merge."}</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <Pill tone="orange" href={`#/review/${t.number}/diff`}>Review PR</Pill>
            {t.prUrl?.startsWith("http") && <Pill tone="dim" href={t.prUrl}>On GitHub</Pill>}
          </div>
        </>
      );
    case "test":
      return (
        <>
          {base}
          <span>{it.items?.length ?? 0} check{(it.items?.length ?? 0) > 1 ? "s" : ""} on {it.env}</span>
          <div><Pill tone="gold" href={`#/test/${t.number}/${it.env}`}>Start checklist</Pill></div>
        </>
      );
    case "gate_failed": {
      const g = t.gate;
      return (
        <>
          {base}
          <span>
            Rebase {g?.rebase === "pass" ? "✓" : g?.rebase === "fail" ? "✗" : "…"} ·{" "}
            {(g?.checks ?? []).map((c) => `${c.name} ${c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "…"}`).join(" · ") || "no checks"} ·{" "}
            <b>reviewer {g?.reviewer === "approve" ? "✓" : g?.reviewer === "pending" ? "…" : "✗"}</b>
            {g?.ci ? ` · CI ${g.ci.status === "pass" ? "✓" : g.ci.status === "fail" ? "✗" : "…"}` : ""}
            {t.sendBacks ? ` · sent back ${t.sendBacks}×` : ""}
          </span>
          {t.note && <div style={{ color: "var(--peach)" }}><Md text={t.note} /></div>}
          <textarea className="ta" rows={2} placeholder="Note for the agent (optional)" value={text} onChange={(e) => setText(e.target.value)} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <Pill tone="salmon" busy={busy} onClick={() => call("send-back", { note: text || "Address the reviewer's notes." }, "Sent back")}>Send back with note</Pill>
            <Pill tone="orange" href={`#/review/${t.number}/diff`}>Review myself</Pill>
            <Pill tone="dim" onClick={() => call("human", {}, "Handed to a human")}>Make ready-for-human</Pill>
          </div>
        </>
      );
    }
    default:
      return (
        <>
          {base}
          {t.note && <div style={{ color: "var(--peach)", maxHeight: 160, overflow: "auto" }} className="thin-scroll"><Md text={t.note} /></div>}
          {it.lastRun?.error && it.lastRun.error !== t.note && <span className="lbl" style={{ color: "var(--redsoft)" }}>{it.lastRun.error}</span>}
          <textarea className="ta" rows={1} placeholder="Optional note for the agent when it resumes" value={text} onChange={(e) => setText(e.target.value)} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <Pill tone="orange" busy={busy} onClick={() => call("retry", { note: text || undefined }, `#${t.number} resumed`)}>{t.sessionId ? "Resume" : "Retry"}</Pill>
            <Pill tone="lavender" href={`#/task/${t.number}`}>Open run</Pill>
            <Pill tone="dim" onClick={() => call("human", {}, "Handed to a human")}>Make ready-for-human</Pill>
            <Pill tone="dim" onClick={() => confirm(`Drop #${t.number}?`) && call("drop")}>Drop</Pill>
          </div>
        </>
      );
  }
}

function DraftBody({ d }: { d: Draft }) {
  const { pid, act } = useApp();
  const [edit, setEdit] = useState(false);
  const [title, setTitle] = useState(d.title);
  const [body, setBody] = useState(d.body);
  const [risk, setRisk] = useState(d.risk);
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    await act(() => post(`/api/p/${pid}/drafts/${d.id}/accept`, edit ? { title, body, risk } : {}), d.number ? `#${d.number} is ready for agents` : "Issue created");
    setBusy(false);
  };
  return (
    <>
      <Title n={d.number}>{d.title}</Title>
      <span style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        Triage agent proposes: <Tag tone={d.risk === "required" ? "red" : "sky"}>{d.risk === "required" ? "review" : "auto"}</Tag>
        {d.labels.map((l) => <Tag key={l} tone="dim">{l}</Tag>)}
      </span>
      {edit ? (
        <>
          <input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <textarea className="ta" rows={10} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Body" />
          <div className="seg" style={{ maxWidth: 280 }}>
            <button className={risk === "auto" ? "on" : ""} onClick={() => setRisk("auto")}>Auto</button>
            <button className={risk === "required" ? "on" : ""} onClick={() => setRisk("required")}>Review</button>
          </div>
        </>
      ) : (
        <details>
          <summary className="lbl" style={{ color: "var(--lilac)", cursor: "pointer" }}>Show spec</summary>
          <Md text={d.body} style={{ paddingTop: 6 }} />
        </details>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <Pill tone="lilac" busy={busy} onClick={accept}>Accept</Pill>
        <Pill tone="dim" onClick={() => setEdit((v) => !v)}>{edit ? "Cancel edit" : "Edit first"}</Pill>
        <Pill tone="dim" onClick={() => act(() => post(`/api/p/${pid}/drafts/${d.id}/reject`))}>Reject</Pill>
      </div>
    </>
  );
}
