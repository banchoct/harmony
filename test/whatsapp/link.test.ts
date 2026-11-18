import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { inflateSync } from "node:zlib";
import { createBaileysChannel } from "../../src/whatsapp/baileys.js";
import {
  acceptedPairing,
  clearSessionDirectory,
  createWhatsAppLinkState,
  formatPairingCode,
  normalizePairingPhone,
  PAIRING_CODE_TTL_MS,
  QR_MARGIN_MODULES,
  QR_TARGET_PX,
  qrModuleScale,
  renderQrPng,
  sessionDirAllowed,
  unfinishedPairing,
  whatsAppPublicStatus,
  whatsAppSessionEnded,
} from "../../src/whatsapp/link.js";

const QR = "qr-payload-secreto";

test("pairing phone becomes E.164, including a Mexican mobile", () => {
  assert.equal(normalizePairingPhone("+52 55 0000 0099"), "+525500000099");
  assert.equal(normalizePairingPhone("52 55 0000 0099"), "+525500000099");
  assert.equal(normalizePairingPhone("5500000099"), "+525500000099");
  assert.equal(normalizePairingPhone("+521 55 0000 0099"), "+525500000099");
  assert.equal(normalizePairingPhone("5215500000099"), "+525500000099");
  assert.equal(normalizePairingPhone("00525500000099"), "+525500000099");
  assert.equal(normalizePairingPhone("+1 202 555 0123"), "+12025550123");
  assert.equal(normalizePairingPhone("abc"), null);
  assert.equal(normalizePairingPhone("+"), null);
  assert.equal(normalizePairingPhone("123"), null);
  assert.equal(normalizePairingPhone(""), null);
});

test("pairing code is shown as eight characters with a hyphen", () => {
  assert.equal(formatPairingCode("abcd1234"), "ABCD-1234");
  assert.equal(formatPairingCode("ABCD-1234"), "ABCD-1234");
  assert.equal(formatPairingCode("abc"), null);
  assert.equal(formatPairingCode("ABCD12345"), null);
});

test("link state moves between waiting, connected and closed", () => {
  const state = createWhatsAppLinkState();
  assert.equal(state.phase(), "waiting");
  assert.equal(state.hasQr(), false);
  state.onQr(QR);
  state.notePairing("+525500000099", "ABCD-EFGH");
  state.onQr("otro-qr");
  assert.equal(state.snapshot().qr, "otro-qr");
  assert.equal(state.snapshot().pairingCode, "ABCD-EFGH");
  state.onOpen();
  assert.equal(state.phase(), "connected");
  assert.equal(state.snapshot().qr, null);
  assert.equal(state.snapshot().pairingCode, null);
  state.onQr("tarde");
  assert.equal(state.snapshot().qr, null);
  state.onClose("dropped");
  assert.equal(state.phase(), "waiting");
  state.onQr(QR);
  state.onClose("logged_out");
  assert.equal(state.phase(), "closed");
  assert.equal(state.snapshot().qr, null);
  state.onQr("no-debe");
  state.onClose("dropped");
  assert.deepEqual(state.snapshot(), {
    phase: "closed",
    qr: null,
    pairingCode: null,
    pairingPhone: null,
    pairingExpiresAt: null,
  });
  state.beginRestart();
  assert.equal(state.phase(), "waiting");
  assert.equal(state.hasQr(), false);
});

test("a new pairing code discards the previous one and then expires", () => {
  let now = 1_000;
  const state = createWhatsAppLinkState(() => now);
  state.onQr("primero");
  state.notePairing("+525500000099", "AAAA-BBBB");
  assert.equal(state.snapshot().qr, null);
  assert.equal(state.readyForCode(), true);
  assert.equal(state.snapshot().pairingCode, "AAAA-BBBB");
  assert.equal(state.snapshot().pairingExpiresAt, now + PAIRING_CODE_TTL_MS);
  state.onQr("sigue");
  state.notePairing("+525500000099", "CCCC-DDDD");
  assert.equal(state.snapshot().pairingCode, "CCCC-DDDD");
  assert.equal(state.snapshot().pairingPhone, "+525500000099");
  assert.equal(state.snapshot().qr, null);
  state.onQr("despues");
  now += PAIRING_CODE_TTL_MS;
  const expired = state.snapshot();
  assert.equal(expired.pairingCode, null);
  assert.equal(expired.pairingPhone, null);
  assert.equal(expired.qr, "despues");
  state.onOpen();
  assert.equal(state.snapshot().pairingCode, null);
  assert.equal(state.snapshot().qr, null);
  assert.equal(state.phase(), "connected");
});

