import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  countAttempts,
  decide,
  needsHistory,
  reconcilePullRequest,
  type PipelineConfig,
  type StatusIds,
  type StatusTransition,
  type TicketSnapshot,
} from './pipeline.js';

const config: PipelineConfig = {
  statuses: {
    refining: 'Refining',
    refinementReview: 'Refinement Review',
    readyToImplement: 'Ready for Implementation',
    implementing: 'Implementing',
    codeReview: 'Code Review',
    reviewing: 'Reviewing',
    changesRequested: 'Changes Requested',
    rebaseRequired: 'Rebase Required',
    awaitingMerge: 'Awaiting Merge',
    done: 'Done',
    failed: 'Agent Failed',
  },
  labels: {
    agentLane: 'agent',
  },
  draftStatuses: ['Backlog', 'To Do'],
  maxAttempts: 3,
};

const ids: StatusIds = { readyToImplement: '10010', changesRequested: '10020' };

function ticket(overrides: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return {
    issueKey: 'ENG-1',
    issueId: '10001',
    summary: 'Add a thing',
    description: 'Rough draft',
    status: 'Backlog',
    // In the agent lane by default: almost every case below is about a ticket
    // the pipeline is allowed to touch. The lane guard gets its own tests.
    labels: ['agent'],
    attempts: 0,
    ...overrides,
  };
}

function transition(toStatusId: string, at: string): StatusTransition {
  return { at, toStatusId };
}

// ---------------------------------------------------------------------------
// The attempt budget is derived from history, never stored.
// ---------------------------------------------------------------------------

describe('countAttempts', () => {
  it('is zero for a ticket that has never been sent back', () => {
    assert.equal(countAttempts([], ids), 0);
    assert.equal(
      countAttempts([transition(ids.readyToImplement, '2026-01-01T00:00:00Z')], ids),
      0,
    );
  });

  it('counts each entry into changes-requested', () => {
    const history = [
      transition(ids.readyToImplement, '2026-01-01T00:00:00Z'),
      transition(ids.changesRequested, '2026-01-01T01:00:00Z'),
      transition(ids.changesRequested, '2026-01-01T02:00:00Z'),
    ];
    assert.equal(countAttempts(history, ids), 2);
  });

  it('ignores transitions into any other status', () => {
    // This is what makes rebases structurally exempt: they move the ticket
    // through a different status, so there is no rule here to get wrong.
    const history = [
      transition(ids.readyToImplement, '2026-01-01T00:00:00Z'),
      transition('10030', '2026-01-01T01:00:00Z'), // rebase required
      transition('10040', '2026-01-01T02:00:00Z'), // implementing
      transition('10050', '2026-01-01T03:00:00Z'), // code review
    ];
    assert.equal(countAttempts(history, ids), 0);
  });

  it('resets at the most recent human approval', () => {
    const history = [
      transition(ids.readyToImplement, '2026-01-01T00:00:00Z'),
      transition(ids.changesRequested, '2026-01-01T01:00:00Z'),
      transition(ids.changesRequested, '2026-01-01T02:00:00Z'),
      // Human sends it back through refinement and re-approves.
      transition(ids.readyToImplement, '2026-01-02T00:00:00Z'),
      transition(ids.changesRequested, '2026-01-02T01:00:00Z'),
    ];
    assert.equal(countAttempts(history, ids), 1);
  });

  it('does not assume the changelog arrives in order', () => {
    const history = [
      transition(ids.changesRequested, '2026-01-02T01:00:00Z'),
      transition(ids.readyToImplement, '2026-01-02T00:00:00Z'),
      transition(ids.changesRequested, '2026-01-01T01:00:00Z'),
      transition(ids.readyToImplement, '2026-01-01T00:00:00Z'),
    ];
    assert.equal(countAttempts(history, ids), 1);
  });

  it('is unaffected by labels — nothing on the ticket can forge it', () => {
    // The whole point: a user editing labels cannot change the budget, because
    // the budget is not read from the ticket at all.
    const history = [
      transition(ids.readyToImplement, '2026-01-01T00:00:00Z'),
      transition(ids.changesRequested, '2026-01-01T01:00:00Z'),
      transition(ids.changesRequested, '2026-01-01T02:00:00Z'),
      transition(ids.changesRequested, '2026-01-01T03:00:00Z'),
    ];
    assert.equal(countAttempts(history, ids), 3);
  });
});

