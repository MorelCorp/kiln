// Pure unified-diff parsing for the Review page's diff view. No DOM, no React: unit tested in test/diff.test.ts.
// Handles `git diff` output (renames, copies, mode changes, binary files, "\ No newline at end of file")
// and falls back to plain `---`/`+++` unified diffs.

export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  /** Line number in the old file (context and deleted lines). */
  old?: number;
  /** Line number in the new file (context and added lines). */
  new?: number;
  /** Followed by "\ No newline at end of file". */
  noNewline?: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the closing @@ (usually the enclosing function). */
  section: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  /** The path to show: the new path, or the old one for a deleted file. */
  path: string;
  status: FileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  similarity?: number;
  oldMode?: string;
  newMode?: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Removes git's C-style quoting from a path, if any. */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      for (const b of new TextEncoder().encode(c)) bytes.push(b);
      continue;
    }
    const n = body[i + 1];
    if (/[0-7]/.test(n ?? "")) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(esc[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** `a/foo` → `foo`; `/dev/null` stays as is. Also drops the tab-separated timestamp of plain diffs. */
function stripPrefix(p: string): string {
  const s = unquote(p.split("\t")[0].trim());
  if (s === "/dev/null") return s;
  return s.replace(/^[ab]\//, "");
}

/** Best effort split of `diff --git a/x b/y` into both paths (ambiguous only with spaces and renames). */
function gitHeaderPaths(rest: string): [string, string] {
  if (rest.startsWith('"')) {
    const m = rest.match(/^("(?:[^"\\]|\\.)*")\s+(.*)$/);
    if (m) return [stripPrefix(m[1]), stripPrefix(m[2])];
  }
  // Same path on both sides (the common case): "a/<p> b/<p>".
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.startsWith("a/") && rest.slice(half + 1).startsWith("b/") && rest.slice(2, half) === rest.slice(half + 3)) {
    return [rest.slice(2, half), rest.slice(half + 3)];
  }
  const i = rest.indexOf(" b/");
  if (i > 0) return [stripPrefix(rest.slice(0, i)), stripPrefix(rest.slice(i + 1))];
  return [stripPrefix(rest), stripPrefix(rest)];
}

function newFile(oldPath = "", newPath = ""): DiffFile {
  return { oldPath, newPath, path: newPath || oldPath, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
}

function finish(f: DiffFile): DiffFile {
  if (f.oldPath === "/dev/null") f.status = "added";
  if (f.newPath === "/dev/null") f.status = "deleted";
  if (f.status === "added") f.oldPath = f.oldPath === "/dev/null" ? f.newPath : f.oldPath;
  if (f.status === "deleted") f.newPath = f.newPath === "/dev/null" ? f.oldPath : f.newPath;
  if (f.status === "modified" && f.oldPath && f.newPath && f.oldPath !== f.newPath) f.status = "renamed";
  f.path = f.status === "deleted" ? f.oldPath : f.newPath || f.oldPath;
  return f;
}

/** Parses a unified diff (as printed by `git diff`) into files and hunks. Empty input gives []. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let h: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  const push = () => {
    if (f) files.push(finish(f));
    f = null;
    h = null;
  };
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
    const cur = f as DiffFile | null;
    const hunk = h as DiffHunk | null;

    // Inside a hunk, its line counts decide where it ends.
    if (cur && hunk && (oldLeft > 0 || newLeft > 0)) {
      const c = l[0];
      if (c === "+") {
        hunk.lines.push({ kind: "add", text: l.slice(1), new: newNo++ });
        cur.additions++;
        newLeft--;
        continue;
      }
      if (c === "-") {
        hunk.lines.push({ kind: "del", text: l.slice(1), old: oldNo++ });
        cur.deletions++;
        oldLeft--;
        continue;
      }
      if (c === " " || l === "") {
        hunk.lines.push({ kind: "ctx", text: l.slice(1), old: oldNo++, new: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (c === "\\") {
        const last = hunk.lines[hunk.lines.length - 1];
        if (last) last.noNewline = true;
        continue;
      }
      // Anything else: the hunk was truncated; fall through and parse the line normally.
      oldLeft = newLeft = 0;
    }
    if (l.startsWith("\\")) {
      const last = hunk?.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }

    if (l.startsWith("diff --git ")) {
      push();
      const [a, b] = gitHeaderPaths(l.slice(11));
      f = newFile(a, b);
      continue;
    }
    const m = HUNK_RE.exec(l);
    if (m && cur) {
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      h = { header: l, oldStart: Number(m[1]), oldLines, newStart: Number(m[3]), newLines, section: m[5] ?? "", lines: [] };
      cur.hunks.push(h);
      oldLeft = oldLines;
      newLeft = newLines;
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      continue;
    }
    if (l.startsWith("--- ") && (!cur || cur.hunks.length > 0) && lines[i + 1]?.startsWith("+++ ")) {
      // A plain unified diff without a `diff --git` line.
      push();
      f = newFile(stripPrefix(l.slice(4)), stripPrefix(lines[i + 1].slice(4)));
      i++;
      continue;
    }
    if (!cur) continue;
    if (l.startsWith("--- ")) cur.oldPath = stripPrefix(l.slice(4));
    else if (l.startsWith("+++ ")) cur.newPath = stripPrefix(l.slice(4));
    else if (l.startsWith("new file mode ")) {
      cur.status = "added";
      cur.newMode = l.slice(14);
    } else if (l.startsWith("deleted file mode ")) {
      cur.status = "deleted";
      cur.oldMode = l.slice(18);
    } else if (l.startsWith("old mode ")) cur.oldMode = l.slice(9);
    else if (l.startsWith("new mode ")) cur.newMode = l.slice(9);
    else if (l.startsWith("rename from ")) {
      cur.status = "renamed";
      cur.oldPath = unquote(l.slice(12));
    } else if (l.startsWith("rename to ")) {
      cur.status = "renamed";
      cur.newPath = unquote(l.slice(10));
    } else if (l.startsWith("copy from ")) {
      cur.status = "copied";
      cur.oldPath = unquote(l.slice(10));
    } else if (l.startsWith("copy to ")) {
      cur.status = "copied";
      cur.newPath = unquote(l.slice(8));
    } else if (l.startsWith("similarity index ")) cur.similarity = parseInt(l.slice(17), 10);
    else if (l.startsWith("Binary files ") || l === "GIT binary patch") cur.binary = true;
  }
  push();
  return files;
}

export interface DiffTotals {
  files: number;
  additions: number;
  deletions: number;
}

export function diffTotals(files: DiffFile[]): DiffTotals {
  return files.reduce((t, f) => ({ files: t.files + 1, additions: t.additions + f.additions, deletions: t.deletions + f.deletions }), { files: 0, additions: 0, deletions: 0 });
}

/** One row of the side-by-side view: a left (old) and/or right (new) line. */
export interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
}

/** Pairs a hunk's lines for the split view: context on both sides, each run of deletions next to the additions that follow it. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === "ctx") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k], right: adds[k] });
  }
  return rows;
}

const GENERATED = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|uv\.lock)$/,
  /(^|\/)(dist|build|vendor|node_modules|__generated__|generated)\//,
  /\.(min\.js|min\.css|map|snap|pb\.go)$/,
  /(_generated|\.generated|\.g)\.[a-z]+$/,
];

/** Lockfiles, build output, minified and generated sources: noise for a reviewer. */
export function isGenerated(path: string): boolean {
  return GENERATED.some((re) => re.test(path));
}

/** A file with more changed lines than this starts collapsed. */
export const LARGE_FILE_LINES = 400;
/** Once this many lines are expanded on the page, further files start collapsed so huge diffs stay responsive. */
export const PAGE_LINE_BUDGET = 3000;

export const lineCount = (f: DiffFile) => f.hunks.reduce((n, h) => n + h.lines.length, 0);

/** Which files start collapsed: generated, large, binary-free deletions, and anything past the page budget. Returns paths. */
export function defaultCollapsed(files: DiffFile[]): Set<string> {
  const out = new Set<string>();
  let shown = 0;
  for (const f of files) {
    const n = lineCount(f);
    if (isGenerated(f.path) || n > LARGE_FILE_LINES || f.status === "deleted" || shown + n > PAGE_LINE_BUDGET) out.add(fileKey(f));
    else shown += n;
  }
  return out;
}

/** Stable key/anchor for a file within a diff. */
export const fileKey = (f: DiffFile) => `${f.oldPath}\u0000${f.newPath}`;
