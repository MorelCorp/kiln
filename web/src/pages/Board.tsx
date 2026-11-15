import { useState } from "react";
import { elapsed, fmtTok, money, post, TIER_LABEL, useApi, useNow, type Board, type Card, type Effort, type RunView, type TaskRow, type Tier } from "../api.ts";
import { EffortSeg, Loading, Pill, Tag, TierSeg, TONE, useApp } from "../ui.tsx";

const COLS: { id: keyof Board["columns"]; label: string; color: string; tone: Parameters<typeof Tag>[0]["tone"] }[] = [
  { id: "triage", label: "Triage", color: "var(--lilac)", tone: "lilac" },
  { id: "ready", label: "Ready", color: "var(--gold)", tone: "gold" },
  { id: "running", label: "Running", color: "var(--sky)", tone: "sky" },
  { id: "needs", label: "Needs you", color: "var(--red)", tone: "red" },
  { id: "merged", label: "Merged", color: "var(--lavender)", tone: "lavender" },
  { id: "staging", label: "Staging", color: "var(--peach)", tone: "peach" },
  { id: "prod", label: "Prod", color: "var(--salmon)", tone: "salmon" },
];

export function needHref(c: Card): string {
  if (c.draftId) return "#/inbox";
  if (c.testEnv) return `#/test/${c.number}/${c.testEnv}`;
  switch (c.phase) {
    case "plan_review": return `#/review/${c.number}`;
    case "pr_review": return `#/review/${c.number}/diff`;
    case "gate_failed": return `#/review/${c.number}/gates`;
    case "question": return "#/inbox";
    default: return `#/task/${c.number}`;
  }
}

export function BoardPage({ board }: { board: Board | null }) {
  if (!board) return <Loading />;
  return (
    <>
      <div className="board">
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", minWidth: "min-content" }}>
          {COLS.map((c) => <Column key={c.id} col={c} cards={board.columns[c.id]} />)}
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, height: 10 }}>
        <div style={{ flex: 6, background: "var(--sky)", borderRadius: "5px 0 0 5px" }} /><div style={{ flex: "0 0 22px", background: "var(--orange)" }} />
        <div style={{ flex: 2, background: "var(--peach)" }} /><div style={{ flex: 2, background: "var(--lilac)", borderRadius: "0 5px 5px 0" }} />
      </div>
      <AgentsAtWork />
    </>
  );
}

function Column({ col, cards }: { col: (typeof COLS)[number]; cards: Card[] }) {
  // Closed issues pile up in Prod: keep that one short, the board scrolls for the rest.
  const [all, setAll] = useState(false);
  const limit = col.id === "prod" ? 8 : Infinity;
  const shown = all ? cards : cards.slice(0, limit);
  // Ready also lists cards handed to a human: count only what an agent can start.
  const human = col.id === "ready" ? cards.filter((c) => c.human).length : 0;
  const count = cards.length - human;
  return (
    <section className="col" aria-label={col.label}>
      <div className="colh" style={{ background: col.color }}>
        <span>{col.label}</span><span>
          {String(count).padStart(2, "0")}
          {human > 0 && <span style={{ opacity: 0.6, marginLeft: 6 }}>+{human} human</span>}
        </span>
      </div>
      {shown.map((c) => <BoardCard key={`${c.number}-${c.draftId ?? ""}-${c.testEnv ?? ""}`} c={c} col={col} />)}
      {cards.length > limit && (
        <button className="lbl" onClick={() => setAll((v) => !v)} style={{ color: col.color, textAlign: "right", background: "none", border: 0, padding: 4 }}>
          {all ? "show less" : `+${cards.length - limit} more`}
        </button>
      )}
      {!cards.length && <div className="lbl" style={{ color: "#4e4e66", textAlign: "right" }}>—</div>}
    </section>
  );
}

