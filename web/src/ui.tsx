import { Component, createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { AppState, Effort, Tier, Tone } from "./api.ts";
import { EFFORTS, EFFORT_LABEL, TIERS, TIER_LABEL } from "./api.ts";

export const TONE: Record<Tone, string> = {
  orange: "var(--orange)", peach: "var(--peach)", lavender: "var(--lavender)", lilac: "var(--lilac)",
  salmon: "var(--salmon)", gold: "var(--gold)", sky: "var(--sky)", red: "var(--red)", dim: "var(--chip)",
};

// ---- error boundary ------------------------------------------------------------------------

export class ErrorBoundary extends Component<{ children: ReactNode; inline?: boolean }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("Kiln UI crashed:", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" style={{ padding: this.props.inline ? 8 : 40, display: "flex", flexDirection: "column", gap: 10, maxWidth: 900 }}>
        <b style={{ color: "var(--red)", fontSize: 22, letterSpacing: ".06em" }}>DISPLAY FAULT</b>
        <pre className="log" style={{ whiteSpace: "pre-wrap" }}>{String(this.state.error.stack ?? this.state.error.message)}</pre>
        <div style={{ display: "flex", gap: 6 }}>
          <Pill tone="orange" onClick={() => this.setState({ error: null })}>Try again</Pill>
          <Pill tone="dim" onClick={() => window.location.reload()}>Reload</Pill>
        </div>
      </div>
    );
  }
}

// ---- router (hash based, no dependency) --------------------------------------------------

