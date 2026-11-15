import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { KILN_ROOT, loadRules } from "../config.ts";
import type { BusEvent, Factory } from "../factory/factory.ts";
import { probeEnvs, deploy, cachedEnvs } from "../factory/envs.ts";
import { worktreePath } from "../factory/gate.ts";
import { git } from "../tasks/source.ts";
import * as assist from "../factory/assist.ts";
import { boardView, inboxView, runSummary, tokensView, tierName } from "./views.ts";
import type { RunEvent } from "../runs/stream.ts";
import { readIssueThread } from "./thread.ts";

const WEB_DIST = join(KILN_ROOT, "web", "dist");
const VERSION = JSON.parse(readFileSync(join(KILN_ROOT, "package.json"), "utf8")).version ?? "0.1.0";

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Handler = (ctx: { f: Factory; params: Record<string, string>; body: any; query: URLSearchParams }) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

const routes: { method: string; re: RegExp; keys: string[]; h: Handler }[] = [];
function route(method: string, path: string, h: Handler) {
  const keys: string[] = [];
  const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, re, keys, h });
}

const num = (s: string) => {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new HttpError(400, `Bad number ${s}`);
  return n;
};

function readEvents(path: string, limit = 1500): RunEvent[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l) as RunEvent);
}

// ---- state ---------------------------------------------------------------------

route("GET", "/api/state", ({ f }) => {
  const p = f.project();
  return {
    version: VERSION,
    activeProject: f.cfg.activeProject,
    projects: f.cfg.projects.map((x) => ({ id: x.id, name: x.name, repo: x.repo, source: x.source ?? "github" })),
    pace: f.cfg.pace,
    hold: f.holdReason() ?? null,
    usage: f.ledger.lastUsage() ?? null,
    rate: f.liveRate(),
    tiers: Object.fromEntries((["small", "medium", "large"] as const).map((t) => [t, { name: tierName(t), model: f.provider(p).modelFor(t) }])),
  };
});

route("POST", "/api/project/active", ({ f, body }) => (f.setActiveProject(String(body.id)), { ok: true }));
route("PATCH", "/api/pace", ({ f, body }) => (f.setPace(body), f.cfg.pace));

// ---- board / inbox / runs ---------------------------------------------------------

route("GET", "/api/p/:pid/board", async ({ f, params }) => {
  const p = f.project(params.pid);
  await f.syncBoard(p.id);
  if (!cachedEnvs(p)) await probeEnvs(f, p).catch(() => undefined);
  return boardView(f, p);
});

route("POST", "/api/p/:pid/sync", async ({ f, params }) => {
  const p = f.project(params.pid);
  await Promise.all([f.syncBoard(p.id, true), probeEnvs(f, p, true).catch(() => undefined)]);
  return boardView(f, p);
});

route("GET", "/api/p/:pid/inbox", ({ f, params }) => inboxView(f, f.project(params.pid)));

route("GET", "/api/p/:pid/runs", ({ f, params }) => {
  const p = f.project(params.pid);
  const live = [...f.live.values()].filter((r) => r.row.project === p.id).map((r) => f.runView(r));
  const recent = f.ledger.listRuns({ project: p.id, limit: 60 }).map((r) => runSummary(f, r));
  const waiting = f.ledger.listTasks(p.id).filter((t) => t.phase === "question");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cost = f.ledger.listRuns({ project: p.id, since: today.toISOString() }).reduce((s, r) => s + r.costUsd, 0);
  return { live, recent, waiting, costToday: cost };
});

route("GET", "/api/runs/:id/events", ({ f, params }) => {
  const live = f.live.get(params.id);
  if (live) return { events: live.events };
  const r = f.ledger.getRun(params.id);
  if (!r) throw new HttpError(404, "No such run");
  return { events: readEvents(r.logPath.replace(/\.log$/, ".jsonl")) };
});

// ---- task ----------------------------------------------------------------------------

