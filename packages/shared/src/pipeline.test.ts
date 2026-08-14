import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  countAttempts,
  decide,
  implementReasonFor,
  needsHistory,
  reconcilePullRequest,
  type IssueHistory,
  type PipelineConfig,
  type StatusIds,
  type StatusTransition,
  type TicketSnapshot,
} from './pipeline.js';

const BOT = 'bot-account-id';
const HUMAN = 'human-account-id';

const config: PipelineConfig = {
  statuses: {
    toDo: 'To Do',
    inProgress: 'In Progress',
    codeReview: 'Code Review',
    validation: 'Validation',
    done: 'Done',
    blocked: 'Blocked',
    closed: 'Closed',
  },
  labels: {
    agentLane: 'agent',
  },
  fields: {
    botAccountId: BOT,
    codeReviewer: 'customfield_10100',
    dor: 'customfield_10200',
    dorTickedValue: 'Yes',
    storyPoints: 'customfield_10300',
    acceptanceCriteria: 'customfield_10400',
  },
  maxAttempts: 3,
};

const ids: StatusIds = { inProgress: '3', codeReview: '10050' };

function ticket(overrides: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return {
    issueKey: 'ENG-1',
    issueId: '10001',
    summary: 'Add a thing',
    description: 'Rough draft',
    status: 'To Do',
    // In the agent lane by default: almost every case below is about a ticket
    // the pipeline is allowed to touch. The lane guard gets its own tests.
    labels: ['agent'],
    dor: false,
    attempts: 0,
    ...overrides,
  };
}

/** A ticket that has been refined and approved, ready for the implementer. */
function approved(overrides: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return ticket({
    status: 'In Progress',
    dor: true,
    acceptanceCriteria: '- it works',
    ...overrides,
  });
}

/** A ticket whose implementer has opened a pull request. */
function withPr(overrides: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return approved({
    status: 'Code Review',
    pullRequestId: 7,
    pullRequestUrl: 'https://bitbucket.org/w/r/pull-requests/7',
    branch: 'agent/eng-1',
    pullRequestMergeable: true,
    ...overrides,
  });
}

function attempt(at: string): StatusTransition {
  return { at, fromStatusId: ids.inProgress, toStatusId: ids.codeReview };
}

function history(overrides: Partial<IssueHistory> = {}): IssueHistory {
  return { transitions: [], dorGrantedAt: [], ...overrides };
}

// ---------------------------------------------------------------------------
// The attempt budget is derived from history, never stored.
// ---------------------------------------------------------------------------

describe('countAttempts', () => {
  it('is zero for a ticket that has never been implemented', () => {
    assert.equal(countAttempts(history(), ids), 0);
    assert.equal(countAttempts(history({ dorGrantedAt: ['2026-01-01T00:00:00Z'] }), ids), 0);
  });

  it('counts each In Progress → Code Review edge', () => {
    const h = history({
      dorGrantedAt: ['2026-01-01T00:00:00Z'],
      transitions: [attempt('2026-01-01T01:00:00Z'), attempt('2026-01-01T02:00:00Z')],
    });
    assert.equal(countAttempts(h, ids), 2);
  });

  it('counts the edge, not the destination', () => {
    // This is what makes rebases and consented fixes structurally exempt: both
    // arrive at Code Review without leaving In Progress, so there is no rule
    // here to get wrong. The gate-2 rebase comes from Validation and is
    // excluded by exactly the same test.
    const h = history({
      dorGrantedAt: ['2026-01-01T00:00:00Z'],
      transitions: [
        // Rebase: Code Review → Code Review, via the implementer.
        { at: '2026-01-01T01:00:00Z', fromStatusId: ids.codeReview, toStatusId: ids.codeReview },
        // Gate-2 rebase: Validation → Code Review.
        { at: '2026-01-01T02:00:00Z', fromStatusId: '10060', toStatusId: ids.codeReview },
        // The reviewer sending work back: the opposite edge.
        { at: '2026-01-01T03:00:00Z', fromStatusId: ids.codeReview, toStatusId: ids.inProgress },
      ],
    });
    assert.equal(countAttempts(h, ids), 0);
  });

  it('ignores an edge into Code Review from nowhere in particular', () => {
    // A human dragging a card straight from To Do onto Code Review is not an
    // implementation attempt, and must not be charged as one.
    const h = history({
      transitions: [{ at: '2026-01-01T01:00:00Z', fromStatusId: '10000', toStatusId: ids.codeReview }],
    });
    assert.equal(countAttempts(h, ids), 0);
  });

  it('resets at the most recent DOR tick', () => {
    const h = history({
      dorGrantedAt: ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'],
      transitions: [
        attempt('2026-01-01T01:00:00Z'),
        attempt('2026-01-01T02:00:00Z'),
        // Human re-ticks DOR on 01-02, granting a fresh budget.
        attempt('2026-01-02T01:00:00Z'),
      ],
    });
    assert.equal(countAttempts(h, ids), 1);
  });

  it('counts everything when DOR has never been recorded as ticked', () => {
    // A ticket whose DOR predates the changelog, or a board where the tick was
    // never captured. Counting from the beginning is the safe direction: it
    // spends the budget rather than granting an unlimited one.
    const h = history({ transitions: [attempt('2026-01-01T01:00:00Z')] });
    assert.equal(countAttempts(h, ids), 1);
  });

  it('does not assume the changelog arrives in order', () => {
    const h = history({
      dorGrantedAt: ['2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'],
      transitions: [
        attempt('2026-01-02T01:00:00Z'),
        attempt('2026-01-01T01:00:00Z'),
        attempt('2026-01-01T02:00:00Z'),
      ],
    });
    assert.equal(countAttempts(h, ids), 1);
  });

  it('is unaffected by anything on the ticket — nothing can forge it', () => {
    // The whole point: a user editing fields or labels cannot change the
    // budget, because the budget is not read from the ticket at all.
    const h = history({
      dorGrantedAt: ['2026-01-01T00:00:00Z'],
      transitions: [
        attempt('2026-01-01T01:00:00Z'),
        attempt('2026-01-01T02:00:00Z'),
        attempt('2026-01-01T03:00:00Z'),
      ],
    });
    assert.equal(countAttempts(h, ids), 3);
  });
});

