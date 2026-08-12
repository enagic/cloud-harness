/**
 * The agent-side Bitbucket write path.
 *
 * Two halves, tested two ways. The git half runs against a real repository in a
 * temp directory, because what matters there is what git actually does with a
 * clean tree, a `.gitignore`, and a branch name that already exists — stubbing
 * git would leave the tests asserting the stub. The REST half stubs fetch, the
 * same seam the watcher's reader tests use.
 *
 * Nothing here touches the network or a real Bitbucket workspace.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { BitbucketConfig, RepositoryRef } from '@cloud-harness/shared';

import { BitbucketClient } from './bitbucket.js';
import { runCommand } from '../runtime/exec.js';

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
    role: 'implementer',
    token: 'tok',
    ...overrides,
  };
}

describe('BitbucketClient — git', () => {
  let workdir: string;
  let client: BitbucketClient;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'bb-git-'));
    client = new BitbucketClient(config(), silent);
    await runCommand('git init -b main -q .', { cwd: workdir, log: silent });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const log = async (): Promise<string> =>
    (await runCommand("git log --format='%an|%ae|%s'", { cwd: workdir, log: silent })).output;

  it('commits everything in the working tree and reports the paths', async () => {
    await writeFile(join(workdir, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(workdir, 'b.ts'), 'export const b = 2;\n');

    const result = await client.commitAll(workdir, 'KAN-6: add a and b');

    assert.equal(result.committed, true);
    assert.deepEqual(result.changedPaths, ['a.ts', 'b.ts']);
    assert.match(await log(), /KAN-6: add a and b/);
  });

  /**
   * Not an error. It means the model finished without changing a file, and the
   * caller reports that to the board rather than pushing an empty branch.
   */
  it('reports a clean tree rather than committing nothing', async () => {
    await writeFile(join(workdir, 'a.ts'), 'export const a = 1;\n');
    await client.commitAll(workdir, 'first');

    const result = await client.commitAll(workdir, 'second');

    assert.deepEqual(result, { committed: false, changedPaths: [] });
  });

  /**
   * The path that would otherwise produce an empty commit and a mystifying PR:
   * every file the model wrote is ignored by the repo it wrote them into.
   */
  it('treats a tree of only ignored files as clean', async () => {
    await writeFile(join(workdir, '.gitignore'), 'generated/\n');
    await runCommand('git add -A && git commit -qm base', { cwd: workdir, log: silent });
    await runCommand('mkdir -p generated', { cwd: workdir, log: silent });
    await writeFile(join(workdir, 'generated', 'out.ts'), 'export const x = 1;\n');

    const result = await client.commitAll(workdir, 'KAN-6: generated only');

    assert.equal(result.committed, false);
  });

  it('commits as the agent identity rather than whoever configured the host', async () => {
    await writeFile(join(workdir, 'a.ts'), 'export const a = 1;\n');
    await client.commitAll(workdir, 'KAN-6: add a');

    assert.match(await log(), /cloud-harness implementer\|implementer@users\.noreply\.bitbucket\.org/);
  });

  it('uses the configured email as the commit author when there is one', async () => {
    const withEmail = new BitbucketClient(config({ email: 'bot@acme.test' }), silent);
    await writeFile(join(workdir, 'a.ts'), 'export const a = 1;\n');

    await withEmail.commitAll(workdir, 'KAN-6: add a');

    assert.match(await log(), /\|bot@acme\.test\|/);
  });

  /** A quote in a model-written message must not reach `bash -lc` unquoted. */
  it('survives a commit message with shell metacharacters in it', async () => {
    await writeFile(join(workdir, 'a.ts'), 'export const a = 1;\n');

    await client.commitAll(workdir, "KAN-6: don't `run` this; $(echo pwned)");

    const output = await log();
    assert.match(output, /don't `run` this; \$\(echo pwned\)/);
    assert.doesNotMatch(output, /pwned$/m);
  });

  /**
   * A redelivered work item clones fresh but reuses the branch name, and failing
   * there would strand the item for a reason that does not matter.
   */
  it('creates a branch that already exists without failing', async () => {
    await writeFile(join(workdir, 'a.ts'), 'export const a = 1;\n');
    await client.commitAll(workdir, 'base');

    await client.createBranch(workdir, 'agent/kan-6-add-a');
    await client.createBranch(workdir, 'agent/kan-6-add-a');

    const branch = await runCommand('git rev-parse --abbrev-ref HEAD', { cwd: workdir, log: silent });
    assert.equal(branch.output.trim(), 'agent/kan-6-add-a');
  });
});

interface Call {
  url: string;
  method: string;
  authorization: string;
  body: unknown;
}

function stubFetch(respond: (url: string, method: string) => Response | undefined): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method,
      authorization: headers.get('authorization') ?? '',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const response = respond(url, method);
    assert.ok(response !== undefined, `unexpected request: ${method} ${url}`);
    return response;
  }) as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function pullRequest(id: number, branch: string): unknown {
  return {
    id,
    links: { html: { href: `https://bitbucket.org/acme/widgets/pull-requests/${id}` } },
    source: { branch: { name: branch } },
  };
}

