import type { Db } from "./db.js";
import { normalizePhone } from "./phone.js";

/** coordinator: runs the home. staff: works in it. member: family; a user only if they have a phone. */
export type PersonKind = "coordinator" | "staff" | "member";

export interface Person {
  id: string;
  name: string;
  kind: PersonKind;
  phone: string | null;
}

const COLUMNS = "id, name, kind, phone";

export async function addPerson(
  db: Db,
  input: { name: string; kind: PersonKind; phone?: string },
): Promise<Person> {
  let phone: string | null = null;
  if (input.phone !== undefined) {
    phone = normalizePhone(input.phone);
    if (!phone) throw new Error("PHONE_INVALID");
  }
  try {
    const rows = await db.query<Person>(
      `INSERT INTO people (name, kind, phone) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [input.name, input.kind, phone],
    );
    return rows[0]!;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new Error("PHONE_TAKEN");
    throw error;
  }
}

/** Whoever holds this number, in the house now or before. For the code that registers people. */
export async function findAnyoneByPhone(
  db: Db,
  rawPhone: string | null,
): Promise<(Person & { active: boolean }) | null> {
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (!phone) return null;
  const rows = await db.query<Person & { active: boolean }>(
    `SELECT ${COLUMNS}, active FROM people WHERE phone = $1`,
    [phone],
  );
  return rows[0] ?? null;
}

/** Identity: the active person whose phone a message came from, or null. */
export async function findPersonByPhone(db: Db, fromPhone: string): Promise<Person | null> {
  const found = await findAnyoneByPhone(db, fromPhone);
  if (!found?.active) return null;
  const { active: _, ...person } = found;
  return person;
}

/** A house with nobody running it cannot be taught or asked anything. */
export async function hasCoordinator(db: Db): Promise<boolean> {
  return (await db.query("SELECT 1 FROM people WHERE kind = 'coordinator' AND active LIMIT 1")).length > 0;
}
