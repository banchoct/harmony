import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createFakeChannel } from "../src/channels/fake.js";
import { createHarmony } from "../src/app.js";
import { deliverPending, enqueue } from "../src/delivery.js";
import { eventKinds } from "../src/log.js";
import { houseViewFor, saveNote } from "../src/memory.js";
import { findPersonByPhone } from "../src/people.js";
import { call, failOnStepErrors, idShown, reply, scriptedModel, shownTo, type ScriptedModel } from "./support/scripted-model.js";
import { houseWithNotes, PHONES } from "./support/house.js";

failOnStepErrors(afterEach);

async function setup(model: ScriptedModel) {
  const house = await houseWithNotes();
  const channel = createFakeChannel();
  createHarmony({ db: house.db, channel, model });
  const sentTo = (phone: string) => channel.sent.filter((m) => m.toPhone === phone).map((m) => m.text);
  return { ...house, channel, sentTo };
}

const ANA = "+525500000001";
const ROSA = "+525500000002";
const ok = reply("Listo.", "otro");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("two deliveries running at once send a message once", async () => {
  const { db, channel, rosa, sentTo } = await setup(scriptedModel());
  const send = channel.send;
  channel.send = async (toPhone, text) => {
    await sleep(40);
    return send(toPhone, text);
  };
  await enqueue(db, rosa.id, "Uno");
  await Promise.all([deliverPending(db, channel), deliverPending(db, channel)]);
  assert.deepEqual(sentTo(ROSA), ["Uno"]);
  await db.close();
});

test("a send that never finishes is given up on and does not hold everything else", async () => {
  const { db, channel, rosa } = await setup(scriptedModel());
  channel.send = () => new Promise(() => {});
  await enqueue(db, rosa.id, "Uno");
  await deliverPending(db, channel, { sendTimeoutMs: 30 });
  const [row] = await db.query<{ sent: boolean; attempts: number; last_error: string }>(
    "SELECT sent_at IS NOT NULL AS sent, attempts, last_error FROM messages WHERE direction = 'out'",
  );
  assert.deepEqual(row, { sent: false, attempts: 1, last_error: "SEND_TIMEOUT" });
  await db.close();
});

const healthNoteFor = (request: Parameters<typeof idShown>[0], viewer: string) =>
  call("guardar_nota", {
    texto: "Leo toma su jarabe a las 8 de la noche.",
    de_salud: true,
    visible_para: "restringida",
    personas_que_la_ven: [idShown(request, "persona", viewer)],
    sobre: [],
  });

test("a yes that cannot be applied leaves the proposal open instead of using it up", async () => {
  const model = scriptedModel(
    (request) => [healthNoteFor(request, "Beto")],
    [ok],
    (request) => [call("dar_de_baja_persona", { persona: idShown(request, "persona", "Beto") })],
    [ok],
    (request) => [call("confirmar", { propuesta: idShown(request, "propuesta"), decision: "si" })],
    (request) => {
      assert.match(shownTo(request), /"is_error":true/);
      return [ok];
    },
  );
  const { db, channel } = await setup(model);
  await channel.receive(PHONES.ana, "Leo toma jarabe a las 8, que lo sepa Beto");
  await channel.receive(PHONES.ana, "Beto ya no trabaja aquí");
  await channel.receive(PHONES.ana, "Sí");
  assert.equal((await db.query("SELECT 1 FROM proposals WHERE resolved_at IS NULL")).length, 1);
  assert.ok(!(await eventKinds(db)).includes("confirmation_resolved"));
  await db.close();
});

