/**
 * Bitbucket, agent side — clone, push, PR lifecycle, rebase.
 *
 * IMPLEMENTED: clone, commit, push, and opening a pull request — everything the
 * implementer's first pass needs. Approve, comment and rebase are still stubbed.
 *
 * Two transports live in this one class and they authenticate differently.
 * Git over HTTPS takes the credential through GIT_ASKPASS (see withCredentials);
 * the REST API takes it in an Authorization header, Bearer or Basic depending on
 * the credential type, exactly as the watcher's reader does. They are kept
 * together because they are one identity, but note they are not one migration:
 * clone/commit/push/rebase will never be MCP tools no matter what Atlassian
 * ships, while the pull request calls are the actual candidates.
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

/** Carries the HTTP status so callers can tell "absent" from "denied". */
export class BitbucketApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BitbucketApiError';
  }
}

/** What `commitAll` did, so a caller can tell "nothing to commit" from a commit. */
export interface CommitResult {
  /** False when the working tree was already clean — the model changed nothing. */
  committed: boolean;
  /** Repo-relative paths in the commit, from `git diff --name-only`. */
  changedPaths: string[];
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
const GIT_TIMEOUT_MS = 5 * 60_000;
const API_BASE = 'https://api.bitbucket.org/2.0';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Single-quote a value for `bash -lc`, which is how runCommand executes.
 *
 * Branch names come off a work item that a human influenced, so none of these
 * are trusted enough to interpolate raw.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The subset of Bitbucket's PR representation this client relies on. */
interface BitbucketPullRequest {
  id?: number;
  links?: { html?: { href?: string } };
  source?: { branch?: { name?: string } };
}

/**
 * Narrow Bitbucket's PR JSON to the three fields the pipeline carries.
 *
 * `id` is required — it is what the reviewer approves and comments against, and
 * a PR without one cannot be acted on later, so this fails here rather than
 * letting a zero travel downstream on the work item.
 */
function toPullRequest(pr: BitbucketPullRequest, branch: string): PullRequest {
  if (typeof pr.id !== 'number') {
    throw new Error(`Bitbucket returned a pull request with no id for branch ${branch}`);
  }
  return {
    id: pr.id,
    url: pr.links?.html?.href ?? '',
    branch: pr.source?.branch?.name ?? branch,
  };
}

export class BitbucketClient {
  /** Which auth scheme this token actually works with, once discovered. */
  private scheme: 'bearer' | 'basic' | undefined;

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
   * The commit author's email.
   *
   * A repository access token has no associated user and therefore no email, so
   * there is nothing truthful to put here — the noreply form says "a machine did
   * this" rather than attributing the commit to a person who did not.
   */
  private get commitEmail(): string {
    return this.config.email ?? `${this.config.role}@users.noreply.bitbucket.org`;
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

  /**
   * Run a git command in the workspace, throwing with its output on failure.
   *
   * Local git only. Anything that talks to the remote goes through
   * withCredentials, because without GIT_ASKPASS a credential prompt hangs
   * until the command timeout rather than failing.
   */
  private async git(workdir: string, command: string, env?: Record<string, string>): Promise<string> {
    const result = await runCommand(`git ${command}`, {
      cwd: workdir,
      log: this.log,
      timeoutMs: GIT_TIMEOUT_MS,
      ...(env === undefined ? {} : { env }),
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `git ${command} failed (exit ${result.exitCode ?? 'null'}` +
          `${result.timedOut ? ', timed out' : ''}) as the ${this.config.role} identity: ` +
          result.output.slice(-500),
      );
    }
    return result.output;
  }

  /**
   * Start a new branch off whatever is currently checked out.
   *
   * `checkout -B` rather than `-b`: a redelivered work item re-runs this against
   * a workspace that is freshly cloned but a branch name that may already exist
   * locally, and failing there would strand the item for a reason that does not
   * matter.
   */
  async createBranch(workdir: string, branch: string): Promise<void> {
    await this.git(workdir, `checkout -B ${shellQuote(branch)}`);
    this.log.info('created branch', { branch });
  }

  /**
   * Stage everything and commit, unless the tree is clean.
   *
   * A clean tree is not an error here — it means the model finished without
   * changing a file, which the caller reports as a failed implementation rather
   * than pushing an empty branch and opening an empty PR.
   *
   * The identity is the agent's, not a person's. Bitbucket attributes the PR to
   * whichever account owns the token regardless of what is in the commit, so
   * this is only about what `git log` reads like — and it should read as the
   * pipeline, so a human scanning history can tell at a glance.
   */
  async commitAll(workdir: string, message: string): Promise<CommitResult> {
    await this.git(workdir, `config user.name ${shellQuote(`cloud-harness ${this.config.role}`)}`);
    await this.git(workdir, `config user.email ${shellQuote(this.commitEmail)}`);

    await this.git(workdir, 'add -A');

    // --cached, because everything is staged by the line above. `git status
    // --porcelain` would also catch files the repo ignores, which are not going
    // into the commit and must not be reported as though they were.
    const staged = await this.git(workdir, 'diff --cached --name-only');
    const changedPaths = staged
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (changedPaths.length === 0) {
      this.log.warn('nothing to commit; the working tree is clean');
      return { committed: false, changedPaths: [] };
    }

    // The message is model-written and reaches `bash -lc`, so it is quoted like
    // every other untrusted value here rather than heredoc'd.
    await this.git(workdir, `commit -m ${shellQuote(message)}`);
    this.log.info('committed', { files: changedPaths.length, message: message.split('\n')[0] });

    return { committed: true, changedPaths };
  }

  /**
   * Push the working branch, setting upstream so a later rebase can force-push.
   *
   * `--force-with-lease` rather than `--force` for the rebase path: it refuses
   * if the remote moved since this workspace last saw it, which is the case
   * where something else is on the branch and clobbering it would lose work.
   */
  async pushBranch(workdir: string, branch: string, force = false): Promise<void> {
    const args = [
      'push',
      ...(force ? ['--force-with-lease'] : []),
      '--set-upstream',
      'origin',
      shellQuote(branch),
    ];

    await this.withCredentials(async (env) => this.git(workdir, args.join(' '), env));
    this.log.info('pushed branch', { branch, force });
  }

  /**
   * Open a pull request from `branch`, or return the one that is already open.
   *
   * Idempotent because a redelivered work item re-runs the whole handler: the
   * branch is pushed again (a no-op) and this is called again, and a second PR
   * from the same source branch would leave two reviews of one change. The
   * lookup is by source branch rather than by anything stored, because nothing
   * is stored — a redelivery is a fresh process with a fresh clone.
   */
  async openPullRequest(args: {
    repo: RepositoryRef;
    branch: string;
    title: string;
    description: string;
  }): Promise<PullRequest> {
    const { repo, branch, title, description } = args;
    const path = `/repositories/${repo.workspace}/${repo.slug}/pullrequests`;

    const existing = await this.findOpenPullRequest(repo, branch);
    if (existing !== undefined) {
      this.log.info('pull request already open for this branch', {
        branch,
        id: existing.id,
      });
      return existing;
    }

    const created = await this.api<BitbucketPullRequest>(path, {
      method: 'POST',
      body: {
        title,
        description,
        source: { branch: { name: branch } },
        destination: { branch: { name: repo.baseBranch } },
        // The human merges (gate 2) and decides what happens to the branch.
        close_source_branch: false,
      },
    });

    const pr = toPullRequest(created, branch);
    this.log.info('opened pull request', { id: pr.id, url: pr.url, branch });
    return pr;
  }

  /** The open PR from `branch`, if there is one. */
  private async findOpenPullRequest(
    repo: RepositoryRef,
    branch: string,
  ): Promise<PullRequest | undefined> {
    // The query language wants the value double-quoted; the branch name is
    // ours (branchNameFor) but escape anyway rather than rely on that.
    const q = `source.branch.name="${branch.replace(/"/g, '\\"')}" AND state="OPEN"`;
    const path =
      `/repositories/${repo.workspace}/${repo.slug}/pullrequests` +
      `?q=${encodeURIComponent(q)}&pagelen=5`;

    const page = await this.api<{ values?: BitbucketPullRequest[] }>(path);
    const match = (page.values ?? [])[0];
    return match === undefined ? undefined : toPullRequest(match, branch);
  }

  /**
   * A REST call under /2.0, with the Bearer-then-Basic scheme discovery the
   * watcher's reader uses. The scheme that works is remembered, so the retry is
   * paid once per process rather than once per call.
   */
  private async api<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const url = `${API_BASE}${path}`;
    const send = async (scheme: 'bearer' | 'basic'): Promise<Response> =>
      fetch(url, {
        method: init.method ?? 'GET',
        headers: {
          authorization: this.apiHeader(scheme),
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

    let response: Response;
    if (this.scheme !== undefined) {
      response = await send(this.scheme);
    } else {
      response = await send('bearer');
      if (response.status === 401 && this.config.email !== undefined) {
        response = await send('basic');
        if (response.status !== 401) this.scheme = 'basic';
      } else if (response.status !== 401) {
        this.scheme = 'bearer';
      }
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable body>');
      throw new BitbucketApiError(
        `${init.method ?? 'GET'} ${path} failed as the ${this.config.role} identity: ` +
          `HTTP ${response.status} ${detail.slice(0, 300)}`,
        response.status,
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private apiHeader(scheme: 'bearer' | 'basic'): string {
    if (scheme === 'bearer') return `Bearer ${this.config.token}`;
    const encoded = Buffer.from(`${this.config.email}:${this.config.token}`).toString('base64');
    return `Basic ${encoded}`;
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

  /**
   * TODO: POST .../pullrequests/{id}/comments
   *
   * This signature is wrong and should change when it is implemented. Taking the
   * whole ReviewFeedback can only produce one comment carrying every finding,
   * which is the shape decision 9 rejects: each finding is a thread someone
   * replies to, and five findings in one comment forces every reply to say which
   * of the five it means. Take a single finding and call this once per finding.
   *
   * Anchoring is three-tier and falls out of the finding: path + line is inline,
   * path alone is file-level, neither is PR-level. `summary` and `verification`
   * are the PR-level pair. An anchor Bitbucket rejects degrades outward rather
   * than dropping the finding.
   *
   * Reading comments back is a separate gap: nothing in this codebase can list a
   * PR's comments, and decision 10 makes that a precondition for the reviewer,
   * which must see its own prior threads — resolved ones included — before it
   * reviews anything.
   */
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
