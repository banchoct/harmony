import { mkdir } from "node:fs/promises";
import type { Writable } from "node:stream";
import pino from "pino";
import QRCode from "qrcode";
import type { Channel, MessageHandler } from "../channel.js";
import {
  lidUserFromJid,
  maskPhone,
  normalizePhone,
  phoneFromDirectKey,
  phoneFromWhatsAppAddress,
  phoneLookupKeys,
} from "./wa-phone.js";
import {
  acceptedPairing,
  clearSessionDirectory,
  createWhatsAppLinkState,
  formatPairingCode,
  normalizePairingPhone,
  pairingDigits,
  unfinishedPairing,
  whatsAppSessionEnded,
  type PairingResult,
  type RefreshQrResult,
  type RestartResult,
  type WhatsAppLinkPort,
} from "./link.js";
import { WHISPER_MAX_BYTES } from "../voice.js";
import { contactsFromBaileysMessage } from "./contact-card.js";
import { describeBaileysMessage, type BaileysInnerMessage } from "./baileys-message.js";

interface WaKey {
  fromMe?: boolean | null;
  id?: string | null;
  remoteJid?: string | null;
  /** Not in the 6.7.24 proto. Read when a newer socket sets it. */
  remoteJidAlt?: string | null;
  senderPn?: string | null;
  senderLid?: string | null;
  participantPn?: string | null;
}

interface WaMessage {
  key?: WaKey;
  message?: BaileysInnerMessage | null;
  /** 2 = ciphertext. The body is missing because Signal could not open it. */
  messageStubType?: number | null;
  messageStubParameters?: Array<string | null> | null;
}

interface WaUpdate {
  connection?: string;
  qr?: string;
  isNewLogin?: boolean;
  lastDisconnect?: { error?: { output?: { statusCode?: number } } };
}

interface WaSocket {
  ev: {
    on(event: string, listener: (...args: any[]) => void): void;
  };
  sendMessage(
    jid: string,
    content: { text: string },
  ): Promise<{ key?: { id?: string | null }; message?: unknown } | undefined>;
  /** When present, Baileys fetches a prekey bundle. `force` drops the saved session. */
  assertSessions?(jids: string[], force: boolean): Promise<unknown>;
  requestPairingCode(phoneNumber: string): Promise<string>;
  updateProfilePicture?(jid: string, content: Buffer): Promise<void>;
  end(error: Error | undefined): void;
}

interface WaCreds {
  registered?: boolean;
  me?: { id?: string };
  /** Set by pair-success. A pairing code request stores `me` without this. */
  account?: unknown;
}

interface AuthKeys {
  set(data: { [category: string]: { [id: string]: unknown } }): Promise<void>;
}

interface BaileysModule {
  default: (config: Record<string, unknown>) => WaSocket;
  useMultiFileAuthState: (folder: string) => Promise<{
    state: { creds: WaCreds; keys?: AuthKeys };
    saveCreds: () => Promise<void>;
  }>;
  fetchLatestBaileysVersion: () => Promise<{ version: number[] }>;
  DisconnectReason: { loggedOut: number };
}

/**
 * WhatsApp adapter for one dedicated number.
 * The session directory holds login keys and must stay out of git.
 * Group, broadcast and newsletter traffic is dropped before the handler.
 * A direct chat addressed as @lid is accepted when WhatsApp includes the
 * phone (remoteJidAlt, senderPn, participantPn) or already shared that lid.
 * Signal sessions and prekeys are written through one queue. The next socket
 * waits for that queue, so a 515 restart cannot save an older ratchet on top
 * of the new one. A message that fails to decrypt is not stored as empty text.
 * `append` is an offline direct chat caught while the socket was down, and
 * also a history sync. Only the direct chat is handled, once per message id.
 * Outbound uses the jid WhatsApp addressed that chat with. A dirty session
 * forces assertSessions on the next send even inside the one-minute window,
 * instead of deleting the ratchet on disk. A clean chat forces at most once
 * per window.
 * Retry counters and the last sent bodies outlive a reconnect, so WhatsApp
 * can ask for a resend and get the same text back. An undecryptable fromMe
 * came from the chip's phone or another linked device, with a ratchet this
 * socket no longer follows; that is logged once per socket.
 */
