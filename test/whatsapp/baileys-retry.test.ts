import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import {
  createBaileysChannel,
  createMemoryCache,
  flushSignalRepeats,
  installSignalLogFilter,
} from "../../src/whatsapp/baileys.js";

const PHONE = "+5215500000001";
const PHONE_JID = "5215500000001@s.whatsapp.net";

interface FakeCreds {
  registered?: boolean;
  me?: { id?: string };
  account?: unknown;
}

interface Opened {
  config: Record<string, unknown>;
  emit(event: string, payload?: unknown): void;
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "harmony-retry-"));
  const logs = capture();
  const opened: Opened[] = [];
  const inbound: string[] = [];
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: async () => ({
      default(config: Record<string, unknown>) {
        const creds = (config.auth as { creds: FakeCreds }).creds;
        creds.registered = true;
        creds.me = { id: "5215500000099:1@s.whatsapp.net" };
        creds.account = { details: "signed" };
        const listeners = new Map<string, Array<(payload?: unknown) => void>>();
        const sock: Opened = {
          config,
          emit(event, payload) {
            for (const listener of listeners.get(event) ?? []) listener(payload);
          },
        };
        opened.push(sock);
        let sent = 0;
        const api = {
          ev: {
            on(event: string, listener: (payload?: unknown) => void) {
              const list = listeners.get(event) ?? [];
              list.push(listener);
              listeners.set(event, list);
            },
          },
          end() {},
          async requestPairingCode() {
            return "ABCD2345";
          },
          async assertSessions() {},
          async sendMessage(_jid: string, content: { text: string }) {
            sent += 1;
            return {
              key: { id: `out-${opened.length}-${sent}` },
              message: { conversation: content.text },
            };
          },
        };
        queueMicrotask(() => sock.emit("connection.update", { connection: "open" }));
        return api;
      },
      async useMultiFileAuthState() {
        return { state: { creds: {} as FakeCreds }, async saveCreds() {} };
      },
      async fetchLatestBaileysVersion() {
        return { version: [2, 3000, 102] };
      },
      DisconnectReason: { loggedOut: 401 },
    }),
  });
  channel.onMessage(async (message) => {
    inbound.push(message.text);
  });
  await channel.start();
  await waitFor(() => channel.whatsapp.status().phase === "connected");
  const last = () => {
    const sock = opened.at(-1);
    if (!sock) throw new Error("no socket");
    return sock;
  };
  return {
    channel,
    logs,
    opened,
    inbound,
    last,
    upsert(messages: unknown[]) {
      last().emit("messages.upsert", { type: "notify", messages });
    },
  };
}

test("a retry receipt gets back the body Harmony sent, even after a reconnect", async () => {
  const h = await harness();
  const sent = await h.channel.send(PHONE, "la comida es a las dos");
  const first = h.last().config;
  const getMessage = first.getMessage as (key: { id?: string }) => Promise<unknown>;
  assert.deepEqual(await getMessage({ id: sent.id }), { conversation: "la comida es a las dos" });
  assert.equal(await getMessage({ id: "otro" }), undefined);

  h.last().emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 428 } } },
  });
  await waitFor(() => h.opened.length === 2 && h.channel.whatsapp.status().phase === "connected");
  const second = h.last().config;
  assert.equal(second.msgRetryCounterCache, first.msgRetryCounterCache);
  const again = second.getMessage as (key: { id?: string }) => Promise<unknown>;
  assert.deepEqual(await again({ id: sent.id }), { conversation: "la comida es a las dos" });
  await h.channel.stop();
});

test("an undecryptable fromMe is named as another device of the number, once per socket", async () => {
  const h = await harness();
  const ciphertext = (id: string) => ({
    key: { id, fromMe: true, remoteJid: PHONE_JID },
    messageStubType: 2,
    message: null,
  });
  h.upsert([ciphertext("m1"), ciphertext("m2")]);
  h.upsert([{ key: { id: "m3", fromMe: true, remoteJid: PHONE_JID }, message: { conversation: "eco" } }]);
  await waitFor(() => h.logs.text().includes("descartó un mensaje: fromMe."));
  const text = h.logs.text();
  assert.equal(count(text, "escrito desde otro dispositivo del número a …0001"), 2);
  assert.equal(count(text, "WHATSAPP_FROMME_SIN_DESCIFRAR"), 1);
  assert.doesNotMatch(text, /5215500000001/);
  assert.deepEqual(h.inbound, []);
  await h.channel.stop();
});

test("three undecryptable messages in a row from a person are flagged, and a readable one resets", async () => {
  const h = await harness();
  const ciphertext = (id: string) => ({
    key: { id, remoteJid: PHONE_JID },
    messageStubType: 2,
    message: null,
  });
  h.upsert([ciphertext("c1"), ciphertext("c2")]);
  await waitFor(() => count(h.logs.text(), "no pudo descifrar un mensaje") === 2);
  h.upsert([{ key: { id: "ok1", remoteJid: PHONE_JID }, message: { conversation: "hola" } }]);
  await waitFor(() => h.inbound.length === 1);
  h.upsert([ciphertext("c3"), ciphertext("c4")]);
  await waitFor(() => count(h.logs.text(), "no pudo descifrar un mensaje") === 4);
  assert.equal(count(h.logs.text(), "WHATSAPP_DECRYPT_STREAK"), 0);
  h.upsert([ciphertext("c5"), ciphertext("c6")]);
  await waitFor(() => count(h.logs.text(), "no pudo descifrar un mensaje") === 6);
  const text = h.logs.text();
  assert.equal(count(text, "WHATSAPP_DECRYPT_STREAK …0001: 3 mensajes seguidos sin descifrar."), 1);
  assert.deepEqual(h.inbound, ["hola"]);
  await h.channel.stop();
});

test("a repeated libsignal decrypt error prints once a minute, then as a count", () => {
  const seen: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => {
    seen.push(args.map((item) => String(item)).join(" "));
  };
  installSignalLogFilter(true);
  try {
    for (let index = 0; index < 5; index += 1) {
      console.error("Failed to decrypt message with any known session...");
      console.error(
        "Session error:SessionError: Over 2000 messages into the future!",
        "SessionError: Over 2000 messages into the future!\n    at SessionCipher.fillMessageKeys",
      );
    }
    console.error("algo distinto");
    assert.deepEqual(seen, [
      "Failed to decrypt message with any known session...",
      "Session error:SessionError: Over 2000 messages into the future!",
      "algo distinto",
    ]);
    flushSignalRepeats();
    assert.deepEqual(seen.slice(3), [
      "libsignal repitió 4 veces en el último minuto: Failed to decrypt message with any known session...",
      "libsignal repitió 4 veces en el último minuto: Session error:SessionError: Over 2000 messages into the future!",
    ]);
    console.error("Session error:Error: Bad MAC");
    assert.equal(seen.at(-1), "Session error:Error: Bad MAC");
    flushSignalRepeats();
    assert.equal(seen.length, 6);
  } finally {
    console.error = error;
  }
});

test("the retry cache drops the oldest key and expires old entries", () => {
  let now = 0;
  const cache = createMemoryCache(2, 1000, () => now);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  now = 1000;
  assert.equal(cache.get("c"), undefined);
  cache.set("d", 4);
  cache.del("d");
  assert.equal(cache.get("d"), undefined);
  cache.set("e", 5);
  cache.flushAll();
  assert.equal(cache.get("e"), undefined);
});

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function capture(): { output: Writable; text: () => string } {
  let body = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      body += String(chunk);
      done();
    },
  });
  return { output, text: () => body };
}
