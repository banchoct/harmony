import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { InboundMessage } from "../../src/channel.js";
import { describeBaileysMessage } from "../../src/whatsapp/baileys-message.js";
import { createBaileysChannel } from "../../src/whatsapp/baileys.js";
import {
  exceedsWhisperLimit,
  usableTranscript,
  WHISPER_MAX_BYTES,
} from "../../src/voice.js";

test("baileys voice notes are recognized", () => {
  assert.equal(
    describeBaileysMessage({
      audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true },
    }).audioMime,
    "audio/ogg",
  );
  assert.equal(
    describeBaileysMessage({ conversation: "hola" }).audioMime,
    null,
  );
  assert.equal(describeBaileysMessage({ conversation: "hola" }).text, "hola");
  const secretUrl = "https://mmg.whatsapp.net/nota-privada-8841";
  const ptt = describeBaileysMessage({
    pttMessage: { ptt: true, seconds: 4, url: secretUrl },
  });
  const audio = describeBaileysMessage({
    audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: 4, url: secretUrl },
  });
  assert.equal(ptt.audioMime, "audio/ogg");
  assert.equal(audio.audioMime, "audio/ogg");
  assert.equal(ptt.audio?.seconds, 4);
  assert.equal(JSON.stringify(ptt).includes(secretUrl), false);
  assert.equal(JSON.stringify(audio).includes(secretUrl), false);
  assert.equal(
    describeBaileysMessage({
      viewOnceMessage: {
        message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: 6 } },
      },
    }).audioMime,
    "audio/ogg",
  );
  assert.equal(
    describeBaileysMessage({
      viewOnceMessageV2: {
        message: { pttMessage: { seconds: 2 } },
      },
    }).audio?.seconds,
    2,
  );
  assert.equal(
    describeBaileysMessage({
      ephemeralMessage: {
        message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } },
      },
    }).audioMime,
    "audio/ogg",
  );
  assert.equal(
    describeBaileysMessage({
      documentWithCaptionMessage: {
        message: { audioMessage: { mimetype: "audio/ogg; codecs=opus" } },
      },
    }).audioMime,
    "audio/ogg",
  );
  assert.equal(
    describeBaileysMessage({
      documentWithCaptionMessage: {
        message: { documentMessage: { mimetype: "audio/mpeg", fileName: "nota.mp3" } },
      },
    }).audioMime,
    "audio/mpeg",
  );
  assert.equal(describeBaileysMessage({ conversation: "hola" }).audio, null);
});

test("noise and a whisper outro are not treated as what the person said", () => {
  for (const junk of ["[Música]", "Subtítulos realizados por la comunidad de Amara.org", "♪"]) {
    assert.equal(usableTranscript(junk), null, junk);
  }
  assert.equal(usableTranscript("sí"), "sí");
  assert.equal(usableTranscript("El mercado es el miércoles."), "El mercado es el miércoles.");
  assert.equal(usableTranscript("[Música de fondo]"), null);
});

test("un cierre de Whisper con puntuación no se usa como nota", () => {
  for (const junk of [
    "Gracias por ver el video",
    "Gracias por ver el video.",
    "¡Gracias por ver el video!",
    "Gracias por ver el video, suscríbete",
    "Thanks for watching.",
  ]) {
    assert.equal(usableTranscript(junk), null, junk);
  }
  assert.equal(
    usableTranscript("gracias, ya vi el video de la receta"),
    "gracias, ya vi el video de la receta",
  );
});

test("the whisper size limit is 25 MB, exclusive", () => {
  assert.equal(exceedsWhisperLimit(WHISPER_MAX_BYTES), false);
  assert.equal(exceedsWhisperLimit(WHISPER_MAX_BYTES + 1), true);
});

