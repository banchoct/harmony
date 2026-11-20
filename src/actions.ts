import type { Db } from "./db.js";
import { enqueue } from "./delivery.js";
import { recordEvent } from "./log.js";
import { correctNote, findNote, retireNote, saveNote, type NoteInput } from "./memory.js";
import { addPerson, findAnyoneByPhone, type Person, type PersonKind } from "./people.js";
import { normalizePhone } from "./phone.js";

/** A change to the memory asked for by whoever runs the home. */
export type Action =
  | { type: "save_note"; note: NoteInput }
  /** `health` is what the model says of the new text; the stored note decides the rest. */
  | { type: "correct_note"; noteId: string; body: string; health: boolean }
  | { type: "retire_note"; noteId: string }
  | { type: "answer_question"; questionId: string; message: string; note: NoteInput }
  | { type: "register_person"; name: string; kind: PersonKind; phone: string | null }
  | { type: "remove_person"; personId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An unanswered proposal stops being confirmable after this long. */
const PROPOSAL_LIFE = "24 hours";

/** Tools throw this to tell the model, in plain words, why something was not done. */
export class Refused extends Error {}

function requireId(id: string, what: string): void {
  if (!UUID.test(id)) throw new Refused(`«${id}» no es el identificador de ${what}.`);
}

/** Refuses empty or oversized text here, in words, before the database refuses it in code. */
function requireText(value: string, what: string, max: number): void {
  const length = value.trim().length;
  if (length === 0) throw new Refused(`Falta ${what}.`);
  if (length > max) throw new Refused(`${what} es demasiado largo: máximo ${max} caracteres.`);
}

async function checkNote(db: Db, note: NoteInput): Promise<void> {
  requireText(note.body, "el texto de la nota", 4000);
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

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/** "Margot" and "Margot Fasja" are one person; "Lupita" on Rosa's number is not. */
function sameName(left: string, right: string): boolean {
  const [a, b] = [fold(left), fold(right)];
  return a.includes(b) || b.includes(a);
}

/**
 * The person of the house a registration is about, if they are already in it: whoever holds
 * the number, or else someone of that exact name who has no number yet. That second case is
 * how a person named in a description of the house later gets their phone, from a contact
 * card, without becoming two people.
 */
async function alreadyInHouse(
  db: Db,
  name: string,
  phone: string | null,
): Promise<{ id: string; name: string; kind: PersonKind; hasPhone: boolean } | null> {
  const holder = await findAnyoneByPhone(db, phone);
  if (holder?.active) return { id: holder.id, name: holder.name, kind: holder.kind, hasPhone: true };
  const withoutPhone = await db.query<{ id: string; name: string; kind: PersonKind }>(
    "SELECT id, name, kind FROM people WHERE active AND phone IS NULL ORDER BY created_at",
  );
  const namesake = withoutPhone.find((person) => fold(person.name) === fold(name));
  return namesake ? { ...namesake, hasPhone: false } : null;
}

const KIND_WORDS: Record<PersonKind, string> = {
  coordinator: "alguien que lleva la casa",
  staff: "personal",
  member: "familia",
};

/**
 * Checks the action can be done. Returns what whoever runs the home must confirm with a yes, or
 * null when it can be done now. A yes is needed for anything touching health (autonomy level 3),
 * for giving or taking away authority over the house, and for putting another name on a number
 * that already belongs to someone.
 */
async function inspect(db: Db, by: Person, action: Action): Promise<string | null> {
  switch (action.type) {
    case "save_note":
      await checkNote(db, action.note);
      return action.note.health ? `Guardar nota de salud: «${action.note.body}»` : null;
    case "correct_note": {
      requireText(action.body, "el texto de la nota", 4000);
      const note = await existingNote(db, action.noteId);
      // The audience of a note does not change when it is corrected, so health text must not
      // arrive this way into a note that others can see.
      if (action.health && !note.health)
        throw new Refused(
          "Esa nota no es de salud y la pueden ver otras personas. Lo de salud va en una nota aparte: guárdala con guardar_nota, restringida.",
        );
      return note.health ? `Corregir la nota de salud «${note.body}» por: «${action.body}»` : null;
    }
    case "retire_note": {
      const note = await existingNote(db, action.noteId);
      return note.health ? `Retirar la nota de salud: «${note.body}»` : null;
    }
    case "answer_question": {
      requireId(action.questionId, "una pregunta pendiente");
      requireText(action.message, "el mensaje para quien preguntó", 4000);
      const open = await db.query("SELECT 1 FROM pending_questions WHERE id = $1 AND answered_at IS NULL", [
        action.questionId,
      ]);
      if (open.length === 0) throw new Refused("Esa pregunta no existe o ya fue contestada.");
      await checkNote(db, action.note);
      return action.note.health
        ? `Contestar una pregunta pendiente y guardar la nota de salud: «${action.note.body}»`
        : null;
    }
    case "register_person": {
      requireText(action.name, "el nombre", 120);
      if (action.phone !== null && !normalizePhone(action.phone))
        throw new Refused("Ese teléfono no es válido. Pídelo con clave de país.");
      // Someone who left the house is not this person: their number starts a new one.
      const current = await alreadyInHouse(db, action.name, action.phone);
      const hasAuthority = current?.kind === "coordinator";
      if (current?.id === by.id && action.kind !== "coordinator")
        throw new Refused("No puedes quitarte a ti la autoridad sobre la casa.");
      if (action.kind === "coordinator" && !hasAuthority)
        return `Dar autoridad sobre la casa a ${action.name}${action.phone ? `, teléfono ${action.phone}` : ""}`;
      if (hasAuthority && action.kind !== "coordinator")
        return `Quitar a ${current.name} la autoridad sobre la casa`;
      if (current && !sameName(current.name, action.name))
        return `Ese número hoy es de ${current.name}. Cambiar esa persona a ${action.name}, ${KIND_WORDS[action.kind]}`;
      return null;
    }
    case "remove_person": {
      requireId(action.personId, "una persona");
      if (action.personId === by.id) throw new Refused("No puedes darte de baja a ti misma.");
      const [person] = await db.query<{ name: string; kind: PersonKind }>(
        "SELECT name, kind FROM people WHERE id = $1 AND active",
        [action.personId],
      );
      if (!person) throw new Refused("Esa persona no existe en la casa.");
      return person.kind === "coordinator" ? `Dar de baja a ${person.name}, que lleva la casa` : null;
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
    case "register_person": {
      const holder = await findAnyoneByPhone(db, action.phone);
      // The number of someone who left is freed, so whoever gets it shares nothing with them:
      // not their notes, not their conversation, not their unsent messages.
      if (holder && !holder.active) await db.query("UPDATE people SET phone = NULL WHERE id = $1", [holder.id]);
      const current = await alreadyInHouse(db, action.name, action.phone);
      if (current) {
        // Their number is kept when they have one; given when they had none and one came.
        await db.query("UPDATE people SET name = $2, kind = $3, phone = coalesce(phone, $4) WHERE id = $1", [
          current.id,
          action.name,
          action.kind,
          action.phone ? normalizePhone(action.phone) : null,
        ]);
        await recordEvent(db, "person_updated", by.id, { person_id: current.id });
        const gained = !current.hasPhone && action.phone ? " Ya tiene teléfono y puede escribirme." : "";
        return `${action.name} ya estaba en la casa; quedó como ${KIND_WORDS[action.kind]}.${gained}`;
      }
      const added = await addPerson(db, { name: action.name, kind: action.kind, phone: action.phone ?? undefined });
      await recordEvent(db, "person_registered", by.id, { person_id: added.id });
      return `${added.name} quedó en la casa con el identificador ${added.id}.`;
    }
    case "remove_person": {
      const [left] = await db.query<{ name: string }>(
        "UPDATE people SET active = false WHERE id = $1 AND active RETURNING name",
        [action.personId],
      );
      if (!left) throw new Refused("Esa persona no existe en la casa.");
      await recordEvent(db, "person_removed", by.id, { person_id: action.personId });
      return `${left.name} ya no es parte de la casa.`;
    }
  }
}

/** Does the action now, or holds it as a proposal when it must wait for a yes. */
export async function submit(db: Db, by: Person, action: Action): Promise<string> {
  const toConfirm = await inspect(db, by, action);
  if (!toConfirm) return apply(db, by, action);
  const [proposal] = await db.query<{ id: string }>(
    "INSERT INTO proposals (requested_by, action, summary) VALUES ($1, $2::text::jsonb, $3) RETURNING id",
    [by.id, JSON.stringify(action), toConfirm],
  );
  await recordEvent(db, "confirmation_requested", by.id, { proposal_id: proposal!.id });
  return (
    `Este cambio necesita confirmación: no se hizo, quedó como propuesta ${proposal!.id}. ` +
    `Dile a ${by.name} en una línea qué entendiste y pídele que confirme con un sí.`
  );
}

/** Closes the proposals nobody answered in time, so an old one cannot be confirmed by a later yes. */
async function expireOldProposals(db: Db): Promise<void> {
  const expired = await db.query<{ id: string; requested_by: string }>(
    `UPDATE proposals SET resolved_at = now(), outcome = 'expired'
     WHERE resolved_at IS NULL AND created_at < now() - interval '${PROPOSAL_LIFE}'
     RETURNING id, requested_by`,
  );
  for (const proposal of expired) {
    await recordEvent(db, "confirmation_resolved", proposal.requested_by, { proposal_id: proposal.id, outcome: "expired" });
  }
}

/** Resolves a proposal with the yes or no of whoever runs the home. */
export async function resolve(db: Db, by: Person, proposalId: string, confirmed: boolean): Promise<string> {
  requireId(proposalId, "una propuesta");
  await expireOldProposals(db);
  // The yes has to come in a message written after the proposal was made. Otherwise the model
  // could propose and confirm by itself within one turn, and the wait would mean nothing.
  const [proposal] = await db.query<{ action: Action }>(
    `SELECT action FROM proposals
     WHERE id = $1 AND resolved_at IS NULL AND EXISTS (
       SELECT 1 FROM messages
       WHERE person_id = $2 AND direction = 'in' AND messages.created_at > proposals.created_at
     )`,
    [proposalId, by.id],
  );
  if (!proposal) {
    throw new Refused(
      "Esa propuesta no existe, ya se resolvió o venció, o todavía no hay un mensaje de quien lleva la casa posterior a ella.",
    );
  }
  // Applied first and closed after: a yes that cannot be applied leaves the proposal open
  // instead of being used up with nothing done.
  let result = "Propuesta descartada. No se guardó nada.";
  if (confirmed) {
    await inspect(db, by, proposal.action);
    result = await apply(db, by, proposal.action);
  }
  const outcome = confirmed ? "confirmed" : "rejected";
  await db.query("UPDATE proposals SET resolved_at = now(), outcome = $2 WHERE id = $1", [proposalId, outcome]);
  await recordEvent(db, "confirmation_resolved", by.id, { proposal_id: proposalId, outcome });
  return result;
}

export interface OpenItems {
  questions: Array<{ id: string; question: string; askedBy: string }>;
  proposals: Array<{ id: string; summary: string }>;
}

/** What is waiting on whoever runs the home: questions passed up and proposals to confirm. */
export async function openItems(db: Db): Promise<OpenItems> {
  await expireOldProposals(db);
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