test("a proposal nobody answered for a day can no longer be confirmed and is no longer shown", async () => {
  let proposal = "";
  const model = scriptedModel(
    (request) => [healthNoteFor(request, "Rosa")],
    (request) => {
      proposal = /propuesta ([0-9a-f-]{36})/.exec(shownTo(request))![1]!;
      return [ok];
    },
    (request) => {
      assert.doesNotMatch(request.system.map((b) => b.text).join("\n"), /\[propuesta /);
      return [call("confirmar", { propuesta: proposal, decision: "si" })];
    },
    (request) => {
      assert.match(shownTo(request), /"is_error":true/);
      return [ok];
    },
  );
  const { db, channel, ana } = await setup(model);
  await channel.receive(PHONES.ana, "Leo toma jarabe a las 8, que lo sepa Rosa");
  await db.query("UPDATE proposals SET created_at = now() - interval '25 hours'");
  await channel.receive(PHONES.ana, "Sí");
  assert.equal((await houseViewFor(db, ana)).notes.length, 2);
  const [row] = await db.query<{ outcome: string }>("SELECT outcome FROM proposals");
  assert.equal(row?.outcome, "expired");
  await db.close();
});

test("a number that belonged to someone who left starts a new person, with nothing inherited", async () => {
  const model = scriptedModel(
    [reply("Sí, al cacahuate.")],
    (request) => [call("dar_de_baja_persona", { persona: idShown(request, "persona", "Rosa") })],
    [ok],
    [call("registrar_persona", { nombre: "Lupita", tipo: "personal", telefono: PHONES.rosa })],
    [ok],
    (request) => {
      assert.doesNotMatch(shownTo(request), /cacahuate|alergias/);
      return [reply("Hola, Lupita.", "otro")];
    },
  );
  const { db, channel, rosa } = await setup(model);
  await channel.receive(PHONES.rosa, "¿Leo tiene alergias?");
  await channel.receive(PHONES.ana, "Rosa ya no trabaja aquí");
  await channel.receive(PHONES.ana, "Lupita entra en su lugar, mismo número");
  const lupita = await findPersonByPhone(db, PHONES.rosa);
  assert.equal(lupita?.name, "Lupita");
  assert.notEqual(lupita?.id, rosa.id);
  assert.ok((await houseViewFor(db, lupita!)).notes.every((note) => !note.health));
  await channel.receive(PHONES.rosa, "Hola");
  await db.close();
});

test("registering the number of someone in the house under another name waits for a yes", async () => {
  const model = scriptedModel([call("registrar_persona", { nombre: "Lupita", tipo: "personal", telefono: PHONES.rosa })], [ok]);
  const { db, channel } = await setup(model);
  await channel.receive(PHONES.ana, "Lupita es personal, su número es el de Rosa");
  assert.equal((await findPersonByPhone(db, PHONES.rosa))?.name, "Rosa");
  const [proposal] = await db.query<{ summary: string }>("SELECT summary FROM proposals WHERE resolved_at IS NULL");
  assert.match(proposal?.summary ?? "", /Rosa/);
  await db.close();
});

test("a note that is not of health cannot become one by correcting it", async () => {
  const model = scriptedModel(
    (request) => [
      call("corregir_nota", {
        nota: idShown(request, "nota", "basura"),
        texto: "La basura sale martes y viernes. Leo toma salbutamol dos veces al día.",
        de_salud: true,
      }),
    ],
    (request) => {
      assert.match(shownTo(request), /"is_error":true/);
      return [ok];
    },
  );
  const { db, channel, beto } = await setup(model);
  await channel.receive(PHONES.ana, "Agrega a lo de la basura que Leo toma salbutamol");
  assert.deepEqual((await houseViewFor(db, beto)).notes.map((n) => n.body), ["La basura sale martes y viernes."]);
  assert.equal((await db.query("SELECT 1 FROM proposals")).length, 0);
  await db.close();
});

test("when a turn fails after something was already done, the person is not told to try again", async () => {
  const model = scriptedModel([call("subir_pregunta", { pregunta: "¿Dónde van las sábanas?" })]);
  const { db, channel, sentTo } = await setup(model);
  await channel.receive(PHONES.rosa, "¿Dónde van las sábanas?");
  assert.equal(sentTo(ANA).length, 1);
  assert.doesNotMatch(sentTo(ROSA).at(-1)!, /intenta de nuevo/i);
  assert.match(sentTo(ROSA).at(-1)!, /no hace falta que lo repitas/i);
  await db.close();
});

test("a phone that is not a number, or an empty name, is refused before any proposal is made", async () => {
  const model = scriptedModel(
    [
      call("registrar_persona", { nombre: "Pablo", tipo: "lleva_la_casa", telefono: "55 1234" }),
      call("registrar_persona", { nombre: "  ", tipo: "personal", telefono: null }),
    ],
    (request) => {
      assert.equal(shownTo(request).match(/"is_error":true/g)?.length, 2);
      return [ok];
    },
  );
  const { db, channel } = await setup(model);
  await channel.receive(PHONES.ana, "Registra a Pablo");
  assert.equal((await db.query("SELECT 1 FROM proposals")).length, 0);
  assert.equal((await db.query("SELECT 1 FROM people")).length, 4);
  assert.ok(!(await eventKinds(db)).includes("error"));
  await db.close();
});

test("an answer with no text for who asked is refused before the question is used up", async () => {
  const model = scriptedModel(
    [call("subir_pregunta", { pregunta: "¿Dónde van las sábanas?" })],
    [ok],
    (request) => [
      call("responder_pendiente", {
        pregunta: idShown(request, "pregunta"),
        mensaje_para_quien_pregunto: " ",
        nota: { texto: "Las sábanas van en el clóset.", de_salud: false, visible_para: "todos", personas_que_la_ven: [], sobre: [] },
      }),
    ],
    (request) => {
      assert.match(shownTo(request), /"is_error":true/);
      return [ok];
    },
  );
  const { db, channel } = await setup(model);
  await channel.receive(PHONES.rosa, "¿Dónde van las sábanas?");
  await channel.receive(PHONES.ana, "En el clóset");
  assert.equal((await db.query("SELECT 1 FROM pending_questions WHERE answered_at IS NULL")).length, 1);
  assert.equal((await db.query("SELECT 1 FROM notes")).length, 2);
  await db.close();
});
