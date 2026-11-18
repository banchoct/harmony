import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createFakeChannel } from "../src/channels/fake.js";
import { createHarmony } from "../src/app.js";
import { eventKinds } from "../src/log.js";
import type { Transcriber } from "../src/voice.js";
import { failOnStepErrors, reply, scriptedModel, shownTo, type ScriptedModel } from "./support/scripted-model.js";

failOnStepErrors(afterEach);
import { houseWithNotes, PHONES } from "./support/house.js";

const ROSA = "+525500000002";
const note = { audio: { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg", seconds: 4 } };

function hearing(said: string | Error): Transcriber & { calls: number } {
  const transcriber = {
    calls: 0,
    async transcribe() {
      transcriber.calls += 1;
      if (said instanceof Error) throw said;
      return said;
    },
  };
  return transcriber;
}

async function setup(model: ScriptedModel, transcriber?: Transcriber) {
  const house = await houseWithNotes();
  const channel = createFakeChannel();
  createHarmony({ db: house.db, channel, model, transcriber });
  const sentTo = (phone: string) => channel.sent.filter((m) => m.toPhone === phone).map((m) => m.text);
  return { ...house, channel, sentTo };
}

test("a voice note is transcribed and answered like a written message", async () => {
  const model = scriptedModel([reply("Martes y viernes.")]);
  const { db, channel, sentTo } = await setup(model, hearing("¿Qué días sale la basura?"));
  await channel.receive(PHONES.rosa, "", note);
  assert.match(shownTo(model.requests[0]!), /¿Qué días sale la basura\?/);
  assert.deepEqual(sentTo(ROSA), ["Martes y viernes."]);
  const [stored] = await db.query<{ body: string }>("SELECT body FROM messages WHERE direction = 'in'");
  assert.equal(stored?.body, "¿Qué días sale la basura?");
  const [event] = await db.query<{ data: unknown }>("SELECT data FROM events WHERE kind = 'voice_note'");
  assert.deepEqual(event?.data, { seconds: 4, transcribed: true });
  await db.close();
});

test("a voice note from a number the house does not know is never transcribed", async () => {
  const transcriber = hearing("Soy Ana");
  const { db, channel } = await setup(scriptedModel(), transcriber);
  await channel.receive("+5215500000099", "", note);
  assert.equal(transcriber.calls, 0);
  assert.deepEqual(channel.sent, []);
  await db.close();
});

test("without a transcriber the person is asked to write instead", async () => {
  const model = scriptedModel();
  const { db, channel, sentTo } = await setup(model);
  await channel.receive(PHONES.rosa, "", note);
  assert.equal(model.requests.length, 0);
  assert.match(sentTo(ROSA)[0]!, /escrib/i);
  assert.ok((await eventKinds(db)).includes("voice_note"));
  await db.close();
});

test("a voice note that cannot be understood is not passed to the model", async () => {
  for (const said of [new Error("TRANSCRIBE_FAILED 500"), "[Música]"]) {
    const model = scriptedModel();
    const { db, channel, sentTo } = await setup(model, hearing(said));
    await channel.receive(PHONES.rosa, "", note);
    assert.equal(model.requests.length, 0);
    assert.match(sentTo(ROSA)[0]!, /no pude entender/i);
    const [event] = await db.query<{ data: { transcribed: boolean } }>("SELECT data FROM events WHERE kind = 'voice_note'");
    assert.equal(event?.data.transcribed, false);
    await db.close();
  }
});

test("a voice note that could not be downloaded or is too long gets a plain reply", async () => {
  for (const extra of [{ audioFailed: true }, { audioTooLarge: true }]) {
    const model = scriptedModel();
    const { db, channel, sentTo } = await setup(model, hearing("x"));
    await channel.receive(PHONES.rosa, "", extra);
    assert.equal(model.requests.length, 0);
    assert.equal(sentTo(ROSA).length, 1);
    await db.close();
  }
});

test("a file with no text is answered without the model: Harmony does not read files yet", async () => {
  const model = scriptedModel();
  const { db, channel, sentTo } = await setup(model);
  await channel.receive(PHONES.rosa, "", { attachment: { kind: "pdf", name: "aviso.pdf" } });
  assert.equal(model.requests.length, 0);
  assert.match(sentTo(ROSA)[0]!, /archivos/i);
  await db.close();
});

test("a file with a caption is handled as the caption, and the model is told a file came", async () => {
  const model = scriptedModel([reply("Martes y viernes.")]);
  const { db, channel } = await setup(model);
  await channel.receive(PHONES.rosa, "¿Qué días sale la basura?", { attachment: { kind: "foto", name: "foto" } });
  assert.match(shownTo(model.requests[0]!), /¿Qué días sale la basura\?/);
  assert.match(shownTo(model.requests[0]!), /no puede leer/);
  await db.close();
});

test("a message with nothing in it is ignored", async () => {
  const model = scriptedModel();
  const { db, channel } = await setup(model);
  await channel.receive(PHONES.rosa, "   ");
  assert.equal(model.requests.length, 0);
  assert.deepEqual(channel.sent, []);
  await db.close();
});

test("two messages arriving together are handled one after the other", async () => {
  const model = scriptedModel(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return [reply("Martes y viernes.")];
    },
    [reply("A las 7.")],
  );
  const { db, channel } = await setup(model);
  await Promise.all([
    channel.receive(PHONES.rosa, "¿Qué días sale la basura?"),
    channel.receive(PHONES.rosa, "¿Y a qué hora?"),
  ]);
  assert.match(shownTo(model.requests[1]!), /Martes y viernes\./);
  await db.close();
});

test("a message that could not be sent for a day is given up, not delivered late", async () => {
  const model = scriptedModel([reply("Martes y viernes.")], [reply("De nada.", "otro")]);
  const { db, channel, sentTo } = await setup(model);
  const send = channel.send;
  channel.send = async () => {
    throw new Error("CHANNEL_DOWN");
  };
  await channel.receive(PHONES.rosa, "¿Qué días sale la basura?");
  await db.query("UPDATE messages SET created_at = now() - interval '25 hours' WHERE direction = 'out'");
  channel.send = send;
  await channel.receive(PHONES.rosa, "Gracias");
  assert.deepEqual(sentTo(ROSA), ["De nada."]);
  assert.ok((await eventKinds(db)).includes("delivery_abandoned"));
  await db.close();
});