describe('BitbucketClient.openPullRequest', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const client = (overrides: Partial<BitbucketConfig> = {}): BitbucketClient =>
    new BitbucketClient(config(overrides), silent);

  it('opens a pull request from the branch onto the base branch', async () => {
    const calls = stubFetch((_url, method) =>
      method === 'POST' ? json(pullRequest(7, 'agent/kan-6')) : json({ values: [] }),
    );

    const pr = await client().openPullRequest({
      repo,
      branch: 'agent/kan-6',
      title: 'KAN-6: add a health endpoint',
      description: 'Adds /health.',
    });

    assert.deepEqual(pr, {
      id: 7,
      url: 'https://bitbucket.org/acme/widgets/pull-requests/7',
      branch: 'agent/kan-6',
    });

    const post = calls.find((call) => call.method === 'POST');
    assert.deepEqual(post?.body, {
      title: 'KAN-6: add a health endpoint',
      description: 'Adds /health.',
      source: { branch: { name: 'agent/kan-6' } },
      destination: { branch: { name: 'main' } },
      close_source_branch: false,
    });
  });

  /**
   * A redelivered work item re-runs the whole handler, and a second PR from one
   * branch would leave two reviews of one change. Nothing is stored between
   * runs, so the source branch is the only thing that can identify it.
   */
  it('returns the pull request that is already open instead of a second one', async () => {
    const calls = stubFetch((_url, method) =>
      method === 'GET' ? json({ values: [pullRequest(7, 'agent/kan-6')] }) : undefined,
    );

    const pr = await client().openPullRequest({
      repo,
      branch: 'agent/kan-6',
      title: 'KAN-6: add a health endpoint',
      description: 'Adds /health.',
    });

    assert.equal(pr.id, 7);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  });

  it('looks for the open pull request from this branch specifically', async () => {
    const calls = stubFetch((_url, method) =>
      method === 'POST' ? json(pullRequest(8, 'agent/kan-6')) : json({ values: [] }),
    );

    await client().openPullRequest({ repo, branch: 'agent/kan-6', title: 't', description: 'd' });

    const query = decodeURIComponent(calls[0]?.url ?? '');
    assert.match(query, /source\.branch\.name="agent\/kan-6"/);
    assert.match(query, /state="OPEN"/);
  });

  /**
   * The id is what the reviewer approves and comments against, so a PR without
   * one cannot be acted on later. Failing here beats letting a zero travel
   * downstream on a work item.
   */
  it('fails loudly when Bitbucket returns a pull request with no id', async () => {
    stubFetch((_url, method) => (method === 'POST' ? json({ links: {} }) : json({ values: [] })));

    await assert.rejects(
      () => client().openPullRequest({ repo, branch: 'agent/kan-6', title: 't', description: 'd' }),
      /no id/,
    );
  });

  it('names the identity in the error when Bitbucket rejects the call', async () => {
    stubFetch(() => new Response('no such repository', { status: 404 }));

    await assert.rejects(
      () => client().openPullRequest({ repo, branch: 'agent/kan-6', title: 't', description: 'd' }),
      /implementer identity.*404/s,
    );
  });

  /**
   * Two credential types are current: an access token is Bearer, an Atlassian
   * API token is Basic email:token. Which one this is can only be discovered by
   * trying, and the answer is remembered so the retry is paid once per process.
   */
  it('falls back to Basic when Bearer is rejected, then remembers it', async () => {
    const calls = stubFetch((_url, method) => {
      const bearer = calls[calls.length - 1]?.authorization.startsWith('Bearer ');
      if (bearer === true) return new Response('unauthorized', { status: 401 });
      return method === 'POST' ? json(pullRequest(9, 'agent/kan-6')) : json({ values: [] });
    });

    const withEmail = client({ email: 'bot@acme.test' });
    await withEmail.openPullRequest({ repo, branch: 'agent/kan-6', title: 't', description: 'd' });
    await withEmail.openPullRequest({ repo, branch: 'agent/kan-6', title: 't', description: 'd' });

    assert.equal(calls[0]?.authorization.startsWith('Bearer '), true);
    assert.equal(calls[1]?.authorization.startsWith('Basic '), true);
    // The second call had its scheme already: no second 401 round trip.
    assert.equal(calls.filter((call) => call.authorization.startsWith('Bearer ')).length, 1);
  });

  /** With no email there is no Basic credential to fall back to; do not try one. */
  it('does not retry as Basic when there is no email to pair with the token', async () => {
    const calls = stubFetch(() => new Response('unauthorized', { status: 401 }));

    await assert.rejects(() =>
      client().openPullRequest({ repo, branch: 'agent/kan-6', title: 't', description: 'd' }),
    );

    assert.equal(calls.length, 1);
  });
});
