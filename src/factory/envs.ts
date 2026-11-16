import { spawn, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvs, mainBranch, type EnvProbe, type GateDef, type ProjectConfig } from "../config.ts";
import type { DeployRow } from "../state/db.ts";
import { git, type PullRequest } from "../tasks/source.ts";
import { RUNS_DIR, type Factory } from "./factory.ts";

const sh = promisify(execCb);

export interface EnvView {
  id: string;
  name: string;
  url?: string;
  version: string | null;
  /** The commit the version resolves to in the repo, when it does. */
  sha: string | null;
  health: string | null;
  error: string | null;
  checkedAt: string;
  deployLabel?: string;
  canDeploy: boolean;
  /** Options for the deploy button; the first is the default. Empty when the deploy takes none. */
  deployChoices: string[];
  candidate: string | null;
  gates: GateView[];
}

export interface GateView {
  name: string;
  ok: boolean;
  output: string;
  /** Label of the gate's step button, when it has a step. */
  step: string | null;
  skippable: boolean;
  /** The history row of the step running now, if any. */
  running: number | null;
}

export interface EnvsView {
  main: { sha: string | null; branch: string };
  envs: EnvView[];
  /** Merged kiln PRs, each with the envs it is on. */
  merged: (PullRequest & { issue: number | null; on: string[] })[];
  checkedAt: string;
}

const cache = new Map<string, { at: number; view: EnvsView }>();
/** `project/env/gate` -> history row of the step running now. */
const running = new Map<string, number>();

async function run(cmd: string, cwd: string, timeout = 30_000): Promise<string> {
  const { stdout } = await sh(cmd, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, shell: "/bin/bash" });
  return stdout.trim();
}

