import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { addPerson, findPersonByPhone } from "../src/people.js";

test("a database saved in a folder is created with its parent folders and keeps what is saved", async () => {
  const root = await mkdtemp(join(tmpdir(), "harmony-db-"));
  const dir = join(root, "data", "harmony");
  const first = await openDb(dir);
  await addPerson(first, { name: "Ana", kind: "coordinator", phone: "+5215500000001" });
  await first.close();
  const second = await openDb(dir);
  assert.equal((await findPersonByPhone(second, "+5215500000001"))?.name, "Ana");
  await second.close();
  // A saved database is tens of megabytes; leaving one per run fills the temporary disk.
  await rm(root, { recursive: true, force: true });
});

test("every table is closed to Supabase's public API roles: row security is on, with no policy", async () => {
  // Supabase serves the tables of the public schema over its web API. Row security with no
  // policy lets only the owner in, which is the connection Harmony uses.
  const db = await openDb();
  const open = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity ORDER BY 1",
  );
  assert.deepEqual(open, []);
  assert.deepEqual(await db.query("SELECT 1 FROM pg_policies WHERE schemaname = 'public'"), []);
  await db.close();
});
