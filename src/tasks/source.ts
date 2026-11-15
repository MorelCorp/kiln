import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mainBranch, type ProjectConfig } from "../config.ts";
import type { Ledger, LocalIssue } from "../state/db.ts";

const exec = promisify(execFile);

export interface Issue {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  closedAt: string | null;
  labels: string[];
}

export interface IssueDetail extends Issue {
  body: string;
  comments: { body: string; author: string; at: string }[];
}

export interface PullRequest {
  number: number;
  url: string;
  headRefName: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
  mergeCommit: string | null;
  title: string;
}

/**
 * Where a project's issues and pull requests live. GitHub through `gh` for real projects;
 * "local" keeps issues in the ledger and merges branches into the local main, for trying
 * Kiln on a scratch repo.
 */
export interface Source {
  listIssues(recentClosed?: number): Promise<Issue[]>;
  getIssue(n: number): Promise<IssueDetail>;
  editLabels(n: number, add: string[], remove: string[]): Promise<void>;
  comment(n: number, body: string): Promise<void>;
  createIssue(i: { title: string; body: string; labels: string[] }): Promise<Issue>;
  closeIssue(n: number, comment?: string): Promise<void>;
  /** Push a branch from a worktree (host side, with your credentials). */
  pushBranch(worktree: string, branch: string, force?: boolean): Promise<void>;
  findPr(branch: string): Promise<PullRequest | undefined>;
  openPr(branch: string, title: string, body: string): Promise<PullRequest>;
  /** Squash-merge. Returns the merge commit sha on main. */
  mergePr(pr: PullRequest, title: string, worktree: string): Promise<string>;
  /** Merged PRs from kiln/ branches, newest first. */
  mergedPrs(limit?: number): Promise<PullRequest[]>;
  /** The ref the gate rebases onto ("origin/main" or "main"). */
  baseRef(): string;
  /** Bring the base ref up to date (git fetch). */
  fetch(): Promise<void>;
}

export async function git(cwd: string, args: string[], opts: { timeout?: number } = {}): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 120_000 });
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/** Runs `gh` with the given args in a directory and returns trimmed stdout. Injectable for tests. */
export type GhRunner = (args: string[], cwd: string) => Promise<string>;
type GitRunner = (cwd: string, args: string[]) => Promise<string>;

