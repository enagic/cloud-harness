/**
 * The workflow state machine.
 *
 * Deliberately pure: `decide()` takes a snapshot of a Jira ticket and returns
 * what should happen, without touching Jira, SQS, or the network. All the
 * loop-breaking rules that matter — the attempt budget, rebase exemption, human
 * gates — live here where they can be reasoned about and unit tested.
 *
 * The pipeline stores no workflow state of its own. Ticket status is the
 * current state, and everything else is DERIVED from history that users cannot
 * rewrite — see countAttempts below.
 */

import type { ImplementReason } from './types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Jira status names, mapped to this team's workflow. Every one is configurable
 * because they must match the board's real statuses exactly — Jira transitions
 * are resolved by name, and a typo here is a ticket that silently never moves.
 */
export interface PipelineStatuses {
  /** Refiner is working. Set by the watcher at dispatch. */
  refining: string;
  /** Human gate 1: refined story awaiting human approval. */
  refinementReview: string;
  /** Human approved the refinement. The signal to implement, and the point at
   *  which the attempt budget resets. */
  readyToImplement: string;
  /** Implementer is working. */
  implementing: string;
  /** PR is up. The signal for the reviewer. */
  codeReview: string;
  /** Reviewer is working. */
  reviewing: string;
  /** Reviewer wants changes. Each entry into this status is one attempt. */
  changesRequested: string;
  /** PR has conflicts. Routes to the implementer WITHOUT consuming an attempt. */
  rebaseRequired: string;
  /** Human gate 2: reviewer approved, awaiting human merge. */
  awaitingMerge: string;
  /** Terminal: merged. */
  done: string;
  /** Terminal: budget exhausted or unrecoverable failure. */
  failed: string;
}

export interface PipelineLabels {
  /** Human adds this to a drafted ticket to start the pipeline. */
  refine: string;
  /** Human adds this to send a refinement back instead of approving it. */
  changesRequested: string;
}

