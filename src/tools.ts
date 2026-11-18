import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Db } from "./db.js";
import { Refused, resolve, submit } from "./actions.js";
import { enqueue } from "./delivery.js";
import { recordEvent } from "./log.js";
import type { NoteInput } from "./memory.js";
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
    .enum(["respuesta_a_pregunta", "pregunta_de_aclaracion", "otro"])
    .describe(
      "respuesta_a_pregunta: contestaste con la memoria de la casa una pregunta de la persona. " +
        "pregunta_de_aclaracion: le pides que aclare una instrucción ambigua antes de actuar. " +
        "otro: cualquier otra cosa (saludo, agradecimiento, aviso de que subiste la pregunta, confirmación de que guardaste algo).",
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
    pregunta: z
      .string()
      .describe(
        "Solo la pregunta, completa y clara para quien no vio la conversación. " +
          "Sin el nombre de quien pregunta (se agrega solo) y sin comentarios sobre lo que hay o no en la memoria.",
      ),
  }),
  async run({ pregunta }, { db, person }) {
    const coordinators = await db.query<{ id: string; name: string }>(
      "SELECT id, name FROM people WHERE kind = 'coordinator' AND active AND phone IS NOT NULL ORDER BY created_at",
    );
    if (coordinators.length === 0) throw new Refused("No hay a quién subirle la pregunta.");
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

const noteFields = z.object({
  texto: z.string().describe("La nota, completa y clara para quien no vio la conversación."),
  de_salud: z.boolean().describe("true si habla de salud: alergias, medicinas, enfermedades, tratamientos."),
  visible_para: z
    .enum(["todos", "restringida"])
    .describe("todos: cualquier persona de la casa. restringida: quien lleva la casa y las personas de personas_que_la_ven."),
  personas_que_la_ven: z
    .array(z.string())
    .describe("Identificadores de las personas que pueden ver una nota restringida. Vacío si es para todos."),
  sobre: z.array(z.string()).describe("Identificadores de las personas de las que habla la nota. Puede ir vacío."),
});

function toNote(fields: z.infer<typeof noteFields>): NoteInput {
  return {
    body: fields.texto,
    health: fields.de_salud,
    audience: fields.visible_para === "todos" ? "all" : "restricted",
    viewers: fields.personas_que_la_ven,
    about: fields.sobre,
  };
}

const guardarNota = tool({
  name: "guardar_nota",
  description:
    "Guarda en la memoria de la casa algo que quien lleva la casa te enseñó. Una nota por tema. " +
    "Si es de salud no se guarda directo: queda como propuesta hasta que confirme.",
  input: noteFields,
  run: (fields, { db, person }) => submit(db, person, { type: "save_note", note: toNote(fields) }),
});

const corregirNota = tool({
  name: "corregir_nota",
  description: "Cambia el texto de una nota existente cuando quien lleva la casa corrige algo.",
  input: z.object({
    nota: z.string().describe("Identificador de la nota."),
    texto: z.string().describe("El texto nuevo, completo."),
  }),
  run: ({ nota, texto }, { db, person }) => submit(db, person, { type: "correct_note", noteId: nota, body: texto }),
});

const retirarNota = tool({
  name: "retirar_nota",
  description: "Retira una nota que ya no aplica.",
  input: z.object({ nota: z.string().describe("Identificador de la nota.") }),
  run: ({ nota }, { db, person }) => submit(db, person, { type: "retire_note", noteId: nota }),
});

const responderPendiente = tool({
  name: "responder_pendiente",
  description:
    "Úsala cuando quien lleva la casa contesta una pregunta pendiente: le manda la respuesta a quien preguntó " +
    "y la guarda como nota, para no volver a preguntarla.",
  input: z.object({
    pregunta: z.string().describe("Identificador de la pregunta pendiente."),
    mensaje_para_quien_pregunto: z.string().describe("La respuesta, redactada para quien hizo la pregunta."),
    nota: noteFields,
  }),
  run: ({ pregunta, mensaje_para_quien_pregunto, nota }, { db, person }) =>
    submit(db, person, {
      type: "answer_question",
      questionId: pregunta,
      message: mensaje_para_quien_pregunto,
      note: toNote(nota),
    }),
});

const confirmar = tool({
  name: "confirmar",
  description: "Registra el sí o el no de quien lleva la casa a una propuesta en espera. Con sí, el cambio se aplica.",
  input: z.object({
    propuesta: z.string().describe("Identificador de la propuesta."),
    decision: z.enum(["si", "no"]),
  }),
  run: ({ propuesta, decision }, { db, person }) => resolve(db, person, propuesta, decision === "si"),
});

const KIND_BY_LABEL = { lleva_la_casa: "coordinator", personal: "staff", miembro: "member" } as const;

const registrarPersona = tool({
  name: "registrar_persona",
  description:
    "Da de alta a una persona de la casa. Con teléfono podrá escribirle a Harmony; sin teléfono solo se sabe de ella. " +
    "Dar de alta a alguien que lleva la casa no se hace directo: queda como propuesta hasta que confirme.",
  input: z.object({
    nombre: z.string(),
    tipo: z
      .enum(["lleva_la_casa", "personal", "miembro"])
      .describe("lleva_la_casa: tiene autoridad sobre la memoria. personal: trabaja en la casa. miembro: familia."),
    telefono: z.string().nullable().describe("Con clave de país, o null si no tiene o no se sabe."),
  }),
  run: ({ nombre, tipo, telefono }, { db, person }) =>
    submit(db, person, { type: "register_person", name: nombre, kind: KIND_BY_LABEL[tipo], phone: telefono }),
});

const darDeBajaPersona = tool({
  name: "dar_de_baja_persona",
  description: "Da de baja a una persona que ya no es de la casa. Deja de poder escribirle a Harmony.",
  input: z.object({ persona: z.string().describe("Identificador de la persona.") }),
  run: ({ persona }, { db, person }) => submit(db, person, { type: "remove_person", personId: persona }),
});

/** The tools the code offers for a turn. Authority lives here: what is not listed cannot run. */
export function toolsFor(person: Person): HarmonyTool[] {
  if (person.kind !== "coordinator") return [responder, subirPregunta];
  return [responder, guardarNota, corregirNota, retirarNota, responderPendiente, confirmar, registrarPersona, darDeBajaPersona];
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
