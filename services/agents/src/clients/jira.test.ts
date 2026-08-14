/**
 * The agent-side Jira write path.
 *
 * Focused on the writes whose failure is silent rather than loud. The remote
 * link is one: the reviewer's work item is built from `branch`,
 * `pullRequestUrl` and `pullRequestId`, and `dispatch_review` returns undefined
 * when any of them is missing — so a link that does not land leaves the ticket
 * sitting in Code Review with nothing happening and nothing logged as wrong.
 *
 * The in-flight markers are the others, and they are worse. An agent that
 * finishes without releasing Assignee leaves the board saying it is still
 * working and the state machine idles on that ticket forever; an agent that
 * releases it before writing its hand-back comment leaves a window in which the
 * ticket reads as an unrefined draft and gets refined all over again.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { JiraConfig, PipelineConfig } from '@cloud-harness/shared';

import { JiraWriter } from './jira.js';

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

const config: JiraConfig = {
  baseUrl: 'https://acme.atlassian.net',
  userEmail: 'bot@acme.test',
  apiToken: 'tok',
  projectKey: 'KAN',
};

const BOT = 'bot-account-id';

const pipeline: PipelineConfig = {
  statuses: {
    toDo: 'To Do',
    inProgress: 'In Progress',
    codeReview: 'Code Review',
    validation: 'Validation',
    done: 'Done',
    blocked: 'Blocked',
    closed: 'Closed',
  },
  labels: { agentLane: 'agent' },
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

function writer(): JiraWriter {
  return new JiraWriter(config, pipeline, silent);
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function stubFetch(response: () => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>),
    });
    return response();
  }) as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;

describe('JiraWriter.linkPullRequest', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('attaches the pull request to the issue', async () => {
    const calls = stubFetch(() => new Response('', { status: 201 }));

    await writer().linkPullRequest('KAN-6', {
      url: 'https://bitbucket.org/acme/widgets/pull-requests/7',
      id: 7,
      branch: 'agent/kan-6',
    });

    const call = calls[0];
    assert.equal(call?.method, 'POST');
    assert.match(call?.url ?? '', /\/rest\/api\/3\/issue\/KAN-6\/remotelink$/);
    assert.deepEqual(call?.body['object'], {
      url: 'https://bitbucket.org/acme/widgets/pull-requests/7',
      title: 'PR #7: agent/kan-6',
      icon: { url16x16: 'https://bitbucket.org/favicon.ico', title: 'Bitbucket' },
    });
  });

  /**
   * The globalId is what makes this an upsert. A redelivered work item re-links
   * rather than adding a second copy of the same link to the ticket.
   */
  it('uses a globalId derived from the pull request id', async () => {
    const calls = stubFetch(() => new Response('', { status: 201 }));
    const client = writer();
    const pr = { url: 'https://bitbucket.org/acme/widgets/pull-requests/7', id: 7, branch: 'agent/kan-6' };

    await client.linkPullRequest('KAN-6', pr);
    await client.linkPullRequest('KAN-6', pr);

    assert.equal(calls[0]?.body['globalId'], 'cloud-harness-pr-7');
    assert.equal(calls[1]?.body['globalId'], 'cloud-harness-pr-7');
  });

  it('throws with the status when Jira rejects the link', async () => {
    stubFetch(() => new Response('issue does not exist', { status: 404 }));

    await assert.rejects(
      () =>
        writer().linkPullRequest('KAN-999', {
          url: 'https://bitbucket.org/acme/widgets/pull-requests/7',
          id: 7,
          branch: 'agent/kan-999',
        }),
      /404/,
    );
  });
});

