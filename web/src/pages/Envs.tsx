import { useState } from "react";
import { ago, api, post, useApi, useBus, type EnvsView } from "../api.ts";
import { Empty, Loading, Pill, useApp } from "../ui.tsx";

const ENV_COLORS = ["var(--peach)", "var(--salmon)", "var(--lilac)", "var(--gold)"];

export function EnvsPage() {
  const { pid, act } = useApp();
  const [v, err, reload, setV] = useApi<EnvsView>(`/api/p/${pid}/envs`, ["deploy"], 1500);
  const [logs, setLogs] = useState<Record<number, string>>({});
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
  const doDeploy = async (envId: string, name: string) => {
    if (!confirm(`Run the ${name} deploy script now?`)) return;
    setBusy(envId);
    const r = await act(() => post<{ id: number }>(`/api/p/${pid}/envs/${envId}/deploy`), `Deploy to ${name} started`);
    if (r) setOpen(r.id);
    setBusy(null);
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
          const gatesOk = e.gates.every((g) => g.ok);
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
                {e.gates.map((g) => (
                  <span key={g.name} title={g.output} style={{ color: g.ok ? "var(--sky)" : "var(--redsoft)" }}>{g.ok ? "✓" : "✗"} {g.name}</span>
                ))}
                {e.canDeploy && (
                  <Pill tone={i === v.envs.length - 1 ? "salmon" : "peach"} busy={busy === e.id} disabled={!gatesOk} onClick={() => doDeploy(e.id, e.name)} style={{ alignSelf: "flex-start" }}>
                    {e.deployLabel ?? `Deploy ${e.name}`}{gatesOk ? "" : " · locked"}
                  </Pill>
                )}
                {!gatesOk && <span className="lbl" style={{ color: "var(--muted)" }}>Unlocks when every gate above passes.</span>}
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
                <span style={{ minWidth: 160, textTransform: "uppercase" }}>{d.env} ‹ {d.version ?? "?"}</span>
                <span style={{ color: d.status === "failed" ? "var(--red)" : d.status === "running" ? "var(--gold)" : "var(--sky)" }}>{d.status}</span>
                <span className="lbl" style={{ marginLeft: "auto", color: "var(--muted)" }}>{open === d.id ? "hide log" : "log"}</span>
              </button>
              {open === d.id && <pre className="log thin-scroll">{logs[d.id] || "…"}</pre>}
            </div>
          ))}
        </section>
      )}
    </>
  );
}
