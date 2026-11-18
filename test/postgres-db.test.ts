import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { openDb } from "../src/db.js";
import { postgresSsl } from "../src/postgres-db.js";
import { logSummary, recordEvent } from "../src/log.js";
import { houseViewFor, saveNote } from "../src/memory.js";
import { addPerson, findPersonByPhone } from "../src/people.js";

/** A real Postgres wire server in this process, so the production driver is tested offline. */
async function postgresServer(): Promise<{ url: string; stop(): Promise<void> }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const backing = new PGlite();
  const server = new PGLiteSocketServer({ db: backing, port, host: "127.0.0.1", maxConnections: 5 });
  await server.start();
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    async stop() {
      await server.stop();
      await backing.close();
    },
  };
}

test("the house works the same over a Postgres connection as in memory", async () => {
  const server = await postgresServer();
  const db = await openDb(server.url);
  const ana = await addPerson(db, { name: "Ana", kind: "coordinator", phone: "+5215500000001" });
  const rosa = await addPerson(db, { name: "Rosa", kind: "staff", phone: "+5215500000002" });
  const leo = await addPerson(db, { name: "Leo", kind: "member" });
  await saveNote(db, { body: "La basura sale martes y viernes.", audience: "all", taughtBy: ana.id });
  await saveNote(db, {
    body: "Leo es alérgico al cacahuate.",
    health: true,
    audience: "restricted",
    viewers: [rosa.id],
    about: [leo.id],
    taughtBy: ana.id,
  });

  assert.equal((await findPersonByPhone(db, "+525500000002"))?.id, rosa.id);
  const view = await houseViewFor(db, rosa);
  assert.deepEqual(view.notes.map((n) => n.body), ["La basura sale martes y viernes.", "Leo es alérgico al cacahuate."]);
  assert.deepEqual(view.notes[1]?.about, [leo.id]);
  assert.deepEqual(view.notes[1]?.viewers, [rosa.id]);
  assert.equal(view.notes[1]?.health, true);

  await recordEvent(db, "answered_alone", rosa.id);
  await recordEvent(db, "model_call", rosa.id, { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 });
  const summary = await logSummary(db);
  assert.equal(summary.answeredAlone, 1);
  assert.equal(summary.inputTokens, 100);
  const [stored] = await db.query<{ data: unknown }>("SELECT data FROM events WHERE kind = 'model_call'");
  assert.deepEqual(stored?.data, { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 });
  await db.close();
  await server.stop();
});

test("opening the same Postgres database again keeps what is there", async () => {
  const server = await postgresServer();
  const first = await openDb(server.url);
  await addPerson(first, { name: "Ana", kind: "coordinator", phone: "+5215500000001" });
  await first.close();
  const second = await openDb(server.url);
  assert.equal((await findPersonByPhone(second, "+5215500000001"))?.name, "Ana");
  await second.close();
  await server.stop();
});

test("a remote database is only reached over verified TLS", () => {
  assert.throws(() => postgresSsl("postgres://u:p@db.example.com:5432/postgres"), /TLS_REQUIRED/);
  assert.throws(() => postgresSsl("postgres://u:p@db.example.com:5432/postgres?sslmode=disable"), /TLS_REQUIRED/);
  const remote = postgresSsl("postgres://u:p@db.example.com:5432/postgres?sslmode=require");
  assert.ok(remote && remote.rejectUnauthorized === true && remote.ca.length > 100);
  assert.equal(postgresSsl("postgres://u:p@127.0.0.1:5432/postgres"), false);
  assert.throws(() => postgresSsl("mysql://u:p@db.example.com/x"), /INVALID_DATABASE_URL/);
});
