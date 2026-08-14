/**
 * Turns a state machine decision into the work item the target agent consumes.
 *
 * The refined story is carried, not parsed. It is prose living in the ticket
 * description, so the watcher hands it downstream verbatim — this file has no
 * opinion about what is inside it, and deliberately never gains one.
 */

import {
  WORK_ITEM_SCHEMA_VERSION,
  type ImplementWorkItem,
  type PipelineAction,
  type RefineWorkItem,
  type RepositoryRef,
  type ReviewWorkItem,
  type RuntimeRef,
  type TicketSnapshot,
  type WorkItem,
} from '@cloud-harness/shared';

export interface WorkItemContext {
  ticket: TicketSnapshot;
  repository: RepositoryRef;
  runtime: RuntimeRef;
  maxAttempts: number;
}

export function buildWorkItem(
  action: PipelineAction,
  ctx: WorkItemContext,
): WorkItem | undefined {
  const { ticket, repository, runtime, maxAttempts } = ctx;

  const base = {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    issueKey: ticket.issueKey,
    issueId: ticket.issueId,
    title: ticket.summary,
    repository,
    runtime,
    dispatchedAt: new Date().toISOString(),
  } as const;

  switch (action.kind) {
    case 'dispatch_refine': {
      const item: RefineWorkItem = {
        ...base,
        agent: 'refiner',
        draftDescription: ticket.description,
      };
      if (ticket.conversation?.length) item.conversation = ticket.conversation;
      // Present only on a second pass, and the refiner improves it rather than
      // starting over — same contract as the description.
      if (ticket.acceptanceCriteria !== undefined) {
        item.draftAcceptanceCriteria = ticket.acceptanceCriteria;
      }
      return item;
    }

    case 'dispatch_implement': {
      const item: ImplementWorkItem = {
        ...base,
        agent: 'implementer',
        reason: action.reason,
        refinedDescription: ticket.description,
        attempt: action.attempt,
        maxAttempts,
      };

      // Carried, not parsed. This is a board field's contents travelling as
      // text — the watcher has no more opinion about what is inside it than it
      // has about the description.
      if (ticket.acceptanceCriteria !== undefined) {
        item.acceptanceCriteria = ticket.acceptanceCriteria;
      }

      // Everything except the first pass continues an existing branch.
      if (ticket.branch !== undefined) item.existingBranch = ticket.branch;
      if (ticket.pullRequestUrl !== undefined) item.pullRequestUrl = ticket.pullRequestUrl;

      // reviewFeedback is deliberately not filled, and the field is slated for
      // deletion — see decision 9. The reviewer's findings live in the pull
      // request as one comment per finding, so they never pass through here:
      // nothing hands them to the watcher, and the implementer reads them off
      // Bitbucket itself when it starts.
      //
      // That is not only tidiness. Anything carried on the work item is a
      // snapshot taken at dispatch, and a human may reply to a finding — or
      // grant consent on it — between this call and the container starting.
      // Reading the PR at run time gets the current state; this would not.
      //
      // An earlier TODO here said to read the findings back off the ticket.
      // Do not: it would put the detail of a code change on the board and put a
      // parser in the one file that deliberately has no opinion about what is
      // inside the ticket's text.
      return item;
    }

    case 'dispatch_review': {
      if (
        ticket.branch === undefined ||
        ticket.pullRequestUrl === undefined ||
        ticket.pullRequestId === undefined
      ) {
        // Nothing to review. Caller logs and leaves the ticket alone rather
        // than dispatching an agent that would immediately fail.
        return undefined;
      }

      const item: ReviewWorkItem = {
        ...base,
        agent: 'reviewer',
        refinedDescription: ticket.description,
        branch: ticket.branch,
        pullRequestUrl: ticket.pullRequestUrl,
        pullRequestId: ticket.pullRequestId,
        attempt: action.attempt,
        maxAttempts,
      };
      // The checklist the review is verified against, when the refiner wrote one.
      if (ticket.acceptanceCriteria !== undefined) {
        item.acceptanceCriteria = ticket.acceptanceCriteria;
      }
      return item;
    }

    default:
      return undefined;
  }
}
