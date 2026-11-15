import { loadConfig, loadEnv, getProject } from "./config.ts";

loadEnv();

const ORDER = ["running", "ready", "triage", "human", "other", "done"] as const;

async function tasks(projectId?: string) {
  const { Ledger } = await import("./state/db.ts");
  const { sourceFor } = await import("./tasks/source.ts");
  const { fetchBoard } = await import("./tasks/board.ts");
  const cfg = loadConfig();
  const p = getProject(cfg, projectId ?? cfg.activeProject);
  const board = await fetchBoard(p, sourceFor(p, new Ledger()));
  console.log(`${p.name} (${p.source === "local" ? "local" : p.repo})\n`);
  for (const state of ORDER) {
    const items = board.filter((t) => t.state === state);
    if (!items.length) continue;
    console.log(`${state.toUpperCase()} (${items.length})`);
    for (const t of items) console.log(`  #${t.number}  ${t.title}`);
    console.log();
  }
}

function guardApiKey() {
  if (process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is set: Claude Code would bill the API instead of the subscription. Unset it.");
    process.exit(1);
  }
}

async function daemon() {
  guardApiKey();
  const { Factory } = await import("./factory/factory.ts");
  const { startServer } = await import("./server/http.ts");
  const f = new Factory();
  const port = Number(process.env.KILN_PORT ?? f.cfg.port ?? 7420);
  startServer(f, port);
  f.startLoop();
  // A fresh reading of the subscription windows, so the header and the usage guard are not blind.
  const last = f.ledger.lastUsage();
  if (!last || Date.now() - Date.parse(last.at) > 30 * 60_000) {
    const { probeUsage } = await import("./factory/assist.ts");
    probeUsage(f, f.project()).catch((e) => console.error(`Usage probe failed: ${e.message}`));
  }
  console.log(`Kiln command center on http://127.0.0.1:${port}  (loop ${f.cfg.pace.paused ? "paused" : "running"})`);
  const bye = () => {
    console.log("\nStopping: aborting live runs (worktrees are kept).");
    f.stopLoop();
    setTimeout(() => process.exit(0), 1500);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

/** M1: one task, by hand, in the foreground. Ctrl-C aborts and keeps the worktree. */
async function runOne(projectId: string | undefined, numberArg: string | undefined) {
  guardApiKey();
  const number = Number(numberArg);
  if (!projectId || !Number.isInteger(number)) {
    console.log("usage: kiln run <project> <issue>");
    process.exitCode = 1;
    return;
  }
  const { Factory } = await import("./factory/factory.ts");
  const f = new Factory();
  const p = f.project(projectId);
  let lastPhase = "";
  const colors: Record<string, string> = { think: "37", read: "36", edit: "33", bash: "35", fail: "31", error: "31", sub: "34", result: "32" };
  f.bus.on("event", (e: { type: string; data: any }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (e.type === "run:event") {
      const ev = e.data.event;
      const c = colors[ev.k] ?? "90";
      console.log(`\x1b[90m${ev.t.slice(11, 19)}\x1b[0m \x1b[${c}m${ev.k.padEnd(8)}\x1b[0m ${ev.sub ? `[${ev.sub}] ` : ""}${ev.text.split("\n")[0]}`);
    } else if (e.type === "task") {
      if (e.data.phase === lastPhase) return;
      lastPhase = e.data.phase;
      console.log(`\x1b[1m→ #${e.data.number}: ${e.data.phase}\x1b[0m${e.data.note ? `  ${String(e.data.note).split("\n")[0]}` : ""}`);
    } else if (e.type === "usage") {
      const u = e.data;
      if (u.isUsingOverage) console.log("\x1b[31m! extra usage in use\x1b[0m");
    } else if (e.type === "toast") console.log(`· ${e.data.text}`);
  });
  process.on("SIGINT", () => {
    console.log("\nStopping (worktree kept)…");
    void f.stop(p.id, number);
  });
  await f.startTask(p.id, number, true);
  // Wait until nothing is running for this task and it reached a resting phase.
  const resting = ["plan_review", "question", "pr_review", "gate_failed", "failed", "usage_paused", "stopped", "merged", "human", "dropped"];
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      const t = f.ledger.getTask(p.id, number);
      if (t && resting.includes(t.phase) && !f.liveFor(p.id, number)) {
        clearInterval(iv);
        console.log(`\nDone: #${number} is ${t.phase}.${t.prUrl ? ` PR: ${t.prUrl}` : ""}${t.question ? `\nQuestion: ${t.question}` : ""}${t.plan ? `\nPlan:\n${t.plan}` : ""}`);
        resolve();
      }
    }, 1000);
  });
  process.exit(0);
}

/** Issues for a project with `"source": "local"` (scratch repos, no GitHub). */
async function local(sub: string | undefined, projectId: string | undefined, rest: string[]) {
  const { Ledger } = await import("./state/db.ts");
  const { sourceFor } = await import("./tasks/source.ts");
  const cfg = loadConfig();
  const p = getProject(cfg, projectId ?? cfg.activeProject);
  if (p.source !== "local") throw new Error(`${p.id} is not a local project`);
  const src = sourceFor(p, new Ledger());
  if (sub === "add") {
    const [title, body = "", ...labels] = rest;
    const i = await src.createIssue({ title, body, labels: labels.length ? labels : [p.labels.ready] });
    console.log(`#${i.number} ${i.title} [${i.labels.join(", ")}]`);
  } else {
    console.log('usage: kiln local add <project> "<title>" "<body>" [labels...]');
  }
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "tasks":
    await tasks(args[0]);
    break;
  case "run":
    await runOne(args[0], args[1]);
    break;
  case "daemon":
  case "serve":
    await daemon();
    break;
  case "local":
    await local(args[0], args[1], args.slice(2));
    break;
  default:
    console.log(`usage:
  kiln daemon                   start the loop and the command center (127.0.0.1)
  kiln run <project> <issue>    run one task by hand in the foreground (Ctrl-C aborts)
  kiln tasks [project]          print a project's board
  kiln local add <project> "<title>" "<body>" [labels...]   add an issue to a local project`);
    process.exitCode = cmd ? 1 : 0;
}
