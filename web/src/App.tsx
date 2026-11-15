import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  api, ago, fmtTok, pct, post, useApi, useBus, useConnected,
  type AppState, type Board, type ChatState, type EnvsView, type Pace,
} from "./api.ts";
import { Ctx, EffortSeg, ErrorBoundary, Md, Pill, TierSeg, go, useApp as useAppCtx, useRoute, type AppCtx, type Toast } from "./ui.tsx";
import { BoardPage } from "./pages/Board.tsx";
import { InboxPage } from "./pages/Inbox.tsx";
import { RunsPage } from "./pages/Runs.tsx";
import { TaskPage } from "./pages/Task.tsx";
import { ReviewPage } from "./pages/Review.tsx";
import { TestPage } from "./pages/Test.tsx";
import { EnvsPage } from "./pages/Envs.tsx";
import { TokensPage } from "./pages/Tokens.tsx";
import { NewTaskPage } from "./pages/NewTask.tsx";

const TITLES: Record<string, string> = {
  board: "Kiln · Pipeline", inbox: "Needs you", runs: "Kiln · Runs", task: "Kiln · Runs", review: "Review",
  test: "Test checklist", envs: "Environments", tokens: "Tokens · Pace", new: "New task",
};

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const reloadState = useCallback(() => {
    api<AppState>("/api/state").then((s) => (setState(s), setErr(null)), (e: Error) => setErr(e.message));
  }, []);
  useEffect(reloadState, [reloadState]);

  const toast = useCallback((text: string, level: "info" | "error" = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, level }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), level === "error" ? 9000 : 4000);
  }, []);

  useBus((e) => {
    if (e.type === "pace" || e.type === "usage") reloadState();
    if (e.type === "toast") toast(e.data.text, e.data.level);
    if (e.type === "tick" && state) setState((s) => (s ? { ...s, rate: e.data.rate, hold: e.data.hold } : s));
  });

  const ctx = useMemo<AppCtx | null>(() => {
    if (!state) return null;
    return {
      state, pid: state.activeProject, reloadState, toast,
      act: async (fn, ok) => {
        try {
          const r = await fn();
          if (ok) toast(ok);
          return r;
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e), "error");
          return undefined;
        }
      },
    };
  }, [state, reloadState, toast]);

  if (!ctx) {
    return (
      <div style={{ padding: 40, color: err ? "var(--redsoft)" : "var(--lavender)" }} className="lbl">
        {err ? `Kiln daemon unreachable: ${err}. Start it with npm start.` : "Connecting to Kiln…"}
      </div>
    );
  }
  return (
    <Ctx.Provider value={ctx}>
      <Frame />
      <div style={{ position: "fixed", right: 16, bottom: 16, zIndex: 50, display: "flex", flexDirection: "column", gap: 6, maxWidth: "min(420px, calc(100vw - 32px))" }} aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast" style={{ background: t.level === "error" ? "var(--red)" : "var(--sky)", color: "#000", borderRadius: "18px 0 0 18px", padding: "8px 14px", fontSize: 15, letterSpacing: ".03em" }}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

function Frame() {
  const { state, pid, act, reloadState } = useAppCtx();
  const route = useRoute();
  const page = route[0] ?? "board";
  const [paceOpen, setPaceOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [board] = useApi<Board>(`/api/p/${pid}/board`, ["board", "task", "run"], 800);
  const [envs] = useApi<EnvsView>(`/api/p/${pid}/envs`, ["deploy", "envs"], 2000);
  const connected = useConnected();
  const project = state.projects.find((p) => p.id === pid);
  const needs = board?.columns.needs.length ?? 0;

  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    setPaceOpen(false);
    setChatOpen(false);
    mainRef.current?.scrollTo({ top: 0 });
  }, [route.join("/")]);

  // N opens New task (when not typing).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" || e.key === "N") (e.preventDefault(), go("/new"));
      if (e.key === "Escape") (setPaceOpen(false), setChatOpen(false));
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const env = (id: string) => envs?.envs.find((e) => e.id === id);
  const staging = envs?.envs.find((e) => e.id !== "prod") ?? null;
  const prod = env("prod") ?? null;
  const undeployed = envs ? envs.merged.filter((m) => staging && !m.on.includes(staging.id)).length : null;
  const u = state.usage;
  const extra = state.pace.allowExtraUsage ? "ALLOWED" : "BLOCKED";

  let body: ReactNode;
  switch (page) {
    case "inbox": body = <InboxPage />; break;
    case "runs": body = <RunsPage />; break;
    case "task": body = <TaskPage number={Number(route[1])} />; break;
    case "review": body = <ReviewPage number={Number(route[1])} tab={route[2]} />; break;
    case "test": body = <TestPage number={Number(route[1])} env={route[2]} />; break;
    case "envs": body = <EnvsPage />; break;
    case "tokens": body = <TokensPage />; break;
    case "new": body = <NewTaskPage />; break;
    default: body = <BoardPage board={board} />;
  }

  const nav: { id: string; label: string; color: string; tall?: boolean }[] = [
    { id: "board", label: "Board", color: "var(--orange)", tall: true },
    { id: "inbox", label: `Needs you · ${String(needs).padStart(2, "0")}`, color: "var(--red)", tall: true },
    { id: "runs", label: "Runs", color: "var(--lavender)" },
    { id: "envs", label: "Environments", color: "var(--lilac)" },
    { id: "tokens", label: "Tokens", color: "var(--peach)" },
  ];
  const navCur = page === "task" ? "runs" : page === "review" || page === "test" ? "inbox" : page;

  return (
    <div className="frame">
      {/* Header elbow */}
      <header style={{ position: "relative", background: "var(--lilac)", borderRadius: "0 0 0 64px", minHeight: 150, flexShrink: 0 }}>
        <div style={{ position: "absolute", left: "var(--rail)", right: 0, top: 0, bottom: 16, background: "#000", borderRadius: "0 0 0 34px", padding: "0 0 10px 24px", display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 12, overflow: "hidden" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14, letterSpacing: ".08em", color: "var(--gold)", textTransform: "uppercase", minWidth: 0 }}>
            <a href="#/envs" style={{ display: "flex", flexWrap: "wrap", gap: "6px 22px", color: "var(--gold)", textDecoration: "none" }}>
              {staging && <span>{staging.name} <b style={{ color: "var(--ink)" }}>{staging.version ?? "?"}</b></span>}
              {prod && <span>{prod.name} <b style={{ color: "var(--ink)" }}>{prod.version ?? "?"}</b></span>}
              <span>Main <b style={{ color: "var(--ink)" }}>{envs?.main.sha?.slice(0, 7) ?? "…"}</b></span>
              {undeployed !== null && staging && <span>Undeployed <b style={{ color: "var(--ink)" }}>{String(undeployed).padStart(2, "0")}</b></span>}
            </a>
            <a href="#/tokens" style={{ display: "flex", flexWrap: "wrap", gap: "6px 22px", color: "var(--lavender)", textDecoration: "none" }}>
              <span>5H <b style={{ color: "var(--ink)" }}>{pct(u?.fiveHour)}</b></span>
              <span>7D <b style={{ color: "var(--ink)" }}>{pct(u?.sevenDay)}</b></span>
              <span>Kiln <b style={{ color: "var(--ink)" }}>{fmtTok(state.rate)}/min</b></span>
              <span>Extra usage <b style={{ color: state.pace.allowExtraUsage ? "var(--gold)" : "var(--redsoft)" }}>{u?.isUsingOverage ? "IN USE" : extra}</b></span>
              <span>Sync <b style={{ color: "var(--ink)" }}>{board?.syncedAt ? ago(board.syncedAt) : "…"}</b></span>
              {!connected && <span style={{ color: "var(--redsoft)" }}>● Live link down</span>}
              {state.hold && !state.pace.paused && <span style={{ color: "var(--redsoft)" }}>Holding: {state.hold}</span>}
            </a>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, marginLeft: "auto" }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <label style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: -9999 }}>Project</span>
                <select className="pill" value={pid} style={{ background: "var(--orange)", appearance: "none", paddingRight: 20, border: 0 }}
                  onChange={(e) => act(() => post("/api/project/active", { id: e.target.value })).then(() => (reloadState(), go("/board")))}>
                  {state.projects.map((p) => <option key={p.id} value={p.id}>{p.name.toUpperCase()}</option>)}
                </select>
              </label>
              <Pill tone="sky" href="#/new" title="New task (N)">+ New task</Pill>
              <Pill tone="lavender" onClick={() => act(() => post(`/api/p/${pid}/sync`), "Synced")}>Sync now</Pill>
            </div>
            <div style={{ fontSize: "clamp(30px, 5vw, 60px)", fontWeight: 700, color: "var(--orange)", lineHeight: 0.9, letterSpacing: ".02em", textTransform: "uppercase", textAlign: "right" }}>
              {TITLES[page] ?? "Kiln"}
            </div>
          </div>
        </div>
        <div style={{ position: "absolute", left: 0, top: 0, width: "var(--rail)", padding: "10px 10px 0 0", boxSizing: "border-box", textAlign: "right", color: "#000", fontSize: 15, letterSpacing: ".05em", textTransform: "uppercase", overflowWrap: "anywhere" }}>
          Kiln {state.version}<br />{project?.id}
        </div>
      </header>

      {/* Body elbow: the header and the rail stay put; only <main> scrolls (see .frame in theme.css). */}
      <div className="frame-body">
        <nav className="side" aria-label="Main" style={{ flex: "0 0 var(--rail)", display: "flex", flexDirection: "column", gap: 4, minHeight: 0 }}>
          <div style={{ background: "var(--salmon)", height: 44, borderRadius: "64px 0 0 0" }} />
          {nav.map((n) => (
            <a key={n.id} href={`#/${n.id}`} className={navCur === n.id ? "cur" : ""} aria-current={navCur === n.id ? "page" : undefined}
              style={{ background: n.color, minHeight: n.tall ? 64 : 44, filter: n.id === "inbox" && needs === 0 ? "saturate(.35)" : undefined }}>
              {n.label}
            </a>
          ))}
          <div style={{ background: "var(--salmon)", flex: 1, minHeight: 8 }} />
          {/* Sticky only matters in the short-window fallback, where the whole page scrolls. */}
          <div style={{ position: "sticky", bottom: 10, display: "flex", flexDirection: "column", gap: 4, background: "#000", paddingTop: 4, marginTop: -4 }}>
            <button className="navbtn" onClick={() => (setPaceOpen((v) => !v), setChatOpen(false))} aria-expanded={paceOpen} style={{ background: "var(--peach)", minHeight: 52 }}>
              Pace {paceOpen ? "▾" : "▸"}
            </button>
            <button className="navbtn" onClick={() => (setChatOpen((v) => !v), setPaceOpen(false))} aria-expanded={chatOpen} style={{ background: "var(--lilac)", minHeight: 52 }}>
              Chat {chatOpen ? "▾" : "▸"}
            </button>
            <div style={{ background: "var(--gold)", height: 24 }} />
          </div>
        </nav>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", gap: 4, height: 16, flexShrink: 0 }}>
            <div style={{ flex: 3, background: "var(--salmon)" }} /><div style={{ flex: "0 0 22px", background: "var(--orange)" }} />
            <div style={{ flex: 2, background: "var(--lilac)" }} /><div style={{ flex: 4, background: "var(--lavender)" }} />
          </div>
          <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
            <div style={{ position: "absolute", left: 0, top: 0, width: 34, height: 34, background: "var(--salmon)" }} />
            <main ref={mainRef} className="frame-main" style={{ position: "relative", flex: 1, minWidth: 0, background: "#000", borderRadius: "34px 0 0 0", padding: "18px 4px 24px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
              <ErrorBoundary inline key={route.join("/")}>{body}</ErrorBoundary>
            </main>
          </div>
        </div>

        <ErrorBoundary inline><PacePopup open={paceOpen} onClose={() => setPaceOpen(false)} /></ErrorBoundary>
        <ErrorBoundary inline><ChatPopup open={chatOpen} onClose={() => setChatOpen(false)} /></ErrorBoundary>
      </div>
    </div>
  );
}

