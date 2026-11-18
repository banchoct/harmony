import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { createBaileysChannel } from "../../src/whatsapp/baileys.js";

const PAIRED_ID = "5215500000099:1@s.whatsapp.net";

interface FakeCreds {
  registered?: boolean;
  me?: { id?: string };
  account?: unknown;
}

interface FakeUpdate {
  connection?: string;
  qr?: string;
  isNewLogin?: boolean;
  lastDisconnect?: { error?: { output?: { statusCode?: number } } };
}

interface SocketScript {
  creds: FakeCreds;
  sockets: number;
  emit(event: "creds.update"): void;
  emit(event: "connection.update", update: FakeUpdate): void;
}

function scriptedBaileys(
  run: (ctx: SocketScript) => void,
  sends?: { count: number },
) {
  let sockets = 0;
  return async () => ({
    default(config: Record<string, unknown>) {
      sockets += 1;
      const creds = (config.auth as { creds: FakeCreds }).creds;
      const listeners = new Map<string, Array<(...args: any[]) => void>>();
      const ev = {
        on(event: string, listener: (...args: any[]) => void) {
          const list = listeners.get(event) ?? [];
          list.push(listener);
          listeners.set(event, list);
        },
      };
      const emit = (event: "creds.update" | "connection.update", payload?: FakeUpdate) => {
        for (const listener of listeners.get(event) ?? []) listener(payload);
      };
      queueMicrotask(() => {
        run({ creds, sockets, emit });
      });
      return {
        ev,
        end() {},
        async requestPairingCode() {
          return "ABCD2345";
        },
        async sendMessage() {
          if (sends) sends.count += 1;
          if (!creds.me) {
            throw new TypeError("Cannot read properties of undefined (reading 'id')");
          }
          return { key: { id: creds.me.id ?? "local" } };
        },
      };
    },
    async useMultiFileAuthState(folder: string) {
      const file = join(folder, "creds.json");
      let creds: FakeCreds = {};
      try {
        creds = JSON.parse(await readFile(file, "utf8")) as FakeCreds;
      } catch {
        creds = {};
      }
      return {
        state: { creds },
        async saveCreds() {
          await writeFile(file, JSON.stringify(creds));
        },
      };
    },
    async fetchLatestBaileysVersion() {
      return { version: [2, 3000, 102] };
    },
    DisconnectReason: { loggedOut: 401 },
  });
}

test("an accepted QR pairing survives the restart close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-wa-"));
  const keep = join(dir, "keep.txt");
  await writeFile(keep, "session");
  const seen: Array<FakeCreds | undefined> = [];
  const logs = capture();
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: scriptedBaileys(({ creds, sockets, emit }) => {
      seen.push(creds.me ? { me: { id: creds.me.id }, account: creds.account, registered: creds.registered } : {});
      if (sockets === 1) {
        creds.me = { id: PAIRED_ID };
        creds.account = { details: "signed" };
        creds.registered = false;
        emit("creds.update");
        emit("connection.update", { isNewLogin: true });
        emit("connection.update", {
          connection: "close",
          lastDisconnect: { error: { output: { statusCode: 515 } } },
        });
        return;
      }
      emit("connection.update", { connection: "open" });
    }),
  });
  try {
    await channel.start();
    await waitFor(() => channel.whatsapp.status().phase === "connected");
    assert.match(logs.text(), /WhatsApp se desconectó \(515\)\. Reintentando\./);
    assert.match(logs.text(), /WhatsApp aceptó la vinculación/);
    assert.doesNotMatch(logs.text(), /no terminó|Se empieza de nuevo/);
    assert.equal(seen.length >= 2, true);
    assert.equal(seen[1]?.me?.id, PAIRED_ID);
    assert.ok(seen[1]?.account);
    assert.equal(await readFile(join(dir, "creds.json"), "utf8").then((body) => body.includes(PAIRED_ID)), true);
    await access(keep);
  } finally {
    await channel.stop();
  }
});

test("a scanned pairing is kept even when the saved file only has me", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-wa-"));
  const keep = join(dir, "keep.txt");
  await writeFile(keep, "session");
  const seen: string[] = [];
  const logs = capture();
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: scriptedBaileys(({ creds, sockets, emit }) => {
      seen.push(creds.me?.id ?? "");
      if (sockets === 1) {
        creds.me = { id: PAIRED_ID };
        creds.registered = false;
        emit("creds.update");
        emit("connection.update", {
          isNewLogin: true,
          connection: "close",
          lastDisconnect: { error: { output: { statusCode: 515 } } },
        });
        return;
      }
      emit("connection.update", { connection: "open" });
    }),
  });
  try {
    await channel.start();
    await waitFor(() => channel.whatsapp.status().phase === "connected");
    assert.equal(seen[1], PAIRED_ID);
    assert.match(logs.text(), /WhatsApp se desconectó \(515\)\. Reintentando\./);
    assert.doesNotMatch(logs.text(), /no terminó|Se empieza de nuevo/);
    await access(keep);
  } finally {
    await channel.stop();
  }
});

test("a restarted process keeps a paired session that is not marked registered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-wa-"));
  const keep = join(dir, "keep.txt");
  await writeFile(keep, "session");
  await writeFile(
    join(dir, "creds.json"),
    JSON.stringify({
      registered: false,
      me: { id: PAIRED_ID },
      account: { details: "signed" },
    }),
  );
  const seen: string[] = [];
  const logs = capture();
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: scriptedBaileys(({ creds, emit }) => {
      seen.push(creds.me?.id ?? "");
      emit("connection.update", { connection: "open" });
    }),
  });
  try {
    await channel.start();
    await waitFor(() => channel.whatsapp.status().phase === "connected");
    assert.deepEqual(seen, [PAIRED_ID]);
    assert.doesNotMatch(logs.text(), /no terminó|Se empieza de nuevo/);
    await access(keep);
  } finally {
    await channel.stop();
  }
});

