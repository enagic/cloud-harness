import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseManifest, withStackDefaults } from './manifest.js';

const stacks = ['node', 'python', 'jvm'];

describe('parseManifest', () => {
  it('accepts a minimal manifest', () => {
    const result = parseManifest('stack: node\n', stacks);
    assert(result.ok);
    assert.equal(result.manifest.stack, 'node');
    assert.equal(result.manifest.testCommand, undefined);
  });

  it('reads the build and test commands', () => {
    const result = parseManifest(
      ['stack: python', 'setupCommand: uv sync', 'testCommand: uv run pytest'].join('\n'),
      stacks,
    );
    assert(result.ok);
    assert.equal(result.manifest.setupCommand, 'uv sync');
    assert.equal(result.manifest.testCommand, 'uv run pytest');
  });

  it('rejects a missing stack', () => {
    const result = parseManifest('testCommand: npm test\n', stacks);
    assert(!result.ok);
    assert.match(result.error, /missing required field: stack/);
  });

  it('rejects an unknown stack and names the valid ones', () => {
    // The failure has to be actionable on the board — "rust" is a reasonable
    // thing for a team to write, and the message should say what to do about it.
    const result = parseManifest('stack: rust\n', stacks);
    assert(!result.ok);
    assert.match(result.error, /unknown stack "rust"/);
    assert.match(result.error, /node, python, jvm/);
  });

  it('rejects malformed YAML rather than throwing', () => {
    const result = parseManifest('stack: [unclosed\n', stacks);
    assert(!result.ok);
    assert.match(result.error, /not valid YAML/);
  });

  it('rejects a non-mapping document', () => {
    const result = parseManifest('- node\n- python\n', stacks);
    assert(!result.ok);
    assert.match(result.error, /mapping/);
  });

  it('treats blank command strings as absent', () => {
    const result = parseManifest('stack: node\ntestCommand: "   "\n', stacks);
    assert(result.ok);
    assert.equal(result.manifest.testCommand, undefined);
  });

  it('rejects a non-string command', () => {
    const result = parseManifest('stack: node\ntestCommand: 42\n', stacks);
    assert(!result.ok);
    assert.match(result.error, /testCommand must be a string/);
  });

  it('reads protectedPaths as a list', () => {
    const result = parseManifest(
      ['stack: node', 'protectedPaths:', '  - infra/', '  - migrations/'].join('\n'),
      stacks,
    );
    assert(result.ok);
    assert.deepEqual(result.manifest.protectedPaths, ['infra/', 'migrations/']);
  });
});

describe('withStackDefaults', () => {
  const defaults = {
    setupCommand: 'npm ci',
    buildCommand: 'npm run build',
    testCommand: 'npm test',
  };

  it('fills in what the repo omitted', () => {
    const merged = withStackDefaults({ stack: 'node' }, defaults);
    assert.equal(merged.testCommand, 'npm test');
    assert.equal(merged.setupCommand, 'npm ci');
  });

  it('never overrides what the repo said about itself', () => {
    const merged = withStackDefaults({ stack: 'node', testCommand: 'npm run test:ci' }, defaults);
    assert.equal(merged.testCommand, 'npm run test:ci');
    // ...while still filling the rest.
    assert.equal(merged.buildCommand, 'npm run build');
  });

  it('leaves commands undefined when neither side supplies one', () => {
    const merged = withStackDefaults({ stack: 'node' }, {});
    assert.equal(merged.testCommand, undefined);
  });
});
