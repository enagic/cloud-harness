/**
 * Turns a state machine decision into the work item the target agent consumes.
 *
 * PARTIAL — the structural mapping is real; extracting the refined story out of
 * the ticket is not. See parseRefinedStory below.
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

/**
 * TODO: the refiner writes its output into the ticket, and the implementer and
 * reviewer need it back out in structured form. Options, in preference order:
 *
 *   1. The refiner writes a fenced JSON block into the description under a
 *      known heading; this parses it back. Survives human edits around it and
 *      needs no Jira admin.
 *   2. A Jira custom field holding the JSON. Cleaner, needs project config.
 *   3. Re-derive it with a model call. Wasteful and non-deterministic.
 *
 * Until this is settled, everything downstream gets the raw description and no
 * acceptance criteria, which is enough to run the pipeline end to end but not
 * enough for the agents to be good.
 */
function parseRefinedStory(ticket: TicketSnapshot): {
  description: string;
  acceptanceCriteria: string[];
  relevantPaths: string[];
} {
  return {
    description: ticket.description,
    acceptanceCriteria: [],
    relevantPaths: [],
  };
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
      const story = parseRefinedStory(ticket);
      const item: ImplementWorkItem = {
        ...base,
        agent: 'implementer',
        reason: action.reason,
        refinedDescription: story.description,
        acceptanceCriteria: story.acceptanceCriteria,
        relevantPaths: story.relevantPaths,
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

      const story = parseRefinedStory(ticket);
      const item: ReviewWorkItem = {
        ...base,
        agent: 'reviewer',
        refinedDescription: story.description,
        acceptanceCriteria: story.acceptanceCriteria,
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
