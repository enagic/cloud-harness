/**
 * Bitbucket, agent side — clone, push, PR lifecycle, rebase.
 *
 * IMPLEMENTED: everything the implementer and the reviewer need — clone, commit,
 * push, open a pull request, read its diff, read and write its comments, and
 * approve it. Rebase is the one remaining stub.
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

import {
  isAgentComment,
  signAgentComment,
  type BitbucketConfig,
  type Logger,
  type PullRequestComment,
  type RepositoryRef,
} from '@cloud-harness/shared';

import { runCommand } from '../runtime/exec.js';

export interface PullRequest {
  id: number;
  url: string;
  branch: string;
}

/**
 * One comment to post: the text, and where it goes.
 *
 * One finding per call, which is the shape decision 9 settled on. The signature
 * this used to have took a whole `ReviewFeedback` and could therefore only
 * produce a single comment carrying every finding — and every reply to it would
 * have had to say which of the five findings it meant. Each finding is a thread
 * someone answers; threading does that pairing for free.
 *
 * The anchor is validated by the caller against the diff, not here and not by
 * Bitbucket — see reviewer/diff.ts for why there is nothing to validate against
 * at this layer.
 */
export interface PullRequestCommentDraft {
  text: string;
  /** Set for a file-level or line-level comment. */
  path?: string;
  /** Set only with `path`, for a line-level comment. */
  line?: number;
  /** Set to reply in an existing thread rather than start one. */
  parentId?: number;
}

/**
 * What came back from asking to approve.
 *
 * A discriminated result rather than void, because one refusal is expected and
 * is not a fault: Bitbucket does not count an approval from a pull request's own
 * author, and in the sandbox one token is the read, implementer and reviewer
 * identity all at once. The reviewer's verdict is its own; the approval is a
 * formality that a single-identity deployment cannot express. Anything else
 * throws, because a reviewer that silently fails to approve is worse than one
 * that fails loudly.
 */
export type ApprovalResult = { status: 'approved' } | { status: 'refused'; reason: string };

