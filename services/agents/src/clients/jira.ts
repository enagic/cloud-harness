/**
 * Jira, agent side — the write path.
 *
 * Auth and transport mirror services/watcher/src/jira.ts, which is the one
 * client verified against live credentials. The duplication is deliberate: the
 * two clients stay separate so the watcher's role cannot be widened by
 * accident, and a shared base class would be the seam through which it was.
 *
 * The agent writes its own product and its own transition. That is not a
 * widening of privilege — publishing the story already requires editing the
 * ticket, and once you can do that, moving the card is not a bigger grant. What
 * keeps it safe is the lane check the caller runs first; see readLaneState.
 */

import {
  signAgentComment,
  textToAdf,
  type JiraConfig,
  type Logger,
  type PipelineConfig,
  type TicketMutation,
} from '@cloud-harness/shared';

/** Carries the HTTP status so callers can tell "not found" from "denied". */
export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

/**
 * What the lane guard needs, and nothing else. Deliberately not a
 * TicketSnapshot — the agent has no business reading the board generally.
 *
 * The two in-flight markers are here because the column alone no longer says
 * whether this run is still the one in flight. Four states share Code Review
 * and three share To Do, and what tells them apart is who holds the card.
 */
export interface LaneState {
  status: string;
  labels: string[];
  assigneeAccountId?: string;
  codeReviewerAccountId?: string;
}

/** The refiner's product, beyond the story itself. */
export interface RefinementFields {
  /** The prose story, replacing the description. */
  story: string;
  /** Fibonacci. The workflow requires it before In Progress; absent if unsized. */
  storyPoints?: number;
  /** The criteria list, for the Acceptance Criteria field. */
  acceptanceCriteria?: string;
}

export class JiraWriter {
  constructor(
    private readonly config: JiraConfig,
    private readonly pipeline: PipelineConfig,
    private readonly log: Logger,
  ) {}

  protected get authHeader(): string {
    const encoded = Buffer.from(`${this.config.userEmail}:${this.config.apiToken}`).toString('base64');
    return `Basic ${encoded}`;
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: this.authHeader,
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable body>');
      throw new JiraError(
        `${init.method ?? 'GET'} ${path} failed: ${response.status} ${detail.slice(0, 500)}`,
        response.status,
        url,
      );
    }

