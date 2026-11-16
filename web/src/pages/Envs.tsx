import { useState } from "react";
import { ago, api, post, useApi, useBus, type EnvsView } from "../api.ts";
import { Empty, LiveLog, Loading, Pill, useApp } from "../ui.tsx";

const ENV_COLORS = ["var(--peach)", "var(--salmon)", "var(--lilac)", "var(--gold)"];

export function EnvsPage() {
  const { pid, act } = useApp();
  const [v, err, reload, setV] = useApi<EnvsView>(`/api/p/${pid}/envs`, ["deploy", "envs"], 1500);
  const [logs, setLogs] = useState<Record<number, string>>({});
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});
  /** `env/gate` -> skip it on the next deploy of that env. */
  const [skips, setSkips] = useState<Record<string, boolean>>({});
  useBus((e) => {
    if (e.type !== "deploy" || e.project !== pid) return;
    if (e.data.line && e.data.id) {
      setLogs((l) => ({ ...l, [e.data.id]: (l[e.data.id] ?? "") + e.data.line }));
      setOpen(e.data.id);
    }
  });
  if (!v) return <Loading error={err} />;

  const force = async () => {
    setBusy("probe");
    const r = await act(() => api<EnvsView>(`/api/p/${pid}/envs?force=1`));
    if (r) setV(r);
    setBusy(null);
  };
  const doDeploy = async (envId: string, name: string, choice: string | undefined, skip: string[]) => {
    let reason = "";
    if (skip.length) {
      reason = prompt(`Skip ${skip.join(", ")} for this ${name} deploy? Say why (kept in the history):`)?.trim() ?? "";
      if (!reason) return;
    } else if (!confirm(`Run the ${name} deploy script now${choice ? ` (${choice})` : ""}?`)) return;
    setBusy(envId);
    const r = await act(
      () => post<{ id: number }>(`/api/p/${pid}/envs/${envId}/deploy`, { ...(choice ? { choice } : {}), ...(skip.length ? { skip, reason } : {}) }),
      `Deploy to ${name} started${choice ? ` (${choice})` : ""}`,
    );
    if (r) setOpen(r.id);
    setBusy(null);
    reload();
  };
  const runStep = async (envId: string, gate: string, label: string) => {
    if (!confirm(`${label} for "${gate}" now? It runs on this machine with your credentials.`)) return;
    setBusy(`${envId}/${gate}`);
    const r = await act(() => post<{ id: number }>(`/api/p/${pid}/envs/${envId}/gates/step`, { gate }), `${label} started`);
    if (r) setOpen(r.id);
    setBusy(null);
    reload();
  };
  const stopStep = async (id: number, gate: string) => {
    if (!confirm(`Stop "${gate}"? Whatever it was doing is cut short.`)) return;
    await act(() => post(`/api/p/${pid}/deploys/${id}/stop`, {}), "Stopping…");
    reload();
  };
  const showLog = async (id: number) => {
    if (open === id) return setOpen(null);
    const r = await act(() => api<{ log: string }>(`/api/p/${pid}/deploys/${id}/log`));
    if (r) setLogs((l) => ({ ...l, [id]: r.log }));
    setOpen(id);
  };

  const notOn = (envId: string) => v.merged.filter((m) => !m.on.includes(envId));
  const first = v.envs[0];

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
        <span className="lbl" style={{ color: "var(--lilac)" }}>
          Probes from <b>.kiln/envs.yaml</b> · checked <b>{ago(v.checkedAt)}</b> ago
        </span>
        <Pill tone="lilac" sm busy={busy === "probe"} onClick={force}>Probe now</Pill>
      </div>
      {!v.envs.length && (
        <Empty>
          No environments configured. Add <code>.kiln/envs.yaml</code> to the project (see docs/project-files.md): one entry per
          environment with a version probe and an optional deploy script.
        </Empty>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <section className="env" aria-label="main">
          <div className="envh" style={{ background: "var(--lavender)" }}><span>MAIN</span><span className="lbl">{v.main.branch}</span></div>
          <div className="envb">
            <span className="ver" style={{ color: "var(--lavender)" }}>{v.main.sha?.slice(0, 7).toUpperCase() ?? "?"}</span>
            {first ? <span className="lbl" style={{ color: "var(--lavender)" }}>{notOn(first.id).length} Kiln PRs ahead of {first.name}</span> : null}
            {(first ? notOn(first.id) : v.merged).slice(0, 10).map((m) => (
              <div className="row" key={m.number}>
                <b style={{ color: "var(--lavender)" }}>#{m.issue ?? m.number}</b>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</span>
                <span className="lbl" style={{ color: "var(--muted)" }}>{m.mergedAt ? ago(m.mergedAt) : ""}</span>
              </div>
            ))}
            <span className="lbl" style={{ color: "var(--muted)" }}>Local dev: copy any task's worktree path from its page.</span>
          </div>
        </section>
        {v.envs.map((e, i) => {
          const c = ENV_COLORS[i % ENV_COLORS.length];
          const prev = i > 0 ? v.envs[i - 1] : null;
          const pending = prev ? v.merged.filter((m) => m.on.includes(prev.id) && !m.on.includes(e.id)) : notOn(e.id);
          const skipping = e.gates.filter((g) => !g.ok && g.skippable && skips[`${e.id}/${g.name}`]).map((g) => g.name);
          const gatesOk = e.gates.every((g) => g.ok || skipping.includes(g.name));
          const choices = e.deployChoices ?? [];
          const pick = choices.includes(picks[e.id]) ? picks[e.id] : choices[0];
          return (
            <section className="env" aria-label={e.name} key={e.id}>
              <div className="envh" style={{ background: c }}><span>{e.name.toUpperCase()}</span><span className="lbl">{e.url}</span></div>
              <div className="envb">
                <span className="ver" style={{ color: c }}>{e.version?.toUpperCase() ?? "?"}</span>
                {e.error ? <span className="lbl" style={{ color: "var(--redsoft)" }}>{e.error}</span> : (
                  <span className="lbl" style={{ color: "var(--muted)" }}>{e.health ?? "no health probe"}{e.sha ? ` · ${e.sha.slice(0, 7)}` : e.version ? " · not a git ref here" : ""}</span>
                )}
                {e.candidate && <span>Candidate <b>{e.candidate}</b> · {pending.length} task{pending.length === 1 ? "" : "s"}</span>}
                {pending.slice(0, 8).map((m) => (
                  <div className="row" key={m.number}>
                    <b style={{ color: c }}>#{m.issue ?? m.number}</b>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</span>
                  </div>
                ))}
                {e.gates.map((g) => {
                  const k = `${e.id}/${g.name}`;
                  return (
                    <div key={g.name} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                      <span title={g.output} style={{ flex: "1 1 160px", color: g.ok ? "var(--sky)" : skips[k] ? "var(--gold)" : "var(--redsoft)" }}>
                        {g.ok ? "✓" : skips[k] ? "↷" : "✗"} {g.name}
                      </span>
                      {g.step && g.running === null && (
                        <Pill tone="lilac" sm busy={busy === k} onClick={() => runStep(e.id, g.name, g.step!)}>{g.step}</Pill>
                      )}
                      {g.running !== null && (
                        <>
                          <button className="lbl" onClick={() => showLog(g.running!)} style={{ background: "none", border: 0, color: "var(--gold)", cursor: "pointer" }}>running · log</button>
                          <Pill tone="salmon" sm onClick={() => stopStep(g.running!, g.name)}>Stop</Pill>
                        </>
                      )}
                      {!g.ok && g.skippable && (
                        <label className="lbl" style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--muted)", cursor: "pointer" }}>
                          <input type="checkbox" checked={!!skips[k]} onChange={(ev) => setSkips((s) => ({ ...s, [k]: ev.target.checked }))} />
                          skip
                        </label>
                      )}
                    </div>
                  );
                })}
                {e.canDeploy && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    {choices.length > 0 && (
                      <div className="seg" role="radiogroup" aria-label={`${e.name} deploy option`}>
                        {choices.map((o) => (
                          <button key={o} role="radio" aria-checked={pick === o} className={pick === o ? "on" : ""} style={{ padding: "6px 14px" }} onClick={() => setPicks((p) => ({ ...p, [e.id]: o }))}>
                            {o}
                          </button>
                        ))}
                      </div>
                    )}
                    <Pill tone={i === v.envs.length - 1 ? "salmon" : "peach"} busy={busy === e.id} disabled={!gatesOk} onClick={() => doDeploy(e.id, e.name, pick, skipping)}>
                      {e.deployLabel ?? `Deploy ${e.name}`}{gatesOk ? "" : " · locked"}
                    </Pill>
                  </div>
                )}
                {!gatesOk && <span className="lbl" style={{ color: "var(--muted)" }}>Unlocks when every gate above passes{e.gates.some((g) => g.skippable) ? " or is skipped" : ""}.</span>}
              </div>
            </section>
          );
        })}
      </div>
      {v.deploys.length > 0 && (
        <section aria-label="Deploy history" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ flex: "0 0 26px", height: 26, background: "var(--lilac)", borderRadius: "13px 0 0 13px" }} />
            <b style={{ color: "var(--lilac)", fontSize: 20, letterSpacing: ".06em" }}>HISTORY</b>
            <div style={{ flex: 1, height: 8, background: "var(--lilac)" }} />
          </div>
          {v.deploys.map((d) => (
            <div key={d.id}>
              <button className="row" onClick={() => showLog(d.id)} style={{ background: "none", border: 0, borderBottom: "1px solid var(--line)", color: "var(--ink)", width: "100%", font: "inherit", textAlign: "left" }}>
                <span style={{ minWidth: 140 }}>{new Date(d.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                <span style={{ minWidth: 160, textTransform: "uppercase" }}>
                  {d.kind === "step" ? `${d.env} · ${d.gate}` : `${d.env} ‹ ${d.version ?? "?"}`}
                  {d.skipped && <span title={d.skipped.reason} style={{ color: "var(--gold)", textTransform: "none" }}> · skipped {d.skipped.gates.join(", ")}</span>}
                </span>
                <span style={{ color: d.status === "failed" || d.status === "restarted" ? "var(--red)" : d.status === "running" ? "var(--gold)" : d.status === "stopped" ? "var(--muted)" : "var(--sky)" }}>{d.status}</span>
                <span className="lbl" style={{ marginLeft: "auto", color: "var(--muted)" }}>{open === d.id ? "hide log" : "log"}</span>
              </button>
              {open === d.id && <LiveLog text={logs[d.id] || "…"} />}
            </div>
          ))}
        </section>
      )}
    </>
  );
}