export function createBaileysChannel(options: {
  sessionDir: string;
  output?: Writable;
  /** BAILEYS_PAIRING_PHONE. Invalid values are ignored and not logged. */
  pairingPhone?: string | null;
  downloadAudio?: (message: WaMessage) => Promise<Uint8Array>;
  /** Test seam. Production loads @whiskeysockets/baileys. */
  loadBaileys?: () => Promise<BaileysModule>;
  /** Defaults to 2 seconds. Tests pass 0. */
  reconnectDelayMs?: number;
}): Channel & {
  whatsapp: WhatsAppLinkPort;
  /** Null until pair-success has stored me.id. */
  linkedId(): string | null;
} {
  const output = options.output ?? process.stdout;
  const link = createWhatsAppLinkState();
  const suggested = readSuggestedPhone(options.pairingPhone, output);
  let handler: MessageHandler | null = null;
  let socket: WaSocket | null = null;
  let stopping = false;
  let started = false;
  let resetting = false;
  let pairingPending = false;
  /** Set when WhatsApp accepts the link. Automatic reconnect must not wipe it. */
  let pairingAccepted = false;
  /** Same object Baileys mutates. `me` stays undefined until pair-success. */
  let authCreds: WaCreds | null = null;
  let generation = 0;
  let opened = false;
  /** lid user → E.164, filled only when WhatsApp already gave the phone. */
  const lidPhones = new Map<string, string>();
  /** E.164 → jid WhatsApp used for that chat. Capped; oldest keys fall off. */
  const sendJids = new Map<string, string>();
  /** Chats whose next send must fetch a new prekey bundle. */
  const dirtyJids = new Set<string>();
  /** Last successful bundle fetch per send jid. */
  const bundledAt = new Map<string, number>();
  /** Ids already handed to the handler. Notify and offline append share them. */
  const seenMessageIds = new Set<string>();
  /** Shared by every socket so a reconnect does not reset retry counts. */
  const retryCounters = createMemoryCache(RETRY_CACHE_MAX, RETRY_CACHE_MS);
  /** Message id → body Baileys sent. Answers getMessage on a retry receipt. */
  const sentBodies = new Map<string, unknown>();
  /** Send jid → undecryptable messages in a row from that person. */
  const undecryptedRun = new Map<string, number>();
  let foreignDeviceWarned = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let saveTail: Promise<void> = Promise.resolve();
  const waiters: Array<() => void> = [];

  function rememberCreds(epoch: number, saveCreds: () => Promise<void>): void {
    if (epoch !== generation) return;
    // A save already queued must finish. The restart after pair-success bumps
    // the generation while those creds are still being written.
    saveTail = saveTail.then(() => saveCreds()).catch(() => undefined);
  }

  async function flushCreds(): Promise<void> {
    let current = saveTail;
    for (;;) {
      await current;
      if (saveTail === current) return;
      current = saveTail;
    }
  }

  function watchKeyWrites(epoch: number, keys: AuthKeys | undefined): void {
    if (!keys || typeof keys.set !== "function") return;
    const raw = keys.set.bind(keys);
    keys.set = (data) => {
      if (epoch !== generation) {
        output.write("WhatsApp ignoró un guardado de llaves de una sesión ya cerrada.\n");
        return Promise.resolve();
      }
      const run = saveTail.then(() => raw(data));
      saveTail = run.then(() => undefined, () => undefined);
      return run;
    };
  }

  function adoptAuth(epoch: number, state: { creds: WaCreds; keys?: AuthKeys }): void {
    authCreds = state.creds;
    watchKeyWrites(epoch, state.keys);
  }

  function whenReady(): Promise<void> {
    if (opened) return Promise.resolve();
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  function markOpen(): void {
    opened = true;
    const pending = waiters.splice(0, waiters.length);
    for (const resolve of pending) resolve();
  }

  function markClosed(): void {
    opened = false;
  }

  function scheduleReconnect(code?: number): void {
    if (stopping || reconnectTimer) return;
    const status = disconnectStatus(code);
    output.write(
      status
        ? `WhatsApp se desconectó (${status}). Reintentando.\n`
        : "WhatsApp se desconectó. Reintentando.\n",
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch(() => {
        output.write("No se pudo reconectar WhatsApp.\n");
        scheduleReconnect();
      });
    }, Math.max(0, options.reconnectDelayMs ?? 2000));
  }

  async function connect(): Promise<void> {
    // Key writes from the socket we just closed share this queue. Read the
    // directory only after they land, so the next socket cannot save an older
    // ratchet on top of them.
    await flushCreds();
    const current = ++generation;
    const imported = options.loadBaileys
      ? await options.loadBaileys()
      : ((await import("@whiskeysockets/baileys")) as unknown as BaileysModule);
    await mkdir(options.sessionDir, { recursive: true });
    if (current !== generation || stopping) return;
    let { state, saveCreds } = await imported.useMultiFileAuthState(
      options.sessionDir,
    );
    adoptAuth(current, state);
    if (acceptedPairing(state.creds)) pairingAccepted = true;
    // QR pair-success leaves `registered` false. Only a code that never
    // got `account` is unfinished and may be deleted here.
    if (!pairingAccepted && unfinishedPairing(state.creds)) {
      output.write("La vinculación anterior no terminó. Se empieza de nuevo.\n");
      try {
        await flushCreds();
        await clearSessionDirectory(options.sessionDir);
      } catch {
        output.write("No se pudo limpiar la sesión de WhatsApp.\n");
        link.onClose("logged_out");
        return;
      }
      if (current !== generation || stopping) return;
      const fresh = await imported.useMultiFileAuthState(options.sessionDir);
      state = fresh.state;
      saveCreds = fresh.saveCreds;
      adoptAuth(current, state);
    }
    let version: number[] | undefined;
    try {
      version = (await imported.fetchLatestBaileysVersion()).version;
    } catch {
      version = undefined;
    }
    if (current !== generation || stopping) return;
    const logger = pino({ level: "silent" });
    const config: Record<string, unknown> = {
      auth: state,
      logger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      shouldSyncHistoryMessage: () => false,
      msgRetryCounterCache: retryCounters,
      // Without this the default answers undefined and the resend is empty.
      getMessage: async (key: { id?: string | null } | undefined) => {
        const id = key?.id;
        return typeof id === "string" ? sentBodies.get(id) : undefined;
      },
    };
    if (version) config.version = version;
    const sock = imported.default(config);
    if (current !== generation || stopping) {
      sock.end(undefined);
      return;
    }
    socket = sock;
    bundledAt.clear();
    foreignDeviceWarned = false;
    sock.ev.on("creds.update", () => {
      rememberCreds(current, saveCreds);
    });
    sock.ev.on("connection.update", (update) => {
      if (current !== generation) return;
      void onConnection(current, update);
    });
    sock.ev.on("messages.upsert", (upsert) => {
      const payload = asUpsert(upsert);
      if (current !== generation) {
        output.write(formatUpsert(payload, true));
        return;
      }
      void onMessages(payload);
    });
    sock.ev.on("chats.phoneNumberShare", (share) => {
      notePhoneShare(share);
    });
  }

  async function onConnection(current: number, update: WaUpdate): Promise<void> {
    if (current !== generation) return;
    if (update.isNewLogin) {
      pairingAccepted = true;
      pairingPending = false;
      output.write("WhatsApp aceptó la vinculación. Conectando.\n");
    }
    if (update.qr) {
      link.onQr(update.qr);
      const rendered = await QRCode.toString(update.qr, {
        type: "terminal",
        small: true,
      });
      output.write("Escanea este QR con el WhatsApp del chip dedicado.\n");
      output.write(rendered);
      output.write("\n");
    }
    if (update.connection === "open") {
      if (acceptedPairing(authCreds)) pairingAccepted = true;
      // A code request that never reached pair-success keeps pairingPending,
      // so the next close still runs resetUnfinishedPairing.
      if (pairingAccepted) pairingPending = false;
      link.onOpen();
      output.write("WhatsApp conectado.\n");
      markOpen();
    }
    if (update.connection !== "close") return;
    markClosed();
    const retiring = socket;
    socket = null;
    // Baileys already closed the websocket. end() is idempotent and drops
    // listeners so this socket cannot keep decrypting beside the next one.
    retiring?.end(undefined);
    if (stopping || current !== generation) return;
    const code = update.lastDisconnect?.error?.output?.statusCode;
    if (whatsAppSessionEnded(code)) {
      pairingPending = false;
      link.onClose("logged_out");
      output.write(
        `La sesión de WhatsApp se cerró (${disconnectStatus(code) ?? "sin código"}). ` +
          "Desde el panel se puede volver a vincular.\n",
      );
      return;
    }
    const retryCode = pairingPending && !pairingAccepted;
    pairingPending = false;
    link.onClose("dropped");
    if (retryCode) {
      output.write(
        `WhatsApp se desconectó (${disconnectStatus(code) ?? "sin código"}).\n`,
      );
      void resetUnfinishedPairing();
      return;
    }
    scheduleReconnect(code);
  }

  async function resetUnfinishedPairing(): Promise<void> {
    // Accepted QR stays. A code that was asked for and never accepted is cleared.
    if (stopping || resetting || pairingAccepted) return;
    resetting = true;
    try {
      const old = socket;
      socket = null;
      await flushCreds();
      generation += 1;
      old?.end(undefined);
      markClosed();
      pairingPending = false;
      try {
        await clearSessionDirectory(options.sessionDir);
      } catch {
        output.write("No se pudo limpiar la sesión de WhatsApp.\n");
        link.onClose("logged_out");
        return;
      }
      output.write("La vinculación con código no terminó. Se pide de nuevo.\n");
      link.beginRestart();
      await connect();
    } catch {
      output.write("No se pudo reconectar WhatsApp.\n");
      scheduleReconnect();
    } finally {
      resetting = false;
    }
  }

  async function requestPairing(rawPhone: string): Promise<PairingResult> {
    const phoneE164 = normalizePairingPhone(rawPhone);
    if (!phoneE164) return { ok: false, error: "invalid_phone" };
    if (link.phase() === "connected") return { ok: false, error: "already_connected" };
    if (link.phase() === "closed") return { ok: false, error: "closed" };
    const sock = socket;
    if (!sock || !link.readyForCode()) return { ok: false, error: "not_ready" };
    pairingPending = true;
    try {
      const code = await sock.requestPairingCode(pairingDigits(phoneE164));
      const formatted = formatPairingCode(code);
      if (!formatted) {
        void resetUnfinishedPairing();
        return { ok: false, error: "failed" };
      }
      link.notePairing(phoneE164, formatted);
      return { ok: true, code: formatted, phoneE164 };
    } catch {
      output.write("No se pudo pedir el código de vinculación.\n");
      void resetUnfinishedPairing();
      return { ok: false, error: "failed" };
    }
  }

  async function refreshQr(): Promise<RefreshQrResult> {
    if (link.phase() !== "waiting") return { ok: false, error: "not_waiting" };
    if (stopping || resetting) return { ok: false, error: "failed" };
    resetting = true;
    try {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const old = socket;
      socket = null;
      await flushCreds();
      generation += 1;
      old?.end(undefined);
      markClosed();
      pairingPending = false;
      link.discardPairing();
      output.write("Se pidió otro QR de vinculación.\n");
      await connect();
      return { ok: true };
    } catch {
      output.write("No se pudo pedir otro QR.\n");
      scheduleReconnect();
      return { ok: false, error: "failed" };
    } finally {
      resetting = false;
    }
  }

  async function restart(): Promise<RestartResult> {
    if (link.phase() !== "closed") return { ok: false, error: "not_closed" };
    if (stopping || resetting) return { ok: false, error: "failed" };
    resetting = true;
    try {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const old = socket;
      socket = null;
      await flushCreds();
      generation += 1;
      old?.end(undefined);
      markClosed();
      pairingPending = false;
      try {
        await clearSessionDirectory(options.sessionDir);
      } catch {
        output.write("No se pudo limpiar la sesión de WhatsApp.\n");
        return { ok: false, error: "failed" };
      }
      pairingAccepted = false;
      link.beginRestart();
      output.write("Sesión de WhatsApp limpiada. Volviendo a pedir vinculación.\n");
      await connect();
      return { ok: true };
    } catch {
      output.write("No se pudo reconectar WhatsApp.\n");
      scheduleReconnect();
      return { ok: false, error: "failed" };
    } finally {
      resetting = false;
    }
  }

  function rememberSentBody(id: string, body: unknown): void {
    sentBodies.delete(id);
    sentBodies.set(id, body);
    while (sentBodies.size > SENT_BODIES_MAX) {
      const oldest = sentBodies.keys().next().value;
      if (typeof oldest !== "string") break;
      sentBodies.delete(oldest);
    }
  }

  function noteForeignDevice(item: WaMessage): void {
    const to = phoneFromWhatsAppAddress(item.key?.remoteJid);
    output.write(
      discardLine(`fromMe sin descifrar, escrito desde otro dispositivo del número a ${to ? maskPhone(to) : "un chat sin número"}`),
    );
    if (foreignDeviceWarned) return;
    foreignDeviceWarned = true;
    output.write(
      "WHATSAPP_FROMME_SIN_DESCIFRAR Llegan mensajes del propio número que no se pueden descifrar. " +
        "Vienen del teléfono del chip o de otro dispositivo vinculado. " +
        "Si siguen, revisa Dispositivos vinculados y vuelve a vincular desde el panel.\n",
    );
  }

  function noteUndecrypted(remoteJid: string | null | undefined, who: string): void {
    const jid = canonicalSendJid(remoteJid);
    if (!jid) return;
    const run = (undecryptedRun.get(jid) ?? 0) + 1;
    undecryptedRun.set(jid, run);
    if (run === UNDECRYPTED_STREAK) {
      output.write(
        `WHATSAPP_DECRYPT_STREAK ${who}: ${run} mensajes seguidos sin descifrar.\n`,
      );
    }
  }

  function knownLidPhone(lidUser: string): string | null {
    return lidPhones.get(lidUser) ?? null;
  }

  function rememberSendJid(phone: string, remoteJid: string | null | undefined): void {
    const jid = canonicalSendJid(remoteJid);
    if (!jid) return;
    const keys = phoneLookupKeys(phone);
    if (keys.length === 0) return;
    if (jid.endsWith("@s.whatsapp.net")) {
      const user = jid.slice(0, jid.indexOf("@"));
      const digits = new Set(keys.map((item) => item.slice(1)));
      if (!digits.has(user)) return;
    }
    for (const key of keys) {
      sendJids.delete(key);
      sendJids.set(key, jid);
    }
    while (sendJids.size > 128) {
      const oldest = sendJids.keys().next().value;
      if (typeof oldest !== "string") break;
      sendJids.delete(oldest);
    }
  }

  function rememberedJid(phone: string): string | null {
    for (const key of phoneLookupKeys(phone)) {
      const jid = sendJids.get(key);
      if (jid) return jid;
    }
    return null;
  }

  function markSessionDirty(remoteJid: string | null | undefined): void {
    const jid = canonicalSendJid(remoteJid);
    if (jid) dirtyJids.add(jid);
  }

  function shouldForceBundle(jid: string): boolean {
    if (dirtyJids.has(jid)) return true;
    const last = bundledAt.get(jid) ?? 0;
    if (last !== 0 && Date.now() - last < BUNDLE_WINDOW_MS) return false;
    // First bundle, or the previous one already aged out of the window.
    return true;
  }

  function notePhoneShare(share: { lid?: string | null; jid?: string | null } | undefined): void {
    const lid = lidUserFromJid(share?.lid);
    const phone = phoneFromWhatsAppAddress(share?.jid);
    if (!lid || !phone) {
      output.write("WhatsApp compartió un @lid sin número usable.\n");
      return;
    }
    lidPhones.set(lid, phone);
    output.write(`WhatsApp asoció un @lid con ${maskPhone(phone)}.\n`);
  }

  async function onMessages(upsert: {
    type?: string;
    messages?: WaMessage[];
  }): Promise<void> {
    const type = upsertType(upsert.type);
    const messages = Array.isArray(upsert.messages) ? upsert.messages : [];
    output.write(formatUpsert({ type, messages }, false));
    // append is also how Baileys delivers a direct chat that arrived while
    // the socket was reconnecting. History sync is filtered per message.
    if (type !== "notify" && type !== "append") {
      const marks = Math.max(messages.length, 1);
      for (let index = 0; index < marks; index += 1) {
        output.write(discardLine(`tipo distinto de notify (${type})`));
      }
      return;
    }
    if (!handler) {
      const marks = Math.max(messages.length, 1);
      for (let index = 0; index < marks; index += 1) {
        output.write(discardLine("sin manejador"));
      }
      return;
    }
    for (const item of messages) {
      try {
        await takeMessage(item);
      } catch {
        output.write("WhatsApp no pudo leer un mensaje entrante.\n");
      }
    }
  }

  function claimMessageId(id: string): boolean {
    if (seenMessageIds.has(id)) return false;
    seenMessageIds.add(id);
    if (seenMessageIds.size <= 4000) return true;
    const oldest = seenMessageIds.values().next().value;
    if (typeof oldest === "string") seenMessageIds.delete(oldest);
    return true;
  }

  async function takeMessage(item: WaMessage): Promise<void> {
    if (isHistorySync(item)) {
      output.write(discardLine("historial"));
      return;
    }
    if (item.key?.fromMe) {
      // Harmony's own sends arrive readable. A ciphertext fromMe was written
      // on the chip's phone or another device linked to the number.
      if (isUndecrypted(item)) noteForeignDevice(item);
      else output.write(discardLine("fromMe"));
      return;
    }
    if (isUndecrypted(item)) {
      output.write(
        "WhatsApp no pudo descifrar un mensaje. No se registró como texto vacío.\n",
      );
      const resolved = phoneFromDirectKey(item.key, knownLidPhone);
      if (resolved.ok) rememberSendJid(resolved.phone, item.key?.remoteJid);
      noteUndecrypted(item.key?.remoteJid, resolved.ok ? maskPhone(resolved.phone) : "un chat sin número");
      markSessionDirty(item.key?.remoteJid);
      output.write(
        "WhatsApp pedirá una sesión nueva de ese chat antes de volver a escribir.\n",
      );
      return;
    }
    const resolved = phoneFromDirectKey(item.key, knownLidPhone);
    if (!resolved.ok) {
      output.write(discardLine(discardReason(resolved)));
      return;
    }
    const id = item.key?.id;
    if (typeof id !== "string" || id.length === 0) {
      output.write(discardLine("sin id"));
      return;
    }
    if (!claimMessageId(id)) {
      output.write(discardLine("id ya visto"));
      return;
    }
    rememberSendJid(resolved.phone, item.key?.remoteJid);
    const readJid = canonicalSendJid(item.key?.remoteJid);
    if (readJid) undecryptedRun.delete(readJid);
    for (const lid of resolved.lids) lidPhones.set(lid, resolved.phone);
    output.write(`WhatsApp atiende un mensaje directo de ${maskPhone(resolved.phone)}.\n`);
    const receive = handler;
    if (!receive) {
      output.write(discardLine("sin manejador"));
      return;
    }
    const phone = resolved.phone;
    const described = describeBaileysMessage(item.message);
    const contacts = contactsFromBaileysMessage(item.message);
    let audio: { bytes: Uint8Array; mimeType: string; seconds: number | null } | undefined;
    let audioFailed = false;
    let audioTooLarge = false;
    const audioSeconds = described.audio?.seconds ?? null;
    let audioBytes: number | null = described.audio?.fileLength ?? null;
    if (described.audio) {
      const declared = described.audio.fileLength;
      if (declared != null && declared > WHISPER_MAX_BYTES) {
        audioTooLarge = true;
      } else {
        try {
          const bytes = options.downloadAudio
            ? await options.downloadAudio(item)
            : await downloadBaileysMedia(item);
          audioBytes = bytes.byteLength;
          if (bytes.byteLength > WHISPER_MAX_BYTES) {
            audioTooLarge = true;
          } else {
            audio = {
              bytes,
              mimeType: described.audio.mimeType,
              seconds: described.audio.seconds,
            };
          }
        } catch {
          audioFailed = true;
          output.write(`No se pudo descargar el audio ${id}.\n`);
        }
      }
    }
    try {
      await receive({
        id,
        fromPhone: phone,
        text: described.text,
        receivedAt: new Date().toISOString(),
        audio,
        audioFailed,
        ...(audioTooLarge ? { audioTooLarge: true } : {}),
        ...(described.audio ? { audioSeconds, audioBytes } : {}),
        ...(described.attachment ? { attachment: described.attachment } : {}),
        ...(contacts ? { contacts } : {}),
      });
    } catch {
      output.write(`No se pudo registrar el mensaje ${id}.\n`);
    }
  }

  return {
    onMessage(next) {
      handler = next;
    },
    linkedId() {
      const me = authCreds?.me;
      if (!me || typeof me.id !== "string" || me.id.length === 0) return null;
      return me.id;
    },
    async send(toPhone, text, signal?: AbortSignal) {
      if (signal?.aborted) throw new Error("SEND_ABORTED");
      if (!socket) throw new Error("CHANNEL_NOT_READY");
      // sendMessage reads creds.me.id and throws when that object is missing.
      if (!authCreds?.me?.id) throw new Error("CHANNEL_NOT_READY");
      const remembered = rememberedJid(toPhone);
      const fallback = pnSendJid(toPhone);
      const jid = remembered ?? fallback;
      if (!jid) throw new Error("CHANNEL_NOT_READY");
      if (!remembered) {
        output.write(
          `WhatsApp no tiene el jid de ese chat. Se envía a ${maskPhone(toPhone)}.\n`,
        );
      }
      const force = shouldForceBundle(jid);
      if (socket.assertSessions) {
        try {
          await socket.assertSessions([jid], force);
        } catch {
          output.write(
            `WhatsApp no pudo preparar la sesión de ${maskPhone(toPhone)}. No se envió.\n`,
          );
          throw new Error("SIGNAL_SESSION_UNAVAILABLE");
        }
        if (force) {
          bundledAt.set(jid, Date.now());
          dirtyJids.delete(jid);
        }
      }
      // sendMessage cannot be aborted. The caller stops waiting at 60 seconds,
      // releases its lock, and marks sent later only if this promise lands first.
      const sent = await socket.sendMessage(jid, { text });
      const sentId = sent?.key?.id;
      if (typeof sentId === "string" && sent?.message) rememberSentBody(sentId, sent.message);
      return { id: sentId ?? `local-${Date.now()}` };
    },
    whenReady,
    async start() {
      if (started) return;
      started = true;
      stopping = false;
      await connect();
    },
    async stop() {
      stopping = true;
      markClosed();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const retiring = socket;
      socket = null;
      generation += 1;
      retiring?.end(undefined);
      await flushCreds();
    },
    whatsapp: {
      status: () => link.snapshot(),
      suggestedPhone: () => suggested,
      requestPairing,
      refreshQr,
      restart,
      async setProfilePicture(bytes, mimeType) {
        const me = authCreds?.me?.id;
        if (!socket || !me) return { ok: false, error: "not_ready" };
        const update = socket.updateProfilePicture;
        if (!update || !mimeType.startsWith("image/") || bytes.byteLength === 0) {
          output.write("WhatsApp no pudo actualizar la foto de perfil.\n");
          return { ok: false, error: "failed" };
        }
        try {
          await update(me, Buffer.from(bytes));
          output.write("WhatsApp actualizó la foto de perfil.\n");
          return { ok: true };
        } catch {
          output.write("WhatsApp no pudo actualizar la foto de perfil.\n");
          return { ok: false, error: "failed" };
        }
      },
    },
  };
}

