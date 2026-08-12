/**
 * Bitbucket, read-only.
 *
 * The watcher polls PR state for two reasons: merge conflicts have no
 * Jira-side signal (nothing about the ticket changes when someone else merges
 * to the base branch), and neither does the human's merge. It also reads the
 * repo's manifest, which is what selects the runtime — and therefore the queue
 * and the image — before anything is dispatched.
 *
 * IMPLEMENTED: readManifest and findPullRequestForIssue, both of which run on
 * the dispatch path for every ticket. getPullRequest is still a stub; see the
 * note on it.
 *
 * Auth mirrors preflight, which is the shape verified against live credentials.
 * Two credential types are current and they present differently over the REST
 * API:
 *
 *   - a repository or workspace access token -> `Bearer <token>`
 *   - an Atlassian API token with Bitbucket scopes -> Basic email:token
 *
 * App passwords, the third historical option, were removed in July 2026. Bearer
 * is tried first and Basic is the fallback when a 401 comes back and an email is
 * configured to pair with; the scheme that works is remembered so the retry is
 * paid once per process, not once per call.
 */

import {
  MANIFEST_FILENAMES,
  type BitbucketConfig,
  type Logger,
  type PullRequestState,
  type RepositoryRef,
} from '@cloud-harness/shared';

const API_BASE = 'https://api.bitbucket.org/2.0';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long a manifest read is reused. This is called for every pipeline ticket
 * on every tick and the answer changes about once a year, so the only thing the
 * TTL really governs is how long a repo waits to see an edit to its own
 * manifest take effect.
 */
const MANIFEST_TTL_MS = 5 * 60_000;

/** Carries the HTTP status so callers can tell "absent" from "denied". */
export class BitbucketError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BitbucketError';
  }
}

interface CachedManifest {
  source: string | undefined;
  readAt: number;
}

interface BitbucketPullRequest {
  id?: number;
  state?: string;
  links?: { html?: { href?: string } };
  source?: { branch?: { name?: string } };
}

/**
 * The branch prefix the implementer names its branches with, for one issue.
 *
 * Kept in sync with BitbucketClient.branchNameFor on the agent side, which
 * produces `agent/<issue-key-lowercase>[-<slug>]`. The two cannot share code —
 * different service, different package — so a change to either must be made in
 * both.
 */
function branchPrefixFor(issueKey: string): string {
  return `agent/${issueKey.toLowerCase()}`;
}

export class BitbucketReader {
  /** Which auth scheme this token actually works with, once discovered. */
  private scheme: 'bearer' | 'basic' | undefined;
  private readonly manifests = new Map<string, CachedManifest>();

  constructor(
    private readonly config: BitbucketConfig,
    private readonly log: Logger,
  ) {}

  private header(scheme: 'bearer' | 'basic'): string {
    if (scheme === 'bearer') return `Bearer ${this.config.token}`;
    const encoded = Buffer.from(`${this.config.email}:${this.config.token}`).toString('base64');
    return `Basic ${encoded}`;
  }