function BoardCard({ c, col }: { c: Card; col: (typeof COLS)[number] }) {
  const { pid, act } = useApp();
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const color = col.color;
  const head = (
    <span className="num" style={{ color }}>
      {c.number ? `#${c.number}` : "new"} {col.id === "running" && <span className="dot" style={{ background: color }} />}
    </span>
  );
  const tags = c.tags.length ? <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{c.tags.map((t, i) => <Tag key={i} tone={t.tone}>{t.text}</Tag>)}</span> : null;

  if (col.id === "needs") {
    return (
      <a href={needHref(c)} className="card" style={{ borderColor: "var(--red)" }}>
        <Tag tone={c.needTone ?? "red"} style={{ alignSelf: "flex-start" }}>{c.need}</Tag>
        <span>{c.number ? <b>#{c.number} </b> : null}{c.title}</span>
      </a>
    );
  }
  if (col.id === "running") {
    return <a href={`#/task/${c.number}`} className="card">{head}{c.title}{tags}</a>;
  }
  if (col.id === "triage") {
    return (
      <div className="card">
        {head}<a href={c.url} target="_blank" rel="noreferrer" style={{ color: "var(--ink)", textDecoration: "none" }}>{c.title}</a>{tags}
        <Pill tone="lilac" sm busy={busy} style={{ alignSelf: "flex-start" }}
          onClick={async () => (setBusy(true), await act(() => post(`/api/p/${pid}/tasks/${c.number}/triage`), `Draft for #${c.number} is in Needs you`), setBusy(false))}>
          Draft with agent
        </Pill>
      </div>
    );
  }
  if (col.id === "ready") {
    return (
      <div className="card" style={{ position: "relative" }}>
        {head}<a href={c.url} target="_blank" rel="noreferrer" style={{ color: "var(--ink)", textDecoration: "none" }}>{c.title}</a>{tags}
        {!c.human && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            <Pill tone="gold" sm busy={busy} onClick={async () => (setBusy(true), await act(() => post(`/api/p/${pid}/tasks/${c.number}/start`), `#${c.number} started`), setBusy(false))}>Run now</Pill>
            <Pill tone="dim" sm onClick={() => setOver((v) => !v)} ariaLabel="Override model and effort" style={{ color: c.override ? "var(--orange)" : "var(--gold)" }}>
              {c.override ?? "Model · effort"}
            </Pill>
          </div>
        )}
        {over && <OverridePop number={c.number} onClose={() => setOver(false)} />}
      </div>
    );
  }
  return (
    <a href={c.number ? `#/task/${c.number}` : c.url} className="card">
      {head}{c.title}{tags}
    </a>
  );
}

function OverridePop({ number, onClose }: { number: number; onClose: () => void }) {
  const { pid, act, state } = useApp();
  const [tier, setTier] = useState<Tier | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  return (
    <div style={{ position: "absolute", zIndex: 10, top: "100%", left: 0, width: 280, background: "#05050a", border: "2px solid var(--gold)", borderRadius: "0 18px 18px 18px", padding: 10, display: "flex", flexDirection: "column", gap: 6, boxShadow: "0 0 0 4px #000" }}>
      <span className="lbl" style={{ color: "var(--gold)" }}>Model for #{number}</span>
      <TierSeg value={tier} dflt={state.pace.modelCeiling} onChange={setTier} hot />
      <span className="lbl" style={{ color: "var(--gold)" }}>Effort</span>
      <EffortSeg value={effort} dflt={state.pace.effortCeiling} onChange={setEffort} hot />
      <span className="lbl" style={{ color: "var(--muted)" }}>Dashed = pace default. Your choice may exceed the ceilings.</span>
      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
        <Pill tone="dim" sm onClick={() => act(() => post(`/api/p/${pid}/tasks/${number}/override`, { model: null, effort: null })).then(onClose)}>Reset</Pill>
        <Pill tone="gold" sm onClick={() => act(() => post(`/api/p/${pid}/tasks/${number}/override`, { model: tier, effort }), "Override saved").then(onClose)}>Save</Pill>
      </div>
    </div>
  );
}

