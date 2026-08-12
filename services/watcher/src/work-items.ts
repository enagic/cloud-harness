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
      if (ticket.reviewerComments?.length) item.reviewerComments = ticket.reviewerComments;
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

      // Everything except the first pass continues an existing branch.
      if (ticket.branch !== undefined) item.existingBranch = ticket.branch;
      if (ticket.pullRequestUrl !== undefined) item.pullRequestUrl = ticket.pullRequestUrl;

      // TODO: reviewFeedback. The reviewer records its findings on the ticket;
      // this should read them back so the implementer sees what to fix rather
      // than re-deriving it from a comment thread.
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
      return item;
    }

    default:
      return undefined;
  }
}
