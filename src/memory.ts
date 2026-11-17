import type { Db } from "./db.js";
import type { Person } from "./people.js";

/** all: every user of the house. restricted: whoever runs the home plus the listed viewers. */
export type Audience = "all" | "restricted";

export interface Note {
  id: string;
  body: string;
  health: boolean;
  audience: Audience;
  /** Ids of the people the note speaks of. */
  about: string[];
  /** Ids of the people who may see a restricted note, besides whoever runs the home. */
  viewers: string[];
}

/** What one person may know of the house. Only this ever reaches the model for their turn. */
export interface HouseView {
  people: Person[];
  notes: Note[];
}

export async function saveNote(
  db: Db,
  input: {
    body: string;
    health?: boolean;
    audience: Audience;
    viewers?: string[];
    about?: string[];
    taughtBy: string;
  },
): Promise<string> {
  const health = input.health ?? false;
  if (health && input.audience !== "restricted") throw new Error("HEALTH_NOTE_MUST_BE_RESTRICTED");
  const links = [
    ...[...new Set(input.about)].map((id) => ({ id, role: "about" })),
    ...[...new Set(input.viewers)].map((id) => ({ id, role: "viewer" })),
  ];
  // One statement, so the note and its links are saved together or not at all.
  const rows = await db.query<{ id: string }>(
    `WITH note AS (
       INSERT INTO notes (body, health, audience, taught_by) VALUES ($1, $2, $3, $4) RETURNING id
     ), links AS (
       INSERT INTO note_people (note_id, person_id, role)
       SELECT note.id, link.person_id, link.role
       FROM note, unnest($5::uuid[], $6::text[]) AS link (person_id, role)
     )
     SELECT id FROM note`,
    [input.body, health, input.audience, input.taughtBy, links.map((l) => l.id), links.map((l) => l.role)],
  );
  return rows[0]!.id;
}

const linked = (role: string) =>
  `ARRAY(SELECT person_id FROM note_people WHERE note_id = notes.id AND role = '${role}' ORDER BY person_id)`;

/**
 * Privacy lives here, in code. Whoever runs the home sees everything. Anyone else sees the
 * notes for everyone and the restricted ones that list them as a viewer, and no phones.
 */
export async function houseViewFor(db: Db, person: Person): Promise<HouseView> {
  const seesAll = person.kind === "coordinator";
  const people = await db.query<Person>(
    `SELECT id, name, kind, ${seesAll ? "phone" : "NULL AS phone"} FROM people ORDER BY created_at, name`,
  );
  const notes = await db.query<Note>(
    `SELECT id, body, health, audience, ${linked("about")} AS about, ${linked("viewer")} AS viewers
     FROM notes
     WHERE $1 OR audience = 'all' OR EXISTS (
       SELECT 1 FROM note_people
       WHERE note_id = notes.id AND person_id = $2 AND role = 'viewer'
     )
     ORDER BY created_at, id`,
    [seesAll, person.id],
  );
  return { people, notes };
}
