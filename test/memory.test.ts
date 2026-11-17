import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../src/db.js";
import { addPerson, type Person } from "../src/people.js";
import { houseViewFor, saveNote } from "../src/memory.js";

/** An invented house: Ana runs it, Rosa and Beto work in it, Leo is a child. */
async function inventedHouse(): Promise<{ db: Db; ana: Person; rosa: Person; beto: Person; leo: Person }> {
  const db = await openDb();
  const ana = await addPerson(db, { name: "Ana", kind: "coordinator", phone: "+5215500000001" });
  const rosa = await addPerson(db, { name: "Rosa", kind: "staff", phone: "+5215500000002" });
  const beto = await addPerson(db, { name: "Beto", kind: "staff", phone: "+5215500000003" });
  const leo = await addPerson(db, { name: "Leo", kind: "member" });
  return { db, ana, rosa, beto, leo };
}

const bodies = (view: { notes: Array<{ body: string }> }) => view.notes.map((n) => n.body).sort();

test("whoever runs the home sees every note, health included", async () => {
  const { db, ana, rosa, leo } = await inventedHouse();
  await saveNote(db, { body: "La basura sale martes y viernes.", audience: "all", taughtBy: ana.id });
  await saveNote(db, {
    body: "Leo es alérgico al cacahuate.",
    health: true,
    audience: "restricted",
    viewers: [rosa.id],
    about: [leo.id],
    taughtBy: ana.id,
  });
  assert.deepEqual(bodies(await houseViewFor(db, ana)), [
    "La basura sale martes y viernes.",
    "Leo es alérgico al cacahuate.",
  ]);
  await db.close();
});

test("staff see the notes for everyone and the restricted ones that name them, no others", async () => {
  const { db, ana, rosa, beto, leo } = await inventedHouse();
  await saveNote(db, { body: "La basura sale martes y viernes.", audience: "all", taughtBy: ana.id });
  await saveNote(db, {
    body: "Leo es alérgico al cacahuate.",
    health: true,
    audience: "restricted",
    viewers: [rosa.id],
    about: [leo.id],
    taughtBy: ana.id,
  });
  assert.deepEqual(bodies(await houseViewFor(db, rosa)), [
    "La basura sale martes y viernes.",
    "Leo es alérgico al cacahuate.",
  ]);
  assert.deepEqual(bodies(await houseViewFor(db, beto)), ["La basura sale martes y viernes."]);
  await db.close();
});

test("a restricted note with no viewers is seen only by whoever runs the home", async () => {
  const { db, ana, rosa } = await inventedHouse();
  await saveNote(db, { body: "Rosa gana por quincena.", audience: "restricted", taughtBy: ana.id });
  assert.deepEqual(bodies(await houseViewFor(db, rosa)), []);
  assert.deepEqual(bodies(await houseViewFor(db, ana)), ["Rosa gana por quincena."]);
  await db.close();
});

test("a health note cannot be saved for everyone", async () => {
  const { db, ana } = await inventedHouse();
  await assert.rejects(
    saveNote(db, { body: "Leo toma medicina a las 8.", health: true, audience: "all", taughtBy: ana.id }),
    /HEALTH_NOTE_MUST_BE_RESTRICTED/,
  );
  await db.close();
});

test("a view lists the people of the house, with phones only for whoever runs the home", async () => {
  const { db, ana, rosa } = await inventedHouse();
  const forAna = await houseViewFor(db, ana);
  const forRosa = await houseViewFor(db, rosa);
  assert.deepEqual(forRosa.people.map((p) => p.name).sort(), ["Ana", "Beto", "Leo", "Rosa"]);
  assert.ok(forRosa.people.every((p) => p.phone === null));
  assert.equal(forAna.people.find((p) => p.name === "Rosa")?.phone, "+525500000002");
  await db.close();
});

test("a note tells who it is about", async () => {
  const { db, ana, leo } = await inventedHouse();
  await saveNote(db, { body: "Leo entra a la escuela a las 8.", audience: "all", about: [leo.id], taughtBy: ana.id });
  const [note] = (await houseViewFor(db, ana)).notes;
  assert.deepEqual(note?.about, [leo.id]);
  await db.close();
});

test("a person listed twice in a note is linked once", async () => {
  const { db, ana, rosa } = await inventedHouse();
  await saveNote(db, {
    body: "Rosa descansa los domingos.",
    audience: "restricted",
    viewers: [rosa.id, rosa.id],
    about: [rosa.id, rosa.id],
    taughtBy: ana.id,
  });
  const [note] = (await houseViewFor(db, rosa)).notes;
  assert.deepEqual(note?.viewers, [rosa.id]);
  assert.deepEqual(note?.about, [rosa.id]);
  await db.close();
});
