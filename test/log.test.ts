import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createFakeChannel } from "../src/channels/fake.js";
import { createHarmony } from "../src/app.js";
import { formatSummary, logSummary } from "../src/log.js";
import { failOnStepErrors, call, idShown, reply, scriptedModel } from "./support/scripted-model.js";

failOnStepErrors(afterEach);
import { houseWithNotes, PHONES } from "./support/house.js";

const ok = reply("Listo.", "otro");

test("the log counts what Harmony answered alone, what it passed up and what it asked to confirm", async () => {
  const model = scriptedModel(
    // Rosa: one question answered from memory, one passed up, one thank-you.
    [reply("Martes y viernes.")],
    [call("subir_pregunta", { pregunta: "¿Dónde van las sábanas?" })],
    [reply("Ya pregunté.", "otro")],
    [reply("De nada.", "otro")],
    // Beto: one question passed up that stays unanswered.
    [call("subir_pregunta", { pregunta: "¿A qué hora llega el gas?" })],
    [reply("Ya pregunté.", "otro")],
    // Ana: answers Rosa's question, teaches a health fact (held), confirms it, is asked to clarify.
    (request) => [
      call("responder_pendiente", {
        pregunta: idShown(request, "pregunta", "sábanas"),
        mensaje_para_quien_pregunto: "En el clóset.",
        nota: { texto: "Las sábanas van en el clóset.", de_salud: false, visible_para: "todos", personas_que_la_ven: [], sobre: [] },
      }),
    ],
    [ok],
    [call("guardar_nota", { texto: "Leo toma jarabe a las 8.", de_salud: true, visible_para: "restringida", personas_que_la_ven: [], sobre: [] })],
    [reply("¿Lo guardo así?", "otro")],
    (request) => [call("confirmar", { propuesta: idShown(request, "propuesta"), decision: "si" })],
    [ok],
    [reply("¿Solo hoy o siempre?", "pregunta_de_aclaracion")],
  );
  const { db } = await houseWithNotes();
  const channel = createFakeChannel();
  createHarmony({ db, channel, model });
  for (const [phone, text] of [
    [PHONES.rosa, "¿Qué días sale la basura?"],
    [PHONES.rosa, "¿Dónde van las sábanas?"],
    [PHONES.rosa, "Gracias"],
    [PHONES.beto, "¿A qué hora llega el gas?"],
    [PHONES.ana, "Las sábanas van en el clóset"],
    [PHONES.ana, "Leo toma jarabe a las 8"],
    [PHONES.ana, "Sí"],
    [PHONES.ana, "Beto no viene"],
  ] as const) {
    await channel.receive(phone, text);
  }

  const summary = await logSummary(db);
  assert.deepEqual(summary, {
    answeredAlone: 1,
    escalated: 2,
    escalatedAnswered: 1,
    escalatedWaiting: 1,
    confirmationsAsked: 1,
    confirmationsYes: 1,
    confirmationsNo: 0,
    confirmationsWaiting: 0,
    clarificationsAsked: 1,
    taught: 1,
    corrected: 0,
    retired: 0,
    errors: 0,
    unclassifiedReplies: 0,
    inputTokens: 1300,
    cacheReadTokens: 2600,
    cacheWriteTokens: 0,
    outputTokens: 130,
    costUsd: 0.0083,
  });
  const text = formatSummary(summary);
  assert.match(text, /Contestó sola: 1/);
  assert.match(text, /Subió a quien lleva la casa: 2/);
  assert.match(text, /Costo: \$0\.01 USD/);
  await db.close();
});

test("the log can be limited to events since a moment", async () => {
  const model = scriptedModel([reply("Martes y viernes.")]);
  const house = await houseWithNotes();
  const channel = createFakeChannel();
  createHarmony({ db: house.db, channel, model });
  await channel.receive(PHONES.rosa, "¿Qué días sale la basura?");
  assert.equal((await logSummary(house.db)).answeredAlone, 1);
  assert.equal((await logSummary(house.db, new Date(Date.now() + 60_000))).answeredAlone, 0);
  await house.db.close();
});
