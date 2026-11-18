import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { createBaileysChannel } from "../../src/whatsapp/baileys.js";
import type { InboundMessage } from "../../src/channel.js";
import { samePhone } from "../../src/whatsapp/wa-phone.js";

const REPLY = "recibido";
const PHONE = "+5215500000001";
const LID = "155500000000001@lid";
const GROUP = "1203630287654321@g.us";

interface FakeCreds {
  registered?: boolean;
  me?: { id?: string };
  account?: unknown;
}

interface FakeSocket {
  sent: Array<{ jid: string; text: string }>;
  emit(event: string, payload?: unknown): void;
}

function textMessage(id: string, key: Record<string, unknown>, text: string) {
  return {
    key: { id, ...key },
    message: { conversation: text },
  };
}

function loadBaileys(
  run: (ctx: { sock: FakeSocket; index: number }) => void,
) {
  let count = 0;
  return async () => ({
    default(config: Record<string, unknown>) {
      count += 1;
      const index = count;
      const creds = (config.auth as { creds: FakeCreds }).creds;
      creds.registered = true;
      creds.me = { id: "5215500000099:1@s.whatsapp.net" };
      creds.account = { details: "signed" };
      const listeners = new Map<string, Array<(payload?: unknown) => void>>();
      const sent: Array<{ jid: string; text: string }> = [];
      const sock: FakeSocket = {
        sent,
        emit(event, payload) {
          for (const listener of listeners.get(event) ?? []) listener(payload);
        },
      };
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
        async sendMessage(jid: string, content: { text: string }) {
          sent.push({ jid, text: content.text });
          return { key: { id: `out-${sent.length}` } };
        },
      };
      queueMicrotask(() => run({ sock, index }));
      return api;
    },
    async useMultiFileAuthState() {
      return {
        state: { creds: {} as FakeCreds },
        async saveCreds() {},
      };
    },
    async fetchLatestBaileysVersion() {
      return { version: [2, 3000, 102] };
    },
    DisconnectReason: { loggedOut: 401 },
  });
}

async function boot(options?: {
  attach?: boolean;
  run?: (ctx: { sock: FakeSocket; index: number }) => void;
}) {
  const dir = await mkdtemp(join(tmpdir(), "harmony-in-"));
  const logs = capture();
  const sockets: FakeSocket[] = [];
  const received: InboundMessage[] = [];
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: loadBaileys(options?.run ?? ((ctx) => {
      sockets.push(ctx.sock);
      ctx.sock.emit("connection.update", { connection: "open" });
    })),
  });
  if (options?.attach !== false) {
    channel.onMessage(async (message) => {
      received.push(message);
      await channel.send(message.fromPhone, REPLY);
    });
  }
  await channel.start();
  await waitFor(() => channel.whatsapp.status().phase === "connected");
  return { channel, logs, sockets, received };
}

test("a direct message from a known coordinator gets a reply", async () => {
  const { channel, logs, sockets, received } = await boot();
  const sock = sockets[0];
  assert.ok(sock);
  try {
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("coord-1", {
        remoteJid: "5215500000001@s.whatsapp.net",
      }, "hey")],
    });
    await waitFor(() => sock.sent.length >= 1);
    const reply = sock.sent.find((item) => item.jid === "5215500000001@s.whatsapp.net");
    assert.ok(reply);
    assert.equal(reply.text, REPLY);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.id, "coord-1");
    assert.equal(received[0]?.fromPhone, PHONE);
    assert.equal(received[0]?.text, "hey");
    assert.match(logs.text(), /messages\.upsert tipo notify, 1 mensaje/);
    assert.match(logs.text(), /atiende un mensaje directo de …0001/);
    assert.equal(logs.text().includes("5215500000001"), false);
    assert.equal(logs.text().includes("hey"), false);
  } finally {
    await channel.stop();
  }
});

test("an @lid with remoteJidAlt is answered as that coordinator", async () => {
  const { channel, logs, sockets, received } = await boot();
  const sock = sockets[0];
  assert.ok(sock);
  try {
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("lid-alt", {
        remoteJid: LID,
        remoteJidAlt: "5215500000001@s.whatsapp.net",
      }, "hey")],
    });
    await waitFor(() => sock.sent.length >= 1);
    assert.equal(sock.sent[0]?.jid, LID);
    assert.equal(sock.sent[0]?.text, REPLY);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.fromPhone, PHONE);
    assert.equal(logs.text().includes("155500000000001"), false);
    assert.equal(logs.text().includes("hey"), false);
  } finally {
    await channel.stop();
  }
});

