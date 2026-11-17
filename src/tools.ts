import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Db } from "./db.js";
import { enqueue } from "./delivery.js";
import { recordEvent } from "./log.js";
import type { Person } from "./people.js";

export interface ToolContext {
  db: Db;
  /** Who is speaking, as identified by their phone. */
  person: Person;
}

export interface HarmonyTool {
  name: string;
  description: string;
  input: z.ZodType;
  /** Does the work and returns what the model is told. Throwing tells the model it failed. */
  run(input: any, context: ToolContext): Promise<string>;
}

function tool<Schema extends z.ZodType>(definition: {
  name: string;
  description: string;
  input: Schema;
  run(input: z.infer<Schema>, context: ToolContext): Promise<string>;
}): HarmonyTool {
  return definition;
}

export const REPLY_TOOL = "responder";

export const replyInput = z.object({
  mensaje: z.string().describe("El mensaje para la persona, tal como lo va a leer."),
  tipo: z
    .enum(["respuesta_a_pregunta", "otro"])
    .describe(
      "respuesta_a_pregunta: contestaste con la memoria de la casa una pregunta de la persona. " +
        "otro: cualquier otra cosa (saludo, agradecimiento, aviso de que subiste la pregunta, aclaración).",
    ),
});

/** Ends the turn. The code sends `mensaje` to the person; `run` is never called. */
const responder = tool({
  name: REPLY_TOOL,
  description: "Envía tu mensaje a la persona con la que hablas y termina el turno. Úsala siempre para contestar.",
  input: replyInput,
  run: async () => "",
});

const subirPregunta = tool({
  name: "subir_pregunta",
  description:
    "Pasa a quien lleva la casa una pregunta que la memoria de la casa no contesta. " +
    "Úsala en vez de suponer. Después avisa a la persona que ya preguntaste y que le avisarás.",
  input: z.object({
    pregunta: z.string().describe("La pregunta, completa y clara para quien no vio la conversación."),
  }),
  async run({ pregunta }, { db, person }) {
    const coordinators = await db.query<{ id: string; name: string }>(
      "SELECT id, name FROM people WHERE kind = 'coordinator' AND phone IS NOT NULL ORDER BY created_at",
    );
    if (coordinators.length === 0) throw new Error("No hay a quién subirle la pregunta.");
    const [question] = await db.query<{ id: string }>(
      "INSERT INTO pending_questions (asked_by, question) VALUES ($1, $2) RETURNING id",
      [person.id, pregunta],
    );
    for (const coordinator of coordinators) {
      await enqueue(
        db,
        coordinator.id,
        `${person.name} pregunta: «${pregunta}». Contéstame aquí y yo se lo paso y lo guardo.`,
      );
    }
    await recordEvent(db, "escalated", person.id, { question_id: question!.id });
    return `Pregunta enviada a ${coordinators.map((c) => c.name).join(" y ")}.`;
  },
});

/** The tools the code offers for a turn. Authority lives here: what is not listed cannot run. */
export function toolsFor(person: Person): HarmonyTool[] {
  return person.kind === "coordinator" ? [responder] : [responder, subirPregunta];
}

export function toolDefinition(tool: HarmonyTool): Anthropic.Tool {
  const { $schema: _, ...schema } = z.toJSONSchema(tool.input);
  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema as Anthropic.Tool["input_schema"],
    strict: true,
  };
}
