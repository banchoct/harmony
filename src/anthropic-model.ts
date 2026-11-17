import Anthropic from "@anthropic-ai/sdk";
import type { Model } from "./model.js";

const MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * The real model: Claude Opus 5.5 through the Anthropic API. The client reads the key from
 * ANTHROPIC_API_KEY. If the model declines a request, the API retries it on a fallback model
 * inside the same call, so a person is not left without an answer.
 */
export function createAnthropicModel(client: Anthropic = new Anthropic()): Model {
  return {
    async respond(request) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "medium" },
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        system: request.system,
        tools: request.tools,
        messages: request.messages as Anthropic.Beta.BetaMessageParam[],
      });
      if (response.stop_reason === "refusal") throw new Error("MODEL_REFUSED");
      if (response.stop_reason === "max_tokens") throw new Error("MODEL_CUT_OFF");
      const usage = response.usage;
      return {
        // Passed back unchanged on the next step of the turn, thinking blocks included.
        content: response.content as unknown as Anthropic.ContentBlock[],
        usage: {
          inputTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens,
        },
      };
    },
  };
}
