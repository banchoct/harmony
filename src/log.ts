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
