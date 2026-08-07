/**
 * Jira, agent side — the write path.
 *
 * PLACEHOLDER — signatures settled, bodies not. See services/watcher/src/jira.ts
 * for the read path; the two deliberately stay separate so the watcher's role
 * cannot be widened by accident.
 */

import type { JiraConfig, Logger, RefinedStory, ReviewFeedback, TicketMutation } from '@cloud-harness/shared';

export class JiraWriter {
  constructor(
    private readonly config: JiraConfig,
    private readonly log: Logger,
  ) {}

  protected get authHeader(): string {
    const encoded = Buffer.from(`${this.config.userEmail}:${this.config.apiToken}`).toString('base64');
    return `Basic ${encoded}`;
  }

  /**
   * TODO: same three-call sequence as the watcher's applyMutation — labels,
   * then comment, then transition. Status last, so a partial failure leaves the
   * ticket recoverable.
   */
  async applyMutation(_issueKey: string, _mutation: TicketMutation): Promise<void> {
    throw new Error('JiraWriter.applyMutation not implemented');
  }

  /**
   * Writes the refined story back for human review.
   *
   * TODO: decide the format first — see the note on parseRefinedStory in
   * services/watcher/src/work-items.ts. Whatever is written here has to be
   * machine-readable on the way back out, because the implementer and reviewer
   * both consume it. A fenced JSON block under a known heading in the
   * description is the recommended POC shape.
   */
  async publishRefinement(_issueKey: string, _refined: RefinedStory): Promise<void> {
    throw new Error('JiraWriter.publishRefinement not implemented');
  }

  /**
   * TODO: POST /rest/api/3/issue/{key}/remotelink
   *
   * Remote links are how the PR URL travels between agents without needing a
   * custom field configured on the project. Use a stable `globalId` derived
   * from the PR id so repeated calls update rather than duplicate the link.
   */
  async linkPullRequest(
    _issueKey: string,
    _pr: { url: string; id: number; branch: string },
  ): Promise<void> {
    throw new Error('JiraWriter.linkPullRequest not implemented');
  }

  /**
   * Records review findings where the implementer can read them back on its
   * next attempt.
   *
   * TODO: same machine-readability constraint as publishRefinement — the
   * implementer needs the findings structured, not prose.
   */
  async publishReview(_issueKey: string, _feedback: ReviewFeedback): Promise<void> {
    throw new Error('JiraWriter.publishReview not implemented');
  }
}
