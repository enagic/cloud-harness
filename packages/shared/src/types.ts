/**
 * The contracts between the watcher and the three agents.
 *
 * These are the interfaces that must not drift: the watcher writes work items
 * to SQS, the agents read them back, and all four deploy independently. Add
 * fields optionally and bump `schemaVersion` for anything breaking, so an
 * in-flight message written by the old watcher is still readable by the new
 * agent.
 */

import type { RepoManifest } from './manifest.js';

export const WORK_ITEM_SCHEMA_VERSION = 1 as const;

/** Which agent a work item is destined for. */
export type AgentKind = 'refiner' | 'implementer' | 'reviewer';

/** Repo coordinates carried on every work item. */
export interface RepositoryRef {
  workspace: string;
  slug: string;
  baseBranch: string;
}

/**
 * How to build and test the repo, and therefore which container image the work
 * item must run in.
 *
 * `stack` is resolved by the watcher before dispatch, from the repo's
 * `.cloud-harness.yml`. It is not merely informational: it selects the queue,
 * and each queue feeds a task definition whose image carries that stack's
 * language runtimes. An implementer that cannot run `mvn test` cannot verify a
 * Java change, and a reviewer that cannot run the suite is reduced to reading
 * the diff.
 *
 * The manifest is echoed into the event so agents have the build and test
 * commands before they finish cloning, and so a work item is self-describing in
 * the DLQ — you can see what a failed item was trying to do without re-fetching
 * the repo.
 */
export interface RuntimeRef {
  /** Key into the deployment's configured stacks. Selects queue and image. */
  stack: string;
  /** Resolved manifest: repo values, with stack defaults filled in. */
  manifest: RepoManifest;
}

interface WorkItemBase {
  schemaVersion: typeof WORK_ITEM_SCHEMA_VERSION;
  agent: AgentKind;

  /** Jira issue key, e.g. "ENG-1234". Also the idempotency key. */
  issueKey: string;
  /** Jira's internal issue id, stable across key renames. */
  issueId: string;
  title: string;

  repository: RepositoryRef;
  runtime: RuntimeRef;

  /** ISO 8601. When the watcher dispatched this item. */
  dispatchedAt: string;
  /** Free-form passthrough for tracing; not interpreted by the agents. */
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Refiner
// ---------------------------------------------------------------------------

/**
 * One Jira comment, tagged with which side of the pipeline wrote it.
 *
 * The role is the point. The description carries the story and the comments
 * carry the conversation about it, and a conversation only reconstructs if you
 * can tell a question from its answer. Jira issue comments are flat — there is
 * no thread to hang a reply on — so the pairing is order plus authorship, and
 * dropping the agent's own comments would hand the next pass a set of answers
 * with nothing to attach them to.
 */
export interface TicketComment {
  /** `agent` means the pipeline's own Jira account wrote it. */
  author: 'agent' | 'human';
  text: string;
}

export interface RefineWorkItem extends WorkItemBase {
  agent: 'refiner';
  /**
   * The description as it stands on the board.
   *
   * On a first pass this is the human's rough draft. On a second pass it is the
   * refiner's own previous story, possibly with a human's edits on top — a
   * send-back is a column move and does not touch the description. Either way
   * it is the thing to improve, not a thing to start over from.
   */
  draftDescription: string;
  /**
   * The recent comment thread, oldest first, when the ticket is being refined
   * from a draft column in the agent lane.
   *
   * This is how a second pass rehydrates: the agent's own open questions and
   * the human's answers to them are both here, in order. Empty or absent on a
   * first pass, which is how the refiner knows it is one.
   */
  conversation?: TicketComment[];
}

/**
 * What the refiner produces is prose, so there is no type here — just a string.
 *
 * There was a structured `RefinedStory` (title, acceptanceCriteria[],
 * codeContext, openQuestions[]). It is gone deliberately. The story lives in the
 * Jira description, where a human reads it at gate 1 and may edit it before an
 * agent sees it again, and a ticket has to stay interchangeable between the two.
 * A machine format makes the description the agent's private scratch space and
 * makes the human's edit either awkward or silently ignored.
 *
 * Nothing in this system needs it parsed. `decide()` routes on status, labels
 * and attempts and never reads the description; everything else that consumes
 * the story is a model, and models read prose. Structure is still welcome —
 * headings, bullets, a table — as conventional structure a human would write
 * anyway, not as a grammar that breaks when someone edits around it.
 */

// ---------------------------------------------------------------------------
// Implementer
// ---------------------------------------------------------------------------

/**
 * Why the implementer is being invoked. This drives the attempt counter:
 * `changes_requested` increments it, `rebase` deliberately does not — a merge
 * conflict is not the implementer failing review, and burning a review attempt
 * on one would let unrelated churn on the base branch exhaust the budget.
 */
export type ImplementReason = 'initial' | 'changes_requested' | 'rebase';

export interface ImplementWorkItem extends WorkItemBase {
  agent: 'implementer';
  reason: ImplementReason;

