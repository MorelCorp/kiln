import type { ProjectConfig } from "../config.ts";
import type { Issue, Source } from "./source.ts";

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
  /** Open, not parked, and carrying none of Kiln's labels: shown in Triage so it is not invisible. */
  untriaged?: boolean;
}

export function classify(issue: Issue, p: ProjectConfig): Task {
  const labels = issue.labels;
  const has = (l: string) => labels.includes(l);
  let state: TaskState;
  if (issue.state === "CLOSED") state = "done";
  else if ((p.labels.skip ?? []).some(has)) state = "other";
  else if (has(p.labels.running)) state = "running";
  else if (p.labels.triage.some(has)) state = "triage";
  else if (has(p.labels.human)) state = "human";
  else if (has(p.labels.ready)) state = "ready";
  else state = "triage";
  const untriaged = state === "triage" && !p.labels.triage.some(has);
  const pi = p.labels.priority.findIndex(has);
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    labels,
    state,
    priority: pi === -1 ? p.labels.priority.length : pi,
    closedAt: issue.closedAt ?? undefined,
    ...(untriaged ? { untriaged } : {}),
  };
}

/** Open issues plus the most recently closed ones, classified and sorted by priority then number. */
export async function fetchBoard(p: ProjectConfig, source: Source): Promise<Task[]> {
  const issues = await source.listIssues();
  return issues.map((i) => classify(i, p)).sort((a, b) => a.priority - b.priority || a.number - b.number);
}

/**
 * Labels to remove when a task enters `phase`. Terminal phases drop the running label; a merged
 * task also drops the ready label, because GitHub closes its issue and it must not keep looking
 * ready in label filters.
 */
export function labelsToClearOnPhase(phase: string, p: ProjectConfig): string[] {
  return phase === "merged" ? [p.labels.ready, p.labels.running] : [p.labels.running];
}
