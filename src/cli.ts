import { loadConfig, loadEnv, getProject } from "./config.ts";

loadEnv();
import { fetchBoard, type TaskState } from "./tasks/github.ts";

const ORDER: TaskState[] = ["running", "ready", "triage", "human", "other", "done"];

async function tasks(projectId?: string) {
  const cfg = loadConfig();
  const p = getProject(cfg, projectId ?? cfg.activeProject);
  const board = await fetchBoard(p);
  console.log(`${p.name} (${p.repo})\n`);
  for (const state of ORDER) {
    const items = board.filter((t) => t.state === state);
    if (!items.length) continue;
    console.log(`${state.toUpperCase()} (${items.length})`);
    for (const t of items) console.log(`  #${t.number}  ${t.title}`);
    console.log();
  }
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "tasks":
    await tasks(args[0]);
    break;
  default:
    console.log("usage: kiln tasks [project]");
    process.exitCode = cmd ? 1 : 0;
}
