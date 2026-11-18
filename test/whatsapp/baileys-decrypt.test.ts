import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { inspect } from "node:util";
import { createBaileysChannel, installSignalLogFilter } from "../../src/whatsapp/baileys.js";
import type { InboundMessage } from "../../src/channel.js";

const REPLY = "recibido";
const PHONE = "+5215500000001";
const LID = "155500000000001@lid";

interface FakeCreds {
  registered?: boolean;
  me?: { id?: string };
  account?: unknown;
}

interface AuthKeys {
  set(data: { [category: string]: { [id: string]: unknown } }): Promise<void>;
}

interface FakeSocket {
  sent: Array<{ jid: string; text: string }>;
  emit(event: string, payload?: unknown): void;
}

function openSocket(sockets: FakeSocket[]) {
  return ({ sock }: { sock: FakeSocket }) => {
    sockets.push(sock);
    sock.emit("connection.update", { connection: "open" });
  };
}

function loadBaileys(run: (ctx: { sock: FakeSocket; index: number }) => void) {
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

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "harmony-mac-"));
  const logs = capture();
  const sockets: FakeSocket[] = [];
  const received: InboundMessage[] = [];
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: loadBaileys(openSocket(sockets)),
  });
  channel.onMessage(async (message) => {
    received.push(message);
    await channel.send(message.fromPhone, REPLY);
  });
  await channel.start();
  await waitFor(() => channel.whatsapp.status().phase === "connected");
  return { channel, logs, sockets, received, dir };
}

test("a ciphertext stub is not stored as empty text and the same id can still be read", async () => {
  const { channel, logs, sockets, received, dir } = await boot();
  const sock = sockets[0];
  assert.ok(sock);
  const lidSession = join(dir, "session-155500000000001.0.json");
  const phoneSession = join(dir, "session-5215500000001.0.json");
  const otherSession = join(dir, "session-14155552671.0.json");
  const creds = join(dir, "creds.json");
  await writeFile(lidSession, "{}");
  await writeFile(phoneSession, "{}");
  await writeFile(otherSession, "{}");
  await writeFile(creds, "{\"keep\":true}");
  try {
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: {
          id: "mac-1",
          remoteJid: LID,
          senderPn: "5215500000001@s.whatsapp.net",
        },
        messageStubType: 2,
        messageStubParameters: ["No matching sessions found for message"],
        message: null,
      }],
    });
    await waitFor(() => logs.text().includes("pedirá una sesión nueva"));
    assert.equal(sock.sent.length, 0);
    assert.equal(received.length, 0);
    assert.match(logs.text(), /no pudo descifrar un mensaje/);
    assert.match(logs.text(), /No se registró como texto vacío/);
    await access(lidSession);
    await access(phoneSession);
    await access(otherSession);
    await access(creds);
    assert.equal(logs.text().includes("5215500000001"), false);
    assert.equal(logs.text().includes("155500000000001"), false);
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: {
          id: "mac-1",
          remoteJid: "5215500000001@s.whatsapp.net",
        },
        message: { conversation: "hola" },
      }],
    });
    await waitFor(() => sock.sent.length >= 1);
    assert.equal(sock.sent[0]?.jid, "5215500000001@s.whatsapp.net");
    assert.equal(sock.sent[0]?.text, REPLY);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.id, "mac-1");
    assert.equal(received[0]?.text, "hola");
    assert.equal(received[0]?.fromPhone, PHONE);
  } finally {
    await channel.stop();
  }
});

test("a real empty text is delivered as empty text, not a decrypt failure", async () => {
  const { channel, logs, sockets, received } = await boot();
  const sock = sockets[0];
  assert.ok(sock);
  try {
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: { id: "vacio-1", remoteJid: "5215500000001@s.whatsapp.net" },
        message: { conversation: "" },
      }],
    });
    await waitFor(() => sock.sent.length >= 1);
    assert.equal(sock.sent[0]?.jid, "5215500000001@s.whatsapp.net");
    assert.equal(received.length, 1);
    assert.equal(received[0]?.id, "vacio-1");
    assert.equal(received[0]?.text, "");
    assert.equal(received[0]?.fromPhone, PHONE);
    assert.equal(logs.text().includes("no pudo descifrar"), false);
  } finally {
    await channel.stop();
  }
});

