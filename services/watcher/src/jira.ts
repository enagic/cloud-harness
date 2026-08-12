/**
 * Jira Cloud REST v3 — read side plus the mutations the watcher applies.
 *
 * Auth is HTTP Basic with email + API token (JIRA_USER_EMAIL / JIRA_API_TOKEN).
 * Atlassian Cloud API tokens (the `ATATT…` format) are used as the password,
 * with the account's email as the username. A Data Center PAT would be
 * `Bearer` instead — see authHeader.
 */

import {
  adfToText,
  isAgentComment,
  signAgentComment,
  textToAdf,
  type JiraConfig,
  type Logger,
  type PipelineConfig,
  type StatusIds,
  type StatusTransition,
  type TicketComment,
  type TicketMutation,
  type TicketSnapshot,
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

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    labels?: string[];
  };
}

/** Only the fields a TicketSnapshot needs. The default set is large and unused. */
const SNAPSHOT_FIELDS = 'summary,description,status,labels';

export class JiraClient {
  /** Resolved once by resolveStatusIds, then reused for JQL and validation. */
  private statusNameToId = new Map<string, string>();

  constructor(
    private readonly config: JiraConfig,
    private readonly pipeline: PipelineConfig,
    private readonly log: Logger,
  ) {}

  protected get authHeader(): string {
    const encoded = Buffer.from(`${this.config.userEmail}:${this.config.apiToken}`).toString('base64');
    return `Basic ${encoded}`;
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
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
   * Resolve configured status NAMES to their Jira status IDs, once at startup.
   *
   * Two different reasons both point at IDs:
   *  - the changelog records the display name as it was *at the time of the
   *    transition*, so a renamed status silently breaks name-based history
   *    counting; the ID never changes.
   *  - transitions are executed by transition ID anyway (see applyMutation).
   *
   * Fails loudly on any configured status the board does not have. A missing
   * status must not be discovered one ticket at a time in production.
   */
  async resolveStatusIds(): Promise<StatusIds> {
    const byIssueType = await this.request<
      Array<{ name?: string; statuses?: Array<{ id: string; name: string }> }>
    >(`/rest/api/3/project/${encodeURIComponent(this.config.projectKey)}/statuses`);

    this.statusNameToId = new Map();
    for (const issueType of byIssueType) {
      for (const status of issueType.statuses ?? []) {
        this.statusNameToId.set(status.name, status.id);
      }
    }

    const configured = Object.entries(this.pipeline.statuses);
    const missing = configured.filter(([, name]) => !this.statusNameToId.has(name));
    if (missing.length > 0) {
      const available = [...this.statusNameToId.keys()].sort().join(', ');
      throw new Error(
        `Jira project ${this.config.projectKey} is missing ${missing.length} configured status(es): ` +
          `${missing.map(([key, name]) => `${key}="${name}"`).join(', ')}. ` +
          `Statuses on this project: ${available || '<none>'}`,
      );
    }

    this.log.info('resolved pipeline statuses', { count: configured.length });

    return {
      readyToImplement: this.statusNameToId.get(this.pipeline.statuses.readyToImplement)!,
      changesRequested: this.statusNameToId.get(this.pipeline.statuses.changesRequested)!,
    };
  }

  /**
   * Every ticket in the project that the pipeline might care about.
   *
   * Returns snapshots with `attempts: 0` — the caller fills that in from
   * getStatusHistory for the tickets where it matters, so the common case costs
   * one search call rather than one call per ticket.
   *
   * Filtered server-side to the pipeline's statuses plus the kickoff label
   * rather than pulling the whole project.
   */
  async listPipelineTickets(): Promise<TicketSnapshot[]> {
    const statuses = Object.values(this.pipeline.statuses)
      .map((name) => `"${name.replace(/"/g, '\\"')}"`)
      .join(', ');
    const jql =
      `project = "${this.config.projectKey}" AND ` +
      `(status IN (${statuses}) OR labels = "${this.pipeline.labels.agentLane}") ` +
      `ORDER BY created ASC`;

    const tickets: TicketSnapshot[] = [];
    let nextPageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        jql,
        fields: SNAPSHOT_FIELDS,
        maxResults: '100',
      });
      if (nextPageToken) params.set('nextPageToken', nextPageToken);

      const page = await this.request<{
        issues?: JiraIssue[];
        nextPageToken?: string;
        isLast?: boolean;
      }>(`/rest/api/3/search/jql?${params.toString()}`);

      for (const issue of page.issues ?? []) {
        tickets.push({
          issueKey: issue.key,
          issueId: issue.id,
          summary: issue.fields.summary ?? '',
          description: adfToText(issue.fields.description),
          status: issue.fields.status?.name ?? '',
          labels: issue.fields.labels ?? [],
          attempts: 0,
        });
      }

