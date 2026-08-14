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
  type IssueHistory,
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

/**
 * The custom fields arrive under their ids, so the shape is only known at
 * runtime. Everything named is standard; everything else is looked up.
 */
interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    labels?: string[];
    assignee?: { accountId?: string } | null;
  } & Record<string, unknown>;
}

/** Standard fields every snapshot needs. The custom ids are appended per config. */
const SNAPSHOT_FIELDS = ['summary', 'description', 'status', 'labels', 'assignee'];

/** A userpicker's value, when one is set. */
function accountIdOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const accountId = (value as { accountId?: unknown }).accountId;
  return typeof accountId === 'string' ? accountId : undefined;
}

/**
 * Whether a multicheckbox field carries the ticked option.
 *
 * Jira returns these as an array of option objects, and a single-value
 * configuration is still an array. Absent, empty and null all mean unticked.
 */
function isTicked(value: unknown, tickedValue: string): boolean {
  if (!Array.isArray(value)) return false;
  return value.some(
    (option) =>
      typeof option === 'object' &&
      option !== null &&
      (option as { value?: unknown }).value === tickedValue,
  );
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

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
   * Confirm the four configured custom fields exist, once at startup.
   *
   * They are configured by id rather than by name — a rename must not silently
   * break history counting — and an id is exactly the kind of value that gets
   * mistyped once and then behaves like an empty field forever. Jira does not
   * complain about an unknown field id on a read: it simply is not in the
   * response, so DOR reads as unticked and the ticket waits at gate 1 for a
   * human who has already ticked it. Fail at startup instead.
   *
   * Logs the display names it found, which is the cheap way to catch the other
   * half of the mistake: a real id pointing at the wrong field.
   */
  async verifyFields(): Promise<void> {
    const all = await this.request<Array<{ id?: string; name?: string }>>('/rest/api/3/field');
    const byId = new Map<string, string>();
    for (const field of all) {
      if (field.id !== undefined) byId.set(field.id, field.name ?? '<unnamed>');
    }

    const configured: Array<[string, string]> = [
      ['codeReviewer', this.pipeline.fields.codeReviewer],
      ['dor', this.pipeline.fields.dor],
      ['storyPoints', this.pipeline.fields.storyPoints],
      ['acceptanceCriteria', this.pipeline.fields.acceptanceCriteria],
    ];

    const missing = configured.filter(([, id]) => !byId.has(id));
    if (missing.length > 0) {
      throw new Error(
        `Jira has no field with ${missing.length === 1 ? 'this id' : 'these ids'}: ` +
          `${missing.map(([key, id]) => `${key}="${id}"`).join(', ')}. ` +
          'Custom fields are configured by id (customfield_NNNNN), not by name — ' +
          'read the ids off /rest/api/3/field.',
      );
    }

    this.log.info('resolved pipeline fields', {
      fields: Object.fromEntries(configured.map(([key, id]) => [key, `${id} (${byId.get(id)})`])),
    });
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

    // Only the two the attempt budget counts between. Everything else is
    // matched by name at transition time.
    return {
      inProgress: this.statusNameToId.get(this.pipeline.statuses.inProgress)!,
      codeReview: this.statusNameToId.get(this.pipeline.statuses.codeReview)!,
    };
  }

  /**
   * Every ticket in the project that the pipeline might care about.
   *
   * Returns snapshots with `attempts: 0` — the caller fills that in from
   * getIssueHistory for the tickets where it matters, so the common case costs
   * one search call rather than one call per ticket.
   *
   * **The lane label is the whole filter.** This used to also list the
   * pipeline's own statuses, which made sense when they were pipeline-specific
   * columns nothing else on the board would sit in. Against seven generic
   * columns that clause is the entire project, so it is gone — and dropping it
   * is not merely a simplification, it is narrower than what it replaced.
   * `decide()` idles anything without the label before reading anything else.
   */
  async listPipelineTickets(): Promise<TicketSnapshot[]> {
    const jql =
      `project = "${this.config.projectKey}" AND ` +
      `labels = "${this.pipeline.labels.agentLane}" ` +
      `ORDER BY created ASC`;

    const { fields } = this.pipeline;
    const requested = [
      ...SNAPSHOT_FIELDS,
      fields.codeReviewer,
      fields.dor,
      fields.storyPoints,
      fields.acceptanceCriteria,
    ].join(',');

    const tickets: TicketSnapshot[] = [];
    let nextPageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        jql,
        fields: requested,
        maxResults: '100',
      });
      if (nextPageToken) params.set('nextPageToken', nextPageToken);

      const page = await this.request<{
        issues?: JiraIssue[];
        nextPageToken?: string;
        isLast?: boolean;
      }>(`/rest/api/3/search/jql?${params.toString()}`);

      for (const issue of page.issues ?? []) {
        const ticket: TicketSnapshot = {
          issueKey: issue.key,
          issueId: issue.id,
          summary: issue.fields.summary ?? '',
          description: adfToText(issue.fields.description),
          status: issue.fields.status?.name ?? '',
          labels: issue.fields.labels ?? [],
          dor: isTicked(issue.fields[fields.dor], fields.dorTickedValue),
          attempts: 0,
        };

        // The three optional ones are set rather than assigned undefined:
        // exactOptionalPropertyTypes, and "absent" is the meaningful value.
        const assignee = accountIdOf(issue.fields.assignee);
        if (assignee !== undefined) ticket.assigneeAccountId = assignee;

        const codeReviewer = accountIdOf(issue.fields[fields.codeReviewer]);
        if (codeReviewer !== undefined) ticket.codeReviewerAccountId = codeReviewer;

        const points = numberOf(issue.fields[fields.storyPoints]);
        if (points !== undefined) ticket.storyPoints = points;

        // A textarea custom field comes back as ADF on v3, exactly as the
        // description does.
        const criteria = adfToText(issue.fields[fields.acceptanceCriteria]);
        if (criteria.length > 0) ticket.acceptanceCriteria = criteria;

        tickets.push(ticket);
      }

      nextPageToken = page.isLast === true ? undefined : page.nextPageToken;
    } while (nextPageToken);

    // The thread is what tells the three To Do states apart — never refined,
    // waiting at gate 1, or sent back — so unlike everything else here it is
    // read by `decide()` and not only by the refiner. Only tickets that could
    // be in one of those states pay for the extra call.
    for (const ticket of tickets) {
      if (ticket.status === this.pipeline.statuses.toDo && !ticket.dor) {
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
   * The status transitions and DOR grants for one issue, in whatever order Jira
   * returns them — countAttempts does not care about ordering.
   *
   * This is the durable record the attempt budget is derived from, both halves
   * of it. Jira exposes no way to edit or delete a changelog entry, which is
   * precisely why the budget lives here instead of in a label or a counter
   * field: a human may tick DOR to grant another go, and that grant is a real
   * event with an author and a timestamp rather than a value someone set.
   *
   * The DOR half is why this pages the whole changelog rather than only status
   * items. It was already paging all of it and discarding everything that was
   * not a status; the filter widened, the paging did not change.
   *
   * Custom fields are matched on `fieldId`, never on `field` — that is the
   * display name as it stood at the time, and a rename would silently reset
   * every ticket's budget to "never granted".
   */
  async getIssueHistory(issueKey: string): Promise<IssueHistory> {
    const transitions: StatusTransition[] = [];
    const dorGrantedAt: string[] = [];
    let startAt = 0;

    for (;;) {
      const params = new URLSearchParams({ startAt: String(startAt), maxResults: '100' });
      const page = await this.request<{
        values?: Array<{
          created?: string;
          author?: { accountId?: string };
          items?: Array<{
            field?: string;
            fieldId?: string;
            from?: string | null;
            to?: string | null;
            toString?: string | null;
          }>;
        }>;
        total?: number;
        isLast?: boolean;
      }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog?${params.toString()}`);

      const values = page.values ?? [];
      for (const entry of values) {
        const at = entry.created ?? new Date(0).toISOString();

        for (const item of entry.items ?? []) {
          // `to` is the status ID; `toString` is the display name at the time,
          // which a later rename would invalidate.
          if (item.field === 'status' && item.to) {
            const transition: StatusTransition = { at, toStatusId: item.to };
            if (item.from) transition.fromStatusId = item.from;
            if (entry.author?.accountId) transition.authorAccountId = entry.author.accountId;
            transitions.push(transition);
            continue;
          }

          // A multicheckbox records its options by display value, so unlike a
          // status this genuinely has to match on the text. The field itself is
          // still identified by id. An entry that clears the tick has a
          // `toString` without the value in it and is correctly not a grant.
          if (
            item.fieldId === this.pipeline.fields.dor &&
            (item.toString ?? '').includes(this.pipeline.fields.dorTickedValue)
          ) {
            dorGrantedAt.push(at);
          }
        }
      }

      startAt += values.length;
      const done =
        page.isLast === true ||
        values.length === 0 ||
        (page.total !== undefined && startAt >= page.total);
      if (done) break;
    }

    return { transitions, dorGrantedAt };
  }

  /**
   * Applies a TicketMutation: the comment, then fields and labels, then the
   * status transition.
   *
   * The order matches the agent-side client's, and it matters there for a
   * reason that applies here too: the comment thread is now part of the state,
   * and the in-flight markers are the rest of it. A comment written after the
   * marker it belongs with leaves a window where the ticket reads as something
   * it is not. Cheapest to keep one order in both clients and one explanation
   * of it — see services/agents/src/clients/jira.ts.
   *
   * Status goes LAST. It is the coarsest of the effects and the one the next
   * tick routes on, so a partial failure leaves the ticket in its old column
   * with its marker already set, and the retry re-applies the same marker
   * before moving it. The reverse order would move a ticket into a column with
   * nothing marking it as taken, which reads as a fresh dispatch.
   */
  async applyMutation(issueKey: string, mutation: TicketMutation): Promise<void> {
    const key = encodeURIComponent(issueKey);

    // 1. Comment — v3 takes Atlassian Document Format, not markdown. Signed, so
    //    the refiner can tell this from a human's reply when it reads the thread
    //    back, and so a human can tell on a board where the pipeline posts under
    //    their own account.
    if (mutation.comment) {
      await this.request(`/rest/api/3/issue/${key}/comment`, {
        method: 'POST',
        body: { body: textToAdf(signAgentComment(mutation.comment)) },
      });
    }

    // 2. Fields and labels — one call. Separate calls can interleave with a
    //    human edit, and the label update in particular can lose a label.
    //
    //    The in-flight markers are `update` operations rather than `fields`
    //    because they travel alongside the label ops in the same body. Clearing
    //    is an explicit null: an omitted key leaves the field alone, which is
    //    not the same thing and is exactly the bug that would leave a finished
    //    agent still holding the card.
    const update: Record<string, unknown> = {};

    const labelOps = [
      ...(mutation.addLabels ?? []).map((label) => ({ add: label })),
      ...(mutation.removeLabels ?? []).map((label) => ({ remove: label })),
    ];
    if (labelOps.length > 0) update['labels'] = labelOps;

    const bot = this.pipeline.fields.botAccountId;
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
