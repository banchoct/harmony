import type Anthropic from "@anthropic-ai/sdk";
import type { Model, ModelRequest } from "../../src/model.js";

type Step = Anthropic.ContentBlock[] | ((request: ModelRequest) => Anthropic.ContentBlock[]);

let sequence = 0;

/** A text block, as the model would write outside any tool. */
export function text(value: string): Anthropic.ContentBlock {
  return { type: "text", text: value, citations: null } as Anthropic.ContentBlock;
}

/** A tool call, as the model would make it. */
export function call(name: string, input: Record<string, unknown>): Anthropic.ContentBlock {
  return { type: "tool_use", id: `toolu_${++sequence}`, name, input } as Anthropic.ContentBlock;
}

/** The usual end of a turn: the `responder` tool with the message for the person. */
export function reply(mensaje: string, tipo: "respuesta_a_pregunta" | "otro" = "respuesta_a_pregunta") {
  return call("responder", { mensaje, tipo });
}

export interface ScriptedModel extends Model {
  /** Every request the code sent, in order: what the model was allowed to see. */
  requests: ModelRequest[];
}

/** A model that plays a fixed script, one step per request. No network. */
export function scriptedModel(...steps: Step[]): ScriptedModel {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async respond(request) {
      requests.push(structuredClone(request));
      const step = steps.shift();
      if (!step) throw new Error("SCRIPT_ENDED");
      const content = typeof step === "function" ? step(request) : step;
      return { content, usage: { inputTokens: 100, outputTokens: 10 } };
    },
  };
}

/** Everything the model was shown in a request, as one string to search. */
export function shownTo(request: ModelRequest): string {
  return JSON.stringify([request.system, request.messages]);
}