  /**
   * The approved story — the actual spec, as prose. Acceptance criteria and the
   * repository paths the refiner found are part of this text, not separate
   * fields; see the note above RefineWorkItem's neighbours.
   */
  refinedDescription: string;

  /** 1-based. Incremented only for `changes_requested`. */
  attempt: number;
  maxAttempts: number;

  /** Present for every reason except `initial`. */
  existingBranch?: string;
  pullRequestUrl?: string;

  /** Present when reason is `changes_requested`. */
  reviewFeedback?: ReviewFeedback;
}

// ---------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------

export interface ReviewWorkItem extends WorkItemBase {
  agent: 'reviewer';

  /** The story the implementation is meant to satisfy, as prose. */
  refinedDescription: string;

  branch: string;
  pullRequestUrl: string;
  pullRequestId: number;

  /** Which implementation attempt this is reviewing. */
  attempt: number;
  maxAttempts: number;
}

export interface ReviewFinding {
  severity: 'blocker' | 'major' | 'minor';
  path?: string;
  line?: number;
  message: string;
}

export interface ReviewFeedback {
  summary: string;
  findings: ReviewFinding[];
  /**
   * Whether the reviewer actually executed the change, and what happened.
   *
   * `attempted: false` is a meaningful and expected outcome — it means the repo
   * declared no testCommand, or the runtime could not run it. A review that
   * only read the diff should say so rather than implying it verified anything.
   */
  verification: {
    attempted: boolean;
    /** The command run, echoed so the implementer can reproduce it. */
    command?: string;
    passed?: boolean;
    /** Truncated stdout/stderr. Keep it small; this rides in a Jira comment. */
    output?: string;
  };
}

export type WorkItem = RefineWorkItem | ImplementWorkItem | ReviewWorkItem;

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * Two variants, deliberately — "here is the story" or "I crashed".
 *
 * There is no `needs_information` and no `too_large`. Both were proposed and
 * both are the same board gesture as a success: publish the story, comment,
 * move to Refinement Review, human decides. What distinguishes them is written
 * where a human will actually read it — the confidence and size the refiner
 * puts in the story, and the open questions it leaves in a comment — not an
 * enum that nothing downstream branches on. See HANDOFF decision 4.
 */
export type RefineOutcome =
  | { status: 'succeeded'; refined: string }
  | { status: 'failed'; reason: string; retryable: boolean };

export type ImplementOutcome =
  | { status: 'succeeded'; pullRequestUrl: string; pullRequestId: number; branch: string; summary: string }
  | { status: 'failed'; reason: string; retryable: boolean };

export type ReviewOutcome =
  | { status: 'approved'; feedback: ReviewFeedback }
  | { status: 'changes_requested'; feedback: ReviewFeedback }
  | { status: 'failed'; reason: string; retryable: boolean };

export type AgentOutcome = RefineOutcome | ImplementOutcome | ReviewOutcome;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function hasCommonShape(value: unknown): value is WorkItemBase {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<WorkItemBase>;
  return (
    c.schemaVersion === WORK_ITEM_SCHEMA_VERSION &&
    typeof c.issueKey === 'string' &&
    typeof c.issueId === 'string' &&
    typeof c.repository === 'object' &&
    c.repository !== null
  );
}

export function isRefineWorkItem(value: unknown): value is RefineWorkItem {
  return hasCommonShape(value) && value.agent === 'refiner';
}

export function isImplementWorkItem(value: unknown): value is ImplementWorkItem {
  return (
    hasCommonShape(value) &&
    value.agent === 'implementer' &&
    typeof (value as ImplementWorkItem).attempt === 'number'
  );
}

export function isReviewWorkItem(value: unknown): value is ReviewWorkItem {
  return (
    hasCommonShape(value) &&
    value.agent === 'reviewer' &&
    typeof (value as ReviewWorkItem).branch === 'string'
  );
}
