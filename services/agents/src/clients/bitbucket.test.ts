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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

/**
 * The rebase path, against two real repositories.
 *
 * A local repo stands in for Bitbucket and the workspace is a genuine
 * `--single-branch` clone of it, which is the shape that matters: the base
 * branch is not in the clone, so these exercise the explicit fetch refspec
 * rather than assuming `origin/main` is lying around. Nothing here is stubbed —
 * what a rebase does with two edits to one line is precisely the thing there is
 * no point asserting against a fake.
 */
describe('BitbucketClient — rebase', () => {
  let origin: string;
  let workdir: string;
  let client: BitbucketClient;

  /** Commit `content` to `file` on the branch that is checked out in `dir`. */
  const commit = async (dir: string, file: string, content: string, message: string) => {
    await writeFile(join(dir, file), content);
    await runCommand(
      `git add -A && git -c user.email=t@example.com -c user.name=test commit -q -m ${JSON.stringify(message)}`,
      { cwd: dir, log: silent },
    );
  };

  const git = async (dir: string, command: string): Promise<string> =>
    (await runCommand(`git ${command}`, { cwd: dir, log: silent })).output.trim();

  const read = async (file: string): Promise<string> =>
    await readFile(join(workdir, file), 'utf8');

  beforeEach(async () => {
    origin = await mkdtemp(join(tmpdir(), 'bb-origin-'));
    workdir = await mkdtemp(join(tmpdir(), 'bb-rebase-'));
    client = new BitbucketClient(config(), silent);

    // main: one file, two lines. feature branches off it and edits line 2;
    // main then moves on. Whether that overlaps is what each test decides.
    await runCommand('git init -b main -q .', { cwd: origin, log: silent });
    await commit(origin, 'app.ts', 'const version = 1;\nconst mode = "base";\n', 'initial');
    await runCommand('git checkout -q -b feature', { cwd: origin, log: silent });
    await commit(origin, 'app.ts', 'const version = 1;\nconst mode = "feature";\n', 'feature work');
    await runCommand('git checkout -q main', { cwd: origin, log: silent });
  });

  afterEach(async () => {
    await rm(origin, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  });

  /** Clone `feature` into the empty workspace, the way the agent does. */
  const cloneFeature = async (): Promise<void> => {
    await runCommand(
      `git clone -q --single-branch --branch feature ${JSON.stringify(origin)} ${JSON.stringify(workdir)}`,
      { cwd: tmpdir(), log: silent },
    );
  };

  it('reports that a branch already containing its base needs no rebase', async () => {
    await cloneFeature();

    const result = await client.rebaseOntoBase(workdir, 'main');

    assert.deepEqual(result, { status: 'not_needed' });
  });

  it('replays the branch onto a base that moved without conflicting', async () => {
    await commit(origin, 'README.md', '# widgets\n', 'unrelated work on main');
    await cloneFeature();

    const result = await client.rebaseOntoBase(workdir, 'main');

    assert.deepEqual(result, { status: 'clean' });
    // Both sides are present, and the branch's commit is on top.
    assert.match(await read('app.ts'), /"feature"/);
    assert.equal(await read('README.md'), '# widgets\n');
    assert.match(await git(workdir, 'log -1 --format=%s'), /feature work/);
  });

  it('names the conflicted paths and leaves the rebase in progress', async () => {
    await commit(origin, 'app.ts', 'const version = 1;\nconst mode = "main";\n', 'main moved');
    await cloneFeature();

    const result = await client.rebaseOntoBase(workdir, 'main');

    assert.deepEqual(result, { status: 'conflicts', paths: ['app.ts'] });
    // In progress, not aborted: the conflicted tree is what the implementer
    // resolves, and an abort here would throw it away.
    assert.match(await git(workdir, 'status'), /rebase in progress|interactive rebase/);
    assert.match(await read('app.ts'), /^<{7}/m);
  });

  it('finishes the rebase once the conflict is resolved', async () => {
    await commit(origin, 'app.ts', 'const version = 2;\nconst mode = "main";\n', 'main moved');
    await cloneFeature();

    const conflicted = await client.rebaseOntoBase(workdir, 'main');
    assert.equal(conflicted.status, 'conflicts');

    // What the model would have written: both intents kept.
    await writeFile(join(workdir, 'app.ts'), 'const version = 2;\nconst mode = "feature";\n');

    const result = await client.continueRebase(workdir);

    assert.deepEqual(result, { status: 'clean' });
    assert.equal(await read('app.ts'), 'const version = 2;\nconst mode = "feature";\n');
    assert.equal(await git(workdir, 'status --porcelain'), '');
    // The base commit is in the history, so the branch really was replayed.
    assert.match(await git(workdir, 'log --format=%s'), /main moved/);
  });

  /**
   * The resolution that leaves nothing to commit: the same change is already in
   * the base branch. `git rebase --continue` refuses this, deliberately, so the
   * client has to notice and skip instead.
   */
  it('skips a commit whose change is already in the base branch', async () => {
    await commit(origin, 'app.ts', 'const version = 2;\nconst mode = "main";\n', 'main moved');
    await cloneFeature();

    const conflicted = await client.rebaseOntoBase(workdir, 'main');
    assert.equal(conflicted.status, 'conflicts');

    // Resolving in favour of what main already has leaves nothing to commit.
    await writeFile(join(workdir, 'app.ts'), 'const version = 2;\nconst mode = "main";\n');

    const result = await client.continueRebase(workdir);

    assert.deepEqual(result, { status: 'clean' });
    assert.equal(await git(workdir, 'status --porcelain'), '');
    assert.equal(await git(workdir, 'rev-list --count HEAD'), '2');
  });

  it('puts the branch back when the rebase is aborted', async () => {
    await commit(origin, 'app.ts', 'const version = 1;\nconst mode = "main";\n', 'main moved');
    await cloneFeature();
    const before = await git(workdir, 'rev-parse HEAD');

    await client.rebaseOntoBase(workdir, 'main');
    await client.abortRebase(workdir);

    assert.equal(await git(workdir, 'rev-parse HEAD'), before);
    assert.equal(await git(workdir, 'status --porcelain'), '');
    assert.match(await read('app.ts'), /"feature"/);
  });

  /**
   * The images carry no global git config, so a rebase that did not set an
   * identity would fail with "unable to auto-detect email address" — which
   * reads like a credential problem and is not one.
   */
  it('sets its own commit identity rather than relying on the host having one', async () => {
    await commit(origin, 'README.md', '# widgets\n', 'unrelated work on main');
    await cloneFeature();

    const result = await client.rebaseOntoBase(workdir, 'main');

    assert.deepEqual(result, { status: 'clean' });
    assert.match(await git(workdir, 'config user.email'), /implementer@/);
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

/**
 * The reviewer's half of the client.
 *
 * The response fixtures here are trimmed from real Bitbucket responses, captured
 * against PR #1 of kwon-cloud/sandbox — including the ones that document what
 * Bitbucket does NOT do. Reasoning about these endpoints has a poor record in
 * this project.
 */
describe('BitbucketClient — pull request comments', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const client = (): BitbucketClient => new BitbucketClient(config({ role: 'reviewer' }), silent);

  /** Trimmed from a real response; `resolution` is absent while a thread is open. */
  function comment(overrides: Record<string, unknown> = {}): unknown {
    return {
      id: 1,
      content: { raw: 'a finding' },
      deleted: false,
      user: { display_name: 'cli-tools', account_id: '712020:abc' },
      ...overrides,
    };
  }

  it('reads the diff as text rather than parsing it as JSON', async () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
    const calls = stubFetch(() => new Response(diff, { status: 200 }));

    assert.equal(await client().getPullRequestDiff(repo, 1), diff);
    assert.match(calls[0]?.url ?? '', /pullrequests\/1\/diff$/);
  });

  it('tags authorship by the pipeline signature, not by the account', async () => {
    stubFetch(() =>
      json({
        values: [
          comment({ id: 10, content: { raw: 'The lockfile is stale.\n\n— cloud-harness' } }),
          comment({ id: 11, content: { raw: 'Disagree, it is generated.' } }),
        ],
      }),
    );

    const comments = await client().listPullRequestComments(repo, 1);

    assert.deepEqual(
      comments.map((c) => [c.id, c.author]),
      [
        [10, 'agent'],
        [11, 'human'],
      ],
    );
  });

  /**
   * Decision 10. A resolved thread is what stops the reviewer re-raising
   * something already argued down, so it has to arrive tagged rather than
   * filtered out — the refiner shipped the filtering version once already.
   */
  it('carries resolution state instead of hiding resolved threads', async () => {
    stubFetch(() =>
      json({
        values: [
          comment({ id: 10, resolution: { type: 'comment_resolution' } }),
          comment({ id: 11 }),
        ],
      }),
    );

    const comments = await client().listPullRequestComments(repo, 1);

    assert.equal(comments.length, 2);
    assert.deepEqual(
      comments.map((c) => c.resolved),
      [true, false],
    );
  });

  it('carries the thread structure and each comment’s anchor', async () => {
    stubFetch(() =>
      json({
        values: [
          comment({ id: 10, inline: { path: 'src/index.js', to: 4, from: null } }),
          comment({ id: 11, parent: { id: 10 }, inline: { path: 'src/index.js', to: 4 } }),
          comment({ id: 12, inline: { path: 'package.json', to: null, from: null } }),
          comment({ id: 13 }),
        ],
      }),
    );

    const comments = await client().listPullRequestComments(repo, 1);

    assert.deepEqual(
      comments.map((c) => [c.id, c.parentId, c.path, c.line]),
      [
        [10, undefined, 'src/index.js', 4],
        [11, 10, 'src/index.js', 4],
        // File-level: a path and an explicitly null line.
        [12, undefined, 'package.json', undefined],
        // Pull-request level: no inline block at all.
        [13, undefined, undefined, undefined],
      ],
    );
  });

  /** Tombstones carry no text, only a hole in the numbering. */
  it('skips deleted comments', async () => {
    stubFetch(() =>
      json({ values: [comment({ id: 10, deleted: true, content: { raw: '' } }), comment({ id: 11 })] }),
    );

    const comments = await client().listPullRequestComments(repo, 1);

    assert.deepEqual(comments.map((c) => c.id), [11]);
  });

  it('follows pagination', async () => {
    const calls = stubFetch((url) =>
      url.includes('page=2')
        ? json({ values: [comment({ id: 11 })] })
        : json({
            values: [comment({ id: 10 })],
            next: 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/1/comments?page=2',
          }),
    );

    const comments = await client().listPullRequestComments(repo, 1);

    assert.deepEqual(comments.map((c) => c.id), [10, 11]);
    assert.equal(calls.length, 2);
  });

  it('posts a line-level comment as an inline anchor, signed', async () => {
    const calls = stubFetch(() => json({ id: 99 }));

    const id = await client().commentOnPullRequest(repo, 1, {
      text: 'This drops the error.',
      path: 'src/index.js',
      line: 4,
    });

    assert.equal(id, 99);
    assert.deepEqual(calls[0]?.body, {
      content: { raw: 'This drops the error.\n\n— cloud-harness' },
      inline: { path: 'src/index.js', to: 4 },
    });
  });

  it('posts a file-level comment as an inline anchor with no line', async () => {
    const calls = stubFetch(() => json({ id: 99 }));

    await client().commentOnPullRequest(repo, 1, {
      text: 'This file is dead code now.',
      path: 'src/old.js',
    });

    assert.deepEqual((calls[0]?.body as { inline: unknown }).inline, { path: 'src/old.js' });
  });

  it('posts a pull-request-level comment with no anchor at all', async () => {
    const calls = stubFetch(() => json({ id: 99 }));

    await client().commentOnPullRequest(repo, 1, { text: 'Summary of the review.' });

    assert.equal('inline' in (calls[0]?.body as object), false);
  });

  it('replies in a thread by parent id', async () => {
    const calls = stubFetch(() => json({ id: 99 }));

    await client().commentOnPullRequest(repo, 1, { text: 'Still not fixed.', parentId: 10 });

    assert.deepEqual((calls[0]?.body as { parent: unknown }).parent, { id: 10 });
  });
});

describe('BitbucketClient.approvePullRequest', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const client = (): BitbucketClient => new BitbucketClient(config({ role: 'reviewer' }), silent);

  it('approves', async () => {
    const calls = stubFetch(() => json({ approved: true }));

    assert.deepEqual(await client().approvePullRequest(repo, 1), { status: 'approved' });
    assert.equal(calls[0]?.method, 'POST');
    assert.match(calls[0]?.url ?? '', /pullrequests\/1\/approve$/);
  });

  /**
   * The expected refusal, not a fault: Bitbucket does not count an approval from
   * a pull request's own author, and the sandbox runs all three identities off
   * one token. Failing the ticket over it would strand work that passed review.
   */
  it('reports a refusal as a result rather than throwing', async () => {
    stubFetch(() => new Response('You cannot approve your own pull request', { status: 400 }));

    const result = await client().approvePullRequest(repo, 1);

    assert.equal(result.status, 'refused');
    assert.match(result.status === 'refused' ? result.reason : '', /own pull request/);
  });

  /** Anything else is a real failure and must not be swallowed. */
  it('throws when the approval is refused for any other reason', async () => {
    stubFetch(() => new Response('no such pull request', { status: 404 }));

    await assert.rejects(() => client().approvePullRequest(repo, 1), /404/);
  });
});