route("GET", "/api/p/:pid/tasks/:n", async ({ f, params }) => {
  const p = f.project(params.pid);
  const n = num(params.n);
  const [issue] = await Promise.all([f.source(p).getIssue(n)]);
  const task = f.ledger.getTask(p.id, n) ?? null;
  const runs = f.ledger.listRuns({ project: p.id, number: n, limit: 30 }).map((r) => runSummary(f, r));
  const live = f.liveFor(p.id, n);
  const current = live ? f.runView(live) : runs.find((r) => r.kind !== "review") ?? runs[0] ?? null;
  const events = live ? live.events : current ? readEvents(String(current.logPath).replace(/\.log$/, ".jsonl")) : [];
  let changes: { status: string; file: string; add: number; del: number }[] = [];
  if (task) {
    const wt = worktreePath(p, task.branch);
    const cwd = existsSync(wt) ? wt : p.path;
    try {
      const base = f.source(p).baseRef();
      const ref = existsSync(wt) ? "HEAD" : task.branch;
      const stat = await git(cwd, ["diff", "--numstat", `${base}...${ref}`]);
      const names = await git(cwd, ["diff", "--name-status", `${base}...${ref}`]);
      const st = new Map(names.split("\n").filter(Boolean).map((l) => { const [s, ...rest] = l.split("\t"); return [rest[rest.length - 1], s[0]]; }));
      changes = stat.split("\n").filter(Boolean).map((l) => {
        const [a, d, file] = l.split("\t");
        return { status: st.get(file) ?? "M", file, add: Number(a) || 0, del: Number(d) || 0 };
      });
    } catch {
      /* branch not created yet */
    }
  }
  return {
    issue, task, runs, current, events, changes,
    pace: f.cfg.pace,
    rules: { riskyPaths: loadRules(p).riskyPaths },
    worktree: task ? worktreePath(p, task.branch) : null,
  };
});

// Light read for the board's detail modal: issue + comments (read-only), Kiln's task state and the log tail.
route("GET", "/api/p/:pid/tasks/:n/thread", async ({ f, params }) => {
  const p = f.project(params.pid);
  const n = num(params.n);
  const issue = await readIssueThread(f.source(p), n);
  const task = f.ledger.getTask(p.id, n) ?? null;
  const runs = f.ledger.listRuns({ project: p.id, number: n, limit: 30 }).map((r) => runSummary(f, r));
  const live = f.liveFor(p.id, n);
  const current = live ? f.runView(live) : runs.find((r) => r.kind !== "review") ?? runs[0] ?? null;
  const events = live ? live.events : current ? readEvents(String(current.logPath).replace(/\.log$/, ".jsonl"), 80) : [];
  return { issue, task, current, events: events.slice(-80) };
});

route("GET", "/api/p/:pid/tasks/:n/diff", async ({ f, params }) => {
  const p = f.project(params.pid);
  const t = f.ledger.getTask(p.id, num(params.n));
  if (!t) throw new HttpError(404, "No task");
  const wt = worktreePath(p, t.branch);
  const base = f.source(p).baseRef();
  try {
    const diff = existsSync(wt) ? await git(wt, ["diff", `${base}...HEAD`]) : await git(p.path, ["diff", `${base}...${t.branch}`]);
    return { diff };
  } catch (e) {
    return { diff: "", error: e instanceof Error ? e.message : String(e) };
  }
});

const act = (path: string, fn: (f: Factory, pid: string, n: number, body: any) => Promise<unknown> | unknown) => // eslint-disable-line @typescript-eslint/no-explicit-any
  route("POST", `/api/p/:pid/tasks/:n/${path}`, async ({ f, params, body }) => {
    const p = f.project(params.pid);
    return (await fn(f, p.id, num(params.n), body ?? {})) ?? { ok: true };
  });

act("start", (f, pid, n) => f.startTask(pid, n, true));
act("stop", (f, pid, n) => f.stop(pid, n));
act("redirect", (f, pid, n, b) => f.redirect(pid, n, String(b.message ?? ""), !!b.queue));
act("override", (f, pid, n, b) => f.override(pid, n, { model: b.model ?? null, effort: b.effort ?? null, allowExtra: b.allowExtra }, b.applyNow !== false));
act("answer", (f, pid, n, b) => f.answer(pid, n, String(b.text ?? "")));
act("approve-plan", (f, pid, n, b) => f.approvePlan(pid, n, b.note));
act("revise-plan", (f, pid, n, b) => f.revisePlan(pid, n, String(b.note ?? "")));
act("retry", (f, pid, n, b) => f.retry(pid, n, b.note));
act("human", (f, pid, n) => f.handToHuman(pid, n));
act("drop", (f, pid, n) => f.drop(pid, n));
act("approve-pr", (f, pid, n) => f.approvePr(pid, n));
act("send-back", (f, pid, n, b) => f.retry(pid, n, String(b.note ?? "Please address the review notes.")));
act("tests", (f, pid, n, b) => f.submitTests(pid, n, b.results ?? [], !!b.final));
act("triage", (f, pid, n) => assist.triageDraft(f, f.project(pid), n));