/** Bitbucket's comment representation, narrowed to what the pipeline reads. */
interface BitbucketComment {
  id?: number;
  content?: { raw?: string };
  deleted?: boolean;
  parent?: { id?: number };
  /** Present once the thread is resolved; absent while it is open. */
  resolution?: unknown;
  inline?: { path?: string; to?: number | null; from?: number | null };
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
/** Pages of pull request comments to follow. 100 per page; a bound, not a target. */
const COMMENT_PAGE_LIMIT = 5;

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
    const response = await this.send(path, init);

    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable body>');
      throw new BitbucketApiError(
        `${init.method ?? 'GET'} ${path} failed as the ${this.config.role} identity: ` +
          `HTTP ${response.status} ${detail.slice(0, 300)}`,
        response.status,
      );
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  /**
   * The raw request, with the Bearer-then-Basic scheme discovery the watcher's
   * reader uses. The scheme that works is remembered, so the retry is paid once
   * per process rather than once per call.
   *
   * Separate from api() because the diff resource answers in text/plain, not
   * JSON, and parsing it as JSON would fail on a perfectly good response.
   */
  private async send(
    path: string,
    init: { method?: string; body?: unknown } = {},
    accept = 'application/json',
  ): Promise<Response> {
    const url = `${API_BASE}${path}`;
    const attempt = async (scheme: 'bearer' | 'basic'): Promise<Response> =>
      fetch(url, {
        method: init.method ?? 'GET',
        headers: {
          authorization: this.apiHeader(scheme),
          accept,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

    if (this.scheme !== undefined) return attempt(this.scheme);

    const bearer = await attempt('bearer');
    if (bearer.status !== 401 || this.config.email === undefined) {
      if (bearer.status !== 401) this.scheme = 'bearer';
      return bearer;
    }

    const basic = await attempt('basic');
    if (basic.status !== 401) this.scheme = 'basic';
    return basic;
  }

  private apiHeader(scheme: 'bearer' | 'basic'): string {
    if (scheme === 'bearer') return `Bearer ${this.config.token}`;
    const encoded = Buffer.from(`${this.config.email}:${this.config.token}`).toString('base64');
    return `Basic ${encoded}`;
  }

  /**
   * The pull request's diff, as unified text.
   *
   * Read from Bitbucket rather than computed with git, for two reasons. The
   * workspace is cloned `--single-branch`, so the base branch is not even in it
   * and computing a diff would mean a second authenticated fetch. More
   * importantly this endpoint is the *three-dot* diff, computed from the merge
   * base — the same one the pull request page shows, so its line numbers are the
   * ones an inline comment's `to` is interpreted against. A locally computed
   * two-dot diff would number the same change differently the moment the base
   * branch moved, and every anchor would be quietly off.
   *
   * It 302s to a `/diff/{spec}?topic=true` URL; fetch follows that on its own.
   */
  async getPullRequestDiff(repo: RepositoryRef, id: number): Promise<string> {
    const path = `/repositories/${repo.workspace}/${repo.slug}/pullrequests/${id}/diff`;
    const response = await this.send(path, {}, 'text/plain');

    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable body>');
      throw new BitbucketApiError(
        `reading the diff of pull request ${id} as the ${this.config.role} identity: ` +
          `HTTP ${response.status} ${detail.slice(0, 300)}`,
        response.status,
      );
    }

    const diff = await response.text();
    this.log.info('read pull request diff', { id, bytes: diff.length });
    return diff;
  }

  /**
   * Every comment on the pull request, oldest first, tagged rather than filtered.
   *
   * This is the reviewer's memory and the implementer's brief, and decision 10
   * is the whole design of it: **no agent assumes it is the first pass.** A
   * resolved thread, a finding the implementer argued down, a thread resolved
   * and then reopened — those are exactly what stops the reviewer raising
   * something that was already settled, and re-raising a settled disagreement is
   * how the attempt budget gets burned. So resolution travels as metadata and
   * nothing is dropped. The refiner already shipped the other version of this
   * once, as `getHumanComments`, and it handed a second pass the human's answers
   * with the questions removed.
   *
   * Authorship comes from the pipeline's own signature, not from the account
   * that posted the comment. The account looks like the stronger signal here —
   * Bitbucket identities are split three ways precisely so the system can tell
   * its own work from a human's — but that split does not exist in the sandbox,
   * where one token is all three, and under it an author check is not weak but
   * inverted: every comment reads as the pipeline's, including the human's
   * replies. The signature is true wherever it is read and whoever posted it.
   *
   * Deleted comments are skipped: Bitbucket tombstones them with the text
   * removed, so they carry nothing but a hole in the numbering.
   */
  async listPullRequestComments(
    repo: RepositoryRef,
    id: number,
  ): Promise<PullRequestComment[]> {
    const comments: PullRequestComment[] = [];
    let path: string | undefined =
      `/repositories/${repo.workspace}/${repo.slug}/pullrequests/${id}` +
      `/comments?pagelen=100&sort=created_on`;

    // Bounded rather than open: a pathological thread should cost a fixed number
    // of calls, and anything past a few hundred comments is not going into a
    // prompt regardless.
    for (let page = 0; page < COMMENT_PAGE_LIMIT && path !== undefined; page += 1) {
      const body: { values?: BitbucketComment[]; next?: string } = await this.api(path);

      for (const comment of body.values ?? []) {
        if (comment.deleted === true) continue;
        const text = comment.content?.raw?.trim();
        if (comment.id === undefined || text === undefined || text === '') continue;

        comments.push({
          id: comment.id,
          ...(comment.parent?.id === undefined ? {} : { parentId: comment.parent.id }),
          author: isAgentComment(text) ? 'agent' : 'human',
          text,
          // Presence is the signal. A resolved comment carries a
          // `comment_resolution` object; an open one has no such key at all.
          resolved: comment.resolution !== undefined && comment.resolution !== null,
          ...(comment.inline?.path === undefined ? {} : { path: comment.inline.path }),
          ...(typeof comment.inline?.to === 'number' ? { line: comment.inline.to } : {}),
        });
      }

      // `next` is an absolute URL; api() takes a path under /2.0.
      path = body.next === undefined ? undefined : body.next.replace(API_BASE, '');
    }

    this.log.info('read pull request comments', {
      id,
      comments: comments.length,
      resolved: comments.filter((comment) => comment.resolved).length,
    });
    return comments;
  }

  /**
   * Post one comment, at the tightest anchor its caller could resolve.
   *
   * One finding per call. The three tiers are expressed by what is sent, and
   * they are verified against live Bitbucket: `inline: {path, to}` is a line,
   * `inline: {path}` is the file, and no `inline` at all is the pull request.
   *
   * **The anchor is the caller's problem, and it has to be.** Bitbucket accepts
   * an inline comment on a line that is not in the diff, and on a path that is
   * not in the pull request, with 201 and no complaint — the comment is created
   * attached to nothing. There is no rejection to catch here, which is why
   * reviewer/diff.ts resolves the anchor before this is called.
   *
   * Signed on the way out, exactly as the Jira comments are, so a later pass can
   * tell its own findings from a human's replies to them.
   */
  async commentOnPullRequest(
    repo: RepositoryRef,
    id: number,
    draft: PullRequestCommentDraft,
  ): Promise<number> {
    const inline =
      draft.path === undefined
        ? undefined
        : {
            path: draft.path,
            ...(draft.line === undefined ? {} : { to: draft.line }),
          };

    const created = await this.api<BitbucketComment>(
      `/repositories/${repo.workspace}/${repo.slug}/pullrequests/${id}/comments`,
      {
        method: 'POST',
        body: {
          content: { raw: signAgentComment(draft.text) },
          ...(inline === undefined ? {} : { inline }),
          ...(draft.parentId === undefined ? {} : { parent: { id: draft.parentId } }),
        },
      },
    );

    if (typeof created.id !== 'number') {
      throw new Error(`Bitbucket returned a comment with no id on pull request ${id}`);
    }

    this.log.info('commented on pull request', {
      id,
      commentId: created.id,
      anchor: draft.path === undefined ? 'pull_request' : draft.line === undefined ? 'file' : 'line',
      ...(draft.parentId === undefined ? {} : { inReplyTo: draft.parentId }),
    });
    return created.id;
  }

  /**
   * Approve the pull request as this identity.
   *
   * Refusal is a result, not an exception, and only for the one case that is
   * expected: Bitbucket does not count an approval from a pull request's own
   * author, and the sandbox runs the read, implementer and reviewer identities
   * off a single token — so the reviewer is the author of every PR it reviews
   * there. That is the deployment's shape rather than a fault in the reviewer,
   * and failing the ticket over it would strand work that passed its review.
   *
   * Everything else throws. A reviewer whose approval silently does not land is
   * worse than one that stops, because the pull request then sits in
   * `Awaiting Merge` looking reviewed and carrying no approval.
   */
  async approvePullRequest(repo: RepositoryRef, id: number): Promise<ApprovalResult> {
    try {
      await this.api(`/repositories/${repo.workspace}/${repo.slug}/pullrequests/${id}/approve`, {
        method: 'POST',
      });
      this.log.info('approved pull request', { id });
      return { status: 'approved' };
    } catch (err) {
      // 400 is what a self-approval comes back as. 409 is included because
      // "already approved by this account" is the same kind of answer — the
      // desired state holds and there is nothing to retry.
      if (err instanceof BitbucketApiError && (err.status === 400 || err.status === 409)) {
        this.log.warn('approval was refused; the review verdict stands regardless', {
          id,
          role: this.config.role,
          status: err.status,
          detail: err.message,
        });
        return { status: 'refused', reason: err.message };
      }
      throw err;
    }
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