function asUpsert(value: unknown): { type?: string; messages?: WaMessage[] } {
  if (!value || typeof value !== "object") return {};
  const record = value as { type?: unknown; messages?: unknown };
  return {
    type: typeof record.type === "string" ? record.type : undefined,
    messages: Array.isArray(record.messages) ? record.messages as WaMessage[] : [],
  };
}

function formatUpsert(
  upsert: { type?: unknown; messages?: unknown },
  replaced: boolean,
): string {
  const type = upsertType(upsert.type);
  const count = Array.isArray(upsert.messages) ? upsert.messages.length : 0;
  const noun = count === 1 ? "mensaje" : "mensajes";
  const where = replaced ? " de una sesión reemplazada" : "";
  return `WhatsApp messages.upsert${where} tipo ${type}, ${count} ${noun}.\n`;
}

function upsertType(type: unknown): string {
  if (typeof type !== "string") return "sin tipo";
  const clean = type.trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(clean)) return "sin tipo";
  return clean;
}

function discardLine(reason: string): string {
  return `WhatsApp descartó un mensaje: ${reason}.\n`;
}

function discardReason(result: {
  reason: "sin jid" | "jid no soportado" | "sin número";
  server: string | null;
}): string {
  const server = shownServer(result.server);
  if (result.reason === "jid no soportado" && server) {
    return `jid no soportado (@${server})`;
  }
  if (result.reason === "sin número" && server) return `sin número (@${server})`;
  return result.reason;
}

