import { useEffect, useState } from "react";
import { post, useApi, type ChecklistItem, type TaskDetail } from "../api.ts";
import { Empty, Loading, PageTitle, Pill, go, useApp } from "../ui.tsx";

export function TestPage({ number, env }: { number: number; env?: string }) {
  const { pid, act } = useApp();
  const [d, err] = useApi<TaskDetail>(`/api/p/${pid}/tasks/${number}`, []);
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (d?.task?.checklist && !items) setItems(d.task.checklist);
  }, [d, items]);
  if (!d || !items) return <Loading error={err ?? (d && !d.task?.checklist ? "This task has no checklist" : null)} />;

  const shown = items.map((c, i) => ({ c, i })).filter(({ c }) => !env || (c.env || "staging").toLowerCase() === env);
  const set = (i: number, patch: Partial<ChecklistItem>) => setItems((xs) => xs!.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const counts = { pass: 0, fail: 0, skip: 0, todo: 0 };
  for (const { c } of shown) counts[c.result ?? "todo"]++;
  const submit = async (final: boolean) => {
    setBusy(true);
    const r = await act(() => post(`/api/p/${pid}/tasks/${number}/tests`, { results: items, final }), final ? (counts.fail ? "Sent back: a fix run starts" : "Results saved") : "Saved");
    setBusy(false);
    if (r !== undefined && final) go("/inbox");
  };

  return (
    <>
      <a href="#/inbox" className="lbl" style={{ color: "var(--red)", textDecoration: "none" }}>‹ Needs you</a>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className="num" style={{ color: "var(--gold)", fontSize: 28 }}>#{number}</span>
        <PageTitle>{d.issue.title}</PageTitle>
        {env && <span className="lbl" style={{ color: "var(--gold)" }}>on {env}</span>}
      </div>
      {!shown.length && <Empty>No checks for {env}.</Empty>}
      {shown.map(({ c, i }, k) => (
        <article className="check" key={i}>
          <div className="n" style={{ background: c.result === "fail" ? "var(--red)" : c.result === "pass" ? "var(--sky)" : "var(--gold)" }}>{String(k + 1).padStart(2, "0")}</div>
          <div className="bd">
            <b style={{ textTransform: "uppercase", letterSpacing: ".05em" }}>{c.title}</b>
            <span>{c.steps}<br /><span className="lbl" style={{ color: "var(--gold)" }}>Expected</span> {c.expected}</span>
            <div className="pf" role="group" aria-label={`Result for ${c.title}`}>
              <button className={c.result === "pass" ? "pass" : ""} aria-pressed={c.result === "pass"} onClick={() => set(i, { result: "pass" })}>✓ Pass</button>
              <button className={c.result === "fail" ? "fail" : ""} aria-pressed={c.result === "fail"} onClick={() => set(i, { result: "fail" })}>✗ Fail</button>
              <button className={c.result === "skip" ? "skip" : ""} aria-pressed={c.result === "skip"} onClick={() => set(i, { result: "skip" })}>Skip</button>
            </div>
            {c.result === "fail" && (
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="lbl" style={{ color: "var(--redsoft)" }}>What happened · goes back to the agent</span>
                <textarea className="ta" rows={2} value={c.note ?? ""} onChange={(e) => set(i, { note: e.target.value })} style={{ borderColor: "var(--red)" }} />
              </label>
            )}
          </div>
        </article>
      ))}
      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 3, height: 10 }}>
          <div style={{ flex: counts.pass || 0.001, background: "var(--sky)" }} />
          <div style={{ flex: counts.fail || 0.001, background: "var(--red)" }} />
          <div style={{ flex: counts.skip + counts.todo || 0.001, background: "var(--chip)" }} />
        </div>
        <span className="lbl" style={{ color: "var(--gold)" }}>{counts.pass} pass · {counts.fail} fail · {counts.skip} skip · {counts.todo} to do</span>
        <span style={{ color: "var(--peach)" }}>Submitting with a failure reopens the task: a new run on a fresh branch gets your notes, then the normal gates.</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Pill tone="gold" busy={busy} disabled={counts.todo > 0} onClick={() => submit(true)} title={counts.todo ? "Mark every check first" : undefined}>Submit results</Pill>
          <Pill tone="dim" onClick={() => submit(false)}>Save, finish later</Pill>
        </div>
      </section>
    </>
  );
}
