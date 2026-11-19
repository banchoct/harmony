import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createFakeChannel } from "../src/channels/fake.js";
import { createHarmony } from "../src/app.js";
import { findPersonByPhone } from "../src/people.js";
import { call, failOnStepErrors, reply, scriptedModel, shownTo, type ScriptedModel } from "./support/scripted-model.js";
import { houseWithNotes, PHONES } from "./support/house.js";

failOnStepErrors(afterEach);

const CARD = { contacts: [{ name: "Caro Ejemplo", phone: "+525500000004" }] };

async function setup(model: ScriptedModel) {
  const house = await houseWithNotes();
  const channel = createFakeChannel();
  createHarmony({ db: house.db, channel, model });
  return { ...house, channel };
}

test("a contact card from whoever runs the home is shown to the model with its name and number", async () => {
  const model = scriptedModel([reply("¿Caro trabaja en la casa o es de la familia?", "pregunta_de_aclaracion")]);
  const { db, channel } = await setup(model);
  await channel.receive(PHONES.ana, "", CARD);
  const shown = shownTo(model.requests[0]!);
  assert.match(shown, /tarjeta de contacto/);
  assert.match(shown, /Caro Ejemplo/);
  assert.match(shown, /\+525500000004/);
  await db.close();
});

test("the person on a shared card is registered with the card's number and can then write", async () => {
  const model = scriptedModel(
    [call("registrar_persona", { nombre: "Caro Ejemplo", tipo: "personal", telefono: "+525500000004" })],
    [reply("Listo, Caro ya puede escribirme.", "otro")],
    [reply("Hola, Caro.", "otro")],
  );
  const { db, channel } = await setup(model);
  await channel.receive(PHONES.ana, "Ella es Caro, la nueva cocinera", CARD);
  assert.equal((await findPersonByPhone(db, "+5215500000004"))?.name, "Caro Ejemplo");
  await channel.receive("+5215500000004", "Hola");
  assert.deepEqual(channel.sent.filter((m) => m.toPhone === "+525500000004").map((m) => m.text), ["Hola, Caro."]);
  await db.close();
});

test("a card without a usable number is said so to the model", async () => {
  const model = scriptedModel([reply("La tarjeta no trae un número que pueda usar.", "otro")]);
  const { db, channel } = await setup(model);
  await channel.receive(PHONES.ana, "", { contacts: [{ name: "Caro Ejemplo", phone: null }] });
  assert.match(shownTo(model.requests[0]!), /sin número/);
  await db.close();
});

test("staff sharing a card cannot register anyone: they are offered no tool for it", async () => {
  const model = scriptedModel([reply("Eso lo decide quien lleva la casa.", "otro")]);
  const { db, channel } = await setup(model);
  await channel.receive(PHONES.rosa, "", CARD);
  assert.ok(!model.requests[0]!.tools.some((t) => t.name === "registrar_persona"));
  assert.equal(await findPersonByPhone(db, "+5215500000004"), null);
  await db.close();
});