      nextPageToken = page.isLast === true ? undefined : page.nextPageToken;
    } while (nextPageToken);

    // The refiner needs the comment thread when a refinement was sent back.
    // That signal used to be a label; now it is a ticket that has come back to
    // a draft column still in the agent lane, which is also what a brand-new
    // ticket looks like. Both are about to be refined and only those pay for
    // the extra call — a first pass simply finds no comments.
    for (const ticket of tickets) {
      if (
        this.pipeline.draftStatuses.includes(ticket.status) &&
        ticket.labels.includes(this.pipeline.labels.agentLane)
      ) {
        ticket.conversation = await this.getConversation(ticket.issueKey);
      }
    }

    return tickets;
  }

  /**
   * The recent comment thread, oldest first, each comment tagged with whether
   * the pipeline wrote it.
   *
   * Tagged, not filtered. An earlier version dropped the pipeline's own comments
   * outright so that review findings could not read back as human feedback —
   * which also discarded the refiner's own questions, handing the next pass a
   * set of answers with the questions removed. Jira issue comments are flat, so
   * order and authorship are the only things pairing a reply to what it answers.
   *
   * The tag comes from the pipeline's signature on the text, not from the
   * comment's author account. See `isAgentComment` for why the account is the
   * wrong signal — in short, the pipeline's Jira identity may be a person's own,
   * and under that configuration an author check is not merely weak, it is
   * inverted.
   */
  private async getConversation(issueKey: string): Promise<TicketComment[]> {
    // Newest first from Jira, then reversed: the cap has to bite at the far end
    // of the history, not the recent end. A long-running ticket loses its
    // oldest exchanges, which are the ones already settled.
    const params = new URLSearchParams({ orderBy: '-created', maxResults: '20' });
    const page = await this.request<{ comments?: Array<{ body?: unknown }> }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?${params.toString()}`,
    );

    return (page.comments ?? [])
      .map((comment) => adfToText(comment.body))
      .filter((text) => text.length > 0)
      .map((text): TicketComment => ({ author: isAgentComment(text) ? 'agent' : 'human', text }))
      .reverse();
  }

  /**
   * Status transitions for one issue, oldest or newest first — countAttempts
   * does not care about ordering.
   *
   * This is the durable record the attempt budget is derived from. Jira exposes
   * no way to edit or delete a changelog entry, which is precisely why the
   * budget lives here instead of in a label or custom field.
   */
  async getStatusHistory(issueKey: string): Promise<StatusTransition[]> {
    const transitions: StatusTransition[] = [];
    let startAt = 0;

    for (;;) {
      const params = new URLSearchParams({ startAt: String(startAt), maxResults: '100' });
      const page = await this.request<{
        values?: Array<{
          created?: string;
          author?: { accountId?: string };
          items?: Array<{ field?: string; from?: string | null; to?: string | null }>;
        }>;
        total?: number;
        isLast?: boolean;
      }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog?${params.toString()}`);

      const values = page.values ?? [];
      for (const entry of values) {
        for (const item of entry.items ?? []) {
          // `to` is the status ID; `toString` is the display name at the time,
          // which a later rename would invalidate.
          if (item.field !== 'status' || !item.to) continue;
          const transition: StatusTransition = {
            at: entry.created ?? new Date(0).toISOString(),
            toStatusId: item.to,
          };
          if (item.from) transition.fromStatusId = item.from;
          if (entry.author?.accountId) transition.authorAccountId = entry.author.accountId;
          transitions.push(transition);
        }
      }

      startAt += values.length;
      const done =
        page.isLast === true ||
        values.length === 0 ||
        (page.total !== undefined && startAt >= page.total);
      if (done) break;
    }

    return transitions;
  }

  /**
   * Applies a TicketMutation: label add/remove, comment, status transition.
   *
   * Status goes LAST, and it is the only durable effect of a dispatch now that
   * nothing writes a counter. A partial failure therefore leaves the ticket in
   * its old state and the next tick retries cleanly.
   */
  async applyMutation(issueKey: string, mutation: TicketMutation): Promise<void> {
    const key = encodeURIComponent(issueKey);

    // 1. Labels — one call for both directions. Two calls can interleave with a
    //    human edit and lose a label.
    const labelOps = [
      ...(mutation.addLabels ?? []).map((label) => ({ add: label })),
      ...(mutation.removeLabels ?? []).map((label) => ({ remove: label })),
    ];
    if (labelOps.length > 0) {
      await this.request(`/rest/api/3/issue/${key}`, {
        method: 'PUT',
        body: { update: { labels: labelOps } },
      });
    }

    // 2. Comment — v3 takes Atlassian Document Format, not markdown. Signed, so
    //    the refiner can tell this from a human's reply when it reads the thread
    //    back, and so a human can tell on a board where the pipeline posts under
    //    their own account.
    if (mutation.comment) {
      await this.request(`/rest/api/3/issue/${key}/comment`, {
        method: 'POST',
        body: { body: textToAdf(signAgentComment(mutation.comment)) },
      });
    }

    // 3. Status — by transition ID, which is only discoverable from the issue's
    //    current status, so this is fetched per mutation rather than cached.
    if (mutation.status) {
      await this.transitionTo(issueKey, mutation.status);
    }
  }

  private async transitionTo(issueKey: string, statusName: string): Promise<void> {
    const key = encodeURIComponent(issueKey);
    const available = await this.request<{
      transitions?: Array<{ id: string; name?: string; to?: { name?: string; id?: string } }>;
    }>(`/rest/api/3/issue/${key}/transitions`);

    const match = (available.transitions ?? []).find((t) => t.to?.name === statusName);
    if (match === undefined) {
      const options = (available.transitions ?? [])
        .map((t) => t.to?.name ?? t.name ?? t.id)
        .join(', ');
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
  }
}