const runGh: GhRunner = async (args, cwd) => {
  const { stdout } = await exec("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
  return stdout.trim();
};

export class GitHubSource implements Source {
  constructor(private p: ProjectConfig, private run: GhRunner = runGh, private gitRun: GitRunner = git) {}

  private gh(args: string[]): Promise<string> {
    return this.run(args, this.p.path);
  }

  private async list(args: string[]): Promise<Issue[]> {
    const out = await this.gh([
      "issue", "list", "-R", this.p.repo, "--json", "number,title,url,state,closedAt,labels", "--limit", "300", ...args,
    ]);
    return (JSON.parse(out) as (Omit<Issue, "labels"> & { labels: { name: string }[] })[]).map((i) => ({
      ...i,
      labels: i.labels.map((l) => l.name),
    }));
  }

  async listIssues(recentClosed = 30) {
    const [open, closed] = await Promise.all([
      this.list(["--state", "open"]),
      this.list(["--state", "closed", "--limit", String(recentClosed)]),
    ]);
    return [...open, ...closed];
  }

  async getIssue(n: number): Promise<IssueDetail> {
    const out = await this.gh([
      "issue", "view", String(n), "-R", this.p.repo, "--json", "number,title,url,state,closedAt,labels,body,comments",
    ]);
    const i = JSON.parse(out);
    return {
      ...i,
      labels: i.labels.map((l: { name: string }) => l.name),
      comments: (i.comments ?? []).map((c: { body: string; author?: { login: string }; createdAt: string }) => ({
        body: c.body,
        author: c.author?.login ?? "",
        at: c.createdAt,
      })),
    };
  }

  async editLabels(n: number, add: string[], remove: string[]) {
    if (!add.length && !remove.length) return;
    if (add.length) await this.ensureLabels(add);
    const args = ["issue", "edit", String(n), "-R", this.p.repo];
    for (const l of add) args.push("--add-label", l);
    for (const l of remove) args.push("--remove-label", l);
    await this.gh(args);
  }

  private knownLabels?: Set<string>;
  private async ensureLabels(labels: string[]) {
    if (!this.knownLabels) {
      const out = await this.gh(["label", "list", "-R", this.p.repo, "--json", "name", "--limit", "500"]);
      this.knownLabels = new Set((JSON.parse(out) as { name: string }[]).map((l) => l.name));
    }
    for (const l of labels) {
      if (this.knownLabels.has(l)) continue;
      await this.gh(["label", "create", l, "-R", this.p.repo, "--color", "FF9C33", "--description", "Managed by Kiln"]).catch(
        () => undefined,
      );
      this.knownLabels.add(l);
    }
  }

  async comment(n: number, body: string) {
    await this.gh(["issue", "comment", String(n), "-R", this.p.repo, "--body", body]);
  }

  async createIssue(i: { title: string; body: string; labels: string[] }) {
    await this.ensureLabels(i.labels);
    const args = ["issue", "create", "-R", this.p.repo, "--title", i.title, "--body", i.body];
    for (const l of i.labels) args.push("--label", l);
    const url = await this.gh(args);
    const number = Number(url.split("/").pop());
    return { number, title: i.title, url, state: "OPEN" as const, closedAt: null, labels: i.labels };
  }

  async closeIssue(n: number, comment?: string) {
    if (comment) await this.comment(n, comment);
    await this.gh(["issue", "close", String(n), "-R", this.p.repo]);
  }

  async pushBranch(worktree: string, branch: string, force = false) {
    await git(worktree, ["push", ...(force ? ["--force-with-lease"] : []), "-u", "origin", `${branch}:${branch}`]);
  }

  private prFields = "number,url,headRefName,state,mergedAt,mergeCommit,title";
  private toPr(x: {
    number: number; url: string; headRefName: string; state: string; mergedAt: string | null;
    mergeCommit: { oid: string } | null; title: string;
  }): PullRequest {
    return { ...x, state: x.state as PullRequest["state"], mergeCommit: x.mergeCommit?.oid ?? null };
  }

  async findPr(branch: string) {
    const out = await this.gh(["pr", "list", "-R", this.p.repo, "--head", branch, "--state", "all", "--json", this.prFields]);
    const prs = JSON.parse(out);
    return prs.length ? this.toPr(prs[0]) : undefined;
  }

  async openPr(branch: string, title: string, body: string) {
    const existing = await this.findPr(branch);
    if (existing && existing.state === "OPEN") return existing;
    await this.gh(["pr", "create", "-R", this.p.repo, "--head", branch, "--base", mainBranch(this.p), "--title", title, "--body", body]);
    const pr = await this.findPr(branch);
    if (!pr) throw new Error(`PR for ${branch} not found after creating it`);
    return pr;
  }

  async mergePr(pr: PullRequest, title: string, worktree: string) {
    const head = await this.gitRun(worktree, ["rev-parse", "HEAD"]);
    // gh's own --delete-branch would also switch the local branch, which breaks with worktrees.
    await this.gh([
      "pr", "merge", String(pr.number), "-R", this.p.repo, "--squash", "--delete-branch=false",
      "--subject", title, "--match-head-commit", head,
    ]);
    await this.deleteRemoteBranch(pr.headRefName);
    const merged = await this.findPr(pr.headRefName);
    return merged?.mergeCommit ?? "";
  }

  /** Best effort: the merge already happened, so a failure here is logged and never thrown. */
  private async deleteRemoteBranch(branch: string) {
    try {
      await this.gh(["api", "-X", "DELETE", `repos/${this.p.repo}/git/refs/heads/${branch}`]);
    } catch (e) {
      console.warn(`[${this.p.id}] could not delete remote branch ${branch} after merge: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async mergedPrs(limit = 50) {
    const out = await this.gh([
      "pr", "list", "-R", this.p.repo, "--state", "merged", "--limit", String(limit), "--json", this.prFields,
    ]);
    return (JSON.parse(out) as Parameters<GitHubSource["toPr"]>[0][]).map((x) => this.toPr(x));
  }

  baseRef() {
    return `origin/${mainBranch(this.p)}`;
  }

  async fetch() {
    await git(this.p.path, ["fetch", "--quiet", "--tags", "origin", mainBranch(this.p)]);
  }
}

// ---------------------------------------------------------------------------
// Local (scratch repos, no GitHub)
// ---------------------------------------------------------------------------

class LocalSource implements Source {
  constructor(private p: ProjectConfig, private ledger: Ledger) {}

  private url(n: number) {
    return `kiln-local://${this.p.id}/${n}`;
  }

  private issue(i: LocalIssue): Issue {
    return { number: i.number, title: i.title, url: this.url(i.number), state: i.state, closedAt: i.closedAt, labels: i.labels };
  }

  private find(n: number): LocalIssue {
    const i = this.ledger.localIssues(this.p.id).find((x) => x.number === n);
    if (!i) throw new Error(`No local issue #${n}`);
    return i;
  }

  async listIssues() {
    return this.ledger.localIssues(this.p.id).map((i) => this.issue(i));
  }

  async getIssue(n: number): Promise<IssueDetail> {
    const i = this.find(n);
    return { ...this.issue(i), body: i.body, comments: i.comments.map((c) => ({ ...c, author: "kiln" })) };
  }

  async editLabels(n: number, add: string[], remove: string[]) {
    const i = this.find(n);
    i.labels = [...new Set([...i.labels.filter((l) => !remove.includes(l)), ...add])];
    this.ledger.putLocalIssue(this.p.id, i);
  }

  async comment(n: number, body: string) {
    const i = this.find(n);
    i.comments.push({ body, at: new Date().toISOString() });
    this.ledger.putLocalIssue(this.p.id, i);
  }

  async createIssue(x: { title: string; body: string; labels: string[] }) {
    const all = this.ledger.localIssues(this.p.id);
    const number = all.reduce((m, i) => Math.max(m, i.number), 0) + 1;
    const i: LocalIssue = {
      number, title: x.title, body: x.body, labels: x.labels, state: "OPEN", closedAt: null, comments: [],
      createdAt: new Date().toISOString(),
    };
    this.ledger.putLocalIssue(this.p.id, i);
    return this.issue(i);
  }

  async closeIssue(n: number, comment?: string) {
    if (comment) await this.comment(n, comment);
    const i = this.find(n);
    i.state = "CLOSED";
    i.closedAt = new Date().toISOString();
    this.ledger.putLocalIssue(this.p.id, i);
  }

  async pushBranch() {
    // Nothing to push: the worktree's branch already lives in the local repo.
  }

  async findPr(branch: string): Promise<PullRequest | undefined> {
    const n = Number(branch.split("-").pop());
    const t = this.ledger.getTask(this.p.id, n);
    if (!t?.prNumber) return undefined;
    return {
      number: t.prNumber, url: this.url(n), headRefName: branch, title: t.title,
      state: t.mergedSha ? "MERGED" : "OPEN", mergedAt: t.mergedAt, mergeCommit: t.mergedSha,
    };
  }

  async openPr(branch: string, title: string): Promise<PullRequest> {
    const n = Number(branch.split("-").pop());
    return { number: n, url: this.url(n), headRefName: branch, title, state: "OPEN", mergedAt: null, mergeCommit: null };
  }

  async mergePr(pr: PullRequest, title: string, worktree: string) {
    const main = mainBranch(this.p);
    const parent = await git(this.p.path, ["rev-parse", main]);
    try {
      await git(worktree, ["merge-base", "--is-ancestor", parent, "HEAD"]);
    } catch {
      throw new Error(`${pr.headRefName} is not rebased on ${main}; run the gate again`);
    }
    const tree = await git(worktree, ["rev-parse", "HEAD^{tree}"]);
    const sha = await git(this.p.path, ["commit-tree", tree, "-p", parent, "-m", `${title} (#${pr.number})`]);
    const head = await git(this.p.path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const dirty = (await git(this.p.path, ["status", "--porcelain"])) !== "";
    if (head === main && !dirty) await git(this.p.path, ["merge", "--ff-only", "--quiet", sha]);
    else await git(this.p.path, ["update-ref", `refs/heads/${main}`, sha, parent]);
    return sha;
  }

  async mergedPrs() {
    return this.ledger
      .listTasks(this.p.id)
      .filter((t) => t.mergedSha)
      .map((t) => ({
        number: t.prNumber ?? t.number, url: this.url(t.number), headRefName: t.branch, title: t.title,
        state: "MERGED" as const, mergedAt: t.mergedAt, mergeCommit: t.mergedSha,
      }));
  }

  baseRef() {
    return mainBranch(this.p);
  }

  async fetch() {}
}

const cache = new Map<string, Source>();

export function sourceFor(p: ProjectConfig, ledger: Ledger): Source {
  let s = cache.get(p.id);
  if (!s) {
    s = p.source === "local" ? new LocalSource(p, ledger) : new GitHubSource(p);
    cache.set(p.id, s);
  }
  return s;
}