test("inbound @lid is answered on that lid, and a failed decrypt opens the next send", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-lid-send-"));
  const logs = capture();
  const sent: Array<{ jid: string; text: string; session: string; opens: boolean }> = [];
  const bundles: Array<{ jid: string; force: boolean }> = [];
  let session = "stale";
  let phoneAccepts: string | null = null;
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: scriptedSocket({
      async assertSessions(jids, force) {
        bundles.push({ jid: jids[0] ?? "", force });
        if (force) {
          session = "fresh";
          phoneAccepts = "fresh";
        }
      },
      async sendMessage(jid, content) {
        sent.push({
          jid,
          text: content.text,
          session,
          opens: session === phoneAccepts,
        });
        return { key: { id: `out-${sent.length}` } };
      },
      open(sock) {
        sock.emit("connection.update", { connection: "open" });
      },
    }),
  });
  channel.onMessage(async () => undefined);
  try {
    await channel.start();
    await waitFor(() => channel.whatsapp.status().phase === "connected");
    const sock = lastSocket();
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: {
          id: "lid-mac",
          remoteJid: "155500000000001:14@lid",
          senderPn: "5215500000001@s.whatsapp.net",
        },
        messageStubType: 2,
        message: null,
      }],
    });
    await waitFor(() => logs.text().includes("pedirá una sesión nueva"));
    await channel.send("+5215500000001", "respuesta");
    assert.equal(sent[0]?.jid, "155500000000001@lid");
    assert.notEqual(sent[0]?.jid, "5215500000001@s.whatsapp.net");
    assert.equal(bundles[0]?.force, true);
    assert.equal(bundles[0]?.jid, "155500000000001@lid");
    assert.equal(sent[0]?.session, "fresh");
    assert.equal(sent[0]?.opens, true);
    await channel.send("+525500000001", "segunda");
    assert.equal(sent[1]?.jid, "155500000000001@lid");
    assert.equal(bundles[1]?.force, false);
    assert.equal(sent[1]?.opens, true);
    await channel.send("+14155552671", "otro chat");
    assert.equal(sent[2]?.jid, "14155552671@s.whatsapp.net");
    assert.match(logs.text(), /no tiene el jid de ese chat. Se envía a …2671/);
    assert.equal(logs.text().includes("14155552671"), false);
    assert.equal(logs.text().includes("155500000000001"), false);
  } finally {
    await channel.stop();
  }
});

test("inbound on a phone jid is answered on that same jid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-pn-send-"));
  const logs = capture();
  const sent: string[] = [];
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: scriptedSocket({
      async assertSessions() {},
      async sendMessage(jid) {
        sent.push(jid);
        return { key: { id: "out" } };
      },
      open(sock) {
        sock.emit("connection.update", { connection: "open" });
      },
    }),
  });
  channel.onMessage(async (message) => {
    await channel.send(message.fromPhone, "eco");
  });
  try {
    await channel.start();
    await waitFor(() => channel.whatsapp.status().phase === "connected");
    lastSocket().emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: { id: "pn-1", remoteJid: "5215500000001@s.whatsapp.net" },
        message: { conversation: "hola" },
      }],
    });
    await waitFor(() => sent.length >= 1);
    assert.equal(sent[0], "5215500000001@s.whatsapp.net");
  } finally {
    await channel.stop();
  }
});

