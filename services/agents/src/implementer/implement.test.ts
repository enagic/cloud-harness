/**
 * The parts of an implementation that do not need a model: what the implementer
 * is told about the ticket, and how it runs the repository's suite.
 *
 * The verifier tests run real commands in a real temp directory rather than
 * stubbing runCommand. That is the point of them — what is being tested is that
 * setup runs once and not once per call, and that a non-zero exit becomes a
 * `passed: false` verification rather than an exception. Both of those are
 * properties of process handling, and stubbing the process handling away would
 * leave the tests asserting their own stub.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Tool } from 'ai';

import {
  WORK_ITEM_SCHEMA_VERSION,
  type ImplementWorkItem,
  type RepoManifest,
} from '@cloud-harness/shared';

import { createVerifier, storyPrompt, type Verifier } from './implement.js';

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

function workItem(overrides: Partial<ImplementWorkItem> = {}): ImplementWorkItem {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    agent: 'implementer',
    reason: 'initial',
    issueKey: 'KAN-6',
    issueId: '10005',
    title: 'Add a health endpoint',
    repository: { workspace: 'acme', slug: 'service', baseBranch: 'main' },
    runtime: {
      stack: 'node',
      manifest: { stack: 'node', setupCommand: 'npm ci', testCommand: 'npm test' },
    },
    dispatchedAt: '2026-08-12T09:00:00.000Z',
    refinedDescription: '## Summary\n\nExpose /health returning 200.',
    attempt: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

describe('storyPrompt', () => {
  it('carries the story and the coordinates the model needs', () => {
    const prompt = storyPrompt(workItem());

    assert.match(prompt, /Ticket: KAN-6/);
    assert.match(prompt, /Base branch: main/);
    assert.match(prompt, /Stack: node/);
    assert.match(prompt, /Expose \/health returning 200\./);
  });

  /** The story is the spec, so an empty one has to be visible rather than a hole. */
  it('says the story is empty rather than leaving a gap', () => {
    assert.match(storyPrompt(workItem({ refinedDescription: '  ' })), /\(the story is empty\)/);
  });
});

describe('createVerifier', () => {
  let workdir: string;
  const controller = new AbortController();

  const build = (manifest: Partial<RepoManifest>): Verifier =>
    createVerifier({
      manifest: { stack: 'node', ...manifest },
      workdir,
      log: silent,
      signal: controller.signal,
    });

  const runTests = async (verifier: Verifier): Promise<string> => {
    const target = verifier.tools['run_tests'] as Tool | undefined;
    assert.ok(target?.execute, 'run_tests has no execute');
    const output = await target.execute({} as never, { toolCallId: 'test', messages: [] } as never);
    return output as string;
  };

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'verifier-'));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('reports a passing suite with its output', async () => {
    const verifier = build({ testCommand: 'echo "3 passing"' });

    const verification = await verifier.verify();

    assert.equal(verification.attempted, true);
    assert.equal(verification.passed, true);
    assert.equal(verification.command, 'echo "3 passing"');
    assert.match(verification.output ?? '', /3 passing/);
  });

  /**
   * A failing suite is evidence, not an exception. It has to come back as a
   * value the caller can act on, with the output that says why.
   */
  it('reports a failing suite rather than throwing', async () => {
    const verifier = build({ testCommand: 'echo "1 failing" && exit 1' });

    const verification = await verifier.verify();

    assert.equal(verification.attempted, true);
    assert.equal(verification.passed, false);
    assert.match(verification.output ?? '', /1 failing/);
  });

  /**
   * `attempted: false` is a real answer. A repo with no test command produced a
   * branch nobody executed, and that must not read as a branch that passed.
   */
  it('reports an unverifiable repo as not attempted', async () => {
    const verification = await build({}).verify();

    assert.deepEqual(verification, { attempted: false });
  });

  /**
   * The memoisation is most of the difference between a loop that converges and
   * one that times out — `npm ci` costs a minute and its answer does not change
   * between two edits to a source file.
   */
  it('runs setup once across many test runs', async () => {
    const marker = join(workdir, 'setup-count');
    const verifier = build({
      setupCommand: `echo x >> ${marker}`,
      testCommand: 'true',
    });

    await runTests(verifier);
    await runTests(verifier);
    await verifier.verify();

    const runs = (await readFile(marker, 'utf8')).trim().split('\n');
    assert.equal(runs.length, 1);
  });

  /** Setup failing is not a test failure, and the report should not imply it was. */
  it('reports a setup failure as a failed verification naming the setup command', async () => {
    const verifier = build({
      setupCommand: 'echo "lockfile out of date" && exit 1',
      testCommand: 'true',
    });

    const verification = await verifier.verify();

    assert.equal(verification.passed, false);
    assert.match(verification.output ?? '', /Setup failed/);
    assert.match(verification.output ?? '', /lockfile out of date/);
  });

  /**
   * The KAN-8 regression, and the reason success and failure are cached
   * differently. A model that writes `package.json` and runs the tests before
   * writing the lockfile gets a legitimate `npm ci` failure; if that answer is
   * cached, the lockfile it writes next changes nothing, every later run repeats
   * the stale error, and a correct implementation is reported as a failing
   * suite. Setup has to be retried against the working tree as it is now.
   */
  it('retries a failed setup, so the model can fix what broke it', async () => {
    const marker = join(workdir, 'setup-count');
    const gate = join(workdir, 'lockfile');
    // Fails until the "lockfile" exists, exactly as `npm ci` does.
    const verifier = build({
      setupCommand: `echo x >> ${marker} && test -f ${gate}`,
      testCommand: 'true',
    });

    const first = await verifier.verify();
    assert.equal(first.passed, false);
    assert.match(first.output ?? '', /Setup failed/);

    // The model fixes it.
    await writeFile(gate, '{}\n');
    const second = await verifier.verify();

    assert.equal(second.passed, true);
    assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 2);
  });

  /** Once setup succeeds it is not run again — that half of the cache is right. */
  it('stops re-running setup once it has succeeded', async () => {
    const marker = join(workdir, 'setup-count');
    const verifier = build({ setupCommand: `echo x >> ${marker}`, testCommand: 'true' });

    await verifier.verify();
    await verifier.verify();
    await verifier.verify();

    assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 1);
  });

  /**
   * The cap answers the model rather than throwing — a tool error ends the loop
   * and loses the whole implementation, where a sentence leaves it able to
   * finish and say what it could not verify.
   */
  it('caps the model at six test runs and tells it what to do instead', async () => {
    const verifier = build({ testCommand: 'true' });

    for (let i = 0; i < 6; i += 1) {
      const response = await runTests(verifier);
      assert.match(response, /passed/);
    }
    const response = await runTests(verifier);

    assert.match(response, /budget of 6 is spent/);
    assert.match(response, /say in your summary/);
  });

  /** The post-loop run is the authority, so it must not be charged to that cap. */
  it('does not charge the authoritative run against the model budget', async () => {
    const verifier = build({ testCommand: 'true' });

    for (let i = 0; i < 6; i += 1) await runTests(verifier);
    const verification = await verifier.verify();

    assert.equal(verification.passed, true);
  });
});