test("public status keeps the QR payload on the server", () => {
  const pub = whatsAppPublicStatus({
    phase: "waiting",
    qr: QR,
    pairingCode: "ABCD-EFGH",
    pairingPhone: "+525500000099",
  });
  assert.equal(pub.view, "code");
  assert.equal(pub.qr, true);
  assert.equal(pub.pairingCode, "ABCD-EFGH");
  assert.ok(pub.qrTag);
  assert.equal(pub.qrTag?.includes(QR), false);
  assert.equal(JSON.stringify(pub).includes(QR), false);
  const preparing = whatsAppPublicStatus({
    phase: "waiting",
    qr: null,
    pairingCode: null,
    pairingPhone: null,
  });
  assert.equal(preparing.view, "preparing");
  const ready = whatsAppPublicStatus({
    phase: "waiting",
    qr: QR,
    pairingCode: null,
    pairingPhone: null,
  });
  assert.equal(ready.view, "qr");
  assert.equal(whatsAppPublicStatus(null).phase, "unavailable");
  assert.equal(whatsAppPublicStatus(null).view, "unavailable");
});

test("a bad session or a forbidden close is not a drop", () => {
  assert.equal(whatsAppSessionEnded(401), true);
  assert.equal(whatsAppSessionEnded(500), true);
  assert.equal(whatsAppSessionEnded(403), true);
  assert.equal(whatsAppSessionEnded(428), false);
  assert.equal(whatsAppSessionEnded(408), false);
  assert.equal(whatsAppSessionEnded(515), false);
  assert.equal(whatsAppSessionEnded(undefined), false);
});

test("a half-written pairing is not a logged-in session", () => {
  assert.equal(unfinishedPairing({ registered: false, me: { id: "1" } }), true);
  assert.equal(unfinishedPairing({ registered: true, me: { id: "1" } }), false);
  assert.equal(unfinishedPairing({ registered: false }), false);
  assert.equal(unfinishedPairing(undefined), false);
  assert.equal(acceptedPairing({ registered: false, me: { id: "1" } }), false);
  assert.equal(acceptedPairing({ account: { details: "ok" } }), false);
  assert.equal(acceptedPairing(undefined), false);
});

test("a pairing WhatsApp already accepted is not unfinished", () => {
  const accepted = {
    registered: false,
    me: { id: "5215500000099:1@s.whatsapp.net" },
    account: { details: "signed" },
  };
  assert.equal(acceptedPairing(accepted), true);
  assert.equal(unfinishedPairing(accepted), false);
  assert.equal(acceptedPairing({ registered: true, me: { id: "1" } }), true);
  assert.equal(unfinishedPairing({ registered: true, me: { id: "1" } }), false);
});

test("clearing the session directory refuses roots and removes only that folder", async () => {
  assert.throws(() => sessionDirAllowed("/"), /SESSION_DIR_REFUSED/);
  assert.throws(() => sessionDirAllowed("/data"), /SESSION_DIR_REFUSED/);
  assert.throws(() => sessionDirAllowed("/tmp"), /SESSION_DIR_REFUSED/);
  const dir = await mkdtemp(join(tmpdir(), "harmony-wa-"));
  await writeFile(join(dir, "creds.json"), "llaves");
  const link = `${dir}-link`;
  await symlink(dir, link);
  await assert.rejects(clearSessionDirectory(link), /SESSION_DIR_REFUSED/);
  assert.equal(await readFile(join(dir, "creds.json"), "utf8"), "llaves");
  await clearSessionDirectory(dir);
  assert.deepEqual(await readdir(dir), []);
});

test("the Baileys channel does not wipe a session that is not closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-wa-"));
  await writeFile(join(dir, "creds.json"), "{}");
  const logs = capture();
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    pairingPhone: "no-es-telefono",
  });
  assert.equal(channel.whatsapp.suggestedPhone(), null);
  assert.match(logs.text(), /BAILEYS_PAIRING_PHONE no es un teléfono válido/);
  assert.doesNotMatch(logs.text(), /no-es-telefono/);
  assert.equal(channel.whatsapp.status().phase, "waiting");
  assert.deepEqual(await channel.whatsapp.requestPairing("abc"), {
    ok: false,
    error: "invalid_phone",
  });
  assert.deepEqual(await channel.whatsapp.requestPairing("+52 55 0000 0099"), {
    ok: false,
    error: "not_ready",
  });
  assert.deepEqual(await channel.whatsapp.restart(), { ok: false, error: "not_closed" });
  assert.equal(await readFile(join(dir, "creds.json"), "utf8"), "{}");
  assert.equal(channel.whatsapp.status().qr, null);
  const ready = createBaileysChannel({
    sessionDir: dir,
    pairingPhone: "+52 55 0000 0099",
  });
  assert.equal(ready.whatsapp.suggestedPhone(), "+525500000099");
});

