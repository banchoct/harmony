import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeChannel } from "../src/channels/fake.js";
import { createHarmony } from "../src/app.js";
import { eventKinds } from "../src/log.js";
import { houseViewFor } from "../src/memory.js";
import { call, idShown, reply, scriptedModel, shownTo, type ScriptedModel } from "./support/scripted-model.js";
import { houseWithNotes, PHONES } from "./support/house.js";

async function setup(model: ScriptedModel) {
  const house = await houseWithNotes();
  const channel = createFakeChannel();
  createHarmony({ db: house.db, channel, model });
  const sentTo = (phone: string) => channel.sent.filter((m) => m.toPhone === phone).map((m) => m.text);
  const notesFor = async (person: typeof house.ana) => (await houseViewFor(house.db, person)).notes.map((n) => n.body);
  return { ...house, channel, sentTo, notesFor };
}

const ROSA = "+525500000002";
const ok = reply("Listo.", "otro");
const note = (texto: string, extra: Record<string, unknown> = {}) =>
  call("guardar_nota", { texto, de_salud: false, visible_para: "todos", personas_que_la_ven: [], sobre: [], ...extra });

test("whoever runs the home is offered the tools to teach, correct and answer", async () => {
  const model = scriptedModel([ok]);
  const { db, channel } = await setup(model);
  await channel.receive(PHONES.ana, "Hola");
  assert.deepEqual(model.requests[0]!.tools.map((t) => t.name).sort(), [
    "confirmar",
    "corregir_nota",
    "dar_de_baja_persona",
    "guardar_nota",
    "registrar_persona",
    "responder",
    "responder_pendiente",
    "retirar_nota",
  ]);
  await db.close();
});

test("what whoever runs the home teaches is saved and staff then see it", async () => {
  const model = scriptedModel([note("Las sábanas de visitas van en el clóset del pasillo.")], [ok], [reply("En el clóset del pasillo.")]);
  const { db, channel, rosa, notesFor } = await setup(model);
  await channel.receive(PHONES.ana, "Las sábanas de visitas van en el clóset del pasillo");
  assert.ok((await notesFor(rosa)).includes("Las sábanas de visitas van en el clóset del pasillo."));
  assert.ok((await eventKinds(db)).includes("taught"));
  await channel.receive(PHONES.rosa, "¿Dónde van las sábanas de visitas?");
  assert.match(shownTo(model.requests[2]!), /clóset del pasillo/);
  await db.close();
});

test("a restricted note taught for one person is seen by that person only", async () => {
  const model = scriptedModel(
    (request) => [
      note("Rosa descansa los domingos.", {
        visible_para: "restringida",
        personas_que_la_ven: [idShown(request, "persona", "Rosa")],
        sobre: [idShown(request, "persona", "Rosa")],
      }),
    ],
    [ok],
  );
  const { db, channel, rosa, beto, notesFor } = await setup(model);
  await channel.receive(PHONES.ana, "Rosa descansa los domingos, eso solo le toca a ella");
  assert.ok((await notesFor(rosa)).includes("Rosa descansa los domingos."));
  assert.ok(!(await notesFor(beto)).includes("Rosa descansa los domingos."));
  await db.close();
});

test("a note is corrected in place", async () => {
  const model = scriptedModel(
    (request) => [call("corregir_nota", { nota: idShown(request, "nota", "basura"), texto: "La basura sale lunes y jueves." })],
    [ok],
  );
  const { db, channel, beto, notesFor } = await setup(model);
  await channel.receive(PHONES.ana, "No, la basura sale lunes y jueves");
  assert.deepEqual(await notesFor(beto), ["La basura sale lunes y jueves."]);
  assert.ok((await eventKinds(db)).includes("corrected"));
  await db.close();
});

test("a retired note leaves every view", async () => {
  const model = scriptedModel((request) => [call("retirar_nota", { nota: idShown(request, "nota", "basura") })], [ok]);
  const { db, channel, ana, beto, notesFor } = await setup(model);
  await channel.receive(PHONES.ana, "Olvida lo de la basura, ya no aplica");
  assert.deepEqual(await notesFor(beto), []);
  assert.deepEqual(await notesFor(ana), ["Leo es alérgico al cacahuate."]);
  assert.ok((await eventKinds(db)).includes("retired"));
  await db.close();
});

