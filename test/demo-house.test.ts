import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { DEMO_PHONES, seedDemoHouse } from "../src/demo-house.js";
import { houseViewFor } from "../src/memory.js";
import { findPersonByPhone } from "../src/people.js";

test("in the invented house the driver sees neither the children's health nor it leaks through the list", async () => {
  const db = await openDb();
  await seedDemoHouse(db);
  const chuy = (await findPersonByPhone(db, DEMO_PHONES.chuy))!;
  const lupita = (await findPersonByPhone(db, DEMO_PHONES.lupita))!;
  const forChuy = (await houseViewFor(db, chuy)).notes;
  assert.ok(forChuy.every((note) => !note.health));
  assert.ok(forChuy.some((note) => /quincena/.test(note.body)));
  const forLupita = (await houseViewFor(db, lupita)).notes;
  assert.equal(forLupita.filter((note) => note.health).length, 2);
  assert.ok(!forLupita.some((note) => /quincena/.test(note.body)));
  await db.close();
});
