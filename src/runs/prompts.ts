import type { IssueDetail } from "../tasks/source.ts";

/** Used when a project has no `.kiln/prompt.md`. */
export const DEFAULT_PROJECT_PROMPT = `Follow this repository's own conventions: read its CLAUDE.md / AGENTS.md / README
and any contributor docs before changing code. Keep the change focused on the issue. Add or update tests
for what you change and run the relevant test suite before you finish.`;

function issueBlock(issue: IssueDetail): string {
  const comments = issue.comments
    .slice(-10)
    .map((c) => `--- comment by ${c.author || "someone"} (${c.at})\n${c.body}`)
    .join("\n\n");
  return `# Issue #${issue.number}: ${issue.title}

Labels: ${issue.labels.join(", ") || "none"}

${issue.body || "(no description)"}
${comments ? `\n## Discussion\n\n${comments}` : ""}`;
}

const PROTOCOL = `## How you work inside Kiln

You run unattended in a sandbox, on a git worktree checked out on branch {{BRANCH}}.
- Commit your work on this branch with clear messages. Do NOT push and do NOT open a pull request:
  Kiln pushes the branch and opens the PR after you finish.
- Use the TodoWrite tool to keep a short task list up to date; Kiln shows it as your progress.
- Nobody reads your messages while you work. When you are done, or blocked, end your final message
  with exactly ONE of the blocks below, and stop.

When the work is done and committed:
<kiln-done>
{"summary": "two or three sentences on what changed and why",
 "checklist": [{"title": "short check name", "steps": "what a human should do", "expected": "what they should see", "env": "staging"}]}
</kiln-done>
"checklist" lists manual checks a human must do after deployment ("env": "staging" or "prod"); use [] when
automated tests cover everything. Most tasks need none.

When you cannot continue without a human decision (an ambiguity in the issue that matters, a missing
credential, a risky choice):
<kiln-question>Your question, with the options you see and the one you recommend.</kiln-question>
Your session is kept: the answer comes back to you as the next message.`;

