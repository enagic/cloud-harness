/**
 * Bitbucket, agent side — clone, push, PR lifecycle, rebase.
 *
 * PLACEHOLDER — signatures settled, bodies not.
 *
 * Auth: BITBUCKET_TOKEN is injected from Secrets Manager. Whether that is an
 * app password (`x-token-auth:<token>` in the clone URL) or a workspace access
 * token changes the URL format — confirm before implementing, and keep the
 * token out of `git remote -v`, out of .git/config, and out of any logged
 * command line. A credential helper or askpass shim is the safe route.
 */

import type { BitbucketConfig, Logger, RepositoryRef, ReviewFeedback } from '@cloud-harness/shared';

export interface PullRequest {
  id: number;
  url: string;
  branch: string;
}

export type RebaseResult =
  | { status: 'clean' }
  | { status: 'conflicts'; paths: string[] }
  | { status: 'not_needed' };

export class BitbucketClient {
  constructor(
    private readonly config: BitbucketConfig,
    private readonly log: Logger,
  ) {}

  /** TODO: clone into `destination`, checking out `branch` when supplied. */
  async clone(_repo: RepositoryRef, _destination: string, _branch?: string): Promise<void> {
    throw new Error('BitbucketClient.clone not implemented');
  }

  /** TODO: push the working branch. Force-with-lease after a rebase. */
  async pushBranch(_workdir: string, _branch: string, _force?: boolean): Promise<void> {
    throw new Error('BitbucketClient.pushBranch not implemented');
  }

  /**
   * TODO: POST /2.0/repositories/{workspace}/{repo}/pullrequests
   *
   * Must be idempotent — a redelivered work item re-runs this. Look for an open
   * PR from the same source branch first and return it rather than creating a
   * duplicate.
   */
  async openPullRequest(_args: {
    repo: RepositoryRef;
    branch: string;
    title: string;
    description: string;
  }): Promise<PullRequest> {
    throw new Error('BitbucketClient.openPullRequest not implemented');
  }

  /**
   * TODO: POST .../pullrequests/{id}/approve
   *
   * Note this approves as whichever account owns BITBUCKET_TOKEN. If the repo
   * requires approval from someone other than the PR author, the reviewer agent
   * needs its own Bitbucket identity — worth checking against the repo's merge
   * checks before assuming a single token works for both agents.
   */
  async approvePullRequest(_repo: RepositoryRef, _id: number): Promise<void> {
    throw new Error('BitbucketClient.approvePullRequest not implemented');
  }

  /** TODO: POST .../pullrequests/{id}/comments, optionally inline on a path/line. */
  async commentOnPullRequest(
    _repo: RepositoryRef,
    _id: number,
    _feedback: ReviewFeedback,
  ): Promise<void> {
    throw new Error('BitbucketClient.commentOnPullRequest not implemented');
  }

  /**
   * Rebase the working branch onto its base.
   *
   * TODO: `git fetch origin <base>` then `git rebase origin/<base>`.
   *
   * Conflicts are the interesting case and the reason this returns a result
   * rather than throwing: a rebase that cannot be completed mechanically is
   * exactly when the implementer agent should take over and resolve it, and
   * that resolution must NOT consume a review attempt. Abort the rebase before
   * returning `conflicts` so the working tree is left clean.
   */
  async rebaseOntoBase(_workdir: string, _baseBranch: string): Promise<RebaseResult> {
    throw new Error('BitbucketClient.rebaseOntoBase not implemented');
  }

  /** Branch name derived from the issue key, so reruns land on the same branch. */
  static branchNameFor(issueKey: string, title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    return `agent/${issueKey.toLowerCase()}${slug ? `-${slug}` : ''}`;
  }
}
