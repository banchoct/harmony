import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { openItems, Refused } from "./actions.js";
import type { Channel, InboundMessage, SharedContact } from "./channel.js";
import type { Db } from "./db.js";
import { deliverPending, enqueue } from "./delivery.js";
import { recordEvent } from "./log.js";
import { houseViewFor } from "./memory.js";
import type { Model } from "./model.js";
import { findPersonByPhone, type Person } from "./people.js";
import { buildSystem, buildUserMessage, type PastMessage } from "./prompt.js";
import { usableTranscript, type Transcriber } from "./voice.js";
import { ESCALATE_TOOL, REPLY_TOOL, type replyInput, toolDefinition, toolsFor } from "./tools.js";

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

const FAILURE_AFTER_ACTING =
  "Perdón, tuve un problema al terminar de contestarte. Lo que alcancé a hacer sí quedó registrado, así que no hace falta que lo repitas.";
const CANNED = {
  noTranscriber: "Todavía no puedo escuchar notas de voz. ¿Me lo escribes, por favor?",
  notUnderstood: "Perdón, no pude entender tu nota de voz. ¿Me la repites o me lo escribes?",
  tooLarge: "Tu nota de voz es muy larga para mí. ¿Me la mandas en partes más cortas o me lo escribes?",
  notDownloaded: "Perdón, no pude descargar tu nota de voz. ¿Me la mandas otra vez?",
  file: "Todavía no puedo leer archivos ni fotos. ¿Me escribes lo que necesitas?",
};
const FILE_NOTE = "(El mensaje venía con un archivo o una foto. Harmony todavía no puede leer archivos.)";

/** Shared contact cards, in words for the model. The card is data: who to register is decided by tools. */
function describeContacts(contacts: SharedContact[]): string {
  const cards = contacts.map(
    (card) => `${card.name || "sin nombre"}, ${card.phone ? `teléfono ${card.phone}` : "sin número que se pueda usar"}`,
  );
  const what = cards.length === 1 ? "una tarjeta de contacto" : `${cards.length} tarjetas de contacto`;
  return `(Compartió ${what}: ${cards.join("; ")}.)`;
}

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

/**
 * What an inbound message says, as the text kept and shown to the model. `canned` is set when
 * it cannot be used and gets a fixed reply instead of a turn. Null when there is nothing in it.
 */
async function readInbound(
  deps: TurnDeps,
  person: Person,
  inbound: InboundMessage,
): Promise<{ body: string; canned?: string } | null> {
  const cards = inbound.contacts?.length ? describeContacts(inbound.contacts) : "";
  const written = [inbound.text.trim(), cards].filter(Boolean).join("\n\n");
  if (written) return { body: inbound.attachment ? `${written}\n\n${FILE_NOTE}` : written };
  if (inbound.audio || inbound.audioFailed || inbound.audioTooLarge) {
    const heard = await hear(deps, inbound);
    // The log keeps the length and whether it was understood, never the words.
    await recordEvent(deps.db, "voice_note", person.id, {
      seconds: inbound.audio?.seconds ?? inbound.audioSeconds ?? null,
      transcribed: "text" in heard,
    });
    return "text" in heard ? { body: heard.text } : { body: "(nota de voz que no se pudo usar)", canned: heard.reply };
  }
  if (inbound.attachment) return { body: "(archivo sin texto)", canned: CANNED.file };
  return null;
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
  const read = await readInbound(deps, person, inbound);
  if (!read) {
    await recordEvent(db, "empty_message", person.id);
    return;
  }
  const history = await recentMessages(db, person);
  await db.query("INSERT INTO messages (person_id, direction, body, sent_at) VALUES ($1, 'in', $2, now())", [
    person.id,
    read.body,
  ]);
  await recordEvent(db, "message_in", person.id);
  if (read.canned) {
    await enqueue(db, person.id, read.canned);
  } else {
    const progress = { acted: false };
    try {
      await runTurn(deps, person, history, read.body, progress);
    } catch (error) {
      await recordEvent(db, "error", person.id, { message: error instanceof Error ? error.message : String(error) });
      // Asking to try again after something was already done would do it twice.
      await enqueue(db, person.id, progress.acted ? FAILURE_AFTER_ACTING : FAILURE_REPLY);
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

async function runTurn(
  deps: TurnDeps,
  person: Person,
  history: PastMessage[],
  text: string,
  /** Set once a tool has changed something, so a later failure is worded accordingly. */
  progress: { acted: boolean },
): Promise<void> {
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
          progress.acted = true;
          if (tool.name === ESCALATE_TOOL) escalated = true;
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