test("a ptt note is downloaded and delivered without logging the url", async () => {
  const secretUrl = "https://mmg.whatsapp.net/nota-privada-8841";
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((item) => String(item)).join(" "));
  };
  const boot = await openVoiceSocket(async () => Uint8Array.of(9, 8, 7));
  const received: InboundMessage[] = [];
  boot.channel.onMessage(async (message) => {
    received.push(message);
  });
  try {
    await boot.channel.start();
    await waitUntil(() => boot.channel.whatsapp.status().phase === "connected");
    boot.sock.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: { id: "ptt-1", remoteJid: "5215500000001@s.whatsapp.net" },
        message: {
          pttMessage: {
            ptt: true,
            seconds: 8,
            url: secretUrl,
            mimetype: "audio/ogg; codecs=opus",
          },
        },
      }],
    });
    await waitUntil(() => received.length > 0);
  } finally {
    console.log = original;
    await boot.channel.stop();
  }
  assert.equal(boot.downloaded, 1);
  assert.equal(received.length, 1);
  const note = received[0];
  assert.equal(note?.id, "ptt-1");
  assert.equal(note?.fromPhone, "+5215500000001");
  assert.equal(note?.text, "");
  assert.deepEqual(note?.audio?.bytes, Uint8Array.of(9, 8, 7));
  assert.equal(note?.audio?.mimeType, "audio/ogg");
  assert.equal(note?.audio?.seconds, 8);
  assert.equal(note?.audioSeconds, 8);
  assert.equal(note?.audioBytes, 3);
  assert.equal(note?.audioFailed, false);
  assert.equal(note?.audioTooLarge, undefined);
  assert.equal(JSON.stringify(note).includes(secretUrl), false);
  const channelLog = boot.chunks.join("");
  assert.equal(channelLog.includes(secretUrl), false);
  assert.equal(logs.join("\n").includes(secretUrl), false);
});

test("an oversized voice note is not downloaded", async () => {
  const boot = await openVoiceSocket(async () => {
    throw new Error("should not download");
  });
  const received: Array<{ audioTooLarge?: boolean; audio?: unknown }> = [];
  boot.channel.onMessage(async (message) => {
    received.push(message);
  });
  try {
    await boot.channel.start();
    await waitUntil(() => boot.channel.whatsapp.status().phase === "connected");
    boot.sock.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: { id: "big-1", remoteJid: "5215500000001@s.whatsapp.net" },
        message: {
          audioMessage: {
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
            seconds: 50,
            fileLength: WHISPER_MAX_BYTES + 1,
            url: "https://mmg.whatsapp.net/nota-grande-8841",
          },
        },
      }],
    });
    await waitUntil(() => received.length > 0);
  } finally {
    await boot.channel.stop();
  }
  assert.equal(boot.downloaded, 0);
  assert.equal(received[0]?.audioTooLarge, true);
  assert.equal(received[0]?.audio, undefined);
  assert.equal(boot.chunks.join("").includes("mmg.whatsapp.net"), false);
});

async function openVoiceSocket(download: () => Promise<Uint8Array>) {
  const dir = await mkdtemp(join(tmpdir(), "harmony-voice-"));
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const sockets: Array<{ emit(event: string, payload?: unknown): void }> = [];
  let downloaded = 0;
  const channel = createBaileysChannel({
    sessionDir: dir,
    output,
    reconnectDelayMs: 0,
    downloadAudio: async () => {
      downloaded += 1;
      return download();
    },
    loadBaileys: async () => ({
      default(config: Record<string, unknown>) {
        const creds = (config.auth as { creds: { registered?: boolean; me?: { id?: string }; account?: unknown } }).creds;
        creds.registered = true;
        creds.me = { id: "5215500000099:1@s.whatsapp.net" };
        creds.account = { details: "signed" };
        const listeners = new Map<string, Array<(payload?: unknown) => void>>();
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
          async sendMessage() {
            return { key: { id: "out" } };
          },
          emit(event: string, payload?: unknown) {
            for (const listener of listeners.get(event) ?? []) listener(payload);
          },
        };
        sockets.push(api);
        queueMicrotask(() => api.emit("connection.update", { connection: "open" }));
        return api;
      },
      async useMultiFileAuthState() {
        return { state: { creds: {} }, async saveCreds() {} };
      },
      async fetchLatestBaileysVersion() {
        return { version: [2, 3000, 102] };
      },
      DisconnectReason: { loggedOut: 401 },
    }),
  });
  return {
    channel,
    chunks,
    get sock() {
      const socket = sockets[0];
      if (!socket) throw new Error("missing socket");
      return socket;
    },
    get downloaded() {
      return downloaded;
    },
  };
}

async function waitUntil(ready: () => boolean): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 2000) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