test("an @lid with senderPn is answered, and a later bare lid still is", async () => {
  const { channel, logs, sockets, received } = await boot();
  const sock = sockets[0];
  assert.ok(sock);
  try {
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("lid-pn", {
        remoteJid: LID,
        senderPn: "525500000001:14@s.whatsapp.net",
      }, "hola")],
    });
    await waitFor(() => sock.sent.length >= 1);
    assert.equal(sock.sent[0]?.jid, LID);
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("lid-otra", { remoteJid: LID }, "buenas")],
    });
    await waitFor(() => sock.sent.length >= 2);
    assert.equal(sock.sent[1]?.jid, LID);
    assert.equal(received.length, 2);
    assert.deepEqual(received.map((row) => row.id), ["lid-pn", "lid-otra"]);
    assert.equal(received.every((row) => row.fromPhone === "+525500000001"), true);
    assert.equal(received.every((row) => samePhone(row.fromPhone, PHONE)), true);
    assert.equal(logs.text().includes("525500000001"), false);
    assert.equal(logs.text().includes("155500000000001"), false);
  } finally {
    await channel.stop();
  }
});

test("a shared @lid is answered on the next message", async () => {
  const { channel, logs, sockets, received } = await boot();
  const sock = sockets[0];
  assert.ok(sock);
  try {
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("lid-antes", { remoteJid: LID }, "opaco")],
    });
    await flush();
    assert.equal(sock.sent.length, 0);
    assert.equal(received.length, 0);
    assert.match(logs.text(), /sin número \(@lid\)/);
    sock.emit("chats.phoneNumberShare", {
      lid: "155500000000001:14@lid",
      jid: "5215500000001@s.whatsapp.net",
    });
    assert.match(logs.text(), /asoció un @lid con …0001/);
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("lid-despues", { remoteJid: LID }, "hola")],
    });
    await waitFor(() => sock.sent.length >= 1);
    assert.equal(sock.sent[0]?.jid, LID);
    assert.deepEqual(received.map((row) => [row.id, row.fromPhone]), [["lid-despues", PHONE]]);
    assert.equal(logs.text().includes("5215500000001"), false);
    assert.equal(logs.text().includes("155500000000001"), false);
    assert.equal(logs.text().includes("opaco"), false);
  } finally {
    await channel.stop();
  }
});

test("a group, an unresolved lid and other rejects are logged and not answered", async () => {
  const { channel, logs, sockets, received } = await boot();
  const sock = sockets[0];
  assert.ok(sock);
  try {
    sock.emit("messages.upsert", {
      type: "append",
      messages: [{
        key: {
          id: "hist-1",
          remoteJid: "5215500000001@s.whatsapp.net",
        },
        message: {
          protocolMessage: {
            type: 5,
            historySyncNotification: { fileName: "texto-append" },
          },
        },
      }],
    });
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [
        textMessage("me-1", {
          fromMe: true,
          remoteJid: "5215500000001@s.whatsapp.net",
        }, "texto-propio"),
        textMessage("g-1", {
          remoteJid: GROUP,
          participantPn: "5215500000001@s.whatsapp.net",
        }, "texto-de-grupo-ajeno"),
        textMessage("lid-1", { remoteJid: LID }, "texto-lid-opaco"),
        {
          key: { remoteJid: "5215500000001@s.whatsapp.net" },
          message: { conversation: "texto-sin-id" },
        },
        {
          key: { id: "nojid" },
          message: { conversation: "texto-sin-jid" },
        },
      ],
    });
    sock.emit("messages.upsert", {
      type: "reaction",
      messages: [textMessage("rx-1", {
        remoteJid: "5215500000001@s.whatsapp.net",
      }, "texto-reaccion")],
    });
    sock.emit("messages.upsert", {
      type: "append",
      messages: [textMessage("lid-off", { remoteJid: LID }, "texto-lid-offline")],
    });
    await flush();
    assert.equal(sock.sent.length, 0);
    assert.equal(received.length, 0);
    const text = logs.text();
    assert.match(text, /messages\.upsert tipo append, 1 mensaje/);
    assert.match(text, /descartó un mensaje: historial/);
    assert.match(text, /tipo distinto de notify \(reaction\)/);
    assert.match(text, /sin número \(@lid\)/);
    assert.match(text, /descartó un mensaje: fromMe/);
    assert.match(text, /jid no soportado \(@g\.us\)/);
    assert.match(text, /sin número \(@lid\)/);
    assert.match(text, /descartó un mensaje: sin id/);
    assert.match(text, /descartó un mensaje: sin jid/);
    for (const secret of [
      "5215500000001",
      "1203630287654321",
      "155500000000001",
      "texto-append",
      "texto-reaccion",
      "texto-lid-offline",
      "texto-propio",
      "texto-de-grupo-ajeno",
      "texto-lid-opaco",
      "texto-sin-id",
      "texto-sin-jid",
    ]) {
      assert.equal(text.includes(secret), false, secret);
    }
  } finally {
    await channel.stop();
  }
});