function shownServer(server: string | null): string | null {
  if (!server || !/^[a-z0-9.-]{1,32}$/i.test(server)) return null;
  return server;
}

/** Gap before a clean chat may force another prekey bundle. */
const BUNDLE_WINDOW_MS = 60_000;

/** Retry counters per message. Baileys gives up after five on its own. */
const RETRY_CACHE_MAX = 1000;
const RETRY_CACHE_MS = 60 * 60 * 1000;
/** Sent bodies kept for a resend. A retry receipt comes within minutes. */
const SENT_BODIES_MAX = 500;
/** Undecryptable messages in a row from one chat before the log flags it. */
const UNDECRYPTED_STREAK = 3;

/** Baileys CacheStore over a Map. Oldest key falls off first; entries expire. */
export function createMemoryCache(
  max: number,
  ttlMs: number,
  now: () => number = Date.now,
): {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  del(key: string): void;
  flushAll(): void;
} {
  const rows = new Map<string, { value: unknown; until: number }>();
  return {
    get<T>(key: string) {
      const row = rows.get(key);
      if (!row) return undefined;
      if (now() >= row.until) {
        rows.delete(key);
        return undefined;
      }
      return row.value as T;
    },
    set(key, value) {
      rows.delete(key);
      rows.set(key, { value, until: now() + ttlMs });
      while (rows.size > max) {
        const oldest = rows.keys().next().value;
        if (typeof oldest !== "string") break;
        rows.delete(oldest);
      }
    },
    del(key) {
      rows.delete(key);
    },
    flushAll() {
      rows.clear();
    },
  };
}