  /**
   * GET a path under /2.0, returning the raw Response so callers can decide
   * what a 404 means — absent for a manifest, no PR yet for a lookup, and only
   * an error for neither.
   */
  private async get(path: string): Promise<Response> {
    const url = `${API_BASE}${path}`;
    const send = async (scheme: 'bearer' | 'basic'): Promise<Response> =>
      fetch(url, {
        headers: { authorization: this.header(scheme), accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

    if (this.scheme !== undefined) return send(this.scheme);

    const bearer = await send('bearer');
    if (bearer.status !== 401 || this.config.email === undefined) {
      // A non-401 means the credential was understood, whatever the outcome.
      if (bearer.status !== 401) this.scheme = 'bearer';
      return bearer;
    }

    const basic = await send('basic');
    if (basic.status !== 401) {
      this.scheme = 'basic';
      this.log.debug('bitbucket credential is an atlassian api token', { role: this.config.role });
    }
    return basic;
  }

  /** Read a JSON body, or throw with enough detail to act on. */
  private async json<T>(response: Response, what: string): Promise<T> {
    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable body>');
      throw new BitbucketError(
        `${what} failed as the ${this.config.role} identity: ` +
          `HTTP ${response.status} ${detail.slice(0, 300)}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  /**
   * Find the agent's PR for an issue, by branch naming convention.
   *
   * Deliberately derived rather than read from a Jira field: the implementer
   * names its branch `agent/<issue-key>-<slug>`, so Bitbucket itself is the
   * source of truth for whether a PR exists and what state it is in. A Jira
   * remote link is a convenience for humans, not something the pipeline trusts
   * — if someone deletes it, nothing breaks.
   *
   * OPEN wins over MERGED: a reopened piece of work is the live one, and a
   * merged PR is only interesting because it drives the ticket to Done. Both
   * are asked for in a single query because the common case — a ticket that has
   * never been implemented — should cost one call, not two.
   */
  async findPullRequestForIssue(
    repo: RepositoryRef,
    issueKey: string,
  ): Promise<PullRequestState | undefined> {
    const prefix = branchPrefixFor(issueKey);

    // `~` is "contains" in Bitbucket's query language, so this is a filter, not
    // a decision — the exact prefix test below is what actually accepts a
    // branch. Without it KAN-6 would match a branch for KAN-60.
    const params = new URLSearchParams({
      q: `source.branch.name ~ "${prefix}"`,
      sort: '-updated_on',
      pagelen: '20',
      fields: 'values.id,values.state,values.links.html.href,values.source.branch.name',
    });
    // Repeated, not comma-joined: the API treats each `state` as another
    // alternative. Omitting it entirely would default to OPEN only.
    params.append('state', 'OPEN');
    params.append('state', 'MERGED');

    const response = await this.get(
      `/repositories/${repo.workspace}/${repo.slug}/pullrequests?${params.toString()}`,
    );
    const page = await this.json<{ values?: BitbucketPullRequest[] }>(
      response,
      `listing pull requests for ${issueKey}`,
    );

    const candidates = (page.values ?? []).filter((pr) => {
      const branch = pr.source?.branch?.name;
      if (branch === undefined || pr.id === undefined) return false;
      return branch === prefix || branch.startsWith(`${prefix}-`);
    });

    // Already newest-first from the sort, so the first of each state is the one.
    const match =
      candidates.find((pr) => pr.state === 'OPEN') ??
      candidates.find((pr) => pr.state === 'MERGED');
    if (match === undefined) return undefined;

    const id = match.id!;
    return {
      id,
      state: match.state === 'MERGED' ? 'MERGED' : 'OPEN',
      url:
        match.links?.html?.href ??
        `https://bitbucket.org/${repo.workspace}/${repo.slug}/pull-requests/${id}`,
      branch: match.source!.branch!.name!,
      // Not computed here, and not read from here. The list endpoint does not
      // report conflict state, and reconcile() re-fetches the PR through
      // getPullRequest — the only path whose result reaches
      // reconcilePullRequest's mergeable test.
      mergeable: true,
    };
  }

  /**
   * Fetch the raw `.cloud-harness.yml` from the repo's base branch.
   *
   * A single file read, not a clone — the watcher runs on 0.25 vCPU with no git
   * and no working directory, and pulling a repo just to learn which runtime it
   * needs would defeat the point of keeping it small.
   *
   * Returns undefined when the repo has no manifest. That is a normal case, not
   * an error: it means the configured default stack applies. An error here
   * fails the ticket on the board, so the distinction matters — 404 is "say
   * nothing", anything else is "something is wrong with the credential or the
   * repo".
   */
  async readManifest(repo: RepositoryRef): Promise<string | undefined> {
    const key = `${repo.workspace}/${repo.slug}@${repo.baseBranch}`;
    const cached = this.manifests.get(key);
    if (cached !== undefined && Date.now() - cached.readAt < MANIFEST_TTL_MS) {
      return cached.source;
    }

    const source = await this.fetchManifest(repo);
    this.manifests.set(key, { source, readAt: Date.now() });
    return source;
  }

  private async fetchManifest(repo: RepositoryRef): Promise<string | undefined> {
    const branch = encodeURIComponent(repo.baseBranch);

    for (const filename of MANIFEST_FILENAMES) {
      const response = await this.get(
        `/repositories/${repo.workspace}/${repo.slug}/src/${branch}/${filename}`,
      );

      if (response.status === 404) continue;

      if (!response.ok) {
        const detail = await response.text().catch(() => '<unreadable body>');
        throw new BitbucketError(
          `reading ${filename} from ${repo.workspace}/${repo.slug}#${repo.baseBranch} ` +
            `as the ${this.config.role} identity: HTTP ${response.status} ${detail.slice(0, 300)}`,
          response.status,
        );
      }

      // Raw file contents, not JSON — /src serves the blob itself.
      const source = await response.text();
      this.log.debug('read repo manifest', { repo: `${repo.workspace}/${repo.slug}`, filename });
      return source;
    }

    // Every filename 404'd, which is *usually* "this repo has no manifest" — a
    // normal case meaning the default stack applies. But Bitbucket answers 404
    // for a repository the credential cannot see, with the same status and a
    // body that only differs in wording, so the two are indistinguishable here.
    //
    // Left alone, a permissions gap becomes "use the default stack", and a Java
    // repo the read identity was never granted gets its tests run in the Node
    // image — silently, which is the one outcome runtime resolution exists to
    // prevent. So confirm the repo is actually visible before reporting
    // absence. One extra call, only on the path where no manifest was found.
    const probe = await this.get(`/repositories/${repo.workspace}/${repo.slug}`);
    if (!probe.ok) {
      const detail = await probe.text().catch(() => '<unreadable body>');
      throw new BitbucketError(
        `${repo.workspace}/${repo.slug} is not readable by the ${this.config.role} identity ` +
          `(HTTP ${probe.status}). A repository access token only covers the one repository ` +
          `it was created for; a workspace access token covers all of them. ` +
          `This is NOT the same as the repo having no manifest, so the default stack ` +
          `is deliberately not applied. ${detail.slice(0, 200)}`,
        probe.status,
      );
    }

    this.log.debug('no manifest in repo', {
      repo: `${repo.workspace}/${repo.slug}`,
      branch: repo.baseBranch,
    });
    return undefined;
  }

  /**
   * TODO: GET /2.0/repositories/{workspace}/{repo}/pullrequests/{id}
   *
   * Still a stub, and off the refine path — a ticket being refined has no agent
   * branch, so findPullRequestForIssue returns undefined and reconcile() never
   * asks. It blocks the implementer and reviewer, not the refiner.
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
