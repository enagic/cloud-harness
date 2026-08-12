/**
 * Bitbucket, agent side — clone, push, PR lifecycle, rebase.
 *
 * IMPLEMENTED: clone, the read path the refiner needs. The write path (push,
 * PR lifecycle, rebase) is still stubbed.
 *
 * Auth: the token is injected from Secrets Manager, per identity — see
 * loadBitbucketConfig. Two credential types are current and they authenticate
 * differently over HTTPS:
 *
 *   - a repository or workspace access token -> git username `x-token-auth`
 *   - an Atlassian API token with Bitbucket scopes -> git username = the email
 *
 * App passwords, the third historical option, were removed in July 2026.
 *
 * The token reaches git through GIT_ASKPASS and never through the URL, so it
 * stays out of `git remote -v`, out of .git/config, out of the process argument
 * list, and out of every logged command line. Only the username — which is not
 * a secret — is embedded in the remote.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BitbucketConfig, Logger, RepositoryRef, ReviewFeedback } from '@cloud-harness/shared';

import { runCommand } from '../runtime/exec.js';

export interface PullRequest {
  id: number;
  url: string;
  branch: string;
}

export type RebaseResult =
  | { status: 'clean' }
  | { status: 'conflicts'; paths: string[] }
  | { status: 'not_needed' };

export interface CloneOptions {
  /**
   * Truncate history to this many commits. A reader wants 1; anything that
   * rebases wants the full history, because a shallow clone cannot replay
   * commits onto a base branch it does not have.
   */
  depth?: number;
}

const CLONE_TIMEOUT_MS = 10 * 60_000;

/**
 * Single-quote a value for `bash -lc`, which is how runCommand executes.
 *
 * Branch names come off a work item that a human influenced, so none of these
 * are trusted enough to interpolate raw.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class BitbucketClient {
  constructor(
    private readonly config: BitbucketConfig,
    private readonly log: Logger,
  ) {}

  /**
   * The git username for this credential. Not a secret — see the file header
   * for why the token itself never travels this way.
   */
  private get gitUsername(): string {
    return this.config.email ?? 'x-token-auth';
  }

  /**
   * Clone into `destination`, checking out `branch` when supplied.
   *
   * `destination` is expected to exist and be empty — prepareWorkspace makes it
   * with mkdtemp.
   */
  async clone(
    repo: RepositoryRef,
    destination: string,
    branch?: string,
    options: CloneOptions = {},
  ): Promise<void> {
    const target = branch ?? repo.baseBranch;
    const url = `https://${encodeURIComponent(this.gitUsername)}@bitbucket.org/${repo.workspace}/${repo.slug}.git`;

    const args = [
      'clone',
      '--single-branch',
      `--branch ${shellQuote(target)}`,
      ...(options.depth === undefined ? [] : [`--depth ${options.depth}`]),
      shellQuote(url),
      shellQuote(destination),
    ];

    const result = await this.withCredentials(async (env) =>
      runCommand(`git ${args.join(' ')}`, {
        cwd: tmpdir(),
        log: this.log,
        env,
        timeoutMs: CLONE_TIMEOUT_MS,
      }),
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `git clone of ${repo.workspace}/${repo.slug}#${target} failed ` +
          `(exit ${result.exitCode ?? 'null'}${result.timedOut ? ', timed out' : ''}) ` +
          `as the ${this.config.role} identity: ${result.output.slice(-500)}`,
      );
    }

    this.log.info('cloned repository', {
      repo: `${repo.workspace}/${repo.slug}`,
      branch: target,
      depth: options.depth ?? 'full',
      durationMs: result.durationMs,
    });
  }

  /**
   * Run something with git credentials available, then take them away again.
   *
   * GIT_ASKPASS points at a throwaway script that echoes the credential from
   * its own environment. Environment beats the alternatives: a URL-embedded
   * token is persisted into .git/config by clone, and `-c http.extraHeader` is
   * visible to anyone who can read the process list.
   */
  private async withCredentials<T>(
    fn: (env: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'ch-git-'));
    const askpass = join(dir, 'askpass.sh');

    // git calls this for each prompt and puts the prompt text in $1. It asks
    // for the username too when the remote has none, so answer both.
    await writeFile(
      askpass,
      '#!/bin/sh\ncase "$1" in\n  Username*) printf %s "$CH_GIT_USERNAME" ;;\n  *) printf %s "$CH_GIT_PASSWORD" ;;\nesac\n',
      { mode: 0o700 },
    );

    try {
      return await fn({
        GIT_ASKPASS: askpass,
        CH_GIT_USERNAME: this.gitUsername,
        CH_GIT_PASSWORD: this.config.token,
        // Without this a missing or rejected credential hangs on a tty prompt
        // that will never be answered, until the command timeout fires.
        GIT_TERMINAL_PROMPT: '0',
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
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
