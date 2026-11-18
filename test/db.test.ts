import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { addPerson, findPersonByPhone } from "../src/people.js";

test("a database saved in a folder is created with its parent folders and keeps what is saved", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "harmony-db-")), "data", "harmony");
  const first = await openDb(dir);
  await addPerson(first, { name: "Ana", kind: "coordinator", phone: "+5215500000001" });
  await first.close();
  const second = await openDb(dir);
  assert.equal((await findPersonByPhone(second, "+5215500000001"))?.name, "Ana");
  await second.close();
});
