import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { Channel, InboundMessage } from "./channel.js";
import type { Db } from "./db.js";
import { deliverPending, enqueue } from "./delivery.js";
import { recordEvent } from "./log.js";
import { houseViewFor } from "./memory.js";
import type { Model } from "./model.js";
import { findPersonByPhone, type Person } from "./people.js";
import { buildSystem, buildUserMessage, type PastMessage } from "./prompt.js";
import { REPLY_TOOL, type replyInput, toolDefinition, toolsFor } from "./tools.js";

export interface TurnDeps {
  db: Db;
  channel: Channel;
  model: Model;
  now?: () => Date;
  timeZone?: string;
}

const MAX_MODEL_STEPS = 5;
const HISTORY_MESSAGES = 20;
const FAILURE_REPLY = "Perdón, tuve un problema y no pude contestar tu mensaje. Intenta de nuevo en un momento.";

/** One inbound message, start to finish: who it is, what they may see, the model, the reply. */
export async function handleMessage(deps: TurnDeps, inbound: InboundMessage): Promise<void> {
  const { db } = deps;
  const person = await findPersonByPhone(db, inbound.fromPhone);
  if (!person) {
    // Nothing is said to a number the house does not know, and nothing reaches the model.
    await recordEvent(db, "unknown_sender", null, { phone_ending: inbound.fromPhone.slice(-4) });
    return;
  }
  const history = await recentMessages(db, person);
  await db.query("INSERT INTO messages (person_id, direction, body, sent_at) VALUES ($1, 'in', $2, now())", [
    person.id,
    inbound.text,
  ]);
  await recordEvent(db, "message_in", person.id);
  try {
    await runTurn(deps, person, history, inbound.text);
  } catch (error) {
    await recordEvent(db, "error", person.id, { message: error instanceof Error ? error.message : String(error) });
    await enqueue(db, person.id, FAILURE_REPLY);
  }
  await deliverPending(db, deps.channel);
}

async function recentMessages(db: Db, person: Person): Promise<PastMessage[]> {
  const rows = await db.query<PastMessage>(
    "SELECT direction, body FROM messages WHERE person_id = $1 ORDER BY seq DESC LIMIT $2",
    [person.id, HISTORY_MESSAGES],
  );
  return rows.reverse();
}

async function runTurn(deps: TurnDeps, person: Person, history: PastMessage[], text: string): Promise<void> {
  const { db, model } = deps;
  const tools = toolsFor(person);
  const system = buildSystem(person, await houseViewFor(db, person));
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: buildUserMessage({
        person,
        history,
        text,
        now: deps.now?.() ?? new Date(),
        timeZone: deps.timeZone ?? "America/Mexico_City",
      }),
    },
  ];
  let escalated = false;

  const finish = async (reply: string, kind: "respuesta_a_pregunta" | "otro" | null) => {
    if (!reply.trim()) throw new Error("EMPTY_REPLY");
    await enqueue(db, person.id, reply);
    // "Answered alone" counts only a question from someone who does not run the home,
    // answered from memory without passing it up.
    if (kind === null) await recordEvent(db, "unclassified_reply", person.id);
    else if (kind === "respuesta_a_pregunta" && !escalated && person.kind !== "coordinator")
      await recordEvent(db, "answered_alone", person.id);
    else await recordEvent(db, "other_reply", person.id);
  };

  for (let step = 0; step < MAX_MODEL_STEPS; step++) {
    const response = await model.respond({ system, messages, tools: tools.map(toolDefinition) });
    await recordEvent(db, "model_call", person.id, response.usage);
    const calls = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
    if (calls.length === 0) {
      const plain = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
      return finish(plain, null);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let reply: z.infer<typeof replyInput> | null = null;
    for (const use of calls) {
      const result = (content: string, failed = false): void => {
        results.push({ type: "tool_result", tool_use_id: use.id, content, is_error: failed });
      };
      const tool = tools.find((candidate) => candidate.name === use.name);
      if (!tool) {
        result(`La herramienta ${use.name} no está disponible para esta persona.`, true);
        continue;
      }
      const input = tool.input.safeParse(use.input);
      if (!input.success) {
        result(`Datos inválidos: ${input.error.message}`, true);
      } else if (tool.name === REPLY_TOOL) {
        reply = input.data as z.infer<typeof replyInput>;
      } else {
        try {
          result(await tool.run(input.data, { db, person }));
          if (tool.name === "subir_pregunta") escalated = true;
        } catch (error) {
          result(error instanceof Error ? error.message : String(error), true);
        }
      }
    }
    if (reply) return finish(reply.mensaje, reply.tipo);
    messages.push({ role: "assistant", content: response.content }, { role: "user", content: results });
  }
  throw new Error("TURN_TOO_LONG");
}