export function implementPrompt(projectPrompt: string, issue: IssueDetail, branch: string, plan?: string | null, note?: string | null): string {
  return [
    projectPrompt.trim(),
    issueBlock(issue),
    plan ? `## Approved plan\n\nImplement this plan, which the human approved:\n\n${plan}` : "",
    note ? `## Note from the human\n\n${note}` : "",
    PROTOCOL.replace("{{BRANCH}}", branch),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function planPrompt(projectPrompt: string, issue: IssueDetail, branch: string, reason: string, note?: string | null): string {
  return [
    projectPrompt.trim(),
    issueBlock(issue),
    `## Plan first (this task needs human approval: ${reason})

Do NOT change any file and do NOT commit. Read the code you need, then write a short numbered plan
(at most 8 steps) a reviewer can approve in two minutes: what you will change, in which files, how
you will test it, and what is out of scope. End your final message with:
<kiln-plan>
1. ...
2. ...
Out of scope: ...
</kiln-plan>
If the issue is too ambiguous to plan, end with <kiln-question>...</kiln-question> instead.`,
    note ? `## Note from the human about the previous plan\n\n${note}` : "",
    `You are on branch ${branch} in a sandbox.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Sent when resuming a paused/redirected session. */
export function resumePrompt(message: string, kind: "answer" | "redirect" | "approve" | "fix" | "test"): string {
  const head = {
    answer: "The human answered your question:",
    redirect: "The human redirected you. Adjust course accordingly:",
    approve: "The human approved your plan. Implement it now.",
    fix: "The merge gate sent your work back. Fix this, commit, and finish again:",
    test: "A human tested your change and some checks failed. Fix this, commit, and finish again:",
  }[kind];
  return `${head}\n\n${message}`;
}

/** Appended to every resumed turn: a resumed session may never have seen the protocol (plan → implement). */
export function protocolReminder(kind: "plan" | "work", branch: string): string {
  return kind === "plan"
    ? `Do NOT change any file. End your final message with a <kiln-plan>...</kiln-plan> block (numbered steps, then "Out of scope: ..."), or <kiln-question>...</kiln-question> if you are blocked.`
    : PROTOCOL.replace("{{BRANCH}}", branch);
}

export function reviewPrompt(issue: IssueDetail, base: string, branch: string, decisions: string[] = []): string {
  return `You are the reviewer in Kiln's merge gate. Another agent implemented the issue below on branch
${branch}. Review its work. Do NOT change any file.

${issueBlock(issue)}
${decisions.length ? `\n## Decisions the human made while the agent worked (they override the issue text)\n\n${decisions.map((d) => `- ${d.replace(/\n/g, "\n  ")}`).join("\n")}\n` : ""}
## What to do

1. Run \`git log --oneline ${base}..HEAD\` and \`git diff ${base}...HEAD\` to see the change.
2. Check it against the issue: does it do what was asked, completely? Anything out of scope?
3. Look for bugs, missing tests, security problems, leftover debug code, secrets.
4. Decide:
   - "approve": good to merge (small style nits are not a reason to block).
   - "revise": the implementing agent should fix specific things. Be concrete.
   - "escalate": a human must look (the issue is ambiguous, the change is risky, or it is wrong in a way
     the agent is unlikely to fix).

End your final message with:
<kiln-review>
{"verdict": "approve", "notes": "short, concrete notes for the agent or the human"}
</kiln-review>`;
}

export function triagePrompt(issue: IssueDetail, labels: { ready: string; reviewAuto: string; reviewRequired: string; priority: string[] }): string {
  return `You are triaging an issue for an automated coding pipeline. Read the repository as needed
(read-only) and the issue below, then draft a spec an unattended agent can implement.

${issueBlock(issue)}

Decide:
- a clear title;
- a body: context, what to do, acceptance criteria as a checklist, out of scope;
- risk: "auto" when a reviewer agent plus tests are enough, "required" when a human must approve a plan
  and review the PR (auth, payments, data migrations, infra, security, anything irreversible);
- labels to add, chosen from: ${[labels.ready, labels.reviewAuto, labels.reviewRequired, ...labels.priority].join(", ")}
  and any existing area labels you see on similar issues.
If the issue is really several tasks, say so in the body and propose the split.

End your final message with:
<kiln-draft>
{"title": "...", "body": "markdown", "labels": ["..."], "risk": "auto"}
</kiln-draft>`;
}

export function questionsPrompt(description: string): string {
  return `Someone wants to add a task to this repository's backlog. Their description:

"""${description}"""

Look around the repository briefly (read-only, a few files at most) to find real ambiguities that
change what should be built: scope (which apps/packages), edge cases, feature flags, data. Ask at most 3
multiple-choice questions, each with 2 to 4 short options. Ask nothing you can answer from the code.
If nothing is ambiguous, return an empty list.

End your final message with:
<kiln-questions>
[{"q": "question", "options": ["a", "b"]}]
</kiln-questions>`;
}

export function draftPrompt(description: string, answers: { q: string; a: string }[], labelHints: string[]): string {
  return `Draft a GitHub issue for this repository's backlog from the request below. Read the repository as
needed (read-only) to use the right names for things.

Request: """${description}"""
${answers.length ? `\nClarifications:\n${answers.map((x) => `- ${x.q} → ${x.a}`).join("\n")}` : ""}

Write a clear title, and a body with context, what to do, acceptance criteria as a checklist, and out of
scope. Guess the risk: "auto" (tests plus a reviewer agent are enough) or "required" (a human must approve
a plan: auth, payments, migrations, infra, security). Suggest labels from: ${labelHints.join(", ")}.

End your final message with:
<kiln-draft>
{"title": "...", "body": "markdown", "labels": ["..."], "risk": "auto"}
</kiln-draft>`;
}

export function chatSystem(context: string): string {
  return `You are the chat assistant of Kiln, a local software factory that runs coding agents on this
repository's GitHub issues. You answer questions about the project and the factory's state. You never
edit files. You can PROPOSE actions; the human confirms each with a button. Never propose merging or
deploying.

When the human says an issue is done, obsolete or a duplicate, propose closing it (close_issue) with a
short closing comment saying why, rather than only removing its labels. Name the issue number in the
button label.

Current factory state:
${context}

To propose actions, end your message with:
<kiln-actions>
[{"label": "Button text", "kind": "relabel", "args": {"number": 107, "add": ["priority:later"], "remove": []}}]
</kiln-actions>
Kinds and args:
- "create_issue": {"title", "body", "labels": [], "risk": "auto"|"required"}
- "relabel": {"number", "add": [], "remove": []}
- "close_issue": {"number", "comment": "why it is closed", "reason": "completed"|"not planned"} (stops its run if any)
- "pace": {"paused"?: bool, "maxConcurrentAgents"?: n, "modelCeiling"?: "small"|"medium"|"large", "effortCeiling"?: "low".."max"}
- "message_agent": {"number", "message"} (redirects a running agent, or answers a paused one)
- "stop_run": {"number"}
- "open": {"path": "/task/107"} (opens a page in Kiln: /task/<n>, /review/<n>, /inbox, /envs, /tokens)
Omit the block when no action helps.`;
}
