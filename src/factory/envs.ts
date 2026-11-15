import { spawn, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvs, mainBranch, type EnvProbe, type ProjectConfig } from "../config.ts";
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
  candidate: string | null;
  gates: { name: string; ok: boolean; output: string }[];
}

export interface EnvsView {
  main: { sha: string | null; branch: string };
  envs: EnvView[];
  /** Merged kiln PRs, each with the envs it is on. */
  merged: (PullRequest & { issue: number | null; on: string[] })[];
  checkedAt: string;
}

const cache = new Map<string, { at: number; view: EnvsView }>();

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
  if (c && !force && Date.now() - c.at < 60_000) return c.view;
  const src = f.source(p);
  await src.fetch().catch(() => undefined);
  const mainRef = src.baseRef();
  const mainSha = await git(p.path, ["rev-parse", mainRef]).catch(() => null);
  const defs = loadEnvs(p).envs;

  const envs: EnvView[] = await Promise.all(
    defs.map(async (d: EnvProbe): Promise<EnvView> => {
      const v: EnvView = {
        id: d.id, name: d.name, url: d.url, version: null, sha: null, health: null, error: null,
        checkedAt: new Date().toISOString(), deployLabel: d.deployLabel, canDeploy: !!d.deploy, candidate: null, gates: [],
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
          v.gates.push({ name: g.name, ok: out.ok, output: out.o.slice(-500) });
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
  return view;
}

export function cachedEnvs(p: ProjectConfig): EnvsView | undefined {
  return cache.get(p.id)?.view;
}

const deploying = new Set<string>();

/** Runs an env's deploy script. Never automatic: only from a button. */
export async function deploy(f: Factory, p: ProjectConfig, envId: string): Promise<number> {
  const d = loadEnvs(p).envs.find((e) => e.id === envId);
  if (!d?.deploy) throw new Error(`No deploy command for ${envId}`);
  const key = `${p.id}/${envId}`;
  if (deploying.has(key)) throw new Error(`A deploy to ${envId} is already running`);
  const view = await probeEnvs(f, p, true);
  const env = view.envs.find((e) => e.id === envId);
  const failed = env?.gates.filter((g) => !g.ok) ?? [];
  if (failed.length) throw new Error(`Release gate not met: ${failed.map((g) => g.name).join(", ")}`);

  deploying.add(key);
  const logPath = join(RUNS_DIR, `deploy-${p.id}-${envId}-${Date.now()}.log`);
  const row = f.ledger.addDeploy({
    project: p.id, env: envId, version: env?.candidate ?? null, status: "running", startedAt: new Date().toISOString(),
    endedAt: null, logPath,
  });
  f.emit({ type: "deploy", project: p.id, data: { deploy: row } });
  const child = spawn("/bin/bash", ["-lc", d.deploy], { cwd: p.path, env: process.env });
  const onData = (b: Buffer) => {
    const text = b.toString();
    appendFileSync(logPath, text);
    f.emit({ type: "deploy", project: p.id, data: { id: row.id, line: text } });
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code) => {
    deploying.delete(key);
    // A deploy of Kiln itself restarts Kiln: the service stop signals the whole cgroup, this child
    // included, while the daemon is still shutting down. That is not a failure: leave the row
    // "running" and let the next daemon settle it (markOrphanDeploys).
    if (code === null && f.stopping) return;
    const done = { ...row, status: code === 0 ? ("done" as const) : ("failed" as const), endedAt: new Date().toISOString() };
    f.ledger.putDeploy(done);
    f.emit({ type: "deploy", project: p.id, data: { deploy: done } });
    f.toast(`Deploy ${envId}: ${code === 0 ? "done" : `failed (exit ${code})`}`, code === 0 ? "info" : "error", p.id);
    probeEnvs(f, p, true).catch(() => undefined);
  });
  return row.id;
}
