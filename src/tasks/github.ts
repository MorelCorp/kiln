import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectConfig } from "../config.ts";

const exec = promisify(execFile);

export type TaskState = "triage" | "ready" | "human" | "running" | "done" | "other";

export interface Task {
  number: number;
  title: string;
  url: string;
  labels: string[];
  state: TaskState;
  /** Index in the project's priority list; lower is more urgent. */
  priority: number;
  closedAt?: string;
}

interface GhIssue {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  closedAt: string | null;
  labels: { name: string }[];
}

async function gh(repo: string, args: string[]): Promise<GhIssue[]> {
  const { stdout } = await exec(
    "gh",
    ["issue", "list", "-R", repo, "--json", "number,title,url,state,closedAt,labels", "--limit", "200", ...args],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as GhIssue[];
}

export function classify(issue: GhIssue, p: ProjectConfig): Task {
  const labels = issue.labels.map((l) => l.name);
  const has = (l: string) => labels.includes(l);
  let state: TaskState;
  if (issue.state === "CLOSED") state = "done";
  else if (has(p.labels.running)) state = "running";
  else if (p.labels.triage.some(has)) state = "triage";
  else if (has(p.labels.human)) state = "human";
  else if (has(p.labels.ready)) state = "ready";
  else state = "other";
  const pi = p.labels.priority.findIndex(has);
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    labels,
    state,
    priority: pi === -1 ? p.labels.priority.length : pi,
    closedAt: issue.closedAt ?? undefined,
  };
}

/** Open issues plus the last `recentClosed` closed ones, classified and sorted. */
export async function fetchBoard(p: ProjectConfig, recentClosed = 20): Promise<Task[]> {
  const [open, closed] = await Promise.all([
    gh(p.repo, ["--state", "open"]),
    gh(p.repo, ["--state", "closed", "--limit", String(recentClosed)]),
  ]);
  return [...open, ...closed]
    .map((i) => classify(i, p))
    .sort((a, b) => a.priority - b.priority || a.number - b.number);
}