const FILTERED: unique symbol = Symbol.for("harmony.signalLogFilter");

/** Lines libsignal prints with a SessionEntry. Matched whole, not as substrings. */
const SIGNAL_SESSION_LINES = new Set([
  "Session already closed",
  "Closing session:",
  "Opening session:",
  "Removing old closed session:",
]);

/** console.error lines libsignal prints on every message it cannot open. */
const SIGNAL_ERROR_PREFIXES = [
  "Failed to decrypt message with any known session",
  "Session error:",
];
/** Each distinct libsignal error prints once per window; repeats are counted. */
export const SIGNAL_REPEAT_MS = 60_000;

const signalRepeats = {
  since: 0,
  counts: new Map<string, number>(),
  print: null as ((line: string) => void) | null,
};
let signalRepeatTimer: ReturnType<typeof setInterval> | null = null;

/** Writes the repeat counts for the window that just ended and opens a new one. */
export function flushSignalRepeats(now = Date.now()): void {
  const print = signalRepeats.print;
  for (const [line, count] of signalRepeats.counts) {
    if (count > 0 && print) print(`libsignal repitió ${count} veces en el último minuto: ${line}`);
  }
  signalRepeats.counts.clear();
  signalRepeats.since = now;
}

function signalErrorLine(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first !== "string") return null;
  if (!SIGNAL_ERROR_PREFIXES.some((prefix) => first.startsWith(prefix))) return null;
  return first.split("\n")[0]!.slice(0, 200);
}

