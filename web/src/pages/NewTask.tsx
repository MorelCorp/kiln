import { useEffect, useRef, useState } from "react";
import { post } from "../api.ts";
import { Md, Pill, Tag, useApp } from "../ui.tsx";

interface Q { q: string; options: string[] }
interface Draft { title: string; body: string; labels: string[]; risk: "auto" | "required" }
interface Created { number: number; title: string; as: string; risk?: string; url: string }

const SESSION_KEY = "kiln:newtask:session";

export function NewTaskPage() {
  const { pid, act } = useApp();
  const [desc, setDesc] = useState(() => {
    const pre = sessionStorage.getItem("kiln:newtask");
    if (pre) sessionStorage.removeItem("kiln:newtask");
    return pre ?? "";
  });
  const [stage, setStage] = useState<1 | 2 | 3>(1);
  const [qs, setQs] = useState<{ questions: Q[]; model: string; seconds: number } | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<Created[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ta.current?.focus();
  }, []);
  useEffect(() => {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(created.slice(-12))); } catch { /* private mode */ }
  }, [created]);

  const reset = () => {
    setDesc(""); setStage(1); setQs(null); setAnswers({}); setOther({}); setDraft(null); setEditing(false);
    window.setTimeout(() => ta.current?.focus(), 0);
  };

  const ask = async () => {
    setBusy("q");
    const r = await act(() => post<{ questions: Q[]; model: string; seconds: number }>(`/api/p/${pid}/new/questions`, { description: desc }));
    setBusy(null);
    if (!r) return;
    setQs(r);
    setStage(2);
    if (!r.questions.length) void makeDraft(r.questions, {});
  };

  const makeDraft = async (questions = qs?.questions ?? [], ans = answers) => {
    setBusy("d");
    setStage(3);
    const list = questions.map((q, i) => ({ q: q.q, a: ans[i] === "__other" ? other[i] ?? "" : ans[i] })).filter((x) => x.a);
    const r = await act(() => post<Draft>(`/api/p/${pid}/new/draft`, { description: desc, answers: list }));
    setBusy(null);
    if (r) setDraft(r);
    else setStage(2);
  };

  const create = async (as: "ready" | "triage" | "idea", d?: Draft) => {
    const body = d ?? draft ?? { title: desc.slice(0, 90), body: desc, labels: [], risk: "auto" as const };
    setBusy(as);
    const r = await act(() => post<{ number: number; url: string; title: string }>(`/api/p/${pid}/new/create`, { ...body, as }), "Created");
    setBusy(null);
    if (!r) return;
    setCreated((c) => [...c, { number: r.number, title: r.title, as, risk: body.risk, url: r.url }]);
    reset();
  };

  const stageColor = (n: number) => (stage === n ? "var(--orange)" : stage > n ? "var(--lavender)" : "var(--chip)");

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 22, alignItems: "flex-start" }}>
      <div style={{ flex: "999 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        <article className="stage">
          <div className="n" style={{ background: stageColor(1) }}>01</div>
          <div className="bd">
            <b style={{ letterSpacing: ".06em" }}>WHAT DO YOU WANT?</b>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="lbl" style={{ color: "var(--orange)" }}>A sentence or two is enough · dictation works</span>
              <textarea ref={ta} className="ta" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} disabled={stage > 1}
                onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && desc.trim() && void ask()} />
            </label>
            {stage === 1 ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Pill tone="orange" disabled={!desc.trim()} busy={busy === "q"} onClick={ask}>Continue</Pill>
                <Pill tone="dim" disabled={!desc.trim()} busy={busy === "idea"} onClick={() => create("idea", { title: desc.split("\n")[0].slice(0, 90), body: desc, labels: [], risk: "auto" })}>Save as idea, no questions</Pill>
              </div>
            ) : (
              <div><Pill tone="dim" sm onClick={reset}>Start over</Pill></div>
            )}
          </div>
        </article>

        {stage >= 2 && qs && (
          <article className="stage">
            <div className="n" style={{ background: stageColor(2) }}>02</div>
            <div className="bd">
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                <b style={{ letterSpacing: ".06em" }}>QUICK QUESTIONS</b>
                <span className="lbl" style={{ color: "var(--lavender)" }}>{qs.model} · read the repo · {qs.seconds} s</span>
              </div>
              {!qs.questions.length && <span style={{ color: "var(--lavender)" }}>Nothing ambiguous found. Drafting straight away.</span>}
              {qs.questions.map((q, i) => (
                <div className="q" key={i}>
                  <span>{q.q}</span>
                  <div className="opts">
                    {q.options.map((o) => (
                      <button key={o} className={answers[i] === o ? "on" : ""} disabled={stage > 2} onClick={() => setAnswers((a) => ({ ...a, [i]: o }))}>{o}</button>
                    ))}
                    <button className={answers[i] === "__other" ? "on" : ""} disabled={stage > 2} onClick={() => setAnswers((a) => ({ ...a, [i]: "__other" }))}>Other…</button>
                  </div>
                  {answers[i] === "__other" && <input className="inp" value={other[i] ?? ""} onChange={(e) => setOther((o) => ({ ...o, [i]: e.target.value }))} placeholder="Your answer" disabled={stage > 2} />}
                </div>
              ))}
              {stage === 2 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Pill tone="lavender" busy={busy === "d"} onClick={() => makeDraft()}>Draft the issue</Pill>
                  <Pill tone="dim" onClick={() => makeDraft(qs.questions, {})}>Skip the rest</Pill>
                </div>
              )}
            </div>
          </article>
        )}

        {stage === 3 && (
          <article className="stage">
            <div className="n" style={{ background: stageColor(3) }}>03</div>
            <div className="bd">
              <b style={{ letterSpacing: ".06em" }}>DRAFT ISSUE</b>
              {!draft ? (
                <span className="lbl" style={{ color: "var(--lavender)" }}>Drafting<span className="cursor" style={{ marginLeft: 6, background: "var(--lavender)" }} /></span>
              ) : (
                <>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span className="lbl" style={{ color: "var(--orange)" }}>Title</span>
                    <input className="inp" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                  </label>
                  {editing ? (
                    <textarea className="ta" rows={12} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
                  ) : (
                    <div style={{ background: "#000", borderRadius: 14, padding: "8px 12px", maxHeight: 340, overflow: "auto" }} className="thin-scroll"><Md text={draft.body} /></div>
                  )}
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                    <span className="lbl" style={{ color: "var(--orange)" }}>Labels</span>
                    {draft.labels.map((l) => (
                      <button key={l} className="tag" style={{ background: "var(--chip)", color: "var(--lavender)", border: 0 }} title="Remove" onClick={() => setDraft({ ...draft, labels: draft.labels.filter((x) => x !== l) })}>{l} ×</button>
                    ))}
                    <Pill tone="dim" sm onClick={() => setEditing((v) => !v)}>{editing ? "Done editing" : "Edit"}</Pill>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="lbl" style={{ color: "var(--orange)" }}>Risk</span>
                    <div className="seg" style={{ width: 220 }}>
                      <button className={draft.risk === "auto" ? "on" : ""} onClick={() => setDraft({ ...draft, risk: "auto" })}>Auto</button>
                      <button className={draft.risk === "required" ? "on" : ""} onClick={() => setDraft({ ...draft, risk: "required" })}>Review</button>
                    </div>
                    <span className="lbl" style={{ color: "var(--muted)" }}>Path rules can still upgrade it to review.</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Pill tone="orange" busy={busy === "ready"} onClick={() => create("ready")}>Create · ready for agent</Pill>
                    <Pill tone="lilac" busy={busy === "triage"} onClick={() => create("triage")}>Create · needs triage</Pill>
                    <Pill tone="dim" onClick={reset}>Discard</Pill>
                  </div>
                </>
              )}
            </div>
          </article>
        )}
      </div>

      <aside style={{ flex: "1 1 260px", minWidth: 240, maxWidth: 380, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ flex: "0 0 26px", height: 26, background: "var(--sky)", borderRadius: "13px 0 0 13px" }} />
          <b style={{ color: "var(--sky)", fontSize: 20, letterSpacing: ".06em" }}>THIS SESSION</b>
          <div style={{ flex: 1, height: 8, background: "var(--sky)" }} />
        </div>
        <span className="lbl" style={{ color: "var(--sky)" }}>Several tasks in a row: each one lands here</span>
        {created.map((c) => (
          <div key={c.number} style={{ background: "var(--panel)", borderRadius: "0 14px 14px 0", padding: "6px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
            <a href={c.url} target="_blank" rel="noreferrer" style={{ color: "var(--ink)", textDecoration: "none" }}><b>#{c.number}</b> {c.title}</a>
            <span style={{ display: "flex", gap: 4 }}>
              <Tag tone={c.as === "ready" ? "gold" : c.as === "idea" ? "dim" : "lilac"}>{c.as === "ready" ? "ready for agent" : c.as === "idea" ? "idea" : "needs triage"}</Tag>
              {c.as !== "idea" && c.risk && <Tag tone={c.risk === "required" ? "red" : "sky"}>{c.risk === "required" ? "review" : "auto"}</Tag>}
            </span>
          </div>
        ))}
        {desc.trim() && stage > 1 && (
          <div style={{ background: "var(--panel)", borderRadius: "0 14px 14px 0", padding: "6px 10px", color: "var(--lavender)" }}>
            {desc.slice(0, 60)}{desc.length > 60 ? "…" : ""} <span className="lbl">drafting…</span>
          </div>
        )}
        <Pill tone="sky" sm onClick={reset} style={{ alignSelf: "flex-start" }}>+ Another task</Pill>
        <a href="#/board" className="lbl" style={{ color: "var(--sky)" }}>Back to board ›</a>
      </aside>
    </div>
  );
}
