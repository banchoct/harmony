import type { Db } from "./db.js";

/** Adds one row to the log. Rows are never changed or removed. */
export async function recordEvent(
  db: Db,
  kind: string,
  personId: string | null,
  data: Record<string, unknown> = {},
): Promise<void> {
  await db.query("INSERT INTO events (kind, person_id, data) VALUES ($1, $2, $3)", [
    kind,
    personId,
    JSON.stringify(data),
  ]);
}

/** The kinds of every event, oldest first. */
export async function eventKinds(db: Db): Promise<string[]> {
  return (await db.query<{ kind: string }>("SELECT kind FROM events ORDER BY seq")).map((e) => e.kind);
}

export interface LogSummary {
  /** Questions from people who do not run the home, answered from memory without passing them up. */
  answeredAlone: number;
  escalated: number;
  escalatedAnswered: number;
  escalatedWaiting: number;
  confirmationsAsked: number;
  confirmationsYes: number;
  confirmationsNo: number;
  confirmationsWaiting: number;
  clarificationsAsked: number;
  taught: number;
  corrected: number;
  retired: number;
  errors: number;
  unclassifiedReplies: number;
  inputTokens: number;
  outputTokens: number;
}

/** The counts that feed the success signals and the review of the autonomy levels. */
export async function logSummary(db: Db, since: Date = new Date(0)): Promise<LogSummary> {
  const [row] = await db.query<Record<keyof LogSummary, string>>(
    `WITH e AS (SELECT kind, data FROM events WHERE at >= $1)
     SELECT
       count(*) FILTER (WHERE kind = 'answered_alone') AS "answeredAlone",
       count(*) FILTER (WHERE kind = 'escalated') AS "escalated",
       count(*) FILTER (WHERE kind = 'question_answered') AS "escalatedAnswered",
       (SELECT count(*) FROM pending_questions WHERE answered_at IS NULL AND created_at >= $1) AS "escalatedWaiting",
       count(*) FILTER (WHERE kind = 'confirmation_requested') AS "confirmationsAsked",
       count(*) FILTER (WHERE kind = 'confirmation_resolved' AND data->>'outcome' = 'confirmed') AS "confirmationsYes",
       count(*) FILTER (WHERE kind = 'confirmation_resolved' AND data->>'outcome' = 'rejected') AS "confirmationsNo",
       (SELECT count(*) FROM proposals WHERE resolved_at IS NULL AND created_at >= $1) AS "confirmationsWaiting",
       count(*) FILTER (WHERE kind = 'clarification_asked') AS "clarificationsAsked",
       count(*) FILTER (WHERE kind = 'taught') AS "taught",
       count(*) FILTER (WHERE kind = 'corrected') AS "corrected",
       count(*) FILTER (WHERE kind = 'retired') AS "retired",
       count(*) FILTER (WHERE kind = 'error') AS "errors",
       count(*) FILTER (WHERE kind = 'unclassified_reply') AS "unclassifiedReplies",
       coalesce(sum((data->>'inputTokens')::bigint) FILTER (WHERE kind = 'model_call'), 0) AS "inputTokens",
       coalesce(sum((data->>'outputTokens')::bigint) FILTER (WHERE kind = 'model_call'), 0) AS "outputTokens"
     FROM e`,
    [since.toISOString()],
  );
  return Object.fromEntries(Object.entries(row!).map(([key, value]) => [key, Number(value)])) as unknown as LogSummary;
}

export function formatSummary(s: LogSummary): string {
  return [
    "Preguntas del personal",
    `  Contestó sola: ${s.answeredAlone}`,
    `  Subió a quien lleva la casa: ${s.escalated} (contestadas: ${s.escalatedAnswered}, en espera: ${s.escalatedWaiting})`,
    "Confirmaciones y aclaraciones",
    `  Confirmaciones pedidas: ${s.confirmationsAsked} (sí: ${s.confirmationsYes}, no: ${s.confirmationsNo}, en espera: ${s.confirmationsWaiting})`,
    `  Aclaraciones pedidas: ${s.clarificationsAsked}`,
    "Memoria",
    `  Notas enseñadas: ${s.taught}, corregidas: ${s.corrected}, retiradas: ${s.retired}`,
    "Salud del sistema",
    `  Errores: ${s.errors}, respuestas sin clasificar: ${s.unclassifiedReplies}`,
    `  Tokens: ${s.inputTokens} de entrada, ${s.outputTokens} de salida`,
  ].join("\n");
}
