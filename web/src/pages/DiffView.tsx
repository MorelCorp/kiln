import { Fragment, memo, useCallback, useMemo, useState } from "react";
import { defaultCollapsed, diffTotals, fileKey, isGenerated, lineCount, parseDiff, splitRows, type DiffFile, type DiffHunk, type DiffLine, type FileStatus } from "../diff.ts";
import { Empty, Pill, Tag } from "../ui.tsx";
import type { Tone } from "../api.ts";

type Mode = "unified" | "split";
const MODE_KEY = "kiln.diff.mode";

const readMode = (): Mode => {
  try {
    return localStorage.getItem(MODE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
};

const STATUS: Record<FileStatus, { letter: string; tone: Tone; label: string }> = {
  added: { letter: "A", tone: "sky", label: "added" },
  deleted: { letter: "D", tone: "salmon", label: "deleted" },
  modified: { letter: "M", tone: "gold", label: "modified" },
  renamed: { letter: "R", tone: "lavender", label: "renamed" },
  copied: { letter: "C", tone: "lilac", label: "copied" },
};

const anchor = (i: number) => `kiln-diff-file-${i}`;

/** A GitHub-style diff browser: summary, file list, collapsible files, unified or split mode. */
export function DiffView({ text }: { text: string }) {
  const files = useMemo(() => parseDiff(text), [text]);
  const totals = useMemo(() => diffTotals(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => defaultCollapsed(files));
  const [seenText, setSeenText] = useState(text);
  const [mode, setModeState] = useState<Mode>(readMode);
  const [active, setActive] = useState<string | null>(null);
  if (seenText !== text) {
    // New diff (e.g. the agent pushed again): reset the default collapsing.
    setSeenText(text);
    setCollapsed(defaultCollapsed(files));
  }

  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* private mode: keep it for this page only */
    }
  };
  // Stable, so a toggle only re-renders the file it touches.
  const toggle = useCallback(
    (k: string) =>
      setCollapsed((c) => {
        const n = new Set(c);
        if (n.has(k)) n.delete(k);
        else n.add(k);
        return n;
      }),
    [],
  );
  const select = (f: DiffFile, i: number) => {
    const k = fileKey(f);
    setActive(k);
    setCollapsed((c) => {
      if (!c.has(k)) return c;
      const n = new Set(c);
      n.delete(k);
      return n;
    });
    requestAnimationFrame(() => document.getElementById(anchor(i))?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  if (!files.length) return <Empty>No changes yet.</Empty>;

  return (
    <div className="dv">
      <div className="dv-sum">
        <span className="lbl" style={{ color: "var(--peach)" }}>
          {totals.files} file{totals.files === 1 ? "" : "s"} changed
        </span>
        <span className="num dv-add">+{totals.additions}</span>
        <span className="num dv-del">−{totals.deletions}</span>
        <Bar add={totals.additions} del={totals.deletions} />
        <span style={{ flex: 1 }} />
        <Pill tone="dim" sm onClick={() => setCollapsed(new Set())}>Expand all</Pill>
        <Pill tone="dim" sm onClick={() => setCollapsed(new Set(files.map(fileKey)))}>Collapse all</Pill>
        <div className="seg" role="radiogroup" aria-label="Diff layout" style={{ minWidth: 180 }}>
          {(["unified", "split"] as Mode[]).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="dv-body">
        <nav className="dv-files thin-scroll" aria-label="Changed files">
          {files.map((f, i) => {
            const k = fileKey(f);
            const s = STATUS[f.status];
            return (
              <button key={k} className={`dv-fi${active === k ? " on" : ""}`} onClick={() => select(f, i)} title={label(f)}>
                <span className="dv-st" style={{ background: `var(--${s.tone})` }} aria-label={s.label}>{s.letter}</span>
                <span className="dv-fn">
                  <span className="dv-dir">{dir(f.path)}</span>
                  {base(f.path)}
                </span>
                <span className="dv-n">
                  {f.binary ? <span style={{ color: "var(--muted)" }}>bin</span> : (
                    <>
                      {f.additions > 0 && <span className="dv-add">+{f.additions}</span>}
                      {f.deletions > 0 && <span className="dv-del">−{f.deletions}</span>}
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </nav>

        <div className="dv-main">
          {files.map((f, i) => {
            const k = fileKey(f);
            return <FileBox key={k} f={f} id={anchor(i)} open={!collapsed.has(k)} onToggle={toggle} mode={mode} active={active === k} />;
          })}
        </div>
      </div>
    </div>
  );
}

function Bar({ add, del }: { add: number; del: number }) {
  const total = add + del;
  const a = total ? Math.round((add / total) * 5) : 0;
  return (
    <span className="dv-bar" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} style={{ background: !total ? "var(--chip)" : i < a ? "#6fcf6f" : "var(--salmon)" }} />
      ))}
    </span>
  );
}

const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const label = (f: DiffFile) => (f.status === "renamed" || f.status === "copied" ? `${f.oldPath} → ${f.newPath}` : f.path);

const FileBox = memo(function FileBox({ f, id, open, onToggle: toggle, mode, active }: { f: DiffFile; id: string; open: boolean; onToggle: (k: string) => void; mode: Mode; active: boolean }) {
  const onToggle = () => toggle(fileKey(f));
  const s = STATUS[f.status];
  const n = lineCount(f);
  const why = isGenerated(f.path) ? "generated file" : f.status === "deleted" ? "deleted file" : n > 0 ? `${n} lines` : "";
  return (
    <section id={id} className={`dv-file${active ? " on" : ""}`} aria-label={label(f)}>
      <button className="dv-fh" onClick={onToggle} aria-expanded={open}>
        <span className="dv-chev" aria-hidden>{open ? "▾" : "▸"}</span>
        <Tag tone={s.tone}>{s.label}{f.similarity !== undefined && f.status !== "modified" ? ` ${f.similarity}%` : ""}</Tag>
        <span className="dv-path">
          {f.status === "renamed" || f.status === "copied" ? (
            <>
              <span style={{ color: "var(--muted)" }}>{f.oldPath}</span> → {f.newPath}
            </>
          ) : (
            f.path
          )}
        </span>
        {f.oldMode && f.newMode && <span className="dv-meta">{f.oldMode} → {f.newMode}</span>}
        <span style={{ flex: 1 }} />
        {!f.binary && (
          <span className="dv-n">
            <span className="dv-add">+{f.additions}</span>
            <span className="dv-del">−{f.deletions}</span>
          </span>
        )}
      </button>
      {open ? (
        <div className="dv-code thin-scroll">
          {f.binary ? (
            <div className="dv-note">Binary file{f.status === "added" ? " added" : f.status === "deleted" ? " deleted" : " changed"}: not shown.</div>
          ) : !f.hunks.length ? (
            <div className="dv-note">
              {f.status === "renamed" ? "File renamed without changes." : f.status === "copied" ? "File copied without changes." : f.oldMode ? "File mode changed." : f.status === "added" ? "Empty file added." : f.status === "deleted" ? "Empty file deleted." : "No content changes."}
            </div>
          ) : mode === "split" ? (
            <SplitTable hunks={f.hunks} />
          ) : (
            <UnifiedTable hunks={f.hunks} />
          )}
        </div>
      ) : (
        <button className="dv-note dv-load" onClick={onToggle}>
          Collapsed{why ? ` · ${why}` : ""} · show diff
        </button>
      )}
    </section>
  );
});

function Code({ l }: { l: DiffLine }) {
  return (
    <>
      {l.text || " "}
      {l.noNewline && <span className="dv-eof" title="No newline at end of file">⊘</span>}
    </>
  );
}

const sign = (l: DiffLine) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ");

function HunkRow({ h, span }: { h: DiffHunk; span: number }) {
  return (
    <tr className="dv-hunk">
      <td colSpan={span}>
        @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@{h.section ? <span className="dv-sec"> {h.section}</span> : null}
      </td>
    </tr>
  );
}

function UnifiedTable({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <table className="dv-t">
      <colgroup>
        <col className="dv-ln" />
        <col className="dv-ln" />
        <col />
      </colgroup>
      <tbody>
        {hunks.map((h, hi) => (
          <Fragment key={hi}>
            <HunkRow h={h} span={3} />
            {h.lines.map((l, i) => (
              <tr key={i} className={l.kind}>
                <td className="dv-num">{l.old ?? ""}</td>
                <td className="dv-num">{l.new ?? ""}</td>
                <td className="dv-src">
                  <span className="dv-sign">{sign(l)}</span>
                  <Code l={l} />
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function SplitTable({ hunks }: { hunks: DiffHunk[] }) {
  const side = (l: DiffLine | undefined, n: number | undefined) =>
    l ? (
      <>
        <td className={`dv-num ${l.kind}`}>{n ?? ""}</td>
        <td className={`dv-src ${l.kind}`}>
          <span className="dv-sign">{sign(l)}</span>
          <Code l={l} />
        </td>
      </>
    ) : (
      <>
        <td className="dv-num dv-void" />
        <td className="dv-src dv-void" />
      </>
    );
  return (
    <table className="dv-t split">
      <colgroup>
        <col className="dv-ln" />
        <col />
        <col className="dv-ln" />
        <col />
      </colgroup>
      <tbody>
        {hunks.map((h, hi) => (
          <Fragment key={hi}>
            <HunkRow h={h} span={4} />
            {splitRows(h.lines).map((r, i) => (
              <tr key={i}>
                {side(r.left, r.left?.old)}
                {side(r.right, r.right?.new)}
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
