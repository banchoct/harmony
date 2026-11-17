import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { addPerson, findPersonByPhone } from "../src/people.js";

test("a person is identified by the phone the message came from", async () => {
  const db = await openDb();
  const ana = await addPerson(db, { name: "Ana", kind: "coordinator", phone: "+5215500000001" });
  const found = await findPersonByPhone(db, "+5215500000001");
  assert.deepEqual(found, ana);
  assert.equal(found?.kind, "coordinator");
  await db.close();
});

test("the WhatsApp form of a Mexican mobile identifies the same person", async () => {
  const db = await openDb();
  const rosa = await addPerson(db, { name: "Rosa", kind: "staff", phone: "+5215500000002" });
  assert.equal((await findPersonByPhone(db, "+525500000002"))?.id, rosa.id);
  await db.close();
});

test("an unknown or malformed phone identifies nobody", async () => {
  const db = await openDb();
  await addPerson(db, { name: "Rosa", kind: "staff", phone: "+5215500000002" });
  assert.equal(await findPersonByPhone(db, "+5215500000099"), null);
  assert.equal(await findPersonByPhone(db, "Rosa"), null);
  await db.close();
});

test("a member without a phone is a person of the house but not a user", async () => {
  const db = await openDb();
  const leo = await addPerson(db, { name: "Leo", kind: "member" });
  assert.equal(leo.phone, null);
  assert.equal(leo.kind, "member");
  await db.close();
});

test("two people cannot share a number, in either form", async () => {
  const db = await openDb();
  await addPerson(db, { name: "Rosa", kind: "staff", phone: "+5215500000002" });
  await assert.rejects(
    addPerson(db, { name: "Otra", kind: "staff", phone: "+525500000002" }),
    /PHONE_TAKEN/,
  );
  await db.close();
});

test("a phone that is not a number is refused", async () => {
  const db = await openDb();
  await assert.rejects(addPerson(db, { name: "Rosa", kind: "staff", phone: "abc" }), /PHONE_INVALID/);
  await db.close();
});
