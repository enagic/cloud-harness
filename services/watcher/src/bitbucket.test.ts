import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { BitbucketConfig, RepositoryRef } from '@cloud-harness/shared';

import { BitbucketReader } from './bitbucket.js';

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

const repo: RepositoryRef = { workspace: 'acme', slug: 'widgets', baseBranch: 'main' };

function config(overrides: Partial<BitbucketConfig> = {}): BitbucketConfig {
  return {
    workspace: 'acme',
    defaultRepo: 'widgets',
    defaultBranch: 'main',
    role: 'read',
    token: 'tok',
    ...overrides,
  };
}

interface Call {
  url: string;
  authorization: string;
}

/**
 * Replace global fetch with a scripted responder, recording what was asked for.
 *
 * The reader talks to Bitbucket through global fetch exactly as the Jira client
 * does, so this is the seam. `respond` returns undefined for "nothing matched",
 * which fails the test loudly rather than falling through to a real request.
 */
function stubFetch(respond: (url: string) => Response | undefined): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get('authorization') ?? '' });
    const response = respond(url);
    assert.ok(response !== undefined, `unexpected request: ${url}`);
    return response;
  }) as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('BitbucketReader.readManifest', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns the raw file from the base branch', async () => {
    const calls = stubFetch((url) =>
      url.endsWith('/src/main/.cloud-harness.yml') ? new Response('stack: node\n') : undefined,
    );

    const source = await new BitbucketReader(config(), silent).readManifest(repo);

    assert.equal(source, 'stack: node\n');
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/repositories\/acme\/widgets\/src\/main\//);
  });

  it('falls through to the .yaml spelling', async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith('.cloud-harness.yml')) return new Response('', { status: 404 });
      if (url.endsWith('.cloud-harness.yaml')) return new Response('stack: java\n');
      return undefined;
    });

    const source = await new BitbucketReader(config(), silent).readManifest(repo);

    assert.equal(source, 'stack: java\n');
    assert.equal(calls.length, 2);
  });

  // A repo with no manifest is normal — it means the default stack applies —
  // and must not reach the board as a failure.
  it('returns undefined when the repo has no manifest', async () => {
    const calls = stubFetch((url) =>
      // The repo itself is readable; only the files are missing.
      url.endsWith('/repositories/acme/widgets')
        ? json({ full_name: 'acme/widgets' })
        : new Response('', { status: 404 }),
    );

    const source = await new BitbucketReader(config(), silent).readManifest(repo);

    assert.equal(source, undefined);
    // Both filenames, then the visibility probe.
    assert.equal(calls.length, 3);
  });

  // The failure this exists to prevent: Bitbucket 404s a repo the token cannot
  // see, so "no access" would otherwise read as "no manifest" and silently run
  // a Java repo's tests in the Node image.
  it('distinguishes an invisible repo from an absent manifest', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'You may not have access' } }), {
          status: 404,
        }),
    );

    await assert.rejects(
      () => new BitbucketReader(config(), silent).readManifest(repo),
      /not readable by the read identity/,
    );
  });

  // The probe must not turn a real outage into "no manifest" either.
  it('surfaces a non-404 on the visibility probe', async () => {
    stubFetch((url) =>
      url.endsWith('/repositories/acme/widgets')
        ? new Response('boom', { status: 500 })
        : new Response('', { status: 404 }),
    );

    await assert.rejects(
      () => new BitbucketReader(config(), silent).readManifest(repo),
      /HTTP 500/,
    );
  });

  // Denied is not absent. Silently falling back to the default stack here would
  // run a Java repo's tests in a Node image.
  it('throws on a non-404 error', async () => {
    stubFetch(() => new Response('no access', { status: 403 }));

    await assert.rejects(
      () => new BitbucketReader(config(), silent).readManifest(repo),
      /403/,
    );
  });

  it('caches within the TTL — one read per repo, not per ticket', async () => {
    const calls = stubFetch((url) =>
      url.endsWith('.cloud-harness.yml') ? new Response('stack: node\n') : undefined,
    );

    const reader = new BitbucketReader(config(), silent);
    await reader.readManifest(repo);
    await reader.readManifest(repo);
    await reader.readManifest(repo);

    assert.equal(calls.length, 1);
  });

  it('retries an Atlassian API token as Basic when Bearer is rejected', async () => {
    const calls = stubFetch((url) => {
      if (!url.endsWith('.cloud-harness.yml')) return undefined;
      return calls.length === 1 ? new Response('', { status: 401 }) : new Response('stack: node\n');
    });

    const reader = new BitbucketReader(config({ email: 'bot@acme.test' }), silent);
    assert.equal(await reader.readManifest(repo), 'stack: node\n');

    assert.equal(calls.length, 2);
    assert.match(calls[0]!.authorization, /^Bearer /);
    assert.match(calls[1]!.authorization, /^Basic /);

    // The working scheme is remembered, so the 401 is paid once per process.
    await reader.readManifest({ ...repo, baseBranch: 'develop' });
    assert.equal(calls.length, 3);
    assert.match(calls[2]!.authorization, /^Basic /);
  });
});

