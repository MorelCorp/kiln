import { useEffect, useRef, useState } from "react";
import { elapsed, post, useApi, type IssueThread } from "../api.ts";
import { Loading, Md, Pill, Sec, Tag, useApp } from "../ui.tsx";
import { KCOLOR, PHASE_LABEL } from "./Task.tsx";

/** Small GitHub mark that opens the issue in a new tab. Sits in the top right of a card or the modal header. */
export function GithubLink({ url, label, style }: { url: string; label: string; style?: React.CSSProperties }) {
  if (!url.startsWith("http")) return null;
  return (
    <a className="ghlink" href={url} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label={label} style={style}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
      </svg>
    </a>
  );
}

type CloseReason = "completed" | "not planned";

/** "Close issue" under the description: opens a box for a closing comment and GitHub's close reason. */
function CloseIssue({ number, live, onClosed }: { number: number; live: boolean; onClosed: () => void }) {
  const { pid, act } = useApp();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState<CloseReason>("completed");
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) ta.current?.focus();
  }, [open]);

  if (!open) {
    return <Pill tone="red" sm onClick={() => setOpen(true)} style={{ alignSelf: "flex-start" }}>Close issue</Pill>;
  }
  const submit = async () => {
    setBusy(true);
    const r = await act(() => post(`/api/p/${pid}/tasks/${number}/close`, { comment, reason }), `#${number} closed`);
    setBusy(false);
    if (r !== undefined) {
      setOpen(false);
      setComment("");
      onClosed();
    }
  };
  return (
    <div role="group" aria-label={`Close issue #${number}`} style={{ display: "flex", flexDirection: "column", gap: 8, borderLeft: "6px solid var(--red)", padding: "8px 10px", background: "var(--panel)", borderRadius: "0 12px 12px 0" }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="lbl" style={{ color: "var(--redsoft)" }}>Closing comment · optional, posted on the issue</span>
        <textarea ref={ta} className="ta" rows={3} value={comment} onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void submit()} placeholder="Why is it closed?" />
      </label>
      <div className="seg" role="radiogroup" aria-label="Close reason" style={{ alignSelf: "flex-start" }}>
        {(["completed", "not planned"] as const).map((r) => (
          <button key={r} type="button" role="radio" aria-checked={reason === r} className={reason === r ? "on" : ""} style={{ padding: "6px 14px" }} onClick={() => setReason(r)}>{r}</button>
        ))}
      </div>
      {live && <span className="lbl" style={{ color: "var(--redsoft)" }}>An agent is working on it: closing stops the run.</span>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Pill tone="red" busy={busy} onClick={submit}>Close issue</Pill>
        <Pill tone="dim" onClick={() => setOpen(false)} disabled={busy}>Cancel</Pill>
      </div>
    </div>
  );
}

/** Issue detail over the board: body, comments, Kiln's task state, log and PR. The board stays mounted underneath. */
export function IssueModal({ number, title, url, onClose }: { number: number; title: string; url: string; onClose: () => void }) {
  const { pid } = useApp();
  const [d, err, reload] = useApi<IssueThread>(`/api/p/${pid}/tasks/${number}/thread`, ["task", "run", "board"], 700);
  const box = useRef<HTMLDivElement>(null);

  // Escape closes; focus moves into the dialog and returns to the card that opened it.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") (e.stopPropagation(), onClose());
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      prev?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  const task = d?.task ?? null;
  const live = !!d?.current?.live;
  const ghUrl = d?.issue.url ?? url;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="modal" role="dialog" aria-modal="true" aria-label={`Issue #${number}`} tabIndex={-1}>
        <header className="modal-head">
          <span className="num" style={{ color: "var(--sky)", fontSize: 24 }}>#{number}</span>
          <h2 style={{ margin: 0, fontSize: 22, color: "var(--orange)", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{d?.issue.title ?? title}</h2>
          <GithubLink url={ghUrl} label={`Open issue #${number} on GitHub`} />
          <button type="button" className="modal-x" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="modal-body thin-scroll">
          {!d ? <Loading error={err} /> : (
            <>
              <section aria-label="Kiln state" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Sec tone="sky">Kiln</Sec>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  <Tag tone={live ? "sky" : task ? "gold" : "dim"}>{task ? PHASE_LABEL[task.phase] ?? task.phase : "not picked up"}</Tag>
                  {task && <Tag tone={task.risk === "required" ? "red" : "sky"}>{task.risk === "required" ? "review" : "auto"}</Tag>}
                  {d.issue.state === "CLOSED" && <Tag tone="dim">closed</Tag>}
                  {task?.prUrl?.startsWith("http") && <Pill tone="dim" sm href={task.prUrl}>PR</Pill>}
                  <Pill tone="dim" sm href={`#/task/${number}`}>Full task page</Pill>
                </div>
                {task && (
                  <div className="lbl" style={{ color: "var(--lavender)" }}>
                    {task.branch}
                    {d.current ? ` · ${d.current.kind}${live ? ` · ${elapsed(d.current.startedAt)} elapsed` : ` · ${d.current.status}`}` : ""}
                  </div>
                )}
                {task?.question && <div style={{ background: "#1a0c0b", borderLeft: "6px solid var(--red)", padding: "6px 10px", borderRadius: "0 12px 12px 0" }}><Md text={task.question} /></div>}
                {task?.note && !live && <div style={{ borderLeft: "6px solid var(--gold)", padding: "6px 10px", background: "var(--panel)", borderRadius: "0 12px 12px 0" }}><Md text={task.note} /></div>}
                <div className="thin-scroll" style={{ maxHeight: 180, overflowY: "auto" }} aria-label="Log">
                  {!d.events.length && <div className="lbl" style={{ color: "var(--muted)" }}>No log yet.</div>}
                  {d.events.map((e, i) => (
                    <div className="ev" key={i}>
                      <span className="t">{new Date(e.t).toLocaleTimeString([], { hour12: false })}</span>
                      <span className="k" style={{ color: KCOLOR[e.k] ?? "var(--peach)" }}>{e.k}</span>
                      <span className="x">{e.text.split("\n").slice(0, 3).join("\n")}</span>
                    </div>
                  ))}
                </div>
              </section>
              <section aria-label="Issue body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Sec tone="orange">Issue</Sec>
                <Md text={d.issue.body || "(no description)"} />
                {d.issue.state !== "CLOSED" && <CloseIssue number={number} live={live} onClosed={reload} />}
              </section>
              <section aria-label="Comments" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Sec tone="lavender">Comments · {d.issue.comments.length}</Sec>
                {!d.issue.comments.length && <div className="lbl" style={{ color: "var(--muted)" }}>No comments.</div>}
                {d.issue.comments.map((c, i) => (
                  <div key={i} style={{ borderLeft: "4px solid var(--lavender)", paddingLeft: 10, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span className="lbl" style={{ color: "var(--lavender)" }}>{c.author} · {new Date(c.at).toLocaleString()}</span>
                    <Md text={c.body} />
                  </div>
                ))}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