export function AgentsAtWork() {
  const { pid } = useApp();
  const [runs] = useApi<{ live: RunView[]; waiting: TaskRow[]; costToday: number }>(`/api/p/${pid}/runs`, ["run", "task"], 900);
  useNow(1000);
  const live = runs?.live ?? [];
  const waiting = runs?.waiting ?? [];
  const palette = ["var(--sky)", "var(--gold)", "var(--lavender)", "var(--peach)"];
  return (
    <section aria-label="Agents at work" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <div style={{ background: "var(--sky)", height: 26, width: 26, borderRadius: "13px 0 0 13px" }} />
        <div style={{ color: "var(--sky)", fontSize: 22, fontWeight: 700, letterSpacing: ".06em" }}>AGENTS AT WORK</div>
        <div style={{ flex: 1, height: 10, background: "var(--sky)", minWidth: 20 }} />
        <div className="lbl" style={{ color: "var(--sky)" }}>
          {live.length} active · {waiting.length} waiting · {money(runs?.costToday ?? 0)} today
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {!live.length && !waiting.length && (
          <div className="lbl" style={{ color: "var(--muted)", padding: "10px 0" }}>No agent running. Start the loop in Pace, or press Run now on a ready task.</div>
        )}
        {live.map((r, i) => {
          const c = palette[i % palette.length];
          const tok = r.inputTokens + r.cacheCreateTokens + r.cacheReadTokens + r.outputTokens;
          const step = r.progress.find((p) => p.status === "in_progress")?.content;
          return (
            <a key={r.id} href={`#/task/${r.number}`} className="live">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="eq" aria-hidden="true">
                  {[0, 0.2, 0.4, 0.1].map((d, k) => <span key={k} style={{ background: c, animationDelay: `${d + i * 0.15}s` }} />)}
                </span>
                <span className="num" style={{ color: c, fontSize: 18 }}>#{r.number}</span>
                <span style={{ fontSize: 15, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                <span className="lbl" style={{ marginLeft: "auto", color: "var(--lavender)" }}>{elapsed(r.startedAt)}</span>
              </div>
              <div style={{ fontSize: 17, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{step ?? r.activity ?? "Starting"}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                <span className="tag" style={{ background: c }}>{r.kind === "review" ? "reviewer" : r.kind}</span>
                {r.subagents.map((s, k) => (
                  <span key={k} className="tag" style={{ background: "var(--chip)", color: c }}><span className="dot" style={{ background: c, width: 7, height: 7 }} /> sub: {s}</span>
                ))}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 14, letterSpacing: ".05em", color: "var(--gold)", textTransform: "uppercase" }}>
                <span>{fmtTok(tok)} tok</span><span>{fmtTok(r.rate)}/min</span>{r.costUsd > 0 && <span>≈ {money(r.costUsd)}</span>}
                <span style={{ color: r.overridden ? "var(--orange)" : "var(--lavender)" }}>{TIER_LABEL[r.tier]} · {r.effort}{r.overridden ? "*" : ""}</span>
              </div>
              <span className="scan" style={{ background: c, animationDuration: `${2.4 + i * 0.7}s` }} aria-hidden="true" />
            </a>
          );
        })}
        {waiting.map((t) => (
          <a key={t.number} href="#/inbox" className="live" style={{ background: "#1a0c0b" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="dot" style={{ background: "var(--red)", width: 14, height: 14 }} />
              <span className="num" style={{ color: "var(--redsoft)", fontSize: 18 }}>#{t.number}</span>
              <span style={{ fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
              <span className="lbl" style={{ marginLeft: "auto", color: "var(--redsoft)" }}>{elapsed(t.updatedAt).replace(/^00:/, "")}</span>
            </div>
            <div style={{ fontSize: 17 }}>Paused: asked you a question</div>
            <div style={{ fontSize: 14, letterSpacing: ".05em", color: "var(--redsoft)", textTransform: "uppercase" }}>Slot freed</div>
          </a>
        ))}
      </div>
    </section>
  );
}

export { TONE };
