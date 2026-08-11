/**
 * The provider seam, agent side.
 *
 * The agents run their tool loops through the Vercel AI SDK rather than the
 * hand-rolled client in `packages/shared/src/llm.ts`. What the SDK actually
 * buys is the loop *inside* one invocation — model call, tool call, feed the
 * result back, repeat until done — which is the part nobody wants to hand-roll
 * and get subtly wrong.
 *
 * Model-agnosticism survives the move, which was the condition for making it:
 * `LlmConfig` still comes from the same environment variables, and switching
 * LLM_PROVIDER swaps the provider package underneath without any agent noticing.
 * Unlike the hand-rolled seam, the Bedrock side of that switch is implemented
 * here rather than throwing.
 *
 * The shared `ChatModel` is not gone: preflight still uses it to prove the raw
 * endpoint answers, which is a genuinely different question from whether the
 * SDK can drive it. It should retire once the implementer and reviewer have
 * moved over too.
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

import { boolEnv, intEnv, type LlmConfig, type Logger } from '@cloud-harness/shared';

/** The provider key that `providerOptions` entries are filed under. */
const OPENAI_COMPATIBLE_PROVIDER = 'openai-compatible';

/**
 * Deliberately generous. A reasoning model bills hidden thinking against the
 * same completion budget as the answer, so a cap sized for the reply alone
 * comes back empty — that is the bug preflight hit at maxTokens 16, and an
 * agent writing a whole story has far more to say than preflight did.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export interface AgentModel {
  /** Passed to generateText / generateObject. */
  model: LanguageModel;
  /**
   * Provider-specific knobs, spread into every call. Kept beside the model
   * rather than baked into it because the AI SDK takes them per request.
   */
  providerOptions: Record<string, Record<string, string>>;
  /** Per-call completion budget; see DEFAULT_MAX_OUTPUT_TOKENS. */
  maxOutputTokens: number;
  /**
   * Whether the provider enforces a JSON schema server-side.
   *
   * When false, `generateObject` gets no schema onto the wire at all — the
   * openai-compatible provider drops `response_format` with a warning and the
   * model answers in whatever shape it likes, which fails validation on the way
   * back. A caller that needs structured output must then put the schema in the
   * prompt itself and validate the reply.
   *
   * Nothing reads this today: the refiner writes prose, so it uses generateText
   * with no schema at all. It is kept for the reviewer, whose `ReviewFeedback`
   * is genuinely structured and will need generateObject.
   */
  structuredOutputs: boolean;
  /** provider/model, for logs. */
  label: string;
}

/**
 * Build the model handle the agents call through.
 *
 * Note what is NOT here: retries, timeouts, and backoff are the SDK's job
 * (`maxRetries` on each call), and the tool loop is `stopWhen`. This function
 * only resolves credentials and provider-specific options.
 */
export function createAgentModel(config: LlmConfig, log: Logger): AgentModel {
  const maxOutputTokens = intEnv('LLM_MAX_OUTPUT_TOKENS', DEFAULT_MAX_OUTPUT_TOKENS);

  switch (config.provider) {
    case 'openai_compatible': {
      if (config.baseUrl === undefined || config.apiKey === undefined) {
        throw new Error('LLM_PROVIDER=openai_compatible requires LLM_BASE_URL and LLM_API_KEY');
      }

      /**
       * Defaults to on, and it has to: with it off the provider strips the JSON
       * schema out of the request and only warns, so the model never learns
       * what shape to answer in and every structured call fails validation.
       * Turn it off only for a gateway that rejects `response_format:
       * json_schema` outright — callers then put the schema in the prompt.
       */
      const structuredOutputs = boolEnv('LLM_STRUCTURED_OUTPUTS', true);

      const provider = createOpenAICompatible({
        name: OPENAI_COMPATIBLE_PROVIDER,
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
        supportsStructuredOutputs: structuredOutputs,
      });

      return {
        model: provider.chatModel(config.model),
        providerOptions:
          config.reasoningEffort === undefined
            ? {}
            : {
                [OPENAI_COMPATIBLE_PROVIDER]: { reasoningEffort: config.reasoningEffort },
              },
        maxOutputTokens,
        structuredOutputs,
        label: `openai_compatible/${config.model}`,
      };
    }

    case 'bedrock': {
      if (config.region === undefined) {
        throw new Error('LLM_PROVIDER=bedrock requires BEDROCK_REGION');
      }

      // No API key: credentials come from the ECS task role, which the provider
      // resolves through the standard AWS credential chain. Infra grants
      // bedrock:InvokeModel when enable_bedrock_access = true.
      const provider = createAmazonBedrock({ region: config.region });

      if (config.reasoningEffort !== undefined) {
        // Bedrock expresses extended thinking as an explicit token budget, not
        // as an effort level, so there is no honest mapping from the one env
        // var. Warn rather than silently dropping it or inventing a budget.
        log.warn('LLM_REASONING_EFFORT is ignored on bedrock', {
          reasoningEffort: config.reasoningEffort,
          detail: 'Bedrock takes a thinking token budget; wire it explicitly if needed.',
        });
      }

      return {
        model: provider.languageModel(config.model),
        providerOptions: {},
        maxOutputTokens,
        // The Bedrock provider expresses structured output through tool calling,
        // which it handles itself; nothing is dropped from the request.
        structuredOutputs: true,
        label: `bedrock/${config.model}`,
      };
    }
  }
}