// ---- drafts / new task -------------------------------------------------------------------

route("POST", "/api/p/:pid/drafts/:id/accept", async ({ f, params, body }) => ({ number: await assist.acceptDraft(f, f.project(params.pid), num(params.id), body ?? undefined) }));
route("POST", "/api/p/:pid/drafts/:id/reject", ({ f, params }) => (assist.rejectDraft(f, num(params.id)), { ok: true }));
route("POST", "/api/p/:pid/new/questions", ({ f, params, body }) => assist.quickQuestions(f, f.project(params.pid), String(body.description ?? "")));
route("POST", "/api/p/:pid/new/draft", ({ f, params, body }) => assist.quickDraft(f, f.project(params.pid), String(body.description ?? ""), body.answers ?? []));
route("POST", "/api/p/:pid/new/create", ({ f, params, body }) => assist.createTask(f, f.project(params.pid), body));

// ---- envs ----------------------------------------------------------------------------------

route("GET", "/api/p/:pid/envs", async ({ f, params, query }) => {
  const p = f.project(params.pid);
  const view = await probeEnvs(f, p, query.get("force") === "1");
  return { ...view, deploys: f.ledger.listDeploys(p.id) };
});
route("POST", "/api/p/:pid/envs/:env/deploy", async ({ f, params }) => ({ id: await deploy(f, f.project(params.pid), params.env) }));
route("GET", "/api/p/:pid/deploys/:id/log", ({ f, params }) => {
  const d = f.ledger.listDeploys(params.pid, 100).find((x) => x.id === num(params.id));
  if (!d) throw new HttpError(404, "No deploy");
  return { log: existsSync(d.logPath) ? readFileSync(d.logPath, "utf8").slice(-100_000) : "" };
});

// ---- tokens / chat ---------------------------------------------------------------------------

route("POST", "/api/usage/probe", ({ f }) => assist.probeUsage(f, f.project()));
route("GET", "/api/tokens", ({ f, query }) => tokensView(f, query.get("project") ?? undefined));
route("GET", "/api/p/:pid/chat", ({ f, params }) => f.ledger.getChat(f.project(params.pid).id));
route("POST", "/api/p/:pid/chat", ({ f, params, body }) => assist.chat(f, f.project(params.pid), String(body.text ?? "")));
route("POST", "/api/p/:pid/chat/reset", ({ f, params }) => (f.ledger.putChat(f.project(params.pid).id, { sessionId: null, messages: [] }), { ok: true }));
route("POST", "/api/p/:pid/chat/actions/:id", ({ f, params, body }) => assist.runChatAction(f, f.project(params.pid), params.id, !!body?.dismiss));

// ---------------------------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2",
};

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Kiln API is running. The web UI is not built: run `npm run build:web` (or `npm run dev:web` for Vite).");
    return;
  }
  const url = new URL(req.url ?? "/", "http://x");
  let file = normalize(join(WEB_DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(WEB_DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, "index.html");
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  });
  createReadStream(file).pipe(res);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString();
  return s ? JSON.parse(s) : {};
}

/** Changes every time the daemon starts: a page that sees a new one reloads (new code, fresh state). */
const BOOT_ID = randomUUID();

export function startServer(f: Factory, port: number) {
  const clients = new Set<ServerResponse>();
  f.bus.on("event", (e: BusEvent) => {
    const msg = `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(msg);
  });
  setInterval(() => {
    const msg = `event: tick\ndata: ${JSON.stringify({ rate: f.liveRate(), hold: f.holdReason() ?? null })}\n\n`;
    for (const c of clients) c.write(msg);
  }, 5000).unref();

  const server = createServer(async (req, res) => {
    // Localhost only, and refuse cross-site requests (DNS rebinding, drive-by POSTs).
    const host = (req.headers.host ?? "").split(":")[0];
    if (!["127.0.0.1", "localhost"].includes(host)) {
      res.writeHead(403).end("Forbidden host");
      return;
    }
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      res.writeHead(403).end("Forbidden origin");
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`event: hello\ndata: ${JSON.stringify({ boot: BOOT_ID })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res);
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
      return;
    }
    try {
      const m = url.pathname.match(r.re)!;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = req.method === "GET" ? {} : await readBody(req);
      const out = await r.h({ f, params, body, query: url.searchParams });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out ?? { ok: true }));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}