describe('needsHistory', () => {
  it('only pays for the changelog where the decision depends on it', () => {
    assert.equal(needsHistory(withPr(), config), true);
    assert.equal(needsHistory(withPr({ status: 'Validation' }), config), true);
    assert.equal(needsHistory(approved({ ...withPr(), status: 'In Progress' }), config), true);

    // In Progress with no pull request is the first pass off gate 1, and the
    // DOR tick that put it there is also the reset — the count is zero by
    // construction, so the call is not worth making.
    assert.equal(needsHistory(approved(), config), false);
    assert.equal(needsHistory(ticket(), config), false);
    assert.equal(needsHistory(ticket({ status: 'Done' }), config), false);
  });
});

// ---------------------------------------------------------------------------
// The reason comes from Bitbucket, not from a column somebody can drag.
// ---------------------------------------------------------------------------

describe('implementReasonFor', () => {
  it('is a first pass when there is no pull request', () => {
    assert.equal(implementReasonFor(approved()), 'initial');
  });

  it('is a rebase when the pull request conflicts', () => {
    assert.equal(implementReasonFor(withPr({ pullRequestMergeable: false })), 'rebase');
  });

  it('is a send-back for any other open pull request', () => {
    assert.equal(implementReasonFor(withPr()), 'changes_requested');
  });

  it('never reads unknown mergeability as conflicted', () => {
    // Bitbucket has not computed it, or the call failed. A rebase queued on a
    // guess costs an implementer run; a skipped tick costs a minute.
    const unknown = withPr();
    delete unknown.pullRequestMergeable;
    assert.equal(implementReasonFor(unknown), 'changes_requested');
  });
});

// ---------------------------------------------------------------------------
// decide()
// ---------------------------------------------------------------------------

describe('decide — the lane', () => {
  it('does nothing at any stage while the ticket is in the human lane', () => {
    // The whole opt-in. Every one of these would be an action in the agent
    // lane; without the label none of them are.
    const tickets = [
      ticket({ labels: [] }),
      approved({ labels: [] }),
      withPr({ labels: [] }),
      withPr({ labels: [], pullRequestMergeable: false }),
      withPr({ labels: [], status: 'Validation', pullRequestMergeable: false }),
    ];
    for (const t of tickets) {
      const action = decide(t, config);
      assert.equal(action.kind, 'idle', t.status);
      assert.equal(action.kind === 'idle' && action.reason, 'human lane', t.status);
    }
  });

  it('ignores every other label a ticket happens to carry', () => {
    const action = decide(ticket({ labels: ['needs-design', 'p1'] }), config);
    assert.equal(action.kind, 'idle');
  });
});