test("a half-written pairing is still cleared on the next start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-wa-"));
  const keep = join(dir, "keep.txt");
  await writeFile(keep, "session");
  await writeFile(
    join(dir, "creds.json"),
    JSON.stringify({ registered: false, me: { id: "half" } }),
  );
  const seen: string[] = [];
  const logs = capture();
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: scriptedBaileys(({ creds }) => {
      seen.push(creds.me?.id ?? "");
    }),
  });
  try {
    await channel.start();
    assert.deepEqual(seen, [""]);
    assert.match(logs.text(), /La vinculación anterior no terminó/);
    await assert.rejects(access(keep));
    const body = await readFile(join(dir, "creds.json"), "utf8").catch(() => "");
    assert.equal(body.includes("half"), false);
  } finally {
    await channel.stop();
  }
});

test("a logged-out close records the status code and does not delete the link", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-wa-"));
  const keep = join(dir, "keep.txt");
  await writeFile(keep, "session");
  let sockets = 0;
  const logs = capture();
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: scriptedBaileys(({ creds, emit }) => {
      sockets += 1;
      creds.me = { id: PAIRED_ID };
      creds.account = { details: "signed" };
      creds.registered = false;
      emit("creds.update");
      emit("connection.update", { isNewLogin: true });
      emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
    }),
  });
  try {
    await channel.start();
    await waitFor(() => channel.whatsapp.status().phase === "closed");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sockets, 1);
    assert.match(logs.text(), /La sesión de WhatsApp se cerró \(401\)/);
    await access(keep);
    assert.equal((await readFile(join(dir, "creds.json"), "utf8")).includes(PAIRED_ID), true);
  } finally {
    await channel.stop();
  }
});

test("an unfinished pairing code still clears the session and logs the status code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-wa-"));
  const keep = join(dir, "keep.txt");
  const close: { emit: (code: number) => void } = {
    emit() {
      throw new Error("socket not ready");
    },
  };
  const logs = capture();
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: scriptedBaileys(({ sockets, emit }) => {
      if (sockets !== 1) return;
      close.emit = (code) => {
        emit("connection.update", {
          connection: "close",
          lastDisconnect: { error: { output: { statusCode: code } } },
        });
      };
      emit("connection.update", { qr: "qr-uno" });
    }),
  });
  try {
    await channel.start();
    await waitFor(() => channel.whatsapp.status().qr === "qr-uno");
    const paired = await channel.whatsapp.requestPairing("+525500000099");
    assert.equal(paired.ok, true);
    await writeFile(keep, "session");
    close.emit(428);
    await waitFor(() => logs.text().includes("La vinculación con código no terminó"));
    assert.match(logs.text(), /WhatsApp se desconectó \(428\)/);
    await assert.rejects(access(keep));
  } finally {
    await channel.stop();
  }
});

test("a closed session can still be wiped when the coordinator asks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-wa-"));
  const keep = join(dir, "keep.txt");
  await writeFile(keep, "session");
  const logs = capture();
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: scriptedBaileys(({ creds, sockets, emit }) => {
      if (sockets !== 1) return;
      creds.me = { id: PAIRED_ID };
      creds.account = { details: "signed" };
      emit("creds.update");
      emit("connection.update", { isNewLogin: true });
      emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
    }),
  });
  try {
    await channel.start();
    await waitFor(() => channel.whatsapp.status().phase === "closed");
    await access(keep);
    const restarted = await channel.whatsapp.restart();
    assert.deepEqual(restarted, { ok: true });
    assert.match(logs.text(), /Sesión de WhatsApp limpiada/);
    await assert.rejects(access(keep));
  } finally {
    await channel.stop();
  }
});

test("a send is refused while the linked identity is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-wa-"));
  const sends = { count: 0 };
  const logs = capture();
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: scriptedBaileys(({ emit }) => {
      emit("connection.update", { connection: "open" });
    }, sends),
  });
  try {
    await channel.start();
    await waitFor(() => channel.whatsapp.status().phase === "connected");
    assert.equal(channel.linkedId(), null);
    await assert.rejects(channel.send("+525500000099", "hola"), /CHANNEL_NOT_READY/);
    assert.equal(sends.count, 0);
  } finally {
    await channel.stop();
  }
});

test("a code that was requested and never accepted is still cleared", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-wa-"));
  const keep = join(dir, "keep.txt");
  const close: { emit: (code: number) => void; open: () => void } = {
    emit() {
      throw new Error("socket not ready");
    },
    open() {
      throw new Error("socket not ready");
    },
  };
  const logs = capture();
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: scriptedBaileys(({ sockets, creds, emit }) => {
      if (sockets !== 1) return;
      close.open = () => {
        creds.me = { id: "5215500000099@s.whatsapp.net" };
        creds.registered = false;
        emit("connection.update", { connection: "open" });
      };
      close.emit = (code) => {
        emit("connection.update", {
          connection: "close",
          lastDisconnect: { error: { output: { statusCode: code } } },
        });
      };
      emit("connection.update", { qr: "qr-uno" });
    }),
  });
  try {
    await channel.start();
    await waitFor(() => channel.whatsapp.status().qr === "qr-uno");
    const paired = await channel.whatsapp.requestPairing("+525500000099");
    assert.equal(paired.ok, true);
    await writeFile(keep, "session");
    close.open();
    close.emit(428);
    await waitFor(() => logs.text().includes("La vinculación con código no terminó"));
    await assert.rejects(access(keep));
    assert.doesNotMatch(logs.text(), /WhatsApp aceptó la vinculación/);
  } finally {
    await channel.stop();
  }
});

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
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
