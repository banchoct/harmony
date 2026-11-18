import type Anthropic from "@anthropic-ai/sdk";
import type { Model, ModelRequest } from "../../src/model.js";

type Step =
  | Anthropic.ContentBlock[]
  | ((request: ModelRequest) => Anthropic.ContentBlock[] | Promise<Anthropic.ContentBlock[]>);

let sequence = 0;

/**
 * Errors raised inside scripted steps, usually assertions. Each test file checks this after
 * every test (see `failOnStepErrors`), because the turn recovers from a model failure.
 */
const stepFailures: unknown[] = [];

/** Call once per test file: makes a test fail when a scripted step raised an error in it. */
export function failOnStepErrors(afterEach: (fn: () => void) => void): void {
  afterEach(() => {
    const [first] = stepFailures.splice(0);
    if (first) throw first;
  });
}

/** A text block, as the model would write outside any tool. */
export function text(value: string): Anthropic.ContentBlock {
  return { type: "text", text: value, citations: null } as Anthropic.ContentBlock;
}

/** A tool call, as the model would make it. */
export function call(name: string, input: Record<string, unknown>): Anthropic.ContentBlock {
  return { type: "tool_use", id: `toolu_${++sequence}`, name, input } as Anthropic.ContentBlock;
}

/** The usual end of a turn: the `responder` tool with the message for the person. */
export function reply(
  mensaje: string,
  tipo: "respuesta_a_pregunta" | "pregunta_de_aclaracion" | "otro" = "respuesta_a_pregunta",
) {
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
      let content: Anthropic.ContentBlock[];
      try {
        content = typeof step === "function" ? await step(request) : step;
      } catch (error) {
        // The code under test treats a model failure as something to recover from, which
        // would hide an assertion made inside a step. Raising it again outside the turn
        // makes the test that is running fail.
        stepFailures.push(error);
        throw error;
      }
      return { content, usage: { inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 10 } };
    },
  };
}

/** Everything the model was shown in a request, as one string to search. */
export function shownTo(request: ModelRequest): string {
  return JSON.stringify([request.system, request.messages]);
}

/** The id the model was shown for something, e.g. `[pregunta <id>]`. Picks the last one shown. */
export function idShown(request: ModelRequest, label: "nota" | "pregunta" | "propuesta" | "persona", near = ""): string {
  const shown = request.system.map((block) => block.text).join("\n");
  const lines = shown.split("\n").filter((line) => line.includes(`[${label} `) && line.includes(near));
  const match = /\[(?:nota|pregunta|propuesta|persona) ([0-9a-f-]{36})/.exec(lines.at(-1) ?? "");
  if (!match?.[1]) throw new Error(`NO_${label.toUpperCase()}_SHOWN`);
  return match[1];
}
