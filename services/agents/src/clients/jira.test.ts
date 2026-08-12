/**
 * The agent-side Jira write path.
 *
 * Focused on the remote link, because it is the one write whose failure is
 * silent rather than loud: the reviewer's work item is built from `branch`,
 * `pullRequestUrl` and `pullRequestId`, and `dispatch_review` returns undefined
 * when any of them is missing — so a link that does not land leaves the ticket
 * sitting in Code Review with nothing happening and nothing logged as wrong.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { JiraConfig } from '@cloud-harness/shared';

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

    await new JiraWriter(config, silent).linkPullRequest('KAN-6', {
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
    const writer = new JiraWriter(config, silent);
    const pr = { url: 'https://bitbucket.org/acme/widgets/pull-requests/7', id: 7, branch: 'agent/kan-6' };

    await writer.linkPullRequest('KAN-6', pr);
    await writer.linkPullRequest('KAN-6', pr);

    assert.equal(calls[0]?.body['globalId'], 'cloud-harness-pr-7');
    assert.equal(calls[1]?.body['globalId'], 'cloud-harness-pr-7');
  });

  it('throws with the status when Jira rejects the link', async () => {
    stubFetch(() => new Response('issue does not exist', { status: 404 }));

    await assert.rejects(
      () =>
        new JiraWriter(config, silent).linkPullRequest('KAN-999', {
          url: 'https://bitbucket.org/acme/widgets/pull-requests/7',
          id: 7,
          branch: 'agent/kan-999',
        }),
      /404/,
    );
  });
});