function PacePopup({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, act } = useAppCtx();
  const pace = state.pace;
  const set = (p: Partial<Pace>) => act(() => api("/api/pace", { method: "PATCH", body: p }));
  return (
    <section className={`pop${open ? "" : " shut"}`} aria-label="Pace" aria-hidden={!open}
      style={{ position: "fixed", left: "calc(var(--rail) + 24px)", bottom: 84, width: 310, borderColor: "var(--peach)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ color: "var(--peach)", fontSize: 22, fontWeight: 700, letterSpacing: ".06em" }}>PACE</span>
        <span style={{ flex: 1, height: 10, background: "var(--peach)" }} />
        <Pill tone="peach" sm onClick={onClose} ariaLabel="Minimise pace">–</Pill>
      </div>
      <div className="panelbody">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="lbl" style={{ color: "var(--peach)" }}>Loop</span>
          <Pill tone={pace.paused ? "red" : "sky"} sm onClick={() => set({ paused: !pace.paused })}>{pace.paused ? "Paused · start" : "Running · pause"}</Pill>
        </div>
        {state.hold && !pace.paused && <span className="lbl" style={{ color: "var(--redsoft)" }}>Holding: {state.hold}</span>}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="lbl" style={{ color: "var(--peach)" }}>Max agents</span>
          <span style={{ display: "flex", gap: 3, alignItems: "center" }}>
            <Pill tone="dim" sm onClick={() => set({ maxConcurrentAgents: Math.max(1, pace.maxConcurrentAgents - 1) })} ariaLabel="Fewer agents">−</Pill>
            <b style={{ fontSize: 22, width: 32, textAlign: "center" }}>{String(pace.maxConcurrentAgents).padStart(2, "0")}</b>
            <Pill tone="dim" sm onClick={() => set({ maxConcurrentAgents: Math.min(8, pace.maxConcurrentAgents + 1) })} ariaLabel="More agents">+</Pill>
          </span>
        </div>
        <span className="lbl" style={{ color: "var(--peach)" }}>Model ceiling</span>
        <TierSeg value={pace.modelCeiling} onChange={(t) => set({ modelCeiling: t })} />
        <span className="lbl" style={{ color: "var(--peach)" }}>Effort ceiling</span>
        <EffortSeg value={pace.effortCeiling} onChange={(e) => set({ effortCeiling: e })} />
        <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
          <span className="lbl" style={{ color: "var(--peach)" }}>Allow extra usage</span>
          <input type="checkbox" checked={pace.allowExtraUsage} onChange={(e) => set({ allowExtraUsage: e.target.checked })} style={{ width: 22, height: 22, accentColor: "var(--orange)" }} />
        </label>
        <a href="#/tokens" className="lbl" style={{ color: "var(--lavender)", textAlign: "right" }} onClick={onClose}>Budget & thresholds ›</a>
      </div>
    </section>
  );
}

function ChatPopup({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { pid, act } = useAppCtx();
  const [chat, , , setChat] = useApi<ChatState>(open ? `/api/p/${pid}/chat` : null, []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useBus((e) => {
    if (e.type === "chat" && e.project === pid) setChat(e.data);
  });
  // Braces matter: newer browsers return a Promise from scrollIntoView, and React would call it as the cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [chat?.messages.length, open]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    // "new task: …" goes straight to quick capture.
    const m = t.match(/^new task:\s*(.+)$/i);
    if (m) {
      sessionStorage.setItem("kiln:newtask", m[1]);
      setText("");
      onClose();
      go("/new");
      return;
    }
    setText("");
    setBusy(true);
    await act(() => post(`/api/p/${pid}/chat`, { text: t }));
    setBusy(false);
  };

  return (
    <section className={`pop${open ? "" : " shut"}`} aria-label="Chat" aria-hidden={!open}
      style={{ position: "fixed", left: "calc(var(--rail) + 24px)", bottom: 24, width: 400, borderColor: "var(--lilac)", maxHeight: "min(620px, 80vh)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ color: "var(--lilac)", fontSize: 22, fontWeight: 700, letterSpacing: ".06em" }}>CHAT</span>
        <span style={{ flex: 1, height: 10, background: "var(--lilac)" }} />
        <Pill tone="dim" sm onClick={() => act(() => post(`/api/p/${pid}/chat/reset`)).then(() => setChat({ sessionId: null, messages: [] }))} title="Start a new conversation">New</Pill>
        <Pill tone="lilac" sm onClick={onClose} ariaLabel="Minimise chat">–</Pill>
      </div>
      <div className="panelbody thin-scroll" style={{ overflowY: "auto", flex: 1, minHeight: 60 }}>
        {!chat?.messages.length && <span className="lbl" style={{ color: "var(--muted)" }}>Ask about the project or the factory. Actions it proposes need your click.</span>}
        {chat?.messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} style={{ alignSelf: "flex-end", background: "var(--chip)", borderRadius: "14px 14px 0 14px", padding: "6px 10px", fontSize: 15, maxWidth: "85%" }}>{m.text}</div>
          ) : (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <Md text={m.text} style={{ fontSize: 15, lineHeight: 1.35 }} />
              {!!m.actions?.length && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {m.actions.map((a) =>
                    a.status ? (
                      <span key={a.id} className="tag" style={{ background: "var(--chip)", color: a.status === "done" ? "var(--sky)" : "var(--muted)" }}>{a.label} · {a.status}</span>
                    ) : (
                      <span key={a.id} style={{ display: "inline-flex", gap: 2 }}>
                        <Pill tone="lilac" sm onClick={() => {
                          if (a.kind === "open") { go(String(a.args.path ?? "/board").replace(/^\/tasks\//, "/task/")); onClose(); }
                          void act(() => post(`/api/p/${pid}/chat/actions/${a.id}`));
                        }}>{a.label}</Pill>
                        <Pill tone="dim" sm ariaLabel={`Dismiss ${a.label}`} onClick={() => act(() => post(`/api/p/${pid}/chat/actions/${a.id}`, { dismiss: true }))}>×</Pill>
                      </span>
                    ),
                  )}
                </div>
              )}
            </div>
          ),
        )}
        {busy && <span className="lbl" style={{ color: "var(--lilac)" }}>Thinking<span className="cursor" style={{ background: "var(--lilac)", marginLeft: 6 }} /></span>}
        <div ref={end} />
      </div>
      <form style={{ display: "flex", gap: 4, paddingTop: 8 }} onSubmit={(e) => (e.preventDefault(), void send())}>
        <label style={{ flex: 1, minWidth: 0, display: "flex" }}>
          <span style={{ position: "absolute", left: -9999 }}>Message</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="ASK, DIRECT AN AGENT, OR NEW TASK: …"
            style={{ flex: 1, minWidth: 0, background: "var(--panel)", border: "1px solid var(--lilac)", borderRadius: "999px 0 0 999px", color: "var(--ink)", font: "15px Antonio, sans-serif", letterSpacing: ".04em", padding: "8px 12px", minHeight: 40 }} />
        </label>
        <Pill tone="lilac" type="submit" busy={busy} style={{ borderRadius: "0 999px 999px 0" }}>Send</Pill>
      </form>
    </section>
  );
}