describe('decide — the in-flight markers', () => {
  it('does not re-dispatch a ticket the bot is already assigned', () => {
    // Assignee is the in-flight marker for the refiner and the implementer, in
    // whichever column they run.
    for (const status of ['To Do', 'In Progress', 'Code Review']) {
      const action = decide(ticket({ status, dor: true, assigneeAccountId: BOT }), config);
      assert.equal(action.kind, 'idle', status);
      assert.match(action.kind === 'idle' ? action.reason : '', /agent in flight/, status);
    }
  });

  it('does not re-dispatch a review the bot is already holding', () => {
    const action = decide(withPr({ codeReviewerAccountId: BOT }), config);
    assert.equal(action.kind, 'idle');
    assert.match(action.kind === 'idle' ? action.reason : '', /reviewer in flight/);
  });

  it('is not fooled by a human holding either field', () => {
    // A human assignee is normal and means nothing to the pipeline; a human in
    // Code Reviewer at gate 2 is the whole point of that field.
    const assigned = decide(withPr({ assigneeAccountId: HUMAN }), config);
    assert.equal(assigned.kind, 'dispatch_review');

    const reviewed = decide(withPr({ codeReviewerAccountId: HUMAN }), config);
    assert.equal(reviewed.kind, 'dispatch_review');
  });
});

describe('decide — To Do, where three states share a column', () => {
  it('refines a ticket the pipeline has never commented on', () => {
    const action = decide(ticket(), config);
    assert.equal(action.kind, 'dispatch_refine');
    // No transition: refinement happens in the column it is already in.
    assert(action.kind === 'dispatch_refine');
    assert.equal(action.mutation.status, undefined);
    assert.equal(action.mutation.assignee, 'bot');
  });

  it('refines a ticket whose only comments are a human’s', () => {
    // Someone adding context to a brand new ticket must not make this look like
    // a ticket that has already been through the refiner.
    const action = decide(
      ticket({ conversation: [{ author: 'human', text: 'also needs to handle empty input' }] }),
      config,
    );
    assert.equal(action.kind, 'dispatch_refine');
  });

  it('waits at gate 1 once the pipeline has handed back', () => {
    const action = decide(
      ticket({
        conversation: [
          { author: 'human', text: 'draft' },
          { author: 'agent', text: 'I refined this as far as I could.' },
        ],
      }),
      config,
    );
    assert.equal(action.kind, 'idle');
    assert.match(action.kind === 'idle' ? action.reason : '', /gate 1/);
  });

  it('refines again when a human answers', () => {
    // The send-back signal, and it is decision 4's comment thread doing the
    // work rather than a column move there is no column for.
    const action = decide(
      ticket({
        conversation: [
          { author: 'agent', text: '1. CLI or HTTP service?' },
          { author: 'human', text: 'CLI, definitely' },
        ],
      }),
      config,
    );
    assert.equal(action.kind, 'dispatch_refine');
  });

  it('leaves the lane label on when it dispatches', () => {
    // The label is standing consent, not a doorbell. Consuming it here would
    // drop the ticket out of the pipeline after a single stage.
    const action = decide(ticket(), config);
    assert(action.kind === 'dispatch_refine');
    assert.equal(action.mutation.removeLabels, undefined);
  });

  it('implements once DOR is ticked, and moves the card to In Progress', () => {
    const action = decide(ticket({ dor: true, acceptanceCriteria: '- it works' }), config);
    assert(action.kind === 'dispatch_implement');
    assert.equal(action.reason, 'initial');
    assert.equal(action.attempt, 1);
    assert.deepEqual(action.mutation, { status: 'In Progress', assignee: 'bot' });
  });

  it('refuses to implement a DOR ticked on a ticket with no criteria', () => {
    // The one way gate 1 gets skipped by accident: someone ticks DOR on a
    // ticket the refiner never saw. Cheap guard, and it stops the implementer
    // building against no spec at all.
    for (const criteria of [undefined, '', '   ']) {
      const action = decide(
        ticket({ dor: true, ...(criteria === undefined ? {} : { acceptanceCriteria: criteria }) }),
        config,
      );
      assert.equal(action.kind, 'idle', String(criteria));
      assert.match(action.kind === 'idle' ? action.reason : '', /acceptance criteria/);
    }
  });
});