describe('needsHistory', () => {
  it('only pays for the changelog where the decision depends on it', () => {
    assert.equal(needsHistory('Changes Requested', config), true);
    assert.equal(needsHistory('Code Review', config), true);
    assert.equal(needsHistory('Rebase Required', config), true);

    assert.equal(needsHistory('Backlog', config), false);
    assert.equal(needsHistory('Refinement Review', config), false);
    assert.equal(needsHistory('Awaiting Merge', config), false);
    assert.equal(needsHistory('Done', config), false);
  });
});

// ---------------------------------------------------------------------------
// decide()
// ---------------------------------------------------------------------------

describe('decide — the lane', () => {
  it('does nothing at any stage while the ticket is in the human lane', () => {
    // The whole opt-in. Every one of these would be an action in the agent
    // lane; without the label none of them are.
    const statuses = [
      'Backlog',
      'To Do',
      'Refinement Review',
      'Ready for Implementation',
      'Code Review',
      'Changes Requested',
      'Rebase Required',
    ];
    for (const status of statuses) {
      const action = decide(ticket({ status, labels: [] }), config);
      assert.equal(action.kind, 'idle', status);
      assert.equal(action.kind === 'idle' && action.reason, 'human lane', status);
    }
  });

  it('ignores every other label a ticket happens to carry', () => {
    const action = decide(ticket({ labels: ['needs-design', 'p1'] }), config);
    assert.equal(action.kind, 'idle');
  });

  it('stops dispatching the moment a human takes the ticket back', () => {
    // Mid-flight lane change. Nothing new goes out; the agent already running
    // stands down at its own write guard, which is not this function's job.
    assert.equal(decide(ticket({ status: 'Refining', labels: [] }), config).kind, 'idle');
  });
});

describe('decide — kickoff and human gates', () => {
  it('dispatches refinement for a labelled ticket in a draft column', () => {
    for (const status of ['Backlog', 'To Do']) {
      const action = decide(ticket({ status }), config);
      assert.equal(action.kind, 'dispatch_refine', status);
      assert.equal(action.kind === 'dispatch_refine' && action.mutation.status, 'Refining');
    }
  });

  it('leaves the lane label on when it dispatches', () => {
    // The label is standing consent, not a doorbell. Consuming it here would
    // drop the ticket out of the pipeline after a single stage.
    const action = decide(ticket(), config);
    assert(action.kind === 'dispatch_refine');
    assert.equal(action.mutation.removeLabels, undefined);
  });

  it('idles at the refinement review gate', () => {
    assert.equal(decide(ticket({ status: 'Refinement Review' }), config).kind, 'idle');
  });

  it('re-refines when the human moves it back to a draft column', () => {
    // The old changes-requested label's replacement: the board carries the
    // verdict, so sending a story back is just moving the card.
    const action = decide(ticket({ status: 'To Do' }), config);
    assert.equal(action.kind, 'dispatch_refine');
  });

  it('idles at the merge gate — merging is the human’s call', () => {
    assert.equal(decide(ticket({ status: 'Awaiting Merge' }), config).kind, 'idle');
  });

  it('does not re-dispatch a ticket an agent already holds', () => {
    for (const status of ['Refining', 'Implementing', 'Reviewing']) {
      assert.equal(decide(ticket({ status }), config).kind, 'idle', status);
    }
  });

  it('does not kick off from a column it does not recognise', () => {
    // The reason kickoff tests the draft columns rather than just the label.
    // A real board has columns this state machine has never heard of, and a
    // ticket parked in one would otherwise be re-refined on every tick.
    for (const status of ['Blocked', 'On Hold', 'Awaiting Merge']) {
      assert.equal(decide(ticket({ status }), config).kind, 'idle', status);
    }
  });
});