test("a bundle failure does not send a message the phone cannot open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-bundle-"));
  const logs = capture();
  let sent = 0;
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: scriptedSocket({
      async assertSessions() {
        throw new Error("bundle");
      },
      async sendMessage() {
        sent += 1;
        return { key: { id: "out" } };
      },
      open(sock) {
        sock.emit("connection.update", { connection: "open" });
      },
    }),
  });
  try {
    await channel.start();
    await waitFor(() => channel.whatsapp.status().phase === "connected");
    await assert.rejects(
      channel.send("+5215500000001", "hola"),
      /SIGNAL_SESSION_UNAVAILABLE/,
    );
    assert.equal(sent, 0);
    assert.match(logs.text(), /No se envió/);
    assert.match(logs.text(), /…0001/);
    assert.equal(logs.text().includes("5215500000001"), false);
  } finally {
    await channel.stop();
  }
});

test("a free-text log that mentions privKey is kept whole", () => {
  const seen = captureFilteredConsole(() => {
    console.info("revisa privKey en el cajón");
    console.info("nota", { area: "cocina" });
    console.info("muestra", Buffer.from("0123456789abcdef"));
  });
  const blob = seen.join("\n");
  assert.match(blob, /revisa privKey en el cajón/);
  assert.match(blob, /cocina/);
  assert.match(blob, /muestra/);
});

test("a SessionEntry dump is dropped and a normal object is not", () => {
  class SessionEntry {
    indexInfo = { closed: -1, baseKey: "fixture-base" };
    _chains = { chain: { count: 1 } };
    currentRatchet = { counter: 0 };
  }
  const seen = captureFilteredConsole(() => {
    for (const method of ["log", "info", "warn", "debug"] as const) {
      console[method]("Opening session:", new SessionEntry());
    }
    console.info("turno", { area: "cocina", nota: "limpia" });
  });
  const blob = seen.join("\n");
  assert.equal(blob.includes("Opening session"), false);
  assert.equal(blob.includes("fixture-base"), false);
  assert.match(blob, /cocina/);
});

test("a libsignal session line plus a record shape is dropped without the class name", () => {
  const record = {
    indexInfo: { closed: -1 },
    _chains: { chain: { count: 1 } },
    currentRatchet: { counter: 0 },
  };
  assert.notEqual(record.constructor.name, "SessionEntry");
  const seen = captureFilteredConsole(() => {
    for (const line of [
      "Session already closed",
      "Closing session:",
      "Opening session:",
      "Removing old closed session:",
    ]) {
      console.info(line, record);
    }
    console.info("Closing session:", { indexInfo: { closed: -1 } });
    console.info("Closing session: revisa privKey en el cajón");
    console.info("revisa privKey en el cajón", record);
  });
  assert.deepEqual(seen.map((line) => line.includes("_chains")), [false, false, true]);
  assert.match(seen[0] ?? "", /^Closing session: /);
  assert.equal((seen[0] ?? "").includes("_chains"), false);
  assert.equal(seen[1], "Closing session: revisa privKey en el cajón");
  assert.match(seen[2] ?? "", /revisa privKey en el cajón/);
  assert.equal(seen.some((line) => line.startsWith("Opening session:")), false);
  assert.equal(seen.some((line) => line.startsWith("Session already closed")), false);
  assert.equal(seen.some((line) => line.startsWith("Removing old closed session:")), false);
});

test("libsignal session dumps stay out of the log and Bad MAC stays", () => {
  const seen: string[] = [];
  const info = console.info;
  const error = console.error;
  console.info = (...args: unknown[]) => {
    seen.push(inspect(args, { depth: 5, maxArrayLength: 8 }));
  };
  console.error = (...args: unknown[]) => {
    seen.push(args.map((item) => String(item)).join(" "));
  };
  installSignalLogFilter(true);
  class SessionEntry {
    indexInfo = {
      privKey: Buffer.from("0123456789abcdef"),
      rootKey: Buffer.alloc(32, 1),
      remoteIdentityKey: Buffer.alloc(32, 2),
    };
    _chains = { chain: { count: 1 } };
    currentRatchet = { counter: 0 };
  }
  try {
    console.info("Closing session:", new SessionEntry());
    console.error("Failed to decrypt message with any known session...");
    console.error("Session error:Error: Bad MAC");
    const blob = seen.join("\n");
    assert.equal(blob.includes("privKey"), false);
    assert.equal(blob.includes("rootKey"), false);
    assert.equal(/<Buffer [0-9a-f]{2}/i.test(blob), false);
    assert.match(blob, /Failed to decrypt message with any known session/);
    assert.match(blob, /Bad MAC/);
  } finally {
    console.info = info;
    console.error = error;
  }
});

