import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { InboundMessage } from "../src/channel.js";
import { createFakeChannel } from "../src/channels/fake.js";
import { createConsoleChannel, parseConsoleLine } from "../src/channels/console.js";

test("the fake channel hands an inbound message to the handler and records what is sent", async () => {
  const channel = createFakeChannel();
  const seen: InboundMessage[] = [];
  channel.onMessage(async (message) => {
    seen.push(message);
    await channel.send(message.fromPhone, "recibido");
  });
  await channel.receive("+5215500000002", "hola");
  assert.equal(seen[0]?.fromPhone, "+5215500000002");
  assert.equal(seen[0]?.text, "hola");
  assert.deepEqual(channel.sent.map((m) => [m.toPhone, m.text]), [["+5215500000002", "recibido"]]);
});

test("a console line is a phone followed by the text", () => {
  assert.deepEqual(parseConsoleLine("+5215500000002 ¿a qué hora come Leo?"), {
    phone: "+5215500000002",
    text: "¿a qué hora come Leo?",
  });
  assert.equal(parseConsoleLine("hola sin teléfono"), null);
  assert.equal(parseConsoleLine("   "), null);
});

test("the console channel reads lines as messages and prints what it sends", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk: Buffer) => (printed += chunk.toString()));
  const channel = createConsoleChannel({ input, output });
  const seen: InboundMessage[] = [];
  channel.onMessage(async (message) => {
    seen.push(message);
    await channel.send(message.fromPhone, "a las 2");
  });
  await channel.start();
  input.write("+5215500000002 ¿a qué hora come Leo?\n");
  input.end();
  await channel.finished;
  assert.equal(seen[0]?.text, "¿a qué hora come Leo?");
  assert.match(printed, /-> \+5215500000002 a las 2\n/);
});

test("a message that fails does not stop the console from handling the next one", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk: Buffer) => (printed += chunk.toString()));
  const channel = createConsoleChannel({ input, output });
  const handled: string[] = [];
  channel.onMessage(async (message) => {
    if (message.text === "falla") throw new Error("boom");
    handled.push(message.text);
  });
  await channel.start();
  input.write("+5215500000002 falla\n+5215500000002 sigue\n");
  input.end();
  await channel.finished;
  assert.deepEqual(handled, ["sigue"]);
  assert.match(printed, /!! .*boom/);
});

test("stopping a console channel that never started returns", async () => {
  await createConsoleChannel({ input: new PassThrough(), output: new PassThrough() }).stop();
});

test("a console line that is not a message goes to the command hook and its answer is printed", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk: Buffer) => (printed += chunk.toString()));
  const channel = createConsoleChannel({ input, output }, async (line) => (line === "registro" ? "Contestó sola: 3" : null));
  channel.onMessage(async () => {});
  await channel.start();
  input.write("registro\notra cosa\n");
  input.end();
  await channel.finished;
  assert.match(printed, /Contestó sola: 3\n/);
  assert.match(printed, /\?\? /);
});