describe('JiraWriter.applyMutation — the in-flight markers', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Transitions need a lookup first; this answers both calls plausibly. */
  function stubTransitions(): Call[] {
    return stubFetch(
      () =>
        new Response(JSON.stringify({ transitions: [{ id: '31', to: { name: 'Code Review' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
  }

  it('takes the card by setting Assignee to the bot', async () => {
    const calls = stubTransitions();

    await writer().applyMutation('KAN-6', { assignee: 'bot' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'PUT');
    assert.deepEqual(calls[0]?.body['update'], {
      assignee: [{ set: { accountId: BOT } }],
    });
  });

  /**
   * An explicit null, not an omitted key. Omitting it leaves the field exactly
   * as it was, which is the bug that leaves a finished agent still holding the
   * card and the state machine idling on it forever.
   */
  it('releases the card with an explicit null', async () => {
    const calls = stubTransitions();

    await writer().applyMutation('KAN-6', { assignee: 'clear', codeReviewer: 'clear' });

    assert.deepEqual(calls[0]?.body['update'], {
      assignee: [{ set: null }],
      customfield_10100: [{ set: null }],
    });
  });

  it('marks a review on Code Reviewer, not on Assignee', async () => {
    // Two fields for two roles is what lets one column hold a review and a
    // rebase at the same time without either agent claiming the other's run.
    const calls = stubTransitions();

    await writer().applyMutation('KAN-6', { codeReviewer: 'bot' });

    const update = calls[0]?.body['update'] as Record<string, unknown>;
    assert.deepEqual(update['customfield_10100'], [{ set: { accountId: BOT } }]);
    assert.equal(update['assignee'], undefined);
  });

  /**
   * The refiner's hand-back comment is what tells the state machine this ticket
   * has been refined, and releasing the Assignee is what tells it no agent is
   * working on it. In the other order there is a window — one HTTP call wide,
   * but the watcher ticks on a timer — where the ticket reads as an unrefined
   * draft nobody is holding, and is refined again.
   */
  it('writes the comment before it releases the card', async () => {
    const calls = stubTransitions();

    await writer().applyMutation('KAN-6', { comment: 'handing back', assignee: 'clear' });

    assert.match(calls[0]?.url ?? '', /\/comment$/);
    assert.equal(calls[1]?.method, 'PUT');
    assert.deepEqual(calls[1]?.body['update'], { assignee: [{ set: null }] });
  });

  it('transitions last, so a partial failure leaves the ticket where it was', async () => {
    const calls = stubTransitions();

    await writer().applyMutation('KAN-6', {
      comment: 'done',
      assignee: 'clear',
      status: 'Code Review',
    });

    assert.match(calls[0]?.url ?? '', /\/comment$/);
    assert.match(calls[1]?.url ?? '', /\/issue\/KAN-6$/);
    assert.match(calls[2]?.url ?? '', /\/transitions$/); // the lookup
    assert.equal(calls[3]?.method, 'POST');
    assert.deepEqual(calls[3]?.body['transition'], { id: '31' });
  });

  it('does not write fields at all when the mutation has none', async () => {
    const calls = stubTransitions();

    await writer().applyMutation('KAN-6', { comment: 'just a note' });

    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? '', /\/comment$/);
  });
});

describe('JiraWriter.publishRefinement', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('writes the story and both board fields in one call', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));

    await writer().publishRefinement('KAN-6', {
      story: '## Context\n\nA thing.',
      storyPoints: 3,
      acceptanceCriteria: '- it works',
    });

    assert.equal(calls.length, 1);
    const fields = calls[0]?.body['fields'] as Record<string, unknown>;
    assert.equal(fields['customfield_10300'], 3);
    assert.notEqual(fields['description'], undefined);
    // The criteria field is a textarea, so v3 wants ADF rather than a string.
    assert.equal((fields['customfield_10400'] as { type?: string })?.type, 'doc');
  });

  /**
   * An unsized story is still worth publishing. The workflow's own validator
   * stops the ticket at gate 1 until a human puts a number in — which is the
   * fallback that existed before the refiner wrote this field at all, and a
   * wrong number in a gated field is worse than an empty one.
   */
  it('omits Story Points rather than guessing when the model did not size it', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));

    await writer().publishRefinement('KAN-6', { story: 'A thing.' });

    const fields = calls[0]?.body['fields'] as Record<string, unknown>;
    assert.equal('customfield_10300' in fields, false);
    assert.equal('customfield_10400' in fields, false);
  });
});

describe('JiraWriter.readLaneState', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubIssue(fields: Record<string, unknown>): Call[] {
    return stubFetch(
      () =>
        new Response(JSON.stringify({ fields }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
  }

  it('reads both in-flight markers, since the column no longer carries them', async () => {
    const calls = stubIssue({
      status: { name: 'Code Review' },
      labels: ['agent'],
      assignee: { accountId: BOT },
      customfield_10100: { accountId: 'someone-else' },
    });

    const lane = await writer().readLaneState('KAN-6');

    assert.deepEqual(lane, {
      status: 'Code Review',
      labels: ['agent'],
      assigneeAccountId: BOT,
      codeReviewerAccountId: 'someone-else',
    });
    assert.match(calls[0]?.url ?? '', /fields=status,labels,assignee,customfield_10100/);
  });

  it('leaves an unassigned ticket’s markers absent rather than empty', async () => {
    stubIssue({ status: { name: 'To Do' }, labels: [], assignee: null });

    const lane = await writer().readLaneState('KAN-6');

    assert.equal('assigneeAccountId' in lane, false);
    assert.equal('codeReviewerAccountId' in lane, false);
  });
});