describe('decide — In Progress and the attempt budget', () => {
  it('starts at implementation 1 on the first pass', () => {
    const action = decide(approved(), config);
    assert(action.kind === 'dispatch_implement');
    assert.equal(action.reason, 'initial');
    assert.equal(action.attempt, 1);
    // Already in the column, so nothing to transition — only the marker.
    assert.deepEqual(action.mutation, { assignee: 'bot' });
  });

  it('dispatches implementation N+1 after N attempts', () => {
    const action = decide(
      approved({ ...withPr(), status: 'In Progress', attempts: 1 }),
      config,
    );
    assert(action.kind === 'dispatch_implement');
    assert.equal(action.reason, 'changes_requested');
    assert.equal(action.attempt, 2);
  });

  it('allows exactly maxAttempts implementations', () => {
    const base = { ...withPr(), status: 'In Progress' };

    const third = decide(approved({ ...base, attempts: 2 }), config);
    assert(third.kind === 'dispatch_implement');
    assert.equal(third.attempt, 3);

    const fourth = decide(approved({ ...base, attempts: 3 }), config);
    assert.equal(fourth.kind, 'fail');
    assert.equal(fourth.kind === 'fail' && fourth.mutation.status, 'Blocked');
  });
});

describe('decide — Code Review, where four states share a column', () => {
  it('reviews a healthy pull request without moving the card', () => {
    const action = decide(withPr({ attempts: 1 }), config);
    assert(action.kind === 'dispatch_review');
    assert.equal(action.attempt, 1);
    // The reviewer's marker is Code Reviewer, not Assignee — which is what lets
    // this column hold a review and a rebase at once.
    assert.deepEqual(action.mutation, { codeReviewer: 'bot' });
  });

  it('rebases a conflicted pull request without moving the card', () => {
    const action = decide(withPr({ attempts: 2, pullRequestMergeable: false }), config);
    assert(action.kind === 'dispatch_implement');
    assert.equal(action.reason, 'rebase');
    // No status: staying in Code Review is exactly what keeps this off the
    // attempt budget, since countAttempts can only see edges out of In Progress.
    assert.deepEqual(action.mutation, { assignee: 'bot' });
  });

  it('still rebases a ticket that has spent its whole budget', () => {
    // Otherwise a pull request that went the full three rounds could never be
    // made mergeable again, and gate 2 would have nothing to merge.
    const action = decide(withPr({ attempts: 3, pullRequestMergeable: false }), config);
    assert.equal(action.kind, 'dispatch_implement');
  });

  it('does not rebase on unknown mergeability', () => {
    const unknown = withPr();
    delete unknown.pullRequestMergeable;
    assert.equal(decide(unknown, config).kind, 'dispatch_review');
  });
});

describe('decide — the human gates and the terminal columns', () => {
  it('idles at gate 2 — validating and merging is the human’s call', () => {
    const action = decide(withPr({ status: 'Validation' }), config);
    assert.equal(action.kind, 'idle');
    assert.match(action.kind === 'idle' ? action.reason : '', /gate 2/);
  });

  it('rebases from gate 2 when the base branch moves underneath it', () => {
    // The one thing worth doing to an approved pull request while it waits. It
    // arrives at Code Review from Validation, so the edge rule still will not
    // count it.
    const action = decide(
      withPr({ status: 'Validation', pullRequestMergeable: false }),
      config,
    );
    assert(action.kind === 'dispatch_implement');
    assert.equal(action.reason, 'rebase');
    assert.deepEqual(action.mutation, { status: 'Code Review', assignee: 'bot' });
  });

  it('leaves the terminal columns alone', () => {
    for (const status of ['Done', 'Blocked', 'Closed']) {
      assert.equal(decide(withPr({ status }), config).kind, 'idle', status);
    }
  });

  it('does nothing in a column it does not recognise', () => {
    // A real board has columns this state machine has never heard of, and a
    // ticket parked in one must not be acted on.
    for (const status of ['On Hold', 'Awaiting Vendor']) {
      const action = decide(ticket({ status, dor: true }), config);
      assert.equal(action.kind, 'idle', status);
      assert.equal(action.kind === 'idle' && action.reason, 'no signal', status);
    }
  });
});

// ---------------------------------------------------------------------------
// reconcilePullRequest()
// ---------------------------------------------------------------------------