test("a dirty chat forces a bundle inside the 60s window", async () => {
  const harness = await bundleHarness();
  const original = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    await harness.channel.send(PHONE, "primero");
    harness.ciphertext("ct-reciente");
    assert.match(harness.logs.text(), /pedirá una sesión nueva/);
    now += 1_000;
    await harness.channel.send(PHONE, "segundo");
    assert.deepEqual(harness.forces, [true, true]);
  } finally {
    Date.now = original;
    await harness.channel.stop();
  }
});

test("a clean chat does not force again inside the 60s window", async () => {
  const harness = await bundleHarness();
  const original = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    await harness.channel.send(PHONE, "primero");
    now += 59_000;
    await harness.channel.send(PHONE, "segundo");
    assert.deepEqual(harness.forces, [true, false]);
  } finally {
    Date.now = original;
    await harness.channel.stop();
  }
});

test("a clean chat forces again once the 60s window has passed", async () => {
  const harness = await bundleHarness();
  const original = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    await harness.channel.send(PHONE, "primero");
    now += 63_000;
    await harness.channel.send(PHONE, "segundo");
    now += 1_000;
    await harness.channel.send(PHONE, "tercero");
    assert.deepEqual(harness.forces, [true, true, false]);
  } finally {
    Date.now = original;
    await harness.channel.stop();
  }
});

test("eight sends with two ciphertexts force three bundles", async () => {
  const harness = await bundleHarness();
  const original = Date.now;
  const started = 1_700_000_000_000;
  Date.now = () => started;
  try {
    await harness.channel.send(PHONE, "uno");
    await harness.channel.send(PHONE, "dos");
    await harness.channel.send(PHONE, "tres");
    harness.ciphertext("ct-1");
    await harness.channel.send(PHONE, "cuatro");
    await harness.channel.send(PHONE, "cinco");
    await harness.channel.send(PHONE, "seis");
    harness.ciphertext("ct-2");
    await harness.channel.send(PHONE, "siete");
    await harness.channel.send(PHONE, "ocho");
    assert.deepEqual(
      harness.forces,
      [true, false, false, true, false, false, true, false],
    );
  } finally {
    Date.now = original;
    await harness.channel.stop();
  }
});

test("the next socket waits until the previous signal write has landed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-keys-"));
  const logs = capture();
  const sockets: FakeSocket[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writing = false;
  let sawSecond = false;
  let secondAfterWrite = false;
  let keys: AuthKeys | null = null;
  let loads = 0;
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
        const sent: Array<{ jid: string; text: string }> = [];
        const sock: FakeSocket = {
          sent,
          emit(event, payload) {
            for (const listener of listeners.get(event) ?? []) listener(payload);
          },
        };
        sockets.push(sock);
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
            return { key: { id: "out" } };
          },
        };
        queueMicrotask(() => sock.emit("connection.update", { connection: "open" }));
        return api;
      },
      async useMultiFileAuthState() {
        loads += 1;
        const own = loads;
        if (own > 1) {
          sawSecond = true;
          secondAfterWrite = !writing;
        }
        const store: AuthKeys = {
          async set() {
            if (own !== 1) return;
            writing = true;
            await gate;
            writing = false;
          },
        };
        if (own === 1) keys = store;
        return {
          state: {
            creds: {
              registered: true,
              me: { id: "5215500000099:1@s.whatsapp.net" },
              account: { details: "signed" },
            } as FakeCreds,
            keys: store,
          },
          async saveCreds() {},
        };
      },
      async fetchLatestBaileysVersion() {
        return { version: [2, 3000, 102] };
      },
      DisconnectReason: { loggedOut: 401 },
    }),
  });
  try {
    await channel.start();
    await waitFor(() => channel.whatsapp.status().phase === "connected");
    const pending = keys!.set({ session: { "155500000000001.0": { stub: true } } });
    sockets[0]?.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(sawSecond, false);
    release();
    await pending;
    await waitFor(() => sawSecond && channel.whatsapp.status().phase === "connected");
    assert.equal(secondAfterWrite, true);
    assert.equal(logs.text().includes("155500000000001"), false);
  } finally {
    release();
    await channel.stop();
  }
});

