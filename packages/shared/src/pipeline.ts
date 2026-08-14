/**
 * The workflow state machine.
 *
 * Deliberately pure: `decide()` takes a snapshot of a Jira ticket and returns
 * what should happen, without touching Jira, SQS, or the network. All the
 * loop-breaking rules that matter — the attempt budget, rebase exemption, human
 * gates — live here where they can be reasoned about and unit tested.
 *
 * The pipeline stores no workflow state of its own. Jira is the store, and
 * everything the pipeline needs is either a field a human already reads or is
 * DERIVED from history that users cannot rewrite — see countAttempts below.
 *
 * **Status is not the whole state, and used to be.** This file once carried
 * eleven statuses, half of which were the watcher's own bookkeeping wearing a
 * board column. A real board has seven generic columns and no admin rights to
 * add more, so the one axis is split across the fields that already mean what we
 * need them to mean: the column says what kind of work this is, Assignee says an
 * agent is executing, Code Reviewer says which agent, DOR says a human approved
 * the story, and Bitbucket says what is true about the code. Nothing here is
 * repurposed against its grain; that was the test the design had to pass.
 */

import type { ImplementReason, TicketComment } from './types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The board's columns, mapped to this team's workflow. Every one is
 * configurable because they must match the board's real statuses exactly — Jira
 * transitions are resolved by name, and a typo here is a ticket that silently
 * never moves.
 *
 * Seven, and five of them do any work. There is deliberately no column for
 * "refining", "reviewing", "changes requested" or "rebase required": those are
 * roles and facts, not stages, and they live on Assignee, Code Reviewer and the
 * pull request respectively.
 */
export interface PipelineStatuses {
  /**
   * Drafting, refinement, and human gate 1 — three states in one column,
   * told apart by DOR and by the comment thread.
   *
   * Refinement happens here and could not happen anywhere else: the workflow
   * has required-field validators on DOR and Story Points before a ticket may
   * proceed into In Progress, and DOR is by definition unset while the refiner
   * is still writing the story it approves.
   */
  toDo: string;
  /** The implementer's column. Every genuine attempt leaves it for codeReview. */
  inProgress: string;
  /**
   * The pull request's column: awaiting review, under review, awaiting a
   * rebase, or being rebased. A rebase never leaves it — a branch refresh is
   * not a new implementation attempt, and the ticket really is still in code
   * review while it happens.
   */
  codeReview: string;
  /** Human gate 2: post-build QA. The reviewer approved; a human validates and merges. */
  validation: string;
  /** Terminal: merged. */
  done: string;
  /** Terminal: the pipeline gave up and a human is needed. */
  blocked: string;
  /**
   * Terminal: won't do. Carried so the state machine recognises it as a column
   * it must leave alone; never read for a decision and never written.
   */
  closed: string;
}

export interface PipelineLabels {
  /**
   * The lane marker, and the only label the pipeline reads.
   *
   * Present, the ticket is in the agent lane; absent, it is in the human lane
   * and no agent touches it. It is not a trigger — it does not get consumed on
   * dispatch and it stays on the ticket for as long as the agents are welcome.
   * The board column says which stage to run; this says whether to run at all.
   *
   * A ticket may change lanes at any point in its lifecycle, and the pipeline
   * assumes nothing about when. To edit a ticket the agents are working on, a
   * human moves it to the human lane FIRST. Editing while it is still in the
   * agent lane is a broken contract, and the agent's write wins — see the note
   * on publishRefinement in services/agents/src/clients/jira.ts.
   */
  agentLane: string;
}

/**
 * The four board fields that carry what the columns no longer can.
 *
 * Custom fields are identified by id (`customfield_10050`), never by name, for
 * the same reason statuses are resolved to ids: the changelog records the
 * display name as it was at the time, so a rename silently breaks history
 * counting. The watcher validates these exist at startup.
 */
