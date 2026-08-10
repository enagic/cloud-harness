import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { LlmConfig } from './config.js';
import { LlmError, OpenAiCompatibleChatModel } from './llm.js';

const config: LlmConfig = {
  provider: 'openai_compatible',
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
  model: 'test-model',
  timeoutMs: 5_000,
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch with one canned /chat/completions payload. */
function respondWith(payload: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

async function complete(): Promise<ReturnType<OpenAiCompatibleChatModel['complete']>> {
  return new OpenAiCompatibleChatModel(config).complete({
    messages: [{ role: 'user', content: 'hi' }],
  });
}

describe('OpenAiCompatibleChatModel', () => {
  it('returns content and usage on a normal completion', async () => {
    respondWith({
      model: 'served-model',
      choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    });

    const response = await complete();
    assert.equal(response.content, 'ready');
    assert.equal(response.finishReason, 'stop');
    assert.equal(response.model, 'served-model');
    assert.deepEqual(response.usage, { inputTokens: 11, outputTokens: 3 });
  });

  it('surfaces reasoning tokens when the provider reports them', async () => {
    respondWith({
      choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 40,
        completion_tokens_details: { reasoning_tokens: 32 },
      },
    });

    const response = await complete();
    assert.equal(response.usage?.reasoningTokens, 32);
  });

  // The bug this file exists for: a reasoning model given too small a budget
  // spends it all on hidden thinking and returns content: null, not undefined.
  // A strict `=== undefined` guard let the null escape, and the caller failed
  // several frames later on `.trim()` with nothing pointing at the real cause.
  it('rejects a null completion instead of returning it', async () => {
    respondWith({
      choices: [
        {
          message: { content: null, reasoning: 'thinking about it' },
          finish_reason: 'length',
        },
      ],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 16,
        completion_tokens_details: { reasoning_tokens: 15 },
      },
    });

    await assert.rejects(complete(), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      // The message has to name the cause and the fix, not just the symptom.
      assert.match(err.message, /finish_reason=length/);
      assert.match(err.message, /15 of 16/);
      assert.match(err.message, /reasoning/i);
      assert.match(err.message, /maxTokens/);
      return true;
    });
  });

  it('explains budget exhaustion even without reasoning-token detail', async () => {
    respondWith({
      choices: [{ message: { content: null }, finish_reason: 'length' }],
      usage: { prompt_tokens: 11, completion_tokens: 16 },
    });

    await assert.rejects(complete(), (err: unknown) => {
      assert.match((err as Error).message, /budget was exhausted/);
      return true;
    });
  });

  it('names a content filter as the cause', async () => {
    respondWith({ choices: [{ message: { content: null }, finish_reason: 'content_filter' }] });
    await assert.rejects(complete(), (err: unknown) => {
      assert.match((err as Error).message, /filtered/);
      return true;
    });
  });

  it('still rejects a missing message entirely', async () => {
    respondWith({ choices: [] });
    await assert.rejects(complete(), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      return true;
    });
  });

  it('marks 5xx and 429 retryable, other 4xx not', async () => {
    respondWith({ error: 'boom' }, 503);
    await assert.rejects(complete(), (err: unknown) => {
      assert.equal((err as LlmError).retryable, true);
      return true;
    });

    respondWith({ error: 'bad model' }, 400);
    await assert.rejects(complete(), (err: unknown) => {
      assert.equal((err as LlmError).retryable, false);
      return true;
    });
  });
});
