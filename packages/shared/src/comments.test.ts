import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_COMMENT_SIGNATURE, isAgentComment, signAgentComment } from './comments.js';

describe('agent comment signature', () => {
  it('signs on its own line, below the text', () => {
    const signed = signAgentComment('1. Which queue should this drain?');

    assert.equal(signed, `1. Which queue should this drain?\n\n${AGENT_COMMENT_SIGNATURE}`);
    assert.ok(isAgentComment(signed));
  });

  /** Mutations are retried on redelivery; a comment must not collect signatures. */
  it('does not sign twice', () => {
    const once = signAgentComment('a question');
    assert.equal(signAgentComment(once), once);
  });

  it('reads a human comment as human', () => {
    assert.equal(isAgentComment('the existing one, and 14 days is fine'), false);
  });

  /**
   * The signal has to be the text, not the author. One personal account can
   * serve the pipeline and the human reviewing it — that is the sandbox — and
   * under it every comment shares an author.
   */
  it('separates both sides of a thread written from one account', () => {
    const thread = [
      signAgentComment('1. Which queue should this drain?'),
      'the existing one',
      signAgentComment('Refinement published.'),
    ];

    assert.deepEqual(thread.map(isAgentComment), [true, false, true]);
  });

  it('survives trailing whitespace, which the ADF round trip does not preserve', () => {
    assert.ok(isAgentComment(`a question\n\n${AGENT_COMMENT_SIGNATURE}   \n\n`));
  });

  /** A human quoting the pipeline mid-comment is rare; a stray mention is not. */
  it('does not match the signature inside a sentence', () => {
    assert.equal(isAgentComment(`I think ${AGENT_COMMENT_SIGNATURE} got this wrong`), false);
  });
});