export interface PipelineFields {
  /**
   * The dedicated bot Atlassian account.
   *
   * This is the in-flight marker, and an account rather than a label on
   * purpose. A stranded in-flight label is invisible cruft a PO has to know to
   * go looking for; a wrong assignee is at least visible on the card, in the
   * field people already read to answer "who is working on this".
   *
   * NOTE: being assignable is a separate Jira permission from write access, so
   * a bot can edit fields and transition issues perfectly well while silently
   * failing to be assigned. Check `Assignable User` in the project's permission
   * scheme before believing an empty Assignee.
   */
  botAccountId: string;
  /** Userpicker. The bot means the reviewer agent is running; a human means gate 2. */
  codeReviewer: string;
  /** Multicheckbox. Ticked means gate 1 passed and the attempt budget is granted. */
  dor: string;
  /** The option value on `dor` that counts as ticked. */
  dorTickedValue: string;
  /** Number. Required by the workflow before In Progress; written by the refiner. */
  storyPoints: string;
  /**
   * Textarea. Content, not state — the refiner writes the criteria here instead
   * of burying them in prose, and the reviewer verifies against them. This is
   * not a contradiction of "the story is prose": the story stays prose in the
   * description, and criteria are the one part of it that is genuinely a list.
   */
  acceptanceCriteria: string;
}