/** Drops libsignal session dumps by object shape. Free text stays.
 *  Bad MAC and the other decrypt errors stay on console.error, without the
 *  libsignal stack, and a repeat inside the same minute is only counted.
 */
export function installSignalLogFilter(force = false): void {
  for (const method of ["log", "info", "warn", "debug"] as const) {
    const current = console[method] as ((...args: unknown[]) => void) & {
      [FILTERED]?: boolean;
    };
    if (current[FILTERED] && !force) continue;
    const wrapped = ((...args: unknown[]) => {
      if (isLibsignalSessionDump(args)) return;
      current(...args);
    }) as typeof current;
    wrapped[FILTERED] = true;
    console[method] = wrapped;
  }
  const current = console.error as ((...args: unknown[]) => void) & {
    [FILTERED]?: boolean;
  };
  if (current[FILTERED] && !force) return;
  signalRepeats.counts.clear();
  signalRepeats.since = Date.now();
  signalRepeats.print = (line) => current(line);
  const wrapped = ((...args: unknown[]) => {
    const line = signalErrorLine(args);
    if (!line) {
      current(...args);
      return;
    }
    const now = Date.now();
    if (now - signalRepeats.since >= SIGNAL_REPEAT_MS) flushSignalRepeats(now);
    const seen = signalRepeats.counts.get(line);
    if (seen !== undefined) {
      signalRepeats.counts.set(line, seen + 1);
      return;
    }
    signalRepeats.counts.set(line, 0);
    current(line);
  }) as typeof current;
  wrapped[FILTERED] = true;
  console.error = wrapped;
  if (!signalRepeatTimer) {
    signalRepeatTimer = setInterval(() => flushSignalRepeats(), SIGNAL_REPEAT_MS);
    signalRepeatTimer.unref?.();
  }
}

