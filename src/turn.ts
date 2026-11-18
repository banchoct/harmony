import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { openItems, Refused } from "./actions.js";
import type { Channel, InboundMessage } from "./channel.js";
import type { Db } from "./db.js";
import { deliverPending, enqueue } from "./delivery.js";
import { recordEvent } from "./log.js";
import { houseViewFor } from "./memory.js";
import type { Model } from "./model.js";
import { findPersonByPhone, type Person } from "./people.js";
import { buildSystem, buildUserMessage, type PastMessage } from "./prompt.js";
import { usableTranscript, type Transcriber } from "./voice.js";
import { REPLY_TOOL, type replyInput, toolDefinition, toolsFor } from "./tools.js";

export interface TurnDeps {
  db: Db;
  channel: Channel;
  model: Model;
  /** Turns voice notes into text. Without one, Harmony asks the person to write. */
  transcriber?: Transcriber;
  now?: () => Date;
  timeZone?: string;
}

const MAX_MODEL_STEPS = 5;
const HISTORY_MESSAGES = 20;
const FAILURE_REPLY = "Perdón, tuve un problema y no pude contestar tu mensaje. Intenta de nuevo en un momento.";

const CANNED = {
  noTranscriber: "Todavía no puedo escuchar notas de voz. ¿Me lo escribes, por favor?",
  notUnderstood: "Perdón, no pude entender tu nota de voz. ¿Me la repites o me lo escribes?",
  tooLarge: "Tu nota de voz es muy larga para mí. ¿Me la mandas en partes más cortas o me lo escribes?",
  notDownloaded: "Perdón, no pude descargar tu nota de voz. ¿Me la mandas otra vez?",
  file: "Todavía no puedo leer archivos ni fotos. ¿Me escribes lo que necesitas?",
};
const FILE_NOTE = "(El mensaje venía con un archivo o una foto. Harmony todavía no puede leer archivos.)";

/** What a voice note said, or the canned reply for why it could not be used. */
async function hear(deps: TurnDeps, inbound: InboundMessage): Promise<{ text: string } | { reply: string }> {
  if (inbound.audioTooLarge) return { reply: CANNED.tooLarge };
  if (!inbound.audio) return { reply: CANNED.notDownloaded };
  if (!deps.transcriber) return { reply: CANNED.noTranscriber };
  try {
    const text = usableTranscript(await deps.transcriber.transcribe(inbound.audio));
    return text ? { text } : { reply: CANNED.notUnderstood };
  } catch {
    return { reply: CANNED.notUnderstood };
  }
}

/** One inbound message, start to finish: who it is, what they may see, the model, the reply. */
export async function handleMessage(deps: TurnDeps, inbound: InboundMessage): Promise<void> {
  const { db } = deps;
  const person = await findPersonByPhone(db, inbound.fromPhone);
  if (!person) {
    // Nothing is said to a number the house does not know, and nothing of theirs reaches the
    // model or the transcriber.
    await recordEvent(db, "unknown_sender", null, { phone_ending: inbound.fromPhone.slice(-4) });
    return;
  }
  let text = inbound.text.trim();
  let canned: string | null = null;
  const voice = inbound.audio || inbound.audioFailed || inbound.audioTooLarge;
  if (!text && voice) {
    const heard = await hear(deps, inbound);
    // The log keeps the length and whether it was understood, never the words.
    await recordEvent(db, "voice_note", person.id, {
      seconds: inbound.audio?.seconds ?? inbound.audioSeconds ?? null,
      transcribed: "text" in heard,
    });
    if ("text" in heard) text = heard.text;
    else canned = heard.reply;
  } else if (!text && inbound.attachment) {
    canned = CANNED.file;
  } else if (!text) {
    await recordEvent(db, "empty_message", person.id);
    return;
  } else if (inbound.attachment) {
    text = `${text}\n\n${FILE_NOTE}`;
  }

  const history = await recentMessages(db, person);
  await db.query("INSERT INTO messages (person_id, direction, body, sent_at) VALUES ($1, 'in', $2, now())", [
    person.id,
    text || (voice ? "(nota de voz que no se pudo usar)" : "(archivo sin texto)"),
  ]);
  await recordEvent(db, "message_in", person.id);
  if (canned) {
    await enqueue(db, person.id, canned);
  } else {
    try {
      await runTurn(deps, person, history, text);
    } catch (error) {
      await recordEvent(db, "error", person.id, { message: error instanceof Error ? error.message : String(error) });
      await enqueue(db, person.id, FAILURE_REPLY);
    }
  }
  await deliverPending(db, deps.channel);
}

async function recentMessages(db: Db, person: Person): Promise<PastMessage[]> {
  const rows = await db.query<PastMessage>(
    // Only what the person actually wrote or received.
    "SELECT direction, body FROM messages WHERE person_id = $1 AND sent_at IS NOT NULL ORDER BY seq DESC LIMIT $2",
    [person.id, HISTORY_MESSAGES],
  );
  return rows.reverse();
}

async function runTurn(deps: TurnDeps, person: Person, history: PastMessage[], text: string): Promise<void> {
  const { db, model } = deps;
  const tools = toolsFor(person);
  // What waits on whoever runs the home is shown to them only.
  const open = person.kind === "coordinator" ? await openItems(db) : null;
  const system = buildSystem(person, await houseViewFor(db, person), open);
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

  const finish = async (reply: string, kind: z.infer<typeof replyInput>["tipo"] | null) => {
    if (!reply.trim()) throw new Error("EMPTY_REPLY");
    await enqueue(db, person.id, reply);
    // "Answered alone" counts only a question from someone who does not run the home,
    // answered from memory without passing it up.
    if (kind === null) await recordEvent(db, "unclassified_reply", person.id);
    else if (kind === "pregunta_de_aclaracion") await recordEvent(db, "clarification_asked", person.id);
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
        // A reply written next to other calls was written before their results existed, and
        // may claim something that did not happen. It is sent only when it comes alone.
        if (calls.length === 1) reply = input.data as z.infer<typeof replyInput>;
        else result("No se envió: revisa primero el resultado de las otras herramientas y vuelve a llamar a responder.", true);
      } else {
        try {
          result(await tool.run(input.data, { db, person }));
          if (tool.name === "subir_pregunta") escalated = true;
        } catch (error) {
          // A refusal is for the model to read. Anything else is a fault: logged, and not shown.
          if (!(error instanceof Refused)) {
            await recordEvent(db, "error", person.id, { tool: tool.name, message: error instanceof Error ? error.message : String(error) });
          }
          result(error instanceof Refused ? error.message : "La herramienta falló por un problema interno.", true);
        }
      }
    }
    if (reply) return finish(reply.mensaje, reply.tipo);
    messages.push({ role: "assistant", content: response.content }, { role: "user", content: results });
  }
  throw new Error("TURN_TOO_LONG");
}
