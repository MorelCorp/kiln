import { useState } from "react";
import { api, fmtTok, money, pct, post, resetTime, useApi, useBus, type Pace, type TokensView } from "../api.ts";
import { EffortSeg, Loading, Pill, Sec, TierSeg, useApp } from "../ui.tsx";

export function TokensPage() {
  const { act, reloadState } = useApp();
  const [v, err, reload] = useApi<TokensView>("/api/tokens", ["usage", "pace", "run"], 1500);
  const [rates, setRates] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  useBus((e) => {
    if (e.type === "tick") setRates((r) => [...r.slice(-23), e.data.rate as number]);
  });
  if (!v) return <Loading error={err} />;
  const u = v.usage;
  const pace = v.pace;
  const set = async (p: Partial<Pace>) => {
    await act(() => api("/api/pace", { method: "PATCH", body: p }));
    reload();
    reloadState();
  };
  const max = Math.max(1, ...v.days.map((d) => d.small + d.medium + d.large));
  const rmax = Math.max(1, ...rates);

  const Meter = ({ value, stop }: { value: number | null; stop: number }) => (
    <div className="meter" style={{ position: "relative" }} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((value ?? 0) * 100)}>
      <div style={{ width: `${Math.min(100, (value ?? 0) * 100)}%`, background: (value ?? 0) >= stop ? "var(--red)" : "var(--orange)" }} />
      <div style={{ position: "absolute", left: `${stop * 100}%`, top: -3, bottom: -3, width: 3, background: "var(--red)" }} title={`Kiln stops starting runs at ${Math.round(stop * 100)}%`} />
    </div>
  );

  return (
    <>
      <span className="lbl" style={{ color: "var(--lavender)" }}>
        Windows include your own Claude sessions · Kiln's own tokens shown separately · last reading {u ? new Date(u.at).toLocaleTimeString([], { hour12: false }) : "none yet"}
      </span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 22 }}>
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Sec tone="orange">5 h window</Sec>
          <span className="big" style={{ color: "var(--orange)" }}>{pct(u?.fiveHour)}</span>
          <Meter value={u?.fiveHour ?? null} stop={pace.stopAt5h} />
          <span className="lbl" style={{ color: "var(--peach)" }}>Kiln {fmtTok(v.kiln5h)} tok in 5 h · resets {resetTime(u?.fiveHourResetsAt)} · stop at {Math.round(pace.stopAt5h * 100)}%</span>
        </section>
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Sec tone="peach">7 days</Sec>
          <span className="big" style={{ color: "var(--peach)" }}>{pct(u?.sevenDay)}</span>
          <Meter value={u?.sevenDay ?? null} stop={pace.stopAt7d} />
          <span className="lbl" style={{ color: "var(--peach)" }}>resets {resetTime(u?.sevenDayResetsAt)} · stop at {Math.round(pace.stopAt7d * 100)}%</span>
        </section>
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Sec tone="sky">Live rate</Sec>
          <span className="big" style={{ color: "var(--sky)" }}>{fmtTok(v.rate)}<span style={{ fontSize: 20 }}>/MIN</span></span>
          <div aria-hidden="true" style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 30 }}>
            {(rates.length ? rates : [0]).map((r, i) => <div key={i} style={{ flex: 1, height: `${Math.max(6, (r / rmax) * 100)}%`, background: "var(--sky)", opacity: 0.4 + (0.6 * i) / Math.max(1, rates.length) }} />)}
          </div>
          <span className="lbl" style={{ color: "var(--sky)" }}>Today ≈ {money(v.costToday)} API-equivalent</span>
        </section>
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Sec tone={pace.allowExtraUsage ? "gold" : "red"}>Extra usage</Sec>
          <span className="big" style={{ color: pace.allowExtraUsage ? "var(--gold)" : "var(--redsoft)" }}>{u?.isUsingOverage ? "IN USE" : pace.allowExtraUsage ? "ALLOWED" : "BLOCKED"}</span>
          <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }} className="lbl">
            <input type="checkbox" checked={pace.allowExtraUsage} onChange={(e) => set({ allowExtraUsage: e.target.checked })} style={{ width: 20, height: 20, accentColor: "var(--orange)" }} />
            Allow agents to use extra usage
          </label>
          <span style={{ fontSize: 14, color: "var(--peach)", lineHeight: 1.35 }}>
            Off: no runs start on an exhausted window; a run that starts using extra usage is stopped and resumes after the reset. Tasks can opt in one by one.
            {u?.overageStatus ? ` Account: ${u.overageStatus}.` : ""}
          </span>
        </section>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 22, alignItems: "flex-start" }}>
        <section style={{ flex: "2 1 420px", minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <Sec tone="lavender">Daily · 14 days · by model</Sec>
          <div style={{ display: "flex", gap: 14 }} className="lbl">
            <span><span style={{ color: "var(--orange)" }}>■</span> Opus</span>
            <span><span style={{ color: "var(--lavender)" }}>■</span> Sonnet</span>
            <span><span style={{ color: "#4e4e66" }}>■</span> Haiku</span>
          </div>
          <div className="bars" role="img" aria-label="Daily Kiln token usage by model over the last 14 days">
            {v.days.map((d) => {
              const h = (n: number) => `${(n / max) * 100}%`;
              return (
                <div key={d.day} title={`${d.day}: ${fmtTok(d.small + d.medium + d.large)} tokens`}>
                  {d.large > 0 && <div className="op" style={{ height: h(d.large) }} />}
                  {d.medium > 0 && <div className="so" style={{ height: h(d.medium) }} />}
                  {d.small > 0 && <div className="ha" style={{ height: h(d.small) }} />}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }} className="lbl">
            <span>{v.days[0].day.slice(5)}</span><span>{v.days[v.days.length - 1].day.slice(5)}</span>
          </div>
        </section>

        <section aria-label="Pace" style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <Sec tone="peach">Pace defaults</Sec>
          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
            <span className="lbl" style={{ color: "var(--peach)" }}>Loop running</span>
            <input type="checkbox" checked={!pace.paused} onChange={(e) => set({ paused: !e.target.checked })} style={{ width: 22, height: 22, accentColor: "var(--orange)" }} />
          </label>
          {v.hold && !pace.paused && <span className="lbl" style={{ color: "var(--redsoft)" }}>Holding: {v.hold}</span>}
          <span className="lbl" style={{ color: "var(--peach)" }}>Max agents</span>
          <div className="seg">
            {[1, 2, 3, 4].map((n) => <button key={n} className={pace.maxConcurrentAgents === n ? "on" : ""} onClick={() => set({ maxConcurrentAgents: n })}>{n}</button>)}
          </div>
          <span className="lbl" style={{ color: "var(--peach)" }}>Model ceiling</span>
          <TierSeg value={pace.modelCeiling} onChange={(t) => set({ modelCeiling: t })} />
          <span className="lbl" style={{ color: "var(--peach)" }}>Effort ceiling</span>
          <EffortSeg value={pace.effortCeiling} onChange={(e) => set({ effortCeiling: e })} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 6, alignItems: "center" }}>
            <span className="lbl" style={{ color: "var(--peach)" }}>Stop at 5 h %</span>
            <NumIn value={Math.round(pace.stopAt5h * 100)} onSave={(n) => set({ stopAt5h: Math.min(100, Math.max(1, n)) / 100 })} />
            <span className="lbl" style={{ color: "var(--peach)" }}>Stop at 7 d %</span>
            <NumIn value={Math.round(pace.stopAt7d * 100)} onSave={(n) => set({ stopAt7d: Math.min(100, Math.max(1, n)) / 100 })} />
            <span className="lbl" style={{ color: "var(--peach)" }}>Kiln token budget / {pace.tokenWindowHours} h (0 = none)</span>
            <NumIn value={pace.tokenBudget} onSave={(n) => set({ tokenBudget: Math.max(0, n) })} />
          </div>
          <span className="lbl" style={{ color: "var(--muted)" }}>Per-task overrides are set from a task's Runs page.</span>
          <Pill tone="dim" sm busy={busy} style={{ alignSelf: "flex-start" }}
            onClick={async () => (setBusy(true), await act(() => post("/api/usage/probe"), "Usage refreshed"), setBusy(false), reload(), reloadState())}
            title="Runs a tiny Haiku request to read the current subscription windows">
            Refresh usage reading
          </Pill>
        </section>
      </div>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Sec tone="gold">Per task</Sec>
        <div style={{ overflowX: "auto" }} className="thin-scroll">
          <table className="kt">
            <thead><tr><th>Task</th><th>Runs</th><th>Model · effort</th><th>Input + cache</th><th>Output</th><th>≈ Cost</th><th>Extra</th><th>State</th></tr></thead>
            <tbody>
              {!v.perTask.length && <tr><td colSpan={8} className="lbl" style={{ color: "var(--muted)" }}>No runs yet.</td></tr>}
              {v.perTask.map((t) => (
                <tr key={`${t.project}-${t.number}`}>
                  <td><a href={`#/task/${t.number}`} style={{ color: "var(--ink)", textDecoration: "none" }}><b>#{t.number}</b> {t.title}</a></td>
                  <td>{t.runs}</td>
                  <td style={{ color: t.overridden ? "var(--orange)" : undefined }}>{t.models.join(", ")}{t.overridden ? "*" : ""}</td>
                  <td>{fmtTok(t.input)}</td><td>{fmtTok(t.output)}</td><td>{money(t.cost)}</td>
                  <td style={{ color: t.extra ? "var(--red)" : undefined }}>{t.extra ? "yes" : "—"}</td><td>{t.state.replace("_", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span className="lbl" style={{ color: "var(--muted)" }}>* overridden for this task · ≈ cost is the API-equivalent price; the subscription isn't billed per token.</span>
      </section>
    </>
  );
}

function NumIn({ value, onSave }: { value: number; onSave: (n: number) => void }) {
  const [s, setS] = useState(String(value));
  return (
    <input className="inp" inputMode="numeric" value={s} onChange={(e) => setS(e.target.value)} style={{ padding: "4px 10px", borderRadius: 999 }}
      onBlur={() => { const n = Number(s); if (Number.isFinite(n) && n !== value) onSave(n); else setS(String(value)); }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
  );
}