test("a QR payload becomes a PNG with a four-module quiet zone", async () => {
  const png = await renderQrPng(QR);
  assert.ok(png);
  assert.equal(png.subarray(0, 4).toString("hex"), "89504e47");
  assert.equal(await renderQrPng(""), null);
  const zone = quietZone(png);
  assert.equal(zone.modules, QR_MARGIN_MODULES);
  assert.equal(Number.isInteger(zone.modulePx), true);
  assert.equal(zone.modulePx, qrModuleScale(zone.symbolModules));
  assert.equal(zone.width, zone.modulePx * (zone.symbolModules + QR_MARGIN_MODULES * 2));
  assert.ok(zone.width > 250);
  assert.ok(zone.width <= QR_TARGET_PX);
  const longer = await renderQrPng(`2@${"A".repeat(180)}`);
  assert.ok(longer);
  const wide = quietZone(longer);
  assert.equal(wide.modules, QR_MARGIN_MODULES);
  assert.equal(Number.isInteger(wide.modulePx), true);
  assert.ok(wide.width > 250);
  assert.ok(wide.width <= QR_TARGET_PX);
});

test("setProfilePicture waits for the linked account and does not log the jid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harmony-foto-"));
  const logs = capture();
  const seen: Buffer[] = [];
  const channel = createBaileysChannel({
    sessionDir: dir,
    output: logs.output,
    reconnectDelayMs: 0,
    loadBaileys: async () => ({
      default(config: Record<string, unknown>) {
        const creds = (config.auth as { creds: { registered?: boolean; me?: { id?: string }; account?: unknown } }).creds;
        creds.registered = true;
        creds.me = { id: "5215500000099:1@s.whatsapp.net" };
        creds.account = { details: "signed" };
        const listeners = new Map<string, Array<(payload?: unknown) => void>>();
        queueMicrotask(() => {
          for (const listener of listeners.get("connection.update") ?? []) {
            listener({ connection: "open" });
          }
        });
        return {
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
          async updateProfilePicture(_jid: string, content: Buffer) {
            seen.push(content);
          },
        };
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
  try {
    const early = await channel.whatsapp.setProfilePicture(new Uint8Array([1, 2, 3]), "image/png");
    assert.deepEqual(early, { ok: false, error: "not_ready" });
    assert.equal(seen.length, 0);
    await channel.start();
    const png = new Uint8Array([137, 80, 78, 71]);
    const done = await channel.whatsapp.setProfilePicture(png, "image/png");
    assert.deepEqual(done, { ok: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.byteLength, png.byteLength);
    assert.match(logs.text(), /WhatsApp actualizó la foto de perfil\./);
    assert.equal(logs.text().includes("5215500000099"), false);
  } finally {
    await channel.stop();
  }
});

function quietZone(png: Buffer): {
  modulePx: number;
  modules: number;
  width: number;
  symbolModules: number;
} {
  const image = decodePng(png);
  const white = (x: number, y: number) => (image.pixels[y * image.width + x] ?? 0) > 128;
  let top = 0;
  while (top < image.height && rowIsWhite(image, top, white)) top += 1;
  let left = 0;
  while (left < image.width && white(left, top)) left += 1;
  let run = 0;
  for (let x = left; x < image.width && !white(x, top); x += 1) run += 1;
  const modulePx = run / 7;
  return {
    modulePx,
    modules: left / modulePx,
    width: image.width,
    symbolModules: Math.round((image.width / modulePx) - QR_MARGIN_MODULES * 2),
  };
}

function rowIsWhite(
  image: { width: number },
  y: number,
  white: (x: number, y: number) => boolean,
): boolean {
  for (let x = 0; x < image.width; x += 1) {
    if (!white(x, y)) return false;
  }
  return true;
}

function decodePng(buf: Buffer): { width: number; height: number; pixels: Uint8Array } {
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  assert.equal(bitDepth, 8);
  const inflated = inflateSync(Buffer.concat(idat));
  const channels = colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 1;
  const stride = width * channels;
  const pixels = new Uint8Array(width * height);
  let src = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[src] ?? 0;
    src += 1;
    const raw = inflated.subarray(src, src + stride);
    src += stride;
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? cur[i - channels] ?? 0 : 0;
      const up = prev[i] ?? 0;
      const ul = i >= channels ? prev[i - channels] ?? 0 : 0;
      const value = raw[i] ?? 0;
      if (filter === 0) cur[i] = value;
      else if (filter === 1) cur[i] = (value + left) & 255;
      else if (filter === 2) cur[i] = (value + up) & 255;
      else if (filter === 3) cur[i] = (value + Math.floor((left + up) / 2)) & 255;
      else cur[i] = (value + paeth(left, up, ul)) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      pixels[y * width + x] = luminance(cur, x, colorType, palette);
    }
    prev = cur;
  }
  return { width, height, pixels };
}

function luminance(row: Uint8Array, x: number, colorType: number, palette: Buffer | null): number {
  if (colorType === 3 && palette) {
    const index = row[x] ?? 0;
    return palette[index * 3] ?? 0;
  }
  if (colorType === 2) return row[x * 3] ?? 0;
  if (colorType === 6) return row[x * 4] ?? 0;
  if (colorType === 4) return row[x * 2] ?? 0;
  return row[x] ?? 0;
}

function paeth(left: number, up: number, ul: number): number {
  const estimate = left + up - ul;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - ul);
  if (dl <= du && dl <= dul) return left;
  if (du <= dul) return up;
  return ul;
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
