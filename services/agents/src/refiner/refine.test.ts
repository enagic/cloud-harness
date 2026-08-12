/**
 * The two halves of the hand-back that do not need a model: what the refiner is
 * told about a ticket it has seen before, and where its questions accumulate.
 *
 * Both exist because the refiner keeps no state of its own. A second pass is
 * reconstructed entirely from the ticket, so these are the seams where that
 * reconstruction can silently stop working — a thread that reads as a first
 * pass, or a question that never reaches the human who could answer it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Tool } from 'ai';

import { WORK_ITEM_SCHEMA_VERSION, type RefineWorkItem, type TicketComment } from '@cloud-harness/shared';

import { createHandbackTools, draftPrompt } from './refine.js';

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

function workItem(overrides: Partial<RefineWorkItem> = {}): RefineWorkItem {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    agent: 'refiner',
    issueKey: 'KAN-6',
    issueId: '10005',
    title: 'Add a health endpoint',
    repository: { workspace: 'acme', slug: 'service', baseBranch: 'main' },
    runtime: {
      stack: 'node',
      manifest: { stack: 'node', setupCommand: 'npm ci', testCommand: 'npm test' } as never,
    },
    dispatchedAt: '2026-08-12T09:00:00.000Z',
    draftDescription: 'we need a health endpoint',
    ...overrides,
  };
}

async function ask(tools: ReturnType<typeof createHandbackTools>, question: string): Promise<string> {
  const target = tools.tools.ask_human as Tool | undefined;
  assert.ok(target?.execute, 'ask_human has no execute');
  const output = await target.execute({ question }, { toolCallId: 'test', messages: [] } as never);
  return output as string;
}

describe('draftPrompt', () => {
  it('presents an empty thread as a first pass', () => {
    const prompt = draftPrompt(workItem());

    assert.match(prompt, /Draft description as it stands/);
    assert.doesNotMatch(prompt, /earlier pass/);
    assert.match(prompt, /we need a health endpoint/);
  });

  it('says the draft is empty rather than leaving a hole in the prompt', () => {
    assert.match(draftPrompt(workItem({ draftDescription: '   ' })), /\(the draft is empty\)/);
  });

  /**
   * The signal is an agent comment, not the presence of comments. A human who
   * adds context to a brand-new ticket must not make the refiner think it wrote
   * the description — it would then "improve" a draft it should be replacing.
   */
  it('treats human-only comments as a first pass', () => {
    const conversation: TicketComment[] = [{ author: 'human', text: 'talk to the platform team' }];
    const prompt = draftPrompt(workItem({ conversation }));

    assert.match(prompt, /Draft description as it stands/);
    assert.match(prompt, /Nobody has refined this yet/);
    assert.match(prompt, /Human: talk to the platform team/);
  });

  it('recognises its own earlier comment as a prior pass', () => {
    const conversation: TicketComment[] = [
      { author: 'agent', text: '1. Which queue should this drain?' },
      { author: 'human', text: 'the existing one' },
    ];
    const prompt = draftPrompt(workItem({ conversation }));

    assert.match(prompt, /earlier pass/);
    assert.match(prompt, /do not start over/);
  });

  /**
   * Order and authorship are the only things pairing an answer to its question —
   * Jira issue comments are flat, so a thread that arrives unlabelled or out of
   * order is a set of answers to nothing.
   */
  it('labels each side and keeps the thread in order', () => {
    const conversation: TicketComment[] = [
      { author: 'agent', text: 'Which queue?' },
      { author: 'human', text: 'the existing one' },
      { author: 'agent', text: 'Retention?' },
      { author: 'human', text: 'fourteen days' },
    ];
    const prompt = draftPrompt(workItem({ conversation }));
    const thread = prompt.slice(prompt.indexOf('You: Which queue?'));

    assert.equal(
      thread.trim(),
      ['You: Which queue?', 'Human: the existing one', 'You: Retention?', 'Human: fourteen days'].join('\n'),
    );
  });
});

describe('ask_human', () => {
  it('buffers questions in order and writes nothing', async () => {
    const tools = createHandbackTools(silent);

    await ask(tools, 'Which queue should this drain?');
    await ask(tools, 'Is fourteen days retention right?');

    assert.deepEqual(tools.questions(), [
      'Which queue should this drain?',
      'Is fourteen days retention right?',
    ]);
  });

  it('trims, and drops an empty question without recording it', async () => {
    const tools = createHandbackTools(silent);

    await ask(tools, '  Which queue?  ');
    const response = await ask(tools, '   ');

    assert.match(response, /ignored/i);
    assert.deepEqual(tools.questions(), ['Which queue?']);
  });

  /**
   * The cap has to answer the model rather than throw. A tool error ends the
   * loop and loses the story; a sentence telling it the budget is spent leaves
   * it able to finish and say so in the estimate.
   */
  it('caps the questions and tells the model what to do instead', async () => {
    const tools = createHandbackTools(silent);

    for (let i = 0; i < 5; i += 1) await ask(tools, `question ${i}`);
    const response = await ask(tools, 'one too many');

    assert.equal(tools.questions().length, 5);
    assert.doesNotMatch(tools.questions().join('\n'), /one too many/);
    assert.match(response, /confidence is low/);
  });

  it('hands back a copy, so a caller cannot edit the buffer', async () => {
    const tools = createHandbackTools(silent);
    await ask(tools, 'Which queue?');

    tools.questions().push('not a real question');

    assert.deepEqual(tools.questions(), ['Which queue?']);
  });
});