test("an offline append from a known coordinator is handled once", async () => {
  const { channel, logs, sockets, received } = await boot();
  const sock = sockets[0];
  assert.ok(sock);
  try {
    sock.emit("messages.upsert", {
      type: "append",
      messages: [textMessage("off-1", {
        remoteJid: LID,
        senderPn: "5215500000001@s.whatsapp.net",
      }, "hey")],
    });
    await waitFor(() => sock.sent.length >= 1);
    assert.equal(sock.sent.length, 1);
    assert.equal(sock.sent[0]?.jid, LID);
    assert.equal(sock.sent[0]?.text, REPLY);
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("off-1", {
        remoteJid: "5215500000001@s.whatsapp.net",
      }, "hola")],
    });
    await flush();
    assert.equal(sock.sent.length, 1);
    assert.match(logs.text(), /id ya visto/);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.id, "off-1");
    assert.equal(received[0]?.fromPhone, PHONE);
    assert.equal(received[0]?.text, "hey");
    assert.equal(logs.text().includes("5215500000001"), false);
    assert.equal(logs.text().includes("155500000000001"), false);
  } finally {
    await channel.stop();
  }
});

test("an unregistered direct chat is still handled", async () => {
  const { channel, logs, sockets, received } = await boot();
  const sock = sockets[0];
  assert.ok(sock);
  try {
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("raro-1", {
        remoteJid: "5215500000098@s.whatsapp.net",
      }, "hola")],
    });
    await waitFor(() => sock.sent.length >= 1);
    assert.equal(sock.sent[0]?.jid, "5215500000098@s.whatsapp.net");
    assert.equal(sock.sent[0]?.text, REPLY);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.fromPhone, "+5215500000098");
    assert.equal(logs.text().includes("5215500000098"), false);
    assert.match(logs.text(), /…0098/);
  } finally {
    await channel.stop();
  }
});

test("an upsert with no handler is logged instead of vanishing", async () => {
  const { channel, logs, sockets } = await boot({ attach: false });
  const sock = sockets[0];
  assert.ok(sock);
  try {
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("solo-1", {
        remoteJid: "5215500000001@s.whatsapp.net",
      }, "hola")],
    });
    await flush();
    assert.equal(sock.sent.length, 0);
    assert.match(logs.text(), /messages\.upsert tipo notify, 1 mensaje/);
    assert.match(logs.text(), /descartó un mensaje: sin manejador/);
    assert.equal(logs.text().includes("hola"), false);
  } finally {
    await channel.stop();
  }
});

test("after the 515 restart the new socket answers and the old one is logged", async () => {
  const sockets: FakeSocket[] = [];
  const { channel, logs, received } = await boot({
    run({ sock, index }) {
      sockets.push(sock);
      if (index === 1) {
        sock.emit("connection.update", { isNewLogin: true });
        sock.emit("connection.update", {
          connection: "close",
          lastDisconnect: { error: { output: { statusCode: 515 } } },
        });
        return;
      }
      sock.emit("connection.update", { connection: "open" });
    },
  });
  const stale = sockets[0];
  const live = sockets[1];
  assert.ok(stale);
  assert.ok(live);
  try {
    stale.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("viejo-1", {
        remoteJid: "5215500000001@s.whatsapp.net",
      }, "hola")],
    });
    await flush();
    assert.equal(stale.sent.length, 0);
    assert.equal(live.sent.length, 0);
    assert.equal(received.length, 0);
    assert.match(logs.text(), /sesión reemplazada tipo notify, 1 mensaje/);
    live.emit("messages.upsert", {
      type: "notify",
      messages: [textMessage("nuevo-1", {
        remoteJid: "5215500000001@s.whatsapp.net",
      }, "hey")],
    });
    await waitFor(() => live.sent.length >= 1);
    assert.equal(live.sent[0]?.jid, "5215500000001@s.whatsapp.net");
    assert.equal(live.sent[0]?.text, REPLY);
    assert.deepEqual(received.map((row) => row.id), ["nuevo-1"]);
    assert.equal(logs.text().includes("5215500000001"), false);
  } finally {
    await channel.stop();
  }
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
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
