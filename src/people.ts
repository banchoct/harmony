import type { Db } from "./db.js";
import { normalizePhone } from "./phone.js";

/** coordinator: runs the home. staff: works in it. member: known about, does not use Harmony. */
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

/** Identity: the active person whose phone a message came from, or null. */
export async function findPersonByPhone(db: Db, fromPhone: string): Promise<Person | null> {
  const phone = normalizePhone(fromPhone);
  if (!phone) return null;
  const rows = await db.query<Person>(`SELECT ${COLUMNS} FROM people WHERE phone = $1 AND active`, [phone]);
  return rows[0] ?? null;
}