async function resolveSha(p: ProjectConfig, version: string): Promise<string | null> {
  for (const ref of [version, `v${version.replace(/^v/i, "")}`, version.replace(/^v/i, "")]) {
    try {
      return await git(p.path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

/**
 * The PR's merge commit as it is on main. GitHub keeps a PR's original merge sha, so after a history
 * rewrite of main (e.g. scrubbing author emails) that sha is no longer on main (it may still exist
 * locally, unreachable): fall back to the commit on main whose subject is the squash subject (the PR
 * title, with or without " (#N)").
 */
export async function localMergeCommit(
  p: ProjectConfig, pr: PullRequest, mainRef: string, subjects: () => Promise<Map<string, string>>,
): Promise<string | null> {
  if (!pr.mergeCommit) return null;
  if (await isAncestor(p, pr.mergeCommit, mainRef)) return pr.mergeCommit;
  const bySubject = await subjects();
  return bySubject.get(`${pr.title} (#${pr.number})`) ?? bySubject.get(pr.title) ?? pr.mergeCommit;
}

/** Subject -> sha for the last 1000 commits on main (newest wins), loaded at most once per probe. */
export function mainSubjects(p: ProjectConfig, ref: string): () => Promise<Map<string, string>> {
  let memo: Promise<Map<string, string>> | undefined;
  return () =>
    (memo ??= git(p.path, ["log", "-n", "1000", "--format=%H%x09%s", ref])
      .then((out) => {
        const m = new Map<string, string>();
        for (const line of out.split("\n").reverse()) {
          const tab = line.indexOf("\t");
          if (tab > 0) m.set(line.slice(tab + 1), line.slice(0, tab));
        }
        return m;
      })
      .catch(() => new Map()));
}

async function isAncestor(p: ProjectConfig, a: string, b: string): Promise<boolean> {
  try {
    await git(p.path, ["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
}

const issueOf = (pr: PullRequest) => {
  const m = pr.headRefName.match(/^kiln\/issue-(\d+)/);
  return m ? Number(m[1]) : null;
};

export async function probeEnvs(f: Factory, p: ProjectConfig, force = false): Promise<EnvsView> {
  const c = cache.get(p.id);
  if (c && !force && Date.now() - c.at < 60_000) return withRunning(p, c.view);
  const src = f.source(p);
  await src.fetch().catch(() => undefined);
  const mainRef = src.baseRef();
  const mainSha = await git(p.path, ["rev-parse", mainRef]).catch(() => null);
  const defs = loadEnvs(p).envs;

  const envs: EnvView[] = await Promise.all(
    defs.map(async (d: EnvProbe): Promise<EnvView> => {
      const v: EnvView = {
        id: d.id, name: d.name, url: d.url, version: null, sha: null, health: null, error: null,
        checkedAt: new Date().toISOString(), deployLabel: d.deployLabel, canDeploy: !!d.deploy,
        deployChoices: (d.deployChoices ?? []).map(String), candidate: null, gates: [],
      };
      try {
        if (d.probe) {
          v.version = (await run(d.probe, p.path)) || null;
          if (v.version) v.sha = await resolveSha(p, v.version);
        }
        if (d.health) v.health = await run(d.health, p.path).catch((e) => `unhealthy: ${String(e.message).slice(0, 80)}`);
        if (d.candidate) v.candidate = (await run(d.candidate, p.path).catch(() => "")) || null;
        for (const g of d.gate ?? []) {
          const out = await run(g.run, p.path, 60_000).then(
            (o) => ({ ok: true, o }),
            (e) => ({ ok: false, o: String(e.stdout || e.message) }),
          );
          v.gates.push({
            name: g.name, ok: out.ok, output: out.o.slice(-500), step: g.step ? (g.stepLabel ?? "Run") : null,
            skippable: !!g.skippable, running: running.get(`${p.id}/${d.id}/${g.name}`) ?? null,
          });
        }
      } catch (e) {
        v.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
      }
      return v;
    }),
  );

  const subjects = mainSubjects(p, mainRef);
  const prs = (await src.mergedPrs(60).catch(() => [])).filter((x) => x.headRefName.startsWith("kiln/"));
  const merged = await Promise.all(
    prs.map(async (pr) => {
      const on: string[] = [];
      if (pr.mergeCommit) {
        const sha = await localMergeCommit(p, pr, mainRef, subjects);
        for (const e of envs) if (sha && e.sha && (await isAncestor(p, sha, e.sha))) on.push(e.id);
      }
      return { ...pr, issue: issueOf(pr), on };
    }),
  );

  const view: EnvsView = { main: { sha: mainSha, branch: mainBranch(p) }, envs, merged, checkedAt: new Date().toISOString() };
  cache.set(p.id, { at: Date.now(), view });
  // Every open view (the header and the Environments page) refetches the fresh probe.
  f.emit({ type: "envs", project: p.id, data: { checkedAt: view.checkedAt } });
  return view;
}

/** The cached view with each gate's running step read live (steps start and end between probes). */
function withRunning(p: ProjectConfig, view: EnvsView): EnvsView {
  return {
    ...view,
    envs: view.envs.map((e) => ({ ...e, gates: e.gates.map((g) => ({ ...g, running: running.get(`${p.id}/${e.id}/${g.name}`) ?? null })) })),
  };
}

export function cachedEnvs(p: ProjectConfig): EnvsView | undefined {
  return cache.get(p.id)?.view;
}

const deploying = new Set<string>();

/** The deploy option to run with: the requested one if the env lists it, its first one if none was asked. */
export function deployChoice(d: EnvProbe, requested?: unknown): string | undefined {
  const choices = (d.deployChoices ?? []).map(String);
  if (!choices.length) return undefined;
  if (requested === undefined || requested === null || requested === "") return choices[0];
  const c = String(requested);
  if (!choices.includes(c)) throw new Error(`Unknown deploy option "${c}" for ${d.id} (one of: ${choices.join(", ")})`);
  return c;
}

/**
 * Which failing gates block a deploy, given the ones asked to be skipped. A skip needs a reason and
 * may only name a gate that is skippable; a gate that passes needs no skip and is dropped from it.
 */
export function blockingGates(
  defs: GateDef[], results: { name: string; ok: boolean }[], skip: string[] = [], reason = "",
): { blocking: string[]; skipped: string[] } {
  const failing = results.filter((r) => !r.ok).map((r) => r.name);
  for (const name of skip) {
    const def = defs.find((g) => g.name === name);
    if (!def) throw new Error(`Unknown gate "${name}"`);
    if (!def.skippable) throw new Error(`Gate "${name}" cannot be skipped`);
  }
  const skipped = failing.filter((n) => skip.includes(n));
  if (skipped.length && !reason.trim()) throw new Error("Say why you skip a gate");
  return { blocking: failing.filter((n) => !skipped.includes(n)), skipped };
}

/** Runs a command on the host in the project dir, streaming into a history row. Never automatic: only from a button. */
function launch(
  f: Factory, p: ProjectConfig, cmd: string, row: Omit<DeployRow, "id" | "status" | "startedAt" | "endedAt" | "logPath">,
  env: Record<string, string>, preamble: string, done: (code: number | null) => void,
): DeployRow {
  const logPath = join(RUNS_DIR, `${row.kind ?? "deploy"}-${p.id}-${row.env}-${Date.now()}.log`);
  const r = f.ledger.addDeploy({ ...row, status: "running", startedAt: new Date().toISOString(), endedAt: null, logPath });
  f.emit({ type: "deploy", project: p.id, data: { deploy: r } });
  const onData = (b: Buffer | string) => {
    const text = b.toString();
    appendFileSync(logPath, text);
    f.emit({ type: "deploy", project: p.id, data: { id: r.id, line: text } });
  };
  if (preamble) onData(preamble);
  const child = spawn("/bin/bash", ["-lc", cmd], { cwd: p.path, env: { ...process.env, ...env } });
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => onData(`\n${e.message}\n`));
  child.on("close", (code) => {
    done(code);
    // A deploy of Kiln itself restarts Kiln: the service stop signals the whole cgroup, this child
    // included, while the daemon is still shutting down. That is not a failure: leave the row
    // "running" and let the next daemon settle it (markOrphanDeploys).
    if (code === null && f.stopping) return;
    const end = { ...r, status: code === 0 ? ("done" as const) : ("failed" as const), endedAt: new Date().toISOString() };
    f.ledger.putDeploy(end);
    f.emit({ type: "deploy", project: p.id, data: { deploy: end } });
    const what = row.kind === "step" ? `${row.env} · ${row.gate}` : `Deploy ${row.env}`;
    f.toast(`${what}: ${code === 0 ? "done" : `failed (exit ${code})`}`, code === 0 ? "info" : "error", p.id);
    probeEnvs(f, p, true).catch(() => undefined);
  });
  return r;
}

/** Runs an env's deploy script once every gate passes or is skipped (with a reason). */
export async function deploy(
  f: Factory, p: ProjectConfig, envId: string, requested?: unknown, skip: string[] = [], reason = "",
): Promise<number> {
  const d = loadEnvs(p).envs.find((e) => e.id === envId);
  if (!d?.deploy) throw new Error(`No deploy command for ${envId}`);
  const choice = deployChoice(d, requested);
  const key = `${p.id}/${envId}`;
  if (deploying.has(key)) throw new Error(`A deploy to ${envId} is already running`);
  const view = await probeEnvs(f, p, true);
  const env = view.envs.find((e) => e.id === envId);
  const { blocking, skipped } = blockingGates(d.gate ?? [], env?.gates ?? [], skip, reason);
  if (blocking.length) throw new Error(`Release gate not met: ${blocking.join(", ")}`);

  deploying.add(key);
  const r = launch(
    f, p, d.deploy,
    {
      project: p.id, env: envId, kind: "deploy", version: [env?.candidate, choice].filter(Boolean).join(" · ") || null,
      ...(skipped.length ? { skipped: { gates: skipped, reason: reason.trim() } } : {}),
    },
    choice ? { KILN_DEPLOY_CHOICE: choice } : {},
    skipped.length ? `Skipped gates: ${skipped.join(", ")}\nReason: ${reason.trim()}\n\n` : "",
    () => deploying.delete(key),
  );
  return r.id;
}

/** Runs a gate's step (e.g. the scan that writes the report its check looks for). */
export async function runGateStep(f: Factory, p: ProjectConfig, envId: string, gateName: string): Promise<number> {
  const d = loadEnvs(p).envs.find((e) => e.id === envId);
  const g = d?.gate?.find((x) => x.name === gateName);
  if (!d || !g) throw new Error(`No gate "${gateName}" on ${envId}`);
  if (!g.step) throw new Error(`Gate "${gateName}" has no step`);
  const key = `${p.id}/${envId}/${gateName}`;
  if (running.has(key)) throw new Error(`"${gateName}" is already running`);
  const candidate = cachedEnvs(p)?.envs.find((e) => e.id === envId)?.candidate ?? "";
  const r = launch(
    f, p, g.step, { project: p.id, env: envId, kind: "step", gate: gateName, version: candidate || null },
    { KILN_ENV: envId, KILN_CANDIDATE: candidate }, "", () => running.delete(key),
  );
  running.set(key, r.id);
  return r.id;
}