function isLibsignalSessionDump(args: unknown[]): boolean {
  for (const arg of args) {
    if (isSessionEntry(arg)) return true;
  }
  return isDefensiveSessionDump(args);
}

function isSessionEntry(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name === "SessionEntry";
}

/** Backup when constructor.name is lost. Every argument must be a libsignal
 *  session line or a record that has both indexInfo and _chains.
 */
function isDefensiveSessionDump(args: unknown[]): boolean {
  if (args.length < 2) return false;
  let sawLine = false;
  let sawRecord = false;
  for (const arg of args) {
    if (typeof arg === "string" && SIGNAL_SESSION_LINES.has(arg)) {
      sawLine = true;
      continue;
    }
    if (hasSessionRecordShape(arg)) {
      sawRecord = true;
      continue;
    }
    return false;
  }
  return sawLine && sawRecord;
}

function hasSessionRecordShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as { indexInfo?: unknown; _chains?: unknown };
  return record.indexInfo !== undefined && record._chains !== undefined;
}

installSignalLogFilter();

/** Direct-chat jid Baileys can send to, without a device suffix. */
function canonicalSendJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const trimmed = jid.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return null;
  const rawServer = trimmed.slice(at + 1);
  const server = rawServer === "c.us" ? "s.whatsapp.net" : rawServer;
  if (server !== "lid" && server !== "s.whatsapp.net") return null;
  const user = trimmed.slice(0, at).split(":")[0]?.split("_")[0] ?? "";
  if (!/^[1-9]\d{4,20}$/.test(user)) return null;
  return `${user}@${server}`;
}

