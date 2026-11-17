import { useState } from "react";
import { post, useApi, type TaskDetail } from "../api.ts";
import { Empty, Loading, Md, PageTitle, Pill, Sec, Tag, go, useApp } from "../ui.tsx";
import { GateBox } from "./Task.tsx";
import { DiffView } from "./DiffView.tsx";

type Tab = "plan" | "diff" | "gates" | "issue";

export function ReviewPage({ number, tab }: { number: number; tab?: string }) {
  const { pid, act } = useApp();
  const [d, err] = useApi<TaskDetail>(`/api/p/${pid}/tasks/${number}`, ["task"], 600);
  const cur: Tab = (["plan", "diff", "gates", "issue"].includes(tab ?? "") ? tab : "plan") as Tab;
  const [diff] = useApi<{ diff: string; error?: string }>(cur === "diff" ? `/api/p/${pid}/tasks/${number}/diff` : null, ["task"]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  if (!d) return <Loading error={err} />;
  const t = d.task;
  const call = async (path: string, body: unknown, ok: string, then?: string) => {
    setBusy(path);
    const r = await act(() => post(`/api/p/${pid}/tasks/${number}/${path}`, body), ok);
    setBusy(null);
    if (r !== undefined && then) go(then);
  };
  const steps = (t?.plan ?? "").split("\n");
  const numbered = steps.filter((l) => /^\s*\d+[.)]\s/.test(l));
  const rest = steps.filter((l) => !/^\s*\d+[.)]\s/.test(l) && l.trim());

  return (
    <>
      <a href="#/inbox" className="lbl" style={{ color: "var(--red)", textDecoration: "none" }}>‹ Needs you</a>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className="num" style={{ color: "var(--orange)", fontSize: 28 }}>#{number}</span>
        <PageTitle>{d.issue.title}</PageTitle>
        {t && <Tag tone="red">{t.riskReason || (t.risk === "required" ? "review" : "auto")}</Tag>}
      </div>
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }} role="tablist">
        {(["plan", "diff", "gates", "issue"] as Tab[]).map((x) => (
          <Pill key={x} tone={cur === x ? "orange" : "dim"} onClick={() => go(`/review/${number}/${x}`)}>
            {x === "diff" && !t?.prNumber && t?.phase === "plan_review" ? "Diff · after implement" : x}
          </Pill>
        ))}
      </div>

      {cur === "plan" && (
        <section aria-label="Plan" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Sec tone="orange">Agent plan{numbered.length ? ` · ${numbered.length} steps` : ""}</Sec>
          {!t?.plan && <Empty>No plan: this task was not planned first.</Empty>}
          {numbered.map((l, i) => (
            <div className="step" key={i}>
              <span className="n" style={{ background: i % 2 ? "var(--peach)" : "var(--orange)" }}>{String(i + 1).padStart(2, "0")}</span>
              <span className="tx">{l.replace(/^\s*\d+[.)]\s*/, "")}</span>
            </div>
          ))}
          {rest.length > 0 && <Md text={rest.join("\n")} style={{ color: "var(--peach)" }} />}
        </section>
      )}
      {cur === "diff" && (
        <section aria-label="Diff" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Sec tone="peach" right={t?.prUrl?.startsWith("http") ? <Pill tone="dim" sm href={t.prUrl}>Open PR</Pill> : undefined}>Diff</Sec>
          {!diff ? <Loading /> : diff.diff ? <DiffView text={diff.diff} /> : <Empty>{diff.error ?? "No changes yet."}</Empty>}
        </section>
      )}
      {cur === "gates" && (t?.gate ? <GateBox t={t} /> : <Empty>The merge gate has not run yet.</Empty>)}
      {cur === "issue" && (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Sec tone="lavender" right={<Pill tone="dim" sm href={d.issue.url}>On GitHub</Pill>}>Issue</Sec>
          <Md text={d.issue.body || "(no description)"} />
          {d.issue.comments.map((c, i) => (
            <div key={i} style={{ borderLeft: "4px solid var(--lavender)", paddingLeft: 10 }}>
              <span className="lbl" style={{ color: "var(--lavender)" }}>{c.author} · {new Date(c.at).toLocaleDateString()}</span>
              <Md text={c.body} />
            </div>
          ))}
        </section>
      )}

      {t && ["plan_review", "pr_review", "gate_failed"].includes(t.phase) && (
        <section aria-label="Your decision" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Sec tone="red">Your decision</Sec>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="lbl" style={{ color: "var(--peach)" }}>Note to the agent · {t.phase === "plan_review" ? "optional" : "used when sending back"}</span>
            <textarea className="ta" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {t.phase === "plan_review" ? (
              <>
                <Pill tone="orange" busy={busy === "approve-plan"} onClick={() => call("approve-plan", { note: note || undefined }, "Approved: implementing", "/task/" + number)}>Approve and implement</Pill>
                <Pill tone="peach" disabled={!note.trim()} busy={busy === "revise-plan"} onClick={() => call("revise-plan", { note }, "Asked for a new plan", "/task/" + number)}>Revise plan</Pill>
              </>
            ) : (
              <>
                {t.prNumber ? (
                  <Pill tone="orange" busy={busy === "approve-pr"} onClick={() => confirm(`Squash-merge #${number} into main?`) && call("approve-pr", {}, "Merged", "/board")}>Approve and merge</Pill>
                ) : (
                  // The gate failed before opening a PR (e.g. the push was refused): nothing to approve yet.
                  <Pill tone="orange" busy={busy === "retry"} onClick={() => call("retry", {}, "Gate re-running", "/task/" + number)}>Re-run gate</Pill>
                )}
                <Pill tone="peach" disabled={!note.trim()} busy={busy === "send-back"} onClick={() => call("send-back", { note }, "Sent back to the agent", "/task/" + number)}>Send back with note</Pill>
              </>
            )}
            <Pill tone="dim" onClick={() => call("human", {}, "Handed to a human", "/board")}>Make ready-for-human</Pill>
            <Pill tone="dim" onClick={() => confirm(`Drop #${number}?`) && call("drop", {}, "Dropped", "/board")}>Drop</Pill>
          </div>
        </section>
      )}
    </>
  );
}
