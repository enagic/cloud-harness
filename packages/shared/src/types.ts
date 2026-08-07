/**
 * The contracts between the watcher and the three agents.
 *
 * These are the interfaces that must not drift: the watcher writes work items
 * to SQS, the agents read them back, and all four deploy independently. Add
 * fields optionally and bump `schemaVersion` for anything breaking, so an
 * in-flight message written by the old watcher is still readable by the new
 * agent.
 */

export const WORK_ITEM_SCHEMA_VERSION = 1 as const;

/** Which agent a work item is destined for. */
export type AgentKind = 'refiner' | 'implementer' | 'reviewer';

/** Repo coordinates carried on every work item. */
export interface RepositoryRef {
  workspace: string;
  slug: string;
  baseBranch: string;
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

  /** ISO 8601. When the watcher dispatched this item. */
  dispatchedAt: string;
  /** Free-form passthrough for tracing; not interpreted by the agents. */
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Refiner
// ---------------------------------------------------------------------------

export interface RefineWorkItem extends WorkItemBase {
  agent: 'refiner';
  /** The human's rough description, as it stands on the board. */
  draftDescription: string;
  /**
   * Set when a human sent the refinement back rather than approving it —
   * carries their comments so the refiner can revise rather than restart.
   */
  reviewerComments?: string[];
}

/** What the refiner produces, before a human sees it. */
export interface RefinedStory {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  /**
   * Files, modules, and prior art the refiner found in the repo. This is the
   * point of giving the refiner repo access: the implementer should not have
   * to rediscover where the work belongs.
   */
  codeContext: {
    relevantPaths: string[];
    notes: string;
  };
  /** Questions the refiner could not resolve; surfaced to the human reviewer. */
  openQuestions: string[];
  estimate?: string;
}

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

  /** The approved story — the actual spec. */
  refinedDescription: string;
  acceptanceCriteria: string[];
  relevantPaths: string[];

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

  /** The story the implementation is meant to satisfy. */
  refinedDescription: string;
  acceptanceCriteria: string[];

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
  /** Whether the reviewer ran the repo's tests, and what happened. */
  verification: {
    attempted: boolean;
    passed?: boolean;
    output?: string;
  };
}

export type WorkItem = RefineWorkItem | ImplementWorkItem | ReviewWorkItem;

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type RefineOutcome =
  | { status: 'succeeded'; refined: RefinedStory }
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
