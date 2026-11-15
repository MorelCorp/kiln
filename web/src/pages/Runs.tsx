import { elapsed, fmtTok, money, TIER_LABEL, useApi, useNow, type RunView } from "../api.ts";
import { Empty, Loading, Sec, Tag, useApp } from "../ui.tsx";

const STATUS_TONE = { running: "sky", done: "lavender", failed: "red", stopped: "gold", overage: "red" } as const;

export function RunsPage() {
  const { pid } = useApp();
  const [data, err] = useApi<{ live: RunView[]; recent: RunView[] }>(`/api/p/${pid}/runs`, ["run"], 800);
  useNow(1000);
  if (!data) return <Loading error={err} />;
  const past = data.recent.filter((r) => !r.live);
  return (
    <>
      <Sec tone="sky">Live</Sec>
      {!data.live.length && <Empty>No live run.</Empty>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {data.live.map((r) => <RunRowView key={r.id} r={r} />)}
      </div>
      <Sec tone="lavender">Recent</Sec>
      {!past.length && <Empty>No runs yet.</Empty>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {past.map((r) => <RunRowView key={r.id} r={r} />)}
      </div>
    </>
  );
}

function RunRowView({ r }: { r: RunView }) {
  const tok = r.inputTokens + r.cacheCreateTokens + r.cacheReadTokens + r.outputTokens;
  const href = r.number !== null ? `#/task/${r.number}` : undefined;
  return (
    <a href={href} className="card" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: "4px 14px", borderRadius: "0 999px 999px 0" }}>
      <span className="num" style={{ color: "var(--sky)", minWidth: 54 }}>{r.number !== null ? `#${r.number}` : "—"}</span>
      <Tag tone={STATUS_TONE[r.status as keyof typeof STATUS_TONE] ?? "dim"}>{r.status}</Tag>
      <Tag tone="dim">{r.kind}</Tag>
      <span style={{ flex: "1 1 240px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.error ?? r.activity ?? r.summary ?? ""}</span>
      <span className="lbl" style={{ color: "var(--gold)" }}>{fmtTok(tok)} tok{r.costUsd ? ` · ≈ ${money(r.costUsd)}` : ""}</span>
      <span className="lbl" style={{ color: r.overridden ? "var(--orange)" : "var(--lavender)" }}>{TIER_LABEL[r.tier]} · {r.effort}{r.overridden ? "*" : ""}</span>
      <span className="lbl" style={{ color: "var(--lavender)", minWidth: 60, textAlign: "right" }}>{r.live ? elapsed(r.startedAt) : new Date(r.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</span>
      {r.usedOverage && <Tag tone="red">extra usage</Tag>}
    </a>
  );
}