function pnSendJid(phone: string): string | null {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  return `${normalized.slice(1)}@s.whatsapp.net`;
}

/** Baileys WebMessageInfo.StubType.CIPHERTEXT. The plaintext never arrived. */
const CIPHERTEXT_STUB = 2;

/** History sync rides in as append, same as an offline direct chat. */
function isHistorySync(item: WaMessage): boolean {
  const protocol = item.message?.protocolMessage;
  if (!protocol) return false;
  if (protocol.historySyncNotification) return true;
  return protocol.type === 5;
}

function isUndecrypted(item: WaMessage): boolean {
  if (item.messageStubType === CIPHERTEXT_STUB) return true;
  const params = item.messageStubParameters;
  if (!Array.isArray(params)) return false;
  return params.some((value) =>
    value === "No matching sessions found for message" ||
    value === "Key used already or never filled" ||
    value === "Message absent from node"
  );
}

function disconnectStatus(code: number | undefined): string | null {
  if (typeof code !== "number" || !Number.isFinite(code)) return null;
  return String(code);
}

function readSuggestedPhone(
  value: string | null | undefined,
  output: Writable,
): string | null {
  const raw = value?.trim() ?? "";
  if (!raw) return null;
  const phone = normalizePairingPhone(raw);
  if (!phone) {
    output.write(
      "BAILEYS_PAIRING_PHONE no es un teléfono válido. Se pedirá en el panel.\n",
    );
    return null;
  }
  return phone;
}

async function downloadBaileysMedia(message: WaMessage): Promise<Uint8Array> {
  const imported = (await import("@whiskeysockets/baileys")) as {
    downloadMediaMessage: (
      item: WaMessage,
      type: "buffer",
      options: { logger?: unknown },
    ) => Promise<Buffer>;
  };
  const buffer = await imported.downloadMediaMessage(message, "buffer", {
    logger: pino({ level: "silent" }),
  });
  return new Uint8Array(buffer);
}