export function useRoute(): string[] {
  const get = () => (window.location.hash.replace(/^#\/?/, "") || "board").split("/").filter(Boolean);
  const [r, setR] = useState(get);
  useEffect(() => {
    const on = () => setR(get());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

export const go = (path: string) => {
  window.location.hash = path.startsWith("#") ? path : `#${path}`;
};

// ---- app context ---------------------------------------------------------------------------

export interface Toast {
  id: number;
  text: string;
  level: "info" | "error";
}

export interface AppCtx {
  state: AppState;
  pid: string;
  reloadState: () => void;
  toast: (text: string, level?: "info" | "error") => void;
  /** Runs an async action, toasting errors. Returns its result or undefined. */
  act: <T>(fn: () => Promise<T>, ok?: string) => Promise<T | undefined>;
}

export const Ctx = createContext<AppCtx | null>(null);
export const useApp = () => useContext(Ctx)!;

// ---- primitives -------------------------------------------------------------------------------

export function Pill(props: {
  tone?: Tone; children: ReactNode; onClick?: () => void; href?: string; sm?: boolean; disabled?: boolean;
  title?: string; style?: CSSProperties; busy?: boolean; type?: "button" | "submit"; ariaLabel?: string; className?: string;
}) {
  const style: CSSProperties = {
    background: props.tone === "dim" ? "var(--chip)" : TONE[props.tone ?? "orange"],
    color: props.tone === "dim" ? "var(--peach)" : undefined,
    ...props.style,
  };
  const cls = `pill${props.sm ? " sm" : ""}${props.className ? ` ${props.className}` : ""}`;
  if (props.href) {
    return (
      <a className={cls} href={props.href} style={style} title={props.title} aria-label={props.ariaLabel}
        target={props.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
        {props.children}
      </a>
    );
  }
  return (
    <button type={props.type ?? "button"} className={cls} style={style} onClick={props.onClick}
      disabled={props.disabled || props.busy} title={props.title} aria-label={props.ariaLabel}>
      {props.busy ? "…" : props.children}
    </button>
  );
}

export function Tag({ tone = "orange", children, style }: { tone?: Tone; children: ReactNode; style?: CSSProperties }) {
  return (
    <span className="tag" style={{ background: TONE[tone], color: tone === "dim" ? "var(--lavender)" : "#000", ...style }}>
      {children}
    </span>
  );
}

export function Sec({ tone = "orange", children, right }: { tone?: Tone; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="sec">
      <div className="bar" style={{ background: TONE[tone], flex: "0 0 26px", borderRadius: "13px 0 0 13px", height: 26 }} />
      <b style={{ color: TONE[tone] }}>{children}</b>
      <div className="bar" style={{ background: TONE[tone], borderRadius: 0 }} />
      {right}
    </div>
  );
}

export function TierSeg({ value, dflt, onChange, hot }: { value: Tier | null; dflt?: Tier; onChange: (t: Tier) => void; hot?: boolean }) {
  return (
    <div className={`seg${hot ? " hot" : ""}`} role="radiogroup" aria-label="Model">
      {TIERS.map((t) => (
        <button key={t} role="radio" aria-checked={value === t} className={`${value === t ? "on" : ""} ${dflt === t ? "dflt" : ""}`} onClick={() => onChange(t)}>
          {TIER_LABEL[t]}
        </button>
      ))}
    </div>
  );
}

export function EffortSeg({ value, dflt, onChange, hot }: { value: Effort | null; dflt?: Effort; onChange: (e: Effort) => void; hot?: boolean }) {
  return (
    <div className={`seg${hot ? " hot" : ""}`} role="radiogroup" aria-label="Effort">
      {EFFORTS.map((e) => (
        <button key={e} role="radio" aria-checked={value === e} className={`${value === e ? "on" : ""} ${dflt === e ? "dflt" : ""}`} onClick={() => onChange(e)}>
          {EFFORT_LABEL[e]}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="lbl" style={{ color: "var(--muted)", padding: "8px 0" }}>{children}</div>;
}

export function Loading({ error }: { error?: string | null }) {
  return (
    <div className="lbl" style={{ color: error ? "var(--redsoft)" : "var(--lavender)", padding: 12 }}>
      {error ? `Error: ${error}` : "Loading…"}
    </div>
  );
}

/** Very small markdown: headings, bullets, code spans, bold. Keeps text safe (no HTML injection). */
export function Md({ text, style }: { text: unknown; style?: CSSProperties }) {
  const lines = (typeof text === "string" ? text : text == null ? "" : JSON.stringify(text)).split("\n");
  return (
    <div className="md" style={{ whiteSpace: "normal", display: "flex", flexDirection: "column", gap: 4, ...style }}>
      {lines.map((l, i) => {
        const h = l.match(/^(#{1,4})\s+(.*)$/);
        if (h) return <div key={i} style={{ color: "var(--peach)", fontWeight: 700, letterSpacing: ".05em", marginTop: 6, textTransform: "uppercase", fontSize: 16 }}>{inline(h[2])}</div>;
        const b = l.match(/^(\s*)[-*]\s+(\[[ xX]\]\s+)?(.*)$/);
        if (b) return <div key={i} style={{ paddingLeft: 10 + b[1].length * 6, display: "flex", gap: 6 }}><span style={{ color: "var(--orange)" }}>{b[2] ? (b[2].includes("x") || b[2].includes("X") ? "☑" : "☐") : "▸"}</span><span>{inline(b[3])}</span></div>;
        if (!l.trim()) return <div key={i} style={{ height: 4 }} />;
        return <div key={i}>{inline(l)}</div>;
      })}
    </div>
  );
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let k = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push(s.slice(last, m.index));
    const t = m[0];
    out.push(
      t.startsWith("`") ? (
        <code key={k++} style={{ background: "var(--chip)", borderRadius: 6, padding: "0 5px", fontFamily: "ui-monospace, monospace", fontSize: "0.85em" }}>{t.slice(1, -1)}</code>
      ) : (
        <b key={k++}>{t.slice(2, -2)}</b>
      ),
    );
    last = m.index! + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 style={{ margin: 0, fontSize: "clamp(24px, 3vw, 34px)", color: "var(--orange)", letterSpacing: ".03em", textTransform: "uppercase", lineHeight: 1.05 }}>{children}</h1>;
}