export interface PipelineConfig {
  statuses: PipelineStatuses;
  labels: PipelineLabels;
  /** Review round trips allowed before the ticket is failed for human triage. */
  maxAttempts: number;
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/**
 * One entry from the Jira issue changelog, narrowed to status changes.
 *
 * Jira's changelog is append-only: there is no API and no UI affordance for
 * editing or deleting an entry, and every entry carries its author. That makes
 * it the only durable place to keep the attempt budget — a label or a custom
 * field can be edited by anyone with write access to the ticket, accidentally
 * or otherwise, and nothing records that it happened.
 *
 * Status IDs, not names: Jira's changelog records both, but a renamed status
 * changes the historical `toString` while the ID is stable forever.
 */
export interface StatusTransition {
  /** ISO 8601. */
  at: string;
  fromStatusId?: string;
  toStatusId: string;
  authorAccountId?: string;
}

/** Status IDs resolved once from names; see JiraClient.resolveStatusIds. */
export interface StatusIds {
  readyToImplement: string;
  changesRequested: string;
}

/**
 * How many review round trips this ticket has had.
 *
 * Counted as transitions INTO the changes-requested status, since the last
 * transition INTO ready-for-implementation. Two consequences worth stating
 * outright, because both are the reason to do it this way:
 *
 *  1. **Rebases are excluded structurally, not by a rule.** A rebase moves the
 *     ticket through `rebaseRequired`, a different status, so it cannot be
 *     miscounted. There is no conditional here for a future change to break.
 *
 *  2. **A human re-approving resets the budget, and that reset is audited.**
 *     Sending a ticket back through human gate 1 is the legitimate way to grant
 *     more attempts. It requires a real Jira transition by a named account and
 *     it is permanently visible in the changelog — unlike editing a counter,
 *     which leaves no trace.
 *
 * Transitions may arrive in any order; this does not assume sorting.
 */
export function countAttempts(transitions: StatusTransition[], ids: StatusIds): number {
  let resetAt = 0;
  for (const t of transitions) {
    if (t.toStatusId !== ids.readyToImplement) continue;
    const ms = Date.parse(t.at);
    if (!Number.isNaN(ms) && ms > resetAt) resetAt = ms;
  }

  let attempts = 0;
  for (const t of transitions) {
    if (t.toStatusId !== ids.changesRequested) continue;
    const ms = Date.parse(t.at);
    if (Number.isNaN(ms)) continue;
    if (ms >= resetAt) attempts += 1;
  }
  return attempts;
}

/**
 * Whether the watcher needs to pull this ticket's changelog before deciding.
 *
 * The changelog is a per-issue API call, so it is only worth fetching for the
 * handful of tickets whose decision actually depends on the count. Everything
 * else decides from status alone.
 */
export function needsHistory(status: string, config: PipelineConfig): boolean {
  return (
    status === config.statuses.changesRequested ||
    status === config.statuses.codeReview ||
    status === config.statuses.rebaseRequired
  );
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Everything the state machine needs to know about one ticket. */
export interface TicketSnapshot {
  issueKey: string;
  issueId: string;
  summary: string;
  description: string;
  status: string;
  labels: string[];

  /**
   * Review round trips so far, from countAttempts(). The watcher populates this
   * only when needsHistory() says the decision depends on it; it defaults to 0
   * everywhere else, where it is unused.
   */
  attempts: number;

  /** Comments a human left when sending a refinement back. */
  reviewerComments?: string[];

  /**
   * PR coordinates, once one exists. Rehydrated from Bitbucket by branch naming
   * convention rather than trusted from a Jira field — see
   * BitbucketReader.findPullRequestForIssue.
   */
  pullRequestUrl?: string;
  pullRequestId?: number;
  branch?: string;
}

/** PR state the watcher polls from Bitbucket, for tickets that have one. */
export interface PullRequestState {
  id: number;
  url: string;
  branch: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED';
  /** false when the PR has conflicts against its destination branch. */
  mergeable: boolean;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Mutations to apply to the ticket immediately after a successful dispatch, so
 * the watcher's next tick does not re-dispatch the same work.
 *
 * Note there is no counter to write. The only durable effect of a dispatch is
 * the status transition, which Jira records in the changelog for us.
 */
export interface TicketMutation {
  status?: string;
  addLabels?: string[];
  removeLabels?: string[];
  comment?: string;
}

export type PipelineAction =
  | { kind: 'dispatch_refine'; mutation: TicketMutation }
  | {
      kind: 'dispatch_implement';
      reason: ImplementReason;
      /** The attempt number this dispatch represents. */
      attempt: number;
      mutation: TicketMutation;
    }
  | { kind: 'dispatch_review'; attempt: number; mutation: TicketMutation }
  | { kind: 'fail'; reason: string; mutation: TicketMutation }
  | { kind: 'complete'; mutation: TicketMutation }
  | { kind: 'idle'; reason: string };

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Given a ticket, decide what the watcher should do about it this tick.
 *
 * Ordering matters: terminal states short-circuit, then in-flight, then human
 * gates, then agent-triggering statuses, then the kickoff label last. A ticket
 * sitting in a human gate returns `idle` — the pipeline does nothing until a
 * person moves it.
 */
export function decide(ticket: TicketSnapshot, config: PipelineConfig): PipelineAction {
  const { statuses, labels, maxAttempts } = config;

  // --- Terminal -----------------------------------------------------------
  if (ticket.status === statuses.done) {
    return { kind: 'idle', reason: 'ticket is done' };
  }
  if (ticket.status === statuses.failed) {
    return { kind: 'idle', reason: 'ticket failed; awaiting human triage' };
  }

  // --- In flight ----------------------------------------------------------
  // An agent already owns this ticket. The SQS visibility timeout and DLQ are
  // what recover a stuck agent, not a re-dispatch from here — re-dispatching
  // would put two agents on one branch.
  if (
    ticket.status === statuses.refining ||
    ticket.status === statuses.implementing ||
    ticket.status === statuses.reviewing
  ) {
    return { kind: 'idle', reason: `agent in flight (${ticket.status})` };
  }

  // --- Human gates --------------------------------------------------------
  if (ticket.status === statuses.refinementReview) {
    // Human gate 1. The human either approves (transitioning the ticket to
    // readyToImplement, which also resets the attempt budget) or sends it back
    // by adding the changes-requested label.
    if (ticket.labels.includes(labels.changesRequested)) {
      return {
        kind: 'dispatch_refine',
        mutation: {
          status: statuses.refining,
          removeLabels: [labels.changesRequested],
        },
      };
    }
    return { kind: 'idle', reason: 'awaiting human refinement review' };
  }

  if (ticket.status === statuses.awaitingMerge) {
    // Human gate 2. Merging is a human action; the watcher only notices the
    // result when it polls Bitbucket (see reconcilePullRequest).
    return { kind: 'idle', reason: 'awaiting human merge' };
  }

  // --- Reviewer trigger ---------------------------------------------------
  if (ticket.status === statuses.codeReview) {
    return {
      kind: 'dispatch_review',
      // attempts counts *completed* round trips, so the implementation now
      // under review is the next one.
      attempt: ticket.attempts + 1,
      mutation: { status: statuses.reviewing },
    };
  }

  // --- Implementer triggers ----------------------------------------------

  // Rebase. Excluded from the attempt budget by construction: countAttempts
  // only counts entries into changesRequested, and this is a different status.
  // Base-branch churn is not the implementer failing review, and charging for
  // it would let a busy repo exhaust the budget without a single round trip.
  if (ticket.status === statuses.rebaseRequired) {
    return {
      kind: 'dispatch_implement',
      reason: 'rebase',
      // Same implementation attempt as before the conflict, not a new one.
      attempt: ticket.attempts + 1,
      mutation: { status: statuses.implementing },
    };
  }

  // Changes requested: this is the one the budget is spent on. The ticket is
  // already sitting in changesRequested, so that transition is already in the
  // changelog and already counted.
  if (ticket.status === statuses.changesRequested) {
    // attempts is the number of completed round trips. Dispatching now would
    // start implementation number attempts + 1, so the budget is spent when
    // attempts has reached maxAttempts.
    if (ticket.attempts >= maxAttempts) {
      return {
        kind: 'fail',
        reason: `exhausted ${maxAttempts} implementation attempts`,
        mutation: {
          status: statuses.failed,
          comment:
            `Agent pipeline stopped after ${maxAttempts} review round trips. ` +
            `The PR and review history are left in place for a human to pick up. ` +
            `Moving this ticket back through refinement review grants a fresh budget.`,
        },
      };
    }
    return {
      kind: 'dispatch_implement',
      reason: 'changes_requested',
      attempt: ticket.attempts + 1,
      mutation: { status: statuses.implementing },
    };
  }

  // First implementation, off the back of human approval. The transition into
  // readyToImplement is itself the budget reset, so attempts is 0 here.
  if (ticket.status === statuses.readyToImplement) {
    return {
      kind: 'dispatch_implement',
      reason: 'initial',
      attempt: ticket.attempts + 1,
      mutation: { status: statuses.implementing },
    };
  }

  // --- Kickoff ------------------------------------------------------------
  // Lowest priority: a human labelled a drafted ticket. Checked last so a label
  // left on a ticket that has moved on cannot pull it backwards.
  if (ticket.labels.includes(labels.refine)) {
    return {
      kind: 'dispatch_refine',
      mutation: {
        status: statuses.refining,
        removeLabels: [labels.refine],
      },
    };
  }

  return { kind: 'idle', reason: 'no signal' };
}

/**
 * PR-driven transitions, from the watcher's Bitbucket poll.
 *
 * Merge conflicts have no Jira-side signal — nothing in the ticket changes when
 * someone else merges to the base branch — so they can only be discovered by
 * asking Bitbucket. Same for the human's merge.
 */
export function reconcilePullRequest(
  ticket: TicketSnapshot,
  pr: PullRequestState,
  config: PipelineConfig,
): TicketMutation | undefined {
  const { statuses } = config;

  if (pr.state === 'MERGED') {
    if (ticket.status === statuses.done) return undefined;
    return { status: statuses.done, comment: `Merged: ${pr.url}` };
  }

  if (pr.state === 'DECLINED') {
    if (ticket.status === statuses.failed) return undefined;
    return { status: statuses.failed, comment: `Pull request was declined: ${pr.url}` };
  }

  // Conflicted. Only worth acting on where a rebase is safe: not while an agent
  // holds the branch, and not once the ticket is already flagged for rebase.
  if (!pr.mergeable) {
    const holdsBranch =
      ticket.status === statuses.implementing ||
      ticket.status === statuses.reviewing ||
      ticket.status === statuses.rebaseRequired;
    if (holdsBranch) return undefined;

    return {
      status: statuses.rebaseRequired,
      comment: 'Pull request has merge conflicts; queuing a rebase.',
    };
  }

  return undefined;
}