describe('decide — the attempt budget', () => {
  it('starts at implementation 1 on human approval', () => {
    const action = decide(ticket({ status: 'Ready for Implementation', attempts: 0 }), config);
    assert(action.kind === 'dispatch_implement');
    assert.equal(action.reason, 'initial');
    assert.equal(action.attempt, 1);
    // Nothing to write but the status — no counter to keep in sync.
    assert.deepEqual(action.mutation, { status: 'Implementing' });
  });

  it('dispatches implementation N+1 after N round trips', () => {
    const action = decide(ticket({ status: 'Changes Requested', attempts: 1 }), config);
    assert(action.kind === 'dispatch_implement');
    assert.equal(action.reason, 'changes_requested');
    assert.equal(action.attempt, 2);
  });

  it('allows exactly maxAttempts implementations', () => {
    const third = decide(ticket({ status: 'Changes Requested', attempts: 2 }), config);
    assert(third.kind === 'dispatch_implement');
    assert.equal(third.attempt, 3);

    const fourth = decide(ticket({ status: 'Changes Requested', attempts: 3 }), config);
    assert.equal(fourth.kind, 'fail');
    assert.equal(fourth.mutation.status, 'Agent Failed');
  });

  it('does NOT spend budget on a rebase', () => {
    const action = decide(ticket({ status: 'Rebase Required', attempts: 2 }), config);
    assert(action.kind === 'dispatch_implement');
    assert.equal(action.reason, 'rebase');
    // Same implementation attempt as before the conflict.
    assert.equal(action.attempt, 3);
    assert.deepEqual(action.mutation, { status: 'Implementing' });
  });

  it('still rebases a ticket that has spent its whole budget', () => {
    // Otherwise a PR that went the full three rounds could never be made
    // mergeable again, and human gate 2 would have nothing to merge.
    const action = decide(ticket({ status: 'Rebase Required', attempts: 3 }), config);
    assert.equal(action.kind, 'dispatch_implement');
  });
});

describe('decide — reviewer trigger', () => {
  it('reviews the implementation that is actually under review', () => {
    const action = decide(ticket({ status: 'Code Review', attempts: 1 }), config);
    assert(action.kind === 'dispatch_review');
    assert.equal(action.attempt, 2);
    assert.equal(action.mutation.status, 'Reviewing');
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

  it('flags conflicts for rebase', () => {
    const mutation = reconcilePullRequest(
      ticket({ status: 'Awaiting Merge' }),
      { ...pr, mergeable: false },
      config,
    );
    assert.equal(mutation?.status, 'Rebase Required');
  });

  it('leaves conflicts alone while an agent holds the branch', () => {
    for (const status of ['Implementing', 'Reviewing', 'Rebase Required']) {
      assert.equal(
        reconcilePullRequest(ticket({ status }), { ...pr, mergeable: false }, config),
        undefined,
        status,
      );
    }
  });

  it('closes the ticket when the human merges', () => {
    const mutation = reconcilePullRequest(
      ticket({ status: 'Awaiting Merge' }),
      { ...pr, state: 'MERGED' },
      config,
    );
    assert.equal(mutation?.status, 'Done');
  });

  it('is a no-op for a healthy open PR', () => {
    assert.equal(reconcilePullRequest(ticket({ status: 'Awaiting Merge' }), pr, config), undefined);
  });
});

// ---------------------------------------------------------------------------
// End to end over the derivation, since that is where the off-by-ones live.
// ---------------------------------------------------------------------------

describe('a full three-strike lifecycle', () => {
  it('spends exactly three implementations, ignoring an interleaved rebase', () => {
    const history: StatusTransition[] = [];
    const at = (h: number) => `2026-01-01T${String(h).padStart(2, '0')}:00:00Z`;

    // Human approves.
    history.push(transition(ids.readyToImplement, at(0)));
    let attempts = countAttempts(history, ids);
    let action = decide(ticket({ status: 'Ready for Implementation', attempts }), config);
    assert(action.kind === 'dispatch_implement' && action.attempt === 1);

    // Base branch moves under the PR; a rebase happens. No budget spent.
    history.push(transition('10030', at(1))); // rebase required
    attempts = countAttempts(history, ids);
    action = decide(ticket({ status: 'Rebase Required', attempts }), config);
    assert(action.kind === 'dispatch_implement' && action.reason === 'rebase');
    assert.equal(action.attempt, 1, 'still the first implementation');

    // Two review round trips.
    for (const [round, hour] of [
      [2, 2],
      [3, 3],
    ] as const) {
      history.push(transition(ids.changesRequested, at(hour)));
      attempts = countAttempts(history, ids);
      action = decide(ticket({ status: 'Changes Requested', attempts }), config);
      assert(action.kind === 'dispatch_implement', `round ${round}`);
      assert.equal(action.attempt, round);
    }

    // Third rejection exhausts the budget.
    history.push(transition(ids.changesRequested, at(4)));
    attempts = countAttempts(history, ids);
    action = decide(ticket({ status: 'Changes Requested', attempts }), config);
    assert.equal(action.kind, 'fail');

    // A human re-approving grants a fresh budget — and leaves a record of it.
    history.push(transition(ids.readyToImplement, at(5)));
    attempts = countAttempts(history, ids);
    assert.equal(attempts, 0);
    action = decide(ticket({ status: 'Ready for Implementation', attempts }), config);
    assert(action.kind === 'dispatch_implement' && action.attempt === 1);
  });
});
