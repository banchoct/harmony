import { openDb, type Db } from "../../src/db.js";
import { addPerson, type Person } from "../../src/people.js";
import { saveNote } from "../../src/memory.js";

export const PHONES = {
  ana: "+5215500000001",
  rosa: "+5215500000002",
  beto: "+5215500000003",
};

export interface InventedHouse {
  db: Db;
  ana: Person;
  rosa: Person;
  beto: Person;
  leo: Person;
}

/** An invented house: Ana runs it, Rosa and Beto work in it, Leo is a child. No real data. */
/**
 * With HARMONY_TEST_DB=postgres every test house lives behind a Postgres wire server and is
 * reached with the production driver, so the whole suite also checks that driver.
 */
async function openTestDb(): Promise<Db> {
  if (process.env.HARMONY_TEST_DB !== "postgres") return openDb();
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = new PGLiteSocketServer({ db: new PGlite(), port, host: "127.0.0.1", maxConnections: 5 });
  await server.start();
  return openDb(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`);
}

export async function inventedHouse(): Promise<InventedHouse> {
  const db = await openTestDb();
  const ana = await addPerson(db, { name: "Ana", kind: "coordinator", phone: PHONES.ana });
  const rosa = await addPerson(db, { name: "Rosa", kind: "staff", phone: PHONES.rosa });
  const beto = await addPerson(db, { name: "Beto", kind: "staff", phone: PHONES.beto });
  const leo = await addPerson(db, { name: "Leo", kind: "member" });
  return { db, ana, rosa, beto, leo };
}

/** The same house with two notes: one for everyone, one of health that only Rosa may see. */
export async function houseWithNotes(): Promise<InventedHouse> {
  const house = await inventedHouse();
  const { db, ana, rosa, leo } = house;
  await saveNote(db, { body: "La basura sale martes y viernes.", audience: "all", taughtBy: ana.id });
  await saveNote(db, {
    body: "Leo es alérgico al cacahuate.",
    health: true,
    audience: "restricted",
    viewers: [rosa.id],
    about: [leo.id],
    taughtBy: ana.id,
  });
  return house;
}