export interface PipelineConfig {
  statuses: PipelineStatuses;
  labels: PipelineLabels;
  fields: PipelineFields;
  /** Implementation attempts allowed before the ticket is blocked for human triage. */
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
 * or otherwise, and the current value says nothing about how it got there.
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

/**
 * The parts of one issue's changelog the budget is derived from.
 *
 * Both halves are needed now that the reset is a field tick rather than a
 * status: the transitions supply the count, the DOR grants supply the line to
 * count from.
 */
export interface IssueHistory {
  transitions: StatusTransition[];
  /**
   * ISO timestamps at which DOR was set to its ticked value. The budget resets
   * at the latest one; an empty list means it has never been granted and every
   * transition in the log counts.
   */
  dorGrantedAt: string[];
}

/** Status IDs resolved once from names; see JiraClient.resolveStatusIds. */
export interface StatusIds {
  inProgress: string;
  codeReview: string;
}

/**
 * How many implementation attempts this ticket has had.
 *
 * **Count the edge, not the destination.** An attempt is a transition from In
 * Progress into Code Review — a piece of work leaving the implementer for the
 * reviewer — counted since the last time a human ticked DOR. That single rule
 * carries both exemptions structurally, with no conditional here for a future
 * change to break:
 *
 *  1. **A rebase is not an attempt.** It never leaves Code Review, so there is
 *     no edge to count. Base-branch churn is not the implementer failing
 *     review, and charging for it would let a busy repo exhaust the budget
 *     without a single round trip. The same holds for the gate-2 rebase, which
 *     arrives from Validation.
 *
 *  2. **A consented fix is not an attempt either.** Under decision 5 a human
 *     may ask an agent to fix something on a pull request directly. That work
 *     parks in Code Review for exactly the same reason a rebase does, so it
 *     needs neither its own reason nor a flag — it needs to not move.
 *
 * The reset is audited for the same reason the count is. Ticking DOR is a real
 * field change by a named account and Jira records it with author and
 * timestamp; a human granting a fresh budget therefore leaves a trace, unlike
 * editing a counter.
 *
 * Entries may arrive in any order; this does not assume sorting.
 */
export function countAttempts(history: IssueHistory, ids: StatusIds): number {
  let resetAt = 0;
  for (const at of history.dorGrantedAt) {
    const ms = Date.parse(at);
    if (!Number.isNaN(ms) && ms > resetAt) resetAt = ms;
  }

  let attempts = 0;
  for (const transition of history.transitions) {
    if (transition.fromStatusId !== ids.inProgress) continue;
    if (transition.toStatusId !== ids.codeReview) continue;
    const ms = Date.parse(transition.at);
    if (Number.isNaN(ms)) continue;
    if (ms >= resetAt) attempts += 1;
  }
  return attempts;
}

/**
 * Whether the watcher needs to pull this ticket's changelog before deciding.
 *
 * The changelog is a per-issue API call, so it is only worth fetching for the
 * tickets whose decision actually depends on the count. That is now the two
 * columns where an implementation exists or is about to — plus Validation,
 * where a conflicted pull request can send one back for a rebase and the
 * attempt number rides along on the work item.
 *
 * An In Progress ticket with no pull request is the first pass off the back of
 * gate 1; the DOR tick that put it there is also the budget reset, so the count
 * is zero by construction and not worth a call.
 */
export function needsHistory(ticket: TicketSnapshot, config: PipelineConfig): boolean {
  const { statuses } = config;
  if (ticket.status === statuses.codeReview || ticket.status === statuses.validation) {
    return true;
  }
  return ticket.status === statuses.inProgress && ticket.pullRequestId !== undefined;
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
   * Account id of the current assignee, when there is one. The bot's account
   * means an agent is executing this ticket right now.
   */
  assigneeAccountId?: string;
  /**
   * Account id in the Code Reviewer field. The bot's means the reviewer agent
   * is running; anyone else (or nobody) means it is not.
   */
  codeReviewerAccountId?: string;

  /**
   * DOR is ticked: a human read the story and approved it, which is gate 1 and
   * also the moment the attempt budget is granted.
   */
  dor: boolean;
  /** The board's own estimate field, written by the refiner. Carried, not read. */
  storyPoints?: number;
  /**
   * The acceptance criteria field. `decide()` reads only whether it is empty —
   * a DOR ticked on a ticket with no criteria is the one way gate 1 can be
   * skipped by accident, and it is worth refusing to dispatch on.
   */
  acceptanceCriteria?: string;

  /**
   * Implementation attempts so far, from countAttempts(). The watcher populates
   * this only when needsHistory() says the decision depends on it; it defaults
   * to 0 everywhere else, where it is unused.
   */
  attempts: number;

  /**
   * The recent comment thread, agent and human alike, oldest first.
   *
   * `decide()` DOES read this, which is new: with both gate-1 states living in
   * To Do there is no column move to tell "never refined" from "refined,
   * awaiting approval" from "sent back", and the thread already carries all
   * three. See gateOneAction.
   */
  conversation?: TicketComment[];

  /**
   * PR coordinates, once one exists. Rehydrated from Bitbucket by branch naming
   * convention rather than trusted from a Jira field — see
   * BitbucketReader.findPullRequestForIssue.
   */
  pullRequestUrl?: string;
  pullRequestId?: number;
  branch?: string;
  /**
   * Whether the pull request merges cleanly, from the watcher's Bitbucket poll.
   *
   * **undefined means "not known", never "conflicted".** Bitbucket has not
   * computed it, the call failed, or there is no pull request at all. A rebase
   * queued on a guess costs an implementer run; a skipped tick costs a minute.
   */
  pullRequestMergeable?: boolean;
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
 * Note there is still no counter to write. The durable effects of a dispatch
 * are the in-flight marker and, where the stage changes, the transition — both
 * of which Jira records in the changelog for us.
 *
 * `status` is omitted whenever the ticket is already in the target column. Jira
 * transitions are looked up by destination from the issue's current status, and
 * a board that offers no self-transition would fail an "In Progress → In
 * Progress" move that never needed to happen.
 */
export interface TicketMutation {
  status?: string;
  addLabels?: string[];
  removeLabels?: string[];
  comment?: string;
  /** `bot` marks an agent as executing; `clear` unassigns when it finishes. */
  assignee?: 'bot' | 'clear';
  /** Same, for the reviewer agent, on the Code Reviewer field. */
  codeReviewer?: 'bot' | 'clear';
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
// Derivations the decision leans on
// ---------------------------------------------------------------------------

/**
 * Why the implementer is being invoked — asked of Bitbucket, not of the board.
 *
 * `initial`, `changes_requested` and `rebase` used to be three separate
 * statuses. They are all "the implementer's turn", and the repository already
 * knows which one: no pull request means a first pass, a conflicted one means a
 * branch refresh, and anything else means a reviewer sent work back. Deriving
 * it retires three columns and takes the answer off a card somebody can drag.
 *
 * This is decision 9's division of labour again: Jira carries whose attention
 * is needed, Bitbucket carries what is true about the code.
 */
export function implementReasonFor(ticket: TicketSnapshot): ImplementReason {
  if (ticket.pullRequestId === undefined) return 'initial';
  // Explicitly false, never merely unknown. See pullRequestMergeable.
  if (ticket.pullRequestMergeable === false) return 'rebase';
  return 'changes_requested';
}

/** True when an agent is executing this ticket right now. */
function agentInFlight(ticket: TicketSnapshot, fields: PipelineFields): boolean {
  return (
    ticket.assigneeAccountId === fields.botAccountId ||
    ticket.codeReviewerAccountId === fields.botAccountId
  );
}

/**
 * Which of the three To Do states this ticket is in, read off the comment
 * thread.
 *
 * Gate 1 and the draft both live in To Do with DOR unset, so there is no column
 * move to distinguish them — and there does not need to be, because the thread
 * already does. The refiner hands back with a comment every time; a human
 * answers with a comment; and decision 4's signature already tells the two
 * authors apart.
 *
 *  - no pipeline comment at all → this ticket has never been refined
 *  - the pipeline's comment is the newest → gate 1, waiting on a human
 *  - a human has commented since → a send-back, refine it again
 *
 * The cost is worth stating plainly because a PO will meet it: **commenting on
 * a gate-1 ticket in the agent lane re-triggers refinement**, even when the
 * comment was only an aside. It is cheap and idempotent — the second pass
 * improves the story with the whole thread in hand, which is what decision 4
 * built it to do — but it is surprising the first time. If it proves annoying,
 * require the comment to mention the bot; do not invent a new field.
 */
function gateOneAction(ticket: TicketSnapshot): PipelineAction {
  const authors = (ticket.conversation ?? []).map((comment) => comment.author);
  const lastAgent = authors.lastIndexOf('agent');
  const lastHuman = authors.lastIndexOf('human');

  const neverRefined = lastAgent === -1;
  const answered = lastHuman > lastAgent;

  if (neverRefined || answered) {
    return { kind: 'dispatch_refine', mutation: { assignee: 'bot' } };
  }
  return { kind: 'idle', reason: 'gate 1: awaiting human refinement review' };
}

/**
 * The implementer dispatch, wherever it was triggered from.
 *
 * Two things vary by reason and nothing else does. A rebase belongs in Code
 * Review and a real attempt belongs in In Progress — which is not cosmetic,
 * because that is exactly what makes countAttempts able to tell them apart. And
 * the budget is spent by attempts only, so a ticket that has burned its whole
 * budget can still be rebased; otherwise a pull request that went the full three
 * rounds could never be made mergeable again and gate 2 would have nothing to
 * merge.
 */
function dispatchImplement(
  ticket: TicketSnapshot,
  config: PipelineConfig,
  reason: ImplementReason,
): PipelineAction {
  const { statuses, maxAttempts } = config;
  const column = reason === 'rebase' ? statuses.codeReview : statuses.inProgress;

  if (reason !== 'rebase' && ticket.attempts >= maxAttempts) {
    return {
      kind: 'fail',
      reason: `exhausted ${maxAttempts} implementation attempts`,
      mutation: {
        status: statuses.blocked,
        comment:
          `Agent pipeline stopped after ${maxAttempts} implementation attempts. ` +
          `The pull request and its review history are left in place for a human to pick up. ` +
          `Ticking DOR again grants a fresh budget.`,
      },
    };
  }

  return {
    kind: 'dispatch_implement',
    reason,
    // attempts counts *completed* attempts, so the one about to run is the next.
    attempt: ticket.attempts + 1,
    mutation: {
      // Omitted when the ticket is already there; see TicketMutation.
      ...(ticket.status === column ? {} : { status: column }),
      assignee: 'bot',
    },
  };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Given a ticket, decide what the watcher should do about it this tick.
 *
 * Ordering matters: the lane check first, then terminal columns, then the
 * in-flight fields, then the column itself. A ticket sitting in a human gate
 * returns `idle` — the pipeline does nothing until a person acts.
 */
export function decide(ticket: TicketSnapshot, config: PipelineConfig): PipelineAction {
  const { statuses, labels, fields } = config;

  // --- Lane ---------------------------------------------------------------
  // Checked before anything else, on every tick and at every stage. This is the
  // whole opt-in: no label, no agent, whatever the board column says.
  //
  // It is also how a human takes a ticket back mid-flight. Removing the label
  // stops the next dispatch immediately, though it cannot stop an agent that is
  // already running — that one stands down at its own write guard.
  if (!ticket.labels.includes(labels.agentLane)) {
    return { kind: 'idle', reason: 'human lane' };
  }

  // --- Terminal -----------------------------------------------------------
  if (ticket.status === statuses.done) {
    return { kind: 'idle', reason: 'ticket is done' };
  }
  if (ticket.status === statuses.closed) {
    return { kind: 'idle', reason: "ticket is closed (won't do)" };
  }
  if (ticket.status === statuses.blocked) {
    return { kind: 'idle', reason: 'ticket is blocked; awaiting human triage' };
  }

  // --- In flight ----------------------------------------------------------
  // An agent already owns this ticket, and it says so in the field a human
  // reads to find out who is working on something. Re-dispatching would put two
  // agents on one branch; the SQS visibility timeout and DLQ are what recover a
  // stuck agent, not this loop.
  if (agentInFlight(ticket, fields)) {
    return {
      kind: 'idle',
      reason:
        ticket.codeReviewerAccountId === fields.botAccountId
          ? `reviewer in flight (${ticket.status})`
          : `agent in flight (${ticket.status})`,
    };
  }

  // --- To Do: drafting, refinement, gate 1, and the first implementation ---
  if (ticket.status === statuses.toDo) {
    if (!ticket.dor) return gateOneAction(ticket);

    // DOR is ticked but nothing was ever written into the criteria field, which
    // is what a DOR ticked on an unrefined ticket looks like — the one way gate
    // 1 gets skipped by accident. Refuse rather than build against no spec.
    if ((ticket.acceptanceCriteria ?? '').trim().length === 0) {
      return {
        kind: 'idle',
        reason: 'DOR is ticked but the ticket has no acceptance criteria',
      };
    }

    return dispatchImplement(ticket, config, implementReasonFor(ticket));
  }

  // --- In Progress: the implementer's column ------------------------------
  if (ticket.status === statuses.inProgress) {
    return dispatchImplement(ticket, config, implementReasonFor(ticket));
  }

  // --- Code Review: the pull request's column -----------------------------
  if (ticket.status === statuses.codeReview) {
    // A conflicted branch goes back to the implementer without leaving this
    // column, which is both where it belongs and what keeps it off the budget.
    if (ticket.pullRequestMergeable === false) {
      return dispatchImplement(ticket, config, 'rebase');
    }

    return {
      kind: 'dispatch_review',
      // The implementation now under review already produced its own In
      // Progress → Code Review edge, so it IS the count rather than the next
      // one. Floored at 1 because the number is only ever displayed, and "0 of
      // 3" on a pull request that plainly exists reads as a bug — which is what
      // a ticket whose edge predates the last DOR tick would otherwise show.
      attempt: Math.max(ticket.attempts, 1),
      mutation: { codeReviewer: 'bot' },
    };
  }

  // --- Validation: human gate 2 -------------------------------------------
  if (ticket.status === statuses.validation) {
    // The base branch can move under an approved pull request while it waits
    // for a human, and a rebase is the one thing worth doing about it. It
    // arrives from Validation rather than In Progress, so the edge rule still
    // will not count it.
    if (ticket.pullRequestMergeable === false) {
      return dispatchImplement(ticket, config, 'rebase');
    }
    // Merging is a human action; the watcher only notices the result when it
    // polls Bitbucket (see reconcilePullRequest).
    return { kind: 'idle', reason: 'gate 2: awaiting human validation and merge' };
  }

  return { kind: 'idle', reason: 'no signal' };
}

/**
 * PR-driven transitions, from the watcher's Bitbucket poll.
 *
 * A human's merge has no Jira-side signal — nothing in the ticket changes when
 * someone clicks Merge — so it can only be discovered by asking Bitbucket.
 *
 * Conflicts used to be reconciled here too, into a `Rebase Required` status.
 * They are not any more: mergeability travels on the snapshot and `decide()`
 * reads it directly, which is what lets a rebase happen without the ticket
 * leaving Code Review. One less status, and one less write per conflict.
 */
export function reconcilePullRequest(
  ticket: TicketSnapshot,
  pr: PullRequestState,
  config: PipelineConfig,
): TicketMutation | undefined {
  const { statuses } = config;

  if (pr.state === 'MERGED') {
    if (ticket.status === statuses.done) return undefined;
    return { status: statuses.done, comment: `Merged: ${pr.url}`, assignee: 'clear' };
  }

  if (pr.state === 'DECLINED') {
    if (ticket.status === statuses.blocked) return undefined;
    return {
      status: statuses.blocked,
      comment: `Pull request was declined: ${pr.url}`,
      assignee: 'clear',
    };
  }

  return undefined;
}
