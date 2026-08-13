/**
 * The part of an implementation that does not need a model: what the
 * implementer is told about the ticket.
 *
 * The verifier's tests moved to runtime/verifier.test.ts along with the
 * verifier, which the reviewer now shares.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WORK_ITEM_SCHEMA_VERSION, type ImplementWorkItem } from '@cloud-harness/shared';

import { storyPrompt } from './implement.js';

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
