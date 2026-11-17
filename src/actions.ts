import type { Db } from "./db.js";
import { enqueue } from "./delivery.js";
import { recordEvent } from "./log.js";
import { correctNote, findNote, retireNote, saveNote, type NoteInput } from "./memory.js";
import type { Person } from "./people.js";

/** A change to the memory asked for by whoever runs the home. */
export type Action =
  | { type: "save_note"; note: NoteInput }
  | { type: "correct_note"; noteId: string; body: string }
  | { type: "retire_note"; noteId: string }
  | { type: "answer_question"; questionId: string; message: string; note: NoteInput };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Tools throw this to tell the model, in plain words, why something was not done. */
export class Refused extends Error {}

export function requireId(id: string, what: string): void {
  if (!UUID.test(id)) throw new Refused(`«${id}» no es el identificador de ${what}.`);
}

async function checkNote(db: Db, note: NoteInput): Promise<void> {
  if (note.health && note.audience !== "restricted")
    throw new Refused("Una nota de salud no puede ser visible para todos: hazla restringida y di quién la ve.");
  const ids = [...new Set([...(note.viewers ?? []), ...(note.about ?? [])])];
  for (const id of ids) requireId(id, "una persona");
  const found = await db.query("SELECT 1 FROM people WHERE id = ANY($1::uuid[]) AND active", [ids]);
  if (found.length !== ids.length) throw new Refused("Alguna de las personas indicadas no existe en la casa.");
}

async function existingNote(db: Db, id: string): Promise<{ body: string; health: boolean }> {
  requireId(id, "una nota");
  const note = await findNote(db, id);
  if (!note) throw new Refused("Esa nota no existe o ya fue retirada.");
  return note;
}

/**
 * Checks the action can be done and says whether it touches health, in which case it must wait
 * for a yes (autonomy level 3). `summary` is what whoever runs the home is asked to confirm.
 */
async function inspect(db: Db, action: Action): Promise<{ health: boolean; summary: string }> {
  switch (action.type) {
    case "save_note":
      await checkNote(db, action.note);
      return { health: action.note.health ?? false, summary: `Guardar nota de salud: «${action.note.body}»` };
    case "correct_note": {
      const note = await existingNote(db, action.noteId);
      return { health: note.health, summary: `Corregir la nota de salud «${note.body}» por: «${action.body}»` };
    }
    case "retire_note": {
      const note = await existingNote(db, action.noteId);
      return { health: note.health, summary: `Retirar la nota de salud: «${note.body}»` };
    }
    case "answer_question": {
      requireId(action.questionId, "una pregunta pendiente");
      const open = await db.query("SELECT 1 FROM pending_questions WHERE id = $1 AND answered_at IS NULL", [
        action.questionId,
      ]);
      if (open.length === 0) throw new Refused("Esa pregunta no existe o ya fue contestada.");
      await checkNote(db, action.note);
      return {
        health: action.note.health ?? false,
        summary: `Contestar una pregunta pendiente y guardar la nota de salud: «${action.note.body}»`,
      };
    }
  }
}

async function apply(db: Db, by: Person, action: Action): Promise<string> {
  switch (action.type) {
    case "save_note": {
      const id = await saveNote(db, { ...action.note, taughtBy: by.id });
      await recordEvent(db, "taught", by.id, { note_id: id });
      return "Nota guardada.";
    }
    case "correct_note":
      await correctNote(db, action.noteId, action.body);
      await recordEvent(db, "corrected", by.id, { note_id: action.noteId });
      return "Nota corregida.";
    case "retire_note":
      await retireNote(db, action.noteId);
      await recordEvent(db, "retired", by.id, { note_id: action.noteId });
      return "Nota retirada.";
    case "answer_question": {
      // Claiming the question first keeps a second answer from being sent or saved.
      const [question] = await db.query<{ asked_by: string }>(
        `UPDATE pending_questions SET answered_at = now(), answered_by = $2
         WHERE id = $1 AND answered_at IS NULL RETURNING asked_by`,
        [action.questionId, by.id],
      );
      if (!question) throw new Refused("Esa pregunta no existe o ya fue contestada.");
      const noteId = await saveNote(db, { ...action.note, taughtBy: by.id });
      await enqueue(db, question.asked_by, action.message);
      await recordEvent(db, "question_answered", by.id, { question_id: action.questionId, note_id: noteId });
      return "Respuesta enviada a quien preguntó y guardada en la memoria.";
    }
  }
}

/** Does the action now, or holds it as a proposal when it touches health. */
export async function submit(db: Db, by: Person, action: Action): Promise<string> {
  const { health, summary } = await inspect(db, action);
  if (!health) return apply(db, by, action);
  const [proposal] = await db.query<{ id: string }>(
    "INSERT INTO proposals (requested_by, action, summary) VALUES ($1, $2, $3) RETURNING id",
    [by.id, JSON.stringify(action), summary],
  );
  await recordEvent(db, "confirmation_requested", by.id, { proposal_id: proposal!.id });
  return (
    `Es un cambio de salud: no se guardó, quedó como propuesta ${proposal!.id}. ` +
    `Dile a ${by.name} en una línea qué entendiste y pídele que confirme con un sí.`
  );
}

/** Resolves a proposal with the yes or no of whoever runs the home. */
export async function resolve(db: Db, by: Person, proposalId: string, confirmed: boolean): Promise<string> {
  requireId(proposalId, "una propuesta");
  const [proposal] = await db.query<{ action: Action }>(
    `UPDATE proposals SET resolved_at = now(), outcome = $2
     WHERE id = $1 AND resolved_at IS NULL RETURNING action`,
    [proposalId, confirmed ? "confirmed" : "rejected"],
  );
  if (!proposal) throw new Refused("Esa propuesta no existe o ya se resolvió.");
  await recordEvent(db, "confirmation_resolved", by.id, {
    proposal_id: proposalId,
    outcome: confirmed ? "confirmed" : "rejected",
  });
  if (!confirmed) return "Propuesta descartada. No se guardó nada.";
  await inspect(db, proposal.action);
  return apply(db, by, proposal.action);
}

export interface OpenItems {
  questions: Array<{ id: string; question: string; askedBy: string }>;
  proposals: Array<{ id: string; summary: string }>;
}

/** What is waiting on whoever runs the home: questions passed up and proposals to confirm. */
export async function openItems(db: Db): Promise<OpenItems> {
  const questions = await db.query<{ id: string; question: string; askedBy: string }>(
    `SELECT q.id, q.question, people.name AS "askedBy"
     FROM pending_questions q JOIN people ON people.id = q.asked_by
     WHERE q.answered_at IS NULL ORDER BY q.seq`,
  );
  const proposals = await db.query<{ id: string; summary: string }>(
    "SELECT id, summary FROM proposals WHERE resolved_at IS NULL ORDER BY seq",
  );
  return { questions, proposals };
}