describe('BitbucketReader.findPullRequestForIssue', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const pr = (id: number, state: string, branch: string) => ({
    id,
    state,
    links: { html: { href: `https://bitbucket.org/acme/widgets/pull-requests/${id}` } },
    source: { branch: { name: branch } },
  });

  it('prefers the open PR over a merged one', async () => {
    stubFetch((url) =>
      url.includes('/pullrequests?')
        ? json({
            values: [pr(9, 'MERGED', 'agent/kan-6-old'), pr(11, 'OPEN', 'agent/kan-6-add-widget')],
          })
        : undefined,
    );

    const found = await new BitbucketReader(config(), silent).findPullRequestForIssue(repo, 'KAN-6');

    assert.equal(found?.id, 11);
    assert.equal(found?.state, 'OPEN');
    assert.equal(found?.branch, 'agent/kan-6-add-widget');
  });

  it('falls back to a merged PR so the ticket still reconciles to Done', async () => {
    stubFetch(() => json({ values: [pr(9, 'MERGED', 'agent/kan-6')] }));

    const found = await new BitbucketReader(config(), silent).findPullRequestForIssue(repo, 'KAN-6');

    assert.equal(found?.state, 'MERGED');
  });

  // The server-side filter is `contains`, so the exact prefix test is what
  // keeps KAN-6 off KAN-60's branch.
  it('rejects a branch for a different issue with the same prefix', async () => {
    stubFetch(() => json({ values: [pr(12, 'OPEN', 'agent/kan-60-other-thing')] }));

    const found = await new BitbucketReader(config(), silent).findPullRequestForIssue(repo, 'KAN-6');

    assert.equal(found, undefined);
  });

  it('returns undefined when the issue has no agent PR', async () => {
    stubFetch(() => json({ values: [] }));

    const found = await new BitbucketReader(config(), silent).findPullRequestForIssue(repo, 'KAN-6');

    assert.equal(found, undefined);
  });

  it('asks for open and merged PRs newest first', async () => {
    const calls = stubFetch(() => json({ values: [] }));

    await new BitbucketReader(config(), silent).findPullRequestForIssue(repo, 'KAN-6');

    const query = new URL(calls[0]!.url).searchParams;
    assert.equal(query.get('q'), 'source.branch.name ~ "agent/kan-6"');
    assert.equal(query.get('sort'), '-updated_on');
    assert.deepEqual(query.getAll('state'), ['OPEN', 'MERGED']);
  });
});

describe('BitbucketReader.getPullRequest', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const open = {
    id: 7,
    state: 'OPEN',
    links: { html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/7' } },
    source: { branch: { name: 'agent/kan-6-add-widget' } },
  };

  /** The PR itself, then the conflicts endpoint. */
  function stubPullRequest(pr: unknown, conflicts: Response): Call[] {
    return stubFetch((url) => {
      if (url.includes('/conflicts')) return conflicts;
      if (url.includes('/pullrequests/')) return json(pr);
      return undefined;
    });
  }

  /** An open PR whose conflict check answers with `conflicts`. */
  async function withConflicts(conflicts: Response) {
    stubPullRequest(open, conflicts);
    return new BitbucketReader(config(), silent).getPullRequest(repo, 7);
  }

  it('reports an open PR with no conflicts as mergeable', async () => {
    const calls = stubPullRequest(open, json({ values: [], size: 0 }));

    const found = await new BitbucketReader(config(), silent).getPullRequest(repo, 7);

    assert.deepEqual(found, {
      id: 7,
      state: 'OPEN',
      url: 'https://bitbucket.org/acme/widgets/pull-requests/7',
      branch: 'agent/kan-6-add-widget',
      mergeable: true,
    });
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.url, /\/pullrequests\/7\/conflicts\?pagelen=1$/);
  });

  it('reports conflicting paths as not mergeable', async () => {
    // The live shape, from a genuinely conflicting revspec on the sandbox.
    const found = await withConflicts(
      json({
        values: [
          { path: 'package.json', scenario: 'content', message: 'File modified in both' },
          { path: 'src/index.js', scenario: 'content', message: 'File modified in both' },
        ],
        size: 2,
      }),
    );

    assert.equal(found?.mergeable, false);
  });

  // The endpoint reports a total across pages, and pagelen=1 means the values
  // array cannot be trusted to hold all of them.
  it('trusts the reported size over the page length', async () => {
    const found = await withConflicts(json({ values: [{ path: 'package.json' }], size: 4 }));

    assert.equal(found?.mergeable, false);
  });

  // A merged PR drives the ticket to Done, and asking whether it still merges
  // is both meaningless and a wasted call.
  it('does not ask about conflicts on a closed PR', async () => {
    const calls = stubFetch((url) =>
      url.includes('/conflicts') ? undefined : json({ ...open, state: 'MERGED' }),
    );

    const found = await new BitbucketReader(config(), silent).getPullRequest(repo, 7);

    assert.equal(found?.state, 'MERGED');
    assert.equal(calls.length, 1);
  });

  // Everything below returns undefined rather than a conflict. A rebase queued
  // on a guess costs an implementer run; a skipped tick costs a minute.
  it('returns undefined when the PR has been deleted', async () => {
    stubFetch(() => new Response('Not Found', { status: 404 }));

    assert.equal(await new BitbucketReader(config(), silent).getPullRequest(repo, 7), undefined);
  });

  it('returns undefined for a state it does not model', async () => {
    stubPullRequest({ ...open, state: 'SUPERSEDED' }, json({ values: [], size: 0 }));

    assert.equal(await new BitbucketReader(config(), silent).getPullRequest(repo, 7), undefined);
  });

  it('returns undefined when mergeability cannot be determined', async () => {
    const found = await withConflicts(new Response('gateway timeout', { status: 504 }));

    assert.equal(found, undefined);
  });

  it('returns undefined when the conflict response is not JSON', async () => {
    const found = await withConflicts(new Response('<html>maintenance</html>'));

    assert.equal(found, undefined);
  });

  // A read failure on the PR itself is a different thing from a conflict we
  // could not compute — the credential or the repo is wrong, and that belongs
  // on the board.
  it('throws when the PR read is refused', async () => {
    stubFetch(() => new Response('no access', { status: 403 }));

    await assert.rejects(
      () => new BitbucketReader(config(), silent).getPullRequest(repo, 7),
      /403/,
    );
  });
});
