import type Anthropic from "@anthropic-ai/sdk";

/** What the code sends to the model for one step of a turn. */
export interface ModelRequest {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

export interface ModelResponse {
  content: Anthropic.ContentBlock[];
  usage: { inputTokens: number; outputTokens: number };
}

/** The model behind Harmony. The real one calls the Anthropic API; tests use a scripted one. */
export interface Model {
  respond(request: ModelRequest): Promise<ModelResponse>;
}
