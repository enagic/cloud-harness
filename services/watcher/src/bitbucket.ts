/**
 * Bitbucket, read-only.
 *
 * The watcher polls PR state for two reasons: merge conflicts have no
 * Jira-side signal (nothing about the ticket changes when someone else merges
 * to the base branch), and neither does the human's merge.
 *
 * PLACEHOLDER — signatures settled, bodies not.
 */

import type { BitbucketConfig, Logger, PullRequestState, RepositoryRef } from '@cloud-harness/shared';

export class BitbucketReader {
  constructor(
    private readonly config: BitbucketConfig,
    private readonly log: Logger,
  ) {}

  /**
   * Find the agent's PR for an issue, by branch naming convention.
   *
   * Deliberately derived rather than read from a Jira field: the implementer
   * names its branch `agent/<issue-key>-<slug>`, so Bitbucket itself is the
   * source of truth for whether a PR exists and what state it is in. A Jira
   * remote link is a convenience for humans, not something the pipeline trusts
   * — if someone deletes it, nothing breaks.
   *
   * TODO: GET /2.0/repositories/{workspace}/{repo}/pullrequests with a query
   * filter on source.branch.name ~ "agent/<issue-key>". Prefer the newest OPEN
   * PR; fall back to the newest MERGED one so a merged ticket still reconciles
   * to Done. Return undefined when there is none.
   */
  async findPullRequestForIssue(
    _repo: RepositoryRef,
    _issueKey: string,
  ): Promise<PullRequestState | undefined> {
    throw new Error('BitbucketReader.findPullRequestForIssue not implemented');
  }

  /**
   * TODO: GET /2.0/repositories/{workspace}/{repo}/pullrequests/{id}
   *
   * Mergeability is the subtle part. The PR object's own fields do not reliably
   * report conflict state; the usual approaches are
   *   - GET .../pullrequests/{id}/diff and treat a 555/409 as conflicted, or
   *   - inspect the merge-status field, which may report PENDING while
   *     Bitbucket computes it.
   *
   * Whichever we pick, PENDING must map to "unknown", not "conflicted" —
   * treating it as conflicted would queue a spurious rebase on every fresh PR.
   * Return undefined for unknown, so reconcilePullRequest does nothing.
   */
  async getPullRequest(_repo: RepositoryRef, _id: number): Promise<PullRequestState | undefined> {
    throw new Error('BitbucketReader.getPullRequest not implemented');
  }
}