    // 204 on transitions and issue updates.
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Re-read the lane and column, immediately before writing.
   *
   * The work item is minutes old by the time an agent finishes, and a human can
   * have taken the ticket back in that window. Dispatch-time consent is not
   * consent now, so every write is preceded by this.
   *
   * Not atomic with the write that follows — Jira offers no compare-and-swap on
   * issue edit — but it shrinks the window from the length of a whole run to the
   * gap between two calls.
   */
  async readLaneState(issueKey: string): Promise<LaneState> {
    const reviewerField = this.pipeline.fields.codeReviewer;
    const issue = await this.request<{
      fields?: {
        status?: { name?: string };
        labels?: string[];
        assignee?: { accountId?: string } | null;
      } & Record<string, unknown>;
    }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}` +
        `?fields=status,labels,assignee,${encodeURIComponent(reviewerField)}`,
    );

    const state: LaneState = {
      status: issue.fields?.status?.name ?? '',
      labels: issue.fields?.labels ?? [],
    };

    const assignee = issue.fields?.assignee?.accountId;
    if (typeof assignee === 'string') state.assigneeAccountId = assignee;

    const reviewer = issue.fields?.[reviewerField];
    if (typeof reviewer === 'object' && reviewer !== null) {
      const accountId = (reviewer as { accountId?: unknown }).accountId;
      if (typeof accountId === 'string') state.codeReviewerAccountId = accountId;
    }

    return state;
  }

  /**
   * Writes the refined story into the description, plus the two fields the
   * board itself needs, in one call.
   *
   * Replacing is the whole contract. The description is where the story lives,
   * a human edits it in place at the review gate, and a ticket that accumulated
   * every draft would be unreadable within three passes. A human who edited
   * while the ticket was in the agent lane loses that edit — deliberately; Jira
   * keeps the previous value in the issue history if they need it back.
   *
   * Story Points and Acceptance Criteria are written here rather than left in
   * prose because the workflow has required-field validators on them: without a
   * number in the field, gate 1 cannot be passed at all, and a human would be
   * hand-entering one on every single ticket. Story Points is omitted when the
   * model did not size the work — a wrong number in a gated field is worse than
   * an empty one, which at least stops the ticket where a person will see it.
   */
  async publishRefinement(issueKey: string, refinement: RefinementFields): Promise<void> {
    const fields: Record<string, unknown> = {
      description: textToAdf(refinement.story),
    };
    if (refinement.storyPoints !== undefined) {
      fields[this.pipeline.fields.storyPoints] = refinement.storyPoints;
    }
    if (refinement.acceptanceCriteria !== undefined) {
      fields[this.pipeline.fields.acceptanceCriteria] = textToAdf(refinement.acceptanceCriteria);
    }

    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      method: 'PUT',
      body: { fields },
    });
    this.log.info('published refinement', {
      issueKey,
      chars: refinement.story.length,
      storyPoints: refinement.storyPoints,
      criteria: refinement.acceptanceCriteria !== undefined,
    });
  }

  /**
   * Comment, then fields and labels, then status.
   *
   * Every step in that order is chosen so a partial failure leaves the ticket
   * somewhere the next tick handles correctly, and two of the three are load
   * bearing rather than tidy.
   *
   * **The comment goes FIRST**, which is not where it used to be. The refiner's
   * hand-back comment is what tells the state machine this ticket has been
   * refined, and releasing the Assignee is what tells it no agent is working on
   * it. Do those in the other order and there is a window — one HTTP call wide,
   * but the watcher ticks on a timer and will eventually land in it — where the
   * ticket reads as an unrefined draft nobody is holding, and gets refined all
   * over again.
   *
   * **Status goes LAST** so a partial failure leaves the ticket in its old
   * column and the redelivered work item retries cleanly.
   *
   * The in-flight markers matter most on the way out: an agent that finishes
   * without releasing Assignee (or Code Reviewer) leaves the board saying it is
   * still working, and `decide()` believes the board. Clearing is an explicit
   * null — an omitted key leaves the field untouched, which is not the same
   * thing.
   */
  async applyMutation(issueKey: string, mutation: TicketMutation): Promise<void> {
    const key = encodeURIComponent(issueKey);
    const bot = this.pipeline.fields.botAccountId;

    // Signed on the way out. The refiner reads this thread back on its next
    // pass and has to tell its own questions from the answers; it cannot do that
    // from the author account, which may be the same person's. See
    // isAgentComment.
    if (mutation.comment) {
      await this.request(`/rest/api/3/issue/${key}/comment`, {
        method: 'POST',
        body: { body: textToAdf(signAgentComment(mutation.comment)) },
      });
    }

    // One call for all of it: separate calls can interleave with a human edit,
    // and the label update in particular can lose a label.
    const update: Record<string, unknown> = {};

    const labelOps = [
      ...(mutation.addLabels ?? []).map((label) => ({ add: label })),
      ...(mutation.removeLabels ?? []).map((label) => ({ remove: label })),
    ];
    if (labelOps.length > 0) update['labels'] = labelOps;

    if (mutation.assignee !== undefined) {
      update['assignee'] = [{ set: mutation.assignee === 'bot' ? { accountId: bot } : null }];
    }
    if (mutation.codeReviewer !== undefined) {
      update[this.pipeline.fields.codeReviewer] = [
        { set: mutation.codeReviewer === 'bot' ? { accountId: bot } : null },
      ];
    }

    if (Object.keys(update).length > 0) {
      await this.request(`/rest/api/3/issue/${key}`, { method: 'PUT', body: { update } });
    }

    if (mutation.status) {
      await this.transitionTo(issueKey, mutation.status);
    }
  }

  /**
   * Transitions are executed by transition ID, and which IDs exist depends on
   * the issue's current status, so this is fetched per call rather than cached.
   */
  private async transitionTo(issueKey: string, statusName: string): Promise<void> {
    const key = encodeURIComponent(issueKey);
    const available = await this.request<{
      transitions?: Array<{ id: string; name?: string; to?: { name?: string } }>;
    }>(`/rest/api/3/issue/${key}/transitions`);

    const match = (available.transitions ?? []).find((t) => t.to?.name === statusName);
    if (match === undefined) {
      const options = (available.transitions ?? []).map((t) => t.to?.name ?? t.name ?? t.id).join(', ');
      throw new Error(
        `${issueKey}: no transition to "${statusName}" from its current status. ` +
          `Available: ${options || '<none>'}. ` +
          'The board workflow must allow this transition, not just have the status.',
      );
    }

    await this.request(`/rest/api/3/issue/${key}/transitions`, {
      method: 'POST',
      body: { transition: { id: match.id } },
    });
    this.log.info('transitioned', { issueKey, to: statusName });
  }

  /**
   * Attach the PR to the ticket as a remote link.
   *
   * Remote links are how the PR travels to the reviewer without a custom field
   * configured on the project — the watcher reads it back to populate
   * `branch` / `pullRequestUrl` / `pullRequestId` on the review work item, and
   * `dispatch_review` bails out entirely when those are missing.
   *
   * The `globalId` is derived from the PR id, which makes this an upsert: Jira
   * replaces a link with a matching globalId rather than adding a second one, so
   * a redelivered work item re-links instead of littering the ticket.
   */
  async linkPullRequest(
    issueKey: string,
    pr: { url: string; id: number; branch: string },
  ): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/remotelink`, {
      method: 'POST',
      body: {
        globalId: `cloud-harness-pr-${pr.id}`,
        // Not a Jira application link, so `application` is deliberately absent —
        // supplying one asks Jira to resolve an app that is not registered.
        relationship: 'pull request',
        object: {
          url: pr.url,
          title: `PR #${pr.id}: ${pr.branch}`,
          icon: { url16x16: 'https://bitbucket.org/favicon.ico', title: 'Bitbucket' },
        },
      },
    });
    this.log.info('linked pull request', { issueKey, pullRequestId: pr.id });
  }

  /**
   * There is deliberately no `publishReview`.
   *
   * It was a stub with an open question attached — whether review findings
   * survive in Jira as prose or want their own rendering. Decision 9 made the
   * question moot rather than answering it: findings go to the pull request, one
   * comment per finding, anchored at the code they are about. Jira tracks the
   * status of the work and does not carry the payload.
   *
   * What was left for Jira is a transition and a one-line pointer at the pull
   * request, which `applyMutation` already does — so the method dissolved rather
   * than shrank. See reviewer/handle.ts for the caller that would have used it.
   */
}
