/**
 * Jira Cloud REST v3 — read side plus the mutations the watcher applies.
 *
 * PLACEHOLDER — signatures are settled, bodies are not.
 *
 * Auth is HTTP Basic with email + API token (JIRA_USER_EMAIL / JIRA_API_TOKEN).
 */

import type {
  JiraConfig,
  Logger,
  StatusIds,
  StatusTransition,
  TicketMutation,
  TicketSnapshot,
} from '@cloud-harness/shared';

export class JiraClient {
  constructor(
    private readonly config: JiraConfig,
    private readonly log: Logger,
  ) {}

  protected get authHeader(): string {
    const encoded = Buffer.from(`${this.config.userEmail}:${this.config.apiToken}`).toString('base64');
    return `Basic ${encoded}`;
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
   * TODO: GET /rest/api/3/project/{projectKey}/statuses, build name -> id, and
   * fail loudly at startup on any configured status the board does not have.
   * A missing status must not be discovered one ticket at a time in production.
   */
  async resolveStatusIds(): Promise<StatusIds> {
    throw new Error('JiraClient.resolveStatusIds not implemented');
  }

  /**
   * Every ticket in the project that the pipeline might care about.
   *
   * Returns snapshots with `attempts: 0` — the caller fills that in from
   * getStatusHistory for the tickets where it matters, so the common case costs
   * one search call rather than one call per ticket.
   *
   * TODO: GET /rest/api/3/search/jql, filtered server-side to the pipeline's
   * statuses plus the kickoff label rather than pulling the whole project:
   *
   *   project = <key> AND (status IN (<pipeline statuses>) OR labels = <refine>)
   *
   * Handle pagination via nextPageToken, and request only the fields the
   * snapshot needs — the default field set is large and mostly unused here.
   */
  async listPipelineTickets(): Promise<TicketSnapshot[]> {
    throw new Error('JiraClient.listPipelineTickets not implemented');
  }

  /**
   * Status transitions for one issue, oldest or newest first — countAttempts
   * does not care about ordering.
   *
   * This is the durable record the attempt budget is derived from. Jira exposes
   * no way to edit or delete a changelog entry, which is precisely why the
   * budget lives here instead of in a label or custom field.
   *
   * TODO: GET /rest/api/3/issue/{key}/changelog (paginated, default 100 —
   * follow it to the end; a long-lived ticket can exceed one page). Keep only
   * items where `field === "status"`, and read `to` (the status ID), NOT
   * `toString` (the display name at the time).
   */
  async getStatusHistory(_issueKey: string): Promise<StatusTransition[]> {
    throw new Error('JiraClient.getStatusHistory not implemented');
  }

  /**
   * Applies a TicketMutation: label add/remove, comment, status transition.
   *
   * TODO: three calls, in this order —
   *   1. PUT  /rest/api/3/issue/{key}  with update.labels add/remove ops
   *      (one call for both directions; two calls can interleave with a human
   *      edit and lose a label)
   *   2. POST /rest/api/3/issue/{key}/comment  (v3 takes Atlassian Document
   *      Format, not markdown)
   *   3. POST /rest/api/3/issue/{key}/transitions  — takes a transition ID, not
   *      a status name, so resolve via GET .../transitions first and cache it.
   *
   * Status goes LAST, and it is the only durable effect of a dispatch now that
   * nothing writes a counter. A partial failure therefore leaves the ticket in
   * its old state and the next tick retries cleanly.
   */
  async applyMutation(_issueKey: string, _mutation: TicketMutation): Promise<void> {
    throw new Error('JiraClient.applyMutation not implemented');
  }
}