const held: FakeSocket[] = [];

function lastSocket(): FakeSocket {
  const sock = held.at(-1);
  if (!sock) throw new Error("no socket");
  return sock;
}

function scriptedSocket(hooks: {
  assertSessions(jids: string[], force: boolean): Promise<void>;
  sendMessage(
    jid: string,
    content: { text: string },
  ): Promise<{ key?: { id?: string } }>;
  open(sock: FakeSocket): void;
}) {
  return async () => ({
    default(config: Record<string, unknown>) {
      const creds = (config.auth as { creds: FakeCreds }).creds;
      creds.registered = true;
      creds.me = { id: "5215500000099:1@s.whatsapp.net" };
      creds.account = { details: "signed" };
      const listeners = new Map<string, Array<(payload?: unknown) => void>>();
      const sock: FakeSocket = {
        sent: [],
        emit(event, payload) {
          for (const listener of listeners.get(event) ?? []) listener(payload);
        },
      };
      held.push(sock);
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
        assertSessions: hooks.assertSessions,
        sendMessage: hooks.sendMessage,
      };
      queueMicrotask(() => hooks.open(sock));
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

async function bundleHarness(): Promise<{
  channel: ReturnType<typeof createBaileysChannel>;
  forces: boolean[];
  logs: ReturnType<typeof capture>;
  ciphertext: (id: string) => void;
}> {
  const dir = await mkdtemp(join(tmpdir(), "harmony-bundle-window-"));
  const logs = capture();
  const forces: boolean[] = [];
  let sock: FakeSocket | null = null;
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: scriptedSocket({
      async assertSessions(_jids, force) {
        forces.push(force);
      },
      async sendMessage() {
        return { key: { id: `out-${forces.length}` } };
      },
      open(opened) {
        sock = opened;
        opened.emit("connection.update", { connection: "open" });
      },
    }),
  });
  channel.onMessage(async () => undefined);
  await channel.start();
  await waitFor(() => channel.whatsapp.status().phase === "connected");
  return {
    channel,
    forces,
    logs,
    ciphertext(id) {
      if (!sock) throw new Error("no socket");
      sock.emit("messages.upsert", {
        type: "notify",
        messages: [{
          key: { id, remoteJid: "5215500000001@s.whatsapp.net" },
          messageStubType: 2,
          message: null,
        }],
      });
    },
  };
}

function captureFilteredConsole(run: () => void): string[] {
  const seen: string[] = [];
  const saved = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    debug: console.debug,
    error: console.error,
  };
  const record = (...args: unknown[]) => {
    seen.push(args.map((item) => (
      typeof item === "string" ? item : inspect(item, { depth: 5, colors: false })
    )).join(" "));
  };
  console.log = record;
  console.info = record;
  console.warn = record;
  console.debug = record;
  console.error = record;
  installSignalLogFilter(true);
  try {
    run();
  } finally {
    console.log = saved.log;
    console.info = saved.info;
    console.warn = saved.warn;
    console.debug = saved.debug;
    console.error = saved.error;
  }
  return seen;
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
