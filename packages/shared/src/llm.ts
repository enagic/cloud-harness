/**
 * The provider seam.
 *
 * Everything upstream depends on ChatModel, never on a vendor SDK. The POC runs
 * against an OpenAI-compatible /chat/completions endpoint; moving to Bedrock
 * means implementing BedrockChatModel below and flipping LLM_PROVIDER, with no
 * change to calling code.
 */

import type { LlmConfig } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  /** Provider-specific knobs that should not leak into the shared interface. */
  extra?: Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  finishReason: string | undefined;
  usage?: { inputTokens: number; outputTokens: number };
  /** Which model actually served the request, when the provider reports it. */
  model?: string;
}

export interface ChatModel {
  complete(request: ChatRequest): Promise<ChatResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * Minimal OpenAI-compatible client. Deliberately dependency-free — the surface
 * we use is one POST — so swapping gateways never means swapping an SDK.
 */
export class OpenAiCompatibleChatModel implements ChatModel {
  constructor(private readonly config: LlmConfig) {
    if (!config.baseUrl || !config.apiKey) {
      throw new Error('OpenAiCompatibleChatModel requires baseUrl and apiKey');
    }
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages,
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...(this.config.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: this.config.reasoningEffort }),
      ...request.extra,
    };

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable body>');
      // 408/409/429 and 5xx are worth another attempt; 4xx otherwise is not.
      const retryable =
        response.status >= 500 || [408, 409, 429].includes(response.status);
      throw new LlmError(
        `chat/completions failed: ${response.status} ${detail.slice(0, 500)}`,
        response.status,
        retryable,
      );
    }

    const payload = (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const choice = payload.choices?.[0];
    if (choice?.message?.content === undefined) {
      throw new LlmError('chat/completions returned no message content');
    }

    const result: ChatResponse = {
      content: choice.message.content,
      finishReason: choice.finish_reason,
    };
    if (payload.model !== undefined) result.model = payload.model;
    if (payload.usage) {
      result.usage = {
        inputTokens: payload.usage.prompt_tokens ?? 0,
        outputTokens: payload.usage.completion_tokens ?? 0,
      };
    }
    return result;
  }
}

/**
 * TODO(bedrock): implement against @aws-sdk/client-bedrock-runtime.
 *
 * Notes for whoever picks this up:
 *  - Credentials come from the task role; infra grants bedrock:InvokeModel when
 *    enable_bedrock_access = true. There is no API key.
 *  - `config.model` carries the Bedrock model id or inference profile id.
 *  - Bedrock's Converse API maps onto this interface cleanly: system messages
 *    move to the top-level `system` field, the rest map to `messages`.
 */
export class BedrockChatModel implements ChatModel {
  constructor(private readonly config: LlmConfig) {}

  complete(_request: ChatRequest): Promise<ChatResponse> {
    throw new Error(
      `BedrockChatModel is not implemented yet (model=${this.config.model}, region=${this.config.region}). ` +
        'Set LLM_PROVIDER=openai_compatible until it is.',
    );
  }
}

export function createChatModel(config: LlmConfig): ChatModel {
  switch (config.provider) {
    case 'openai_compatible':
      return new OpenAiCompatibleChatModel(config);
    case 'bedrock':
      return new BedrockChatModel(config);
  }
}
