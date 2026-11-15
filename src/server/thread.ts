import type { IssueDetail, Source } from "../tasks/source.ts";

/**
 * Read an issue and its comments through the task source, for the board's detail modal.
 * Read-only by construction: it only takes `getIssue`, so it cannot write to the tracker.
 */
export async function readIssueThread(source: Pick<Source, "getIssue">, n: number): Promise<IssueDetail> {
  const issue = await source.getIssue(n);
  return {
    ...issue,
    body: issue.body ?? "",
    comments: (issue.comments ?? [])
      .map((c) => ({ body: c.body ?? "", author: c.author || "unknown", at: c.at }))
      .sort((a, b) => a.at.localeCompare(b.at)),
  };
}