describe('reconcilePullRequest', () => {
  const pr = {
    id: 7,
    url: 'https://bitbucket.org/w/r/pull-requests/7',
    branch: 'agent/eng-1',
    state: 'OPEN' as const,
    mergeable: true,
  };

  it('closes the ticket when the human merges', () => {
    const mutation = reconcilePullRequest(withPr({ status: 'Validation' }), { ...pr, state: 'MERGED' }, config);
    assert.equal(mutation?.status, 'Done');
    assert.equal(mutation?.assignee, 'clear');
  });

  it('blocks the ticket when the pull request is declined', () => {
    const mutation = reconcilePullRequest(withPr(), { ...pr, state: 'DECLINED' }, config);
    assert.equal(mutation?.status, 'Blocked');
  });

  it('does nothing about a conflict — that is decide()’s job now', () => {
    // Conflicts used to be reconciled into a Rebase Required status. They
    // travel on the snapshot instead, so a rebase happens without the ticket
    // leaving Code Review, which is what keeps it off the attempt budget.
    assert.equal(
      reconcilePullRequest(withPr(), { ...pr, mergeable: false }, config),
      undefined,
    );
  });

  it('is a no-op for a healthy open PR', () => {
    assert.equal(reconcilePullRequest(withPr(), pr, config), undefined);
  });

  it('does not re-close a ticket that is already terminal', () => {
    assert.equal(
      reconcilePullRequest(withPr({ status: 'Done' }), { ...pr, state: 'MERGED' }, config),
      undefined,
    );
    assert.equal(
      reconcilePullRequest(withPr({ status: 'Blocked' }), { ...pr, state: 'DECLINED' }, config),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// End to end over the derivation, since that is where the off-by-ones live.
// ---------------------------------------------------------------------------

describe('a full three-strike lifecycle', () => {
  it('spends exactly three implementations, ignoring an interleaved rebase', () => {
    const log = history();
    const at = (h: number) => `2026-01-01T${String(h).padStart(2, '0')}:00:00Z`;
    const pr = {
      pullRequestId: 7,
      pullRequestUrl: 'https://bitbucket.org/w/r/pull-requests/7',
      branch: 'agent/eng-1',
    };

    // Gate 1: a human reads the story and ticks DOR.
    log.dorGrantedAt.push(at(0));
    let attempts = countAttempts(log, ids);
    let action = decide(ticket({ dor: true, acceptanceCriteria: '- it works', attempts }), config);
    assert(action.kind === 'dispatch_implement' && action.attempt === 1);
    assert.equal(action.mutation.status, 'In Progress');

    // The implementer opens a pull request: In Progress → Code Review. That
    // edge is the first attempt.
    log.transitions.push(attempt(at(1)));
    attempts = countAttempts(log, ids);
    assert.equal(attempts, 1);

    // Base branch moves under the pull request; a rebase happens, entirely
    // within Code Review. No budget spent.
    log.transitions.push({ at: at(2), fromStatusId: ids.codeReview, toStatusId: ids.codeReview });
    attempts = countAttempts(log, ids);
    action = decide(
      approved({ ...pr, status: 'Code Review', pullRequestMergeable: false, attempts }),
      config,
    );
    assert(action.kind === 'dispatch_implement' && action.reason === 'rebase');
    assert.equal(attempts, 1, 'still the first implementation');
    assert.equal(action.mutation.status, undefined, 'and it never leaves Code Review');

    // Two review round trips: back to In Progress, then out again.
    for (const [round, hour] of [
      [2, 3],
      [3, 4],
    ] as const) {
      log.transitions.push({ at: at(hour), fromStatusId: ids.codeReview, toStatusId: ids.inProgress });
      attempts = countAttempts(log, ids);
      action = decide(
        approved({ ...pr, status: 'In Progress', pullRequestMergeable: true, attempts }),
        config,
      );
      assert(action.kind === 'dispatch_implement', `round ${round}`);
      assert.equal(action.attempt, round);
      log.transitions.push(attempt(`2026-01-01T${String(hour).padStart(2, '0')}:30:00Z`));
    }

    // A third send-back exhausts the budget.
    log.transitions.push({ at: at(5), fromStatusId: ids.codeReview, toStatusId: ids.inProgress });
    attempts = countAttempts(log, ids);
    assert.equal(attempts, 3);
    action = decide(
      approved({ ...pr, status: 'In Progress', pullRequestMergeable: true, attempts }),
      config,
    );
    assert.equal(action.kind, 'fail');

    // A human re-ticking DOR grants a fresh budget — and leaves a record of it.
    log.dorGrantedAt.push(at(6));
    attempts = countAttempts(log, ids);
    assert.equal(attempts, 0);
    action = decide(
      approved({ ...pr, status: 'In Progress', pullRequestMergeable: true, attempts }),
      config,
    );
    assert(action.kind === 'dispatch_implement' && action.attempt === 1);
  });
});