test("answered once: the answer to a question passed up reaches who asked and is kept", async () => {
  const model = scriptedModel(
    [call("subir_pregunta", { pregunta: "¿Dónde van las sábanas de visitas?" })],
    [reply("Ya le pregunté a Ana y te aviso.", "otro")],
    (request) => {
      assert.match(shownTo(request), /Rosa.*¿Dónde van las sábanas de visitas\?/);
      return [
        call("responder_pendiente", {
          pregunta: idShown(request, "pregunta"),
          mensaje_para_quien_pregunto: "Dice Ana que van en el clóset del pasillo.",
          nota: { texto: "Las sábanas de visitas van en el clóset del pasillo.", de_salud: false, visible_para: "todos", personas_que_la_ven: [], sobre: [] },
        }),
      ];
    },
    [ok],
    (request) => {
      assert.doesNotMatch(shownTo(request), /\[pregunta /);
      return [ok];
    },
  );
  const { db, channel, sentTo, beto, notesFor } = await setup(model);
  await channel.receive(PHONES.rosa, "¿Dónde guardo las sábanas de visitas?");
  await channel.receive(PHONES.ana, "En el clóset del pasillo");
  assert.equal(sentTo(ROSA).at(-1), "Dice Ana que van en el clóset del pasillo.");
  assert.ok((await notesFor(beto)).includes("Las sábanas de visitas van en el clóset del pasillo."));
  assert.ok((await eventKinds(db)).includes("question_answered"));
  await channel.receive(PHONES.ana, "Gracias");
  await db.close();
});

test("a question cannot be answered twice", async () => {
  let question = "";
  const answer = () =>
    call("responder_pendiente", {
      pregunta: question,
      mensaje_para_quien_pregunto: "En el clóset.",
      nota: { texto: "Las sábanas van en el clóset.", de_salud: false, visible_para: "todos", personas_que_la_ven: [], sobre: [] },
    });
  const model = scriptedModel(
    [call("subir_pregunta", { pregunta: "¿Dónde van las sábanas?" })],
    [ok],
    (request) => {
      question = idShown(request, "pregunta");
      return [answer()];
    },
    () => [answer()],
    (request) => {
      assert.match(shownTo(request), /"is_error":true/);
      return [ok];
    },
  );
  const { db, channel, sentTo } = await setup(model);
  await channel.receive(PHONES.rosa, "¿Dónde van las sábanas?");
  await channel.receive(PHONES.ana, "En el clóset");
  assert.equal(sentTo(ROSA).filter((m) => m === "En el clóset.").length, 1);
  assert.equal((await db.query("SELECT 1 FROM notes WHERE body = 'Las sábanas van en el clóset.'")).length, 1);
  await db.close();
});

const healthNote = (request: Parameters<typeof idShown>[0]) =>
  note("Leo toma su jarabe a las 8 de la noche.", {
    de_salud: true,
    visible_para: "restringida",
    personas_que_la_ven: [idShown(request, "persona", "Rosa")],
    sobre: [idShown(request, "persona", "Leo")],
  });

test("a health change is held as a proposal until whoever runs the home says yes", async () => {
  const model = scriptedModel(
    (request) => [healthNote(request)],
    [reply("Entendí: Leo toma su jarabe a las 8 pm y lo ve Rosa. ¿Lo guardo así?", "otro")],
    (request) => [call("confirmar", { propuesta: idShown(request, "propuesta"), decision: "si" })],
    [ok],
  );
  const { db, channel, ana, rosa, beto, notesFor } = await setup(model);
  await channel.receive(PHONES.ana, "Leo toma su jarabe a las 8 de la noche, que Rosa lo sepa");
  assert.ok(!(await notesFor(ana)).includes("Leo toma su jarabe a las 8 de la noche."));
  assert.ok((await eventKinds(db)).includes("confirmation_requested"));
  await channel.receive(PHONES.ana, "Sí");
  assert.ok((await notesFor(rosa)).includes("Leo toma su jarabe a las 8 de la noche."));
  assert.ok(!(await notesFor(beto)).includes("Leo toma su jarabe a las 8 de la noche."));
  const resolved = await db.query<{ data: { outcome: string } }>("SELECT data FROM events WHERE kind = 'confirmation_resolved'");
  assert.equal(resolved[0]?.data.outcome, "confirmed");
  await db.close();
});

test("a health proposal answered with no is dropped", async () => {
  const model = scriptedModel(
    (request) => [healthNote(request)],
    [ok],
    (request) => [call("confirmar", { propuesta: idShown(request, "propuesta"), decision: "no" })],
    [ok],
    (request) => {
      assert.doesNotMatch(shownTo(request), /\[propuesta /);
      return [ok];
    },
  );
  const { db, channel, ana, notesFor } = await setup(model);
  await channel.receive(PHONES.ana, "Leo toma su jarabe a las 8");
  await channel.receive(PHONES.ana, "No, espera");
  assert.ok(!(await notesFor(ana)).includes("Leo toma su jarabe a las 8 de la noche."));
  const resolved = await db.query<{ data: { outcome: string } }>("SELECT data FROM events WHERE kind = 'confirmation_resolved'");
  assert.equal(resolved[0]?.data.outcome, "rejected");
  await channel.receive(PHONES.ana, "Hola");
  await db.close();
});

test("correcting a health note also waits for a yes", async () => {
  const model = scriptedModel(
    (request) => [call("corregir_nota", { nota: idShown(request, "nota", "cacahuate"), texto: "Leo es alérgico a la nuez." })],
    [ok],
  );
  const { db, channel, ana, notesFor } = await setup(model);
  await channel.receive(PHONES.ana, "Leo es alérgico a la nuez, no al cacahuate");
  assert.ok((await notesFor(ana)).includes("Leo es alérgico al cacahuate."));
  assert.equal((await db.query("SELECT 1 FROM proposals WHERE resolved_at IS NULL")).length, 1);
  await db.close();
});

test("a health note for everyone is refused, not proposed", async () => {
  const model = scriptedModel(
    [note("Leo toma su jarabe a las 8.", { de_salud: true })],
    (request) => {
      assert.match(shownTo(request), /"is_error":true/);
      return [ok];
    },
  );
  const { db, channel } = await setup(model);
  await channel.receive(PHONES.ana, "Leo toma su jarabe a las 8");
  assert.equal((await db.query("SELECT 1 FROM proposals")).length, 0);
  await db.close();
});

test("a note or person that does not exist is refused and nothing changes", async () => {
  const missing = "00000000-0000-4000-8000-000000000000";
  const model = scriptedModel(
    [call("corregir_nota", { nota: missing, texto: "x" }), call("retirar_nota", { nota: "no-es-id" }), note("y", { sobre: [missing] })],
    (request) => {
      assert.equal(shownTo(request).match(/"is_error":true/g)?.length, 3);
      return [ok];
    },
  );
  const { db, channel, ana, notesFor } = await setup(model);
  await channel.receive(PHONES.ana, "Corrige eso");
  assert.equal((await notesFor(ana)).length, 2);
  await db.close();
});

test("a person registered by whoever runs the home is then identified by their phone", async () => {
  const model = scriptedModel(
    [call("registrar_persona", { nombre: "Caro", tipo: "personal", telefono: "+52 1 55 0000 0004" })],
    [ok],
    [reply("Hola, Caro.", "otro")],
  );
  const { db, channel, sentTo } = await setup(model);
  await channel.receive("+5215500000004", "Hola");
  assert.deepEqual(sentTo("+525500000004"), []);
  await channel.receive(PHONES.ana, "Caro empieza mañana, su número es 55 0000 0004");
  await channel.receive("+5215500000004", "Hola");
  assert.deepEqual(sentTo("+525500000004"), ["Hola, Caro."]);
  assert.ok((await eventKinds(db)).includes("person_registered"));
  await db.close();
});

test("a person who left the house is no longer answered or shown", async () => {
  const model = scriptedModel((request) => [call("dar_de_baja_persona", { persona: idShown(request, "persona", "Beto") })], [ok]);
  const { db, channel, ana, sentTo } = await setup(model);
  await channel.receive(PHONES.ana, "Beto ya no trabaja aquí");
  await channel.receive(PHONES.beto, "¿Leo tiene alergias?");
  assert.deepEqual(sentTo("+525500000003"), []);
  assert.ok(!(await houseViewFor(db, ana)).people.some((p) => p.name === "Beto"));
  assert.ok((await eventKinds(db)).includes("unknown_sender"));
  await db.close();
});

test("a reply written alongside another tool is held until the model has seen that tool's result", async () => {
  const model = scriptedModel(
    (request) => [healthNote(request), reply("Listo, guardado.", "otro")],
    (request) => {
      assert.match(shownTo(request), /propuesta/);
      return [reply("Entendí que Leo toma su jarabe a las 8 pm. ¿Lo guardo?", "otro")];
    },
  );
  const { db, channel, sentTo } = await setup(model);
  await channel.receive(PHONES.ana, "Leo toma su jarabe a las 8 de la noche");
  assert.deepEqual(sentTo("+525500000001"), ["Entendí que Leo toma su jarabe a las 8 pm. ¿Lo guardo?"]);
  await db.close();
});

test("nothing is sent to a person after they leave the house", async () => {
  const model = scriptedModel(
    [call("subir_pregunta", { pregunta: "¿Dónde van las sábanas?" })],
    [reply("Ya pregunté.", "otro")],
    (request) => [call("dar_de_baja_persona", { persona: idShown(request, "persona", "Rosa") })],
    [ok],
    (request) => [
      call("responder_pendiente", {
        pregunta: idShown(request, "pregunta"),
        mensaje_para_quien_pregunto: "En el clóset.",
        nota: { texto: "Las sábanas van en el clóset.", de_salud: false, visible_para: "todos", personas_que_la_ven: [], sobre: [] },
      }),
    ],
    [ok],
  );
  const { db, channel, sentTo } = await setup(model);
  await channel.receive(PHONES.rosa, "¿Dónde van las sábanas?");
  await channel.receive(PHONES.ana, "Rosa ya no trabaja aquí");
  await channel.receive(PHONES.ana, "Las sábanas van en el clóset");
  assert.deepEqual(sentTo(ROSA), ["Ya pregunté."]);
  await db.close();
});
