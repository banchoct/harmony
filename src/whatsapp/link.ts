import { createHash } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import QRCode from "qrcode";

/**
 * Estado de la vinculación del chip, sin hablar con WhatsApp.
 * Estado: implementado. Falta vincular el chip de verdad.
 */
export type WhatsAppPhase = "waiting" | "connected" | "closed";

/**
 * Lo que dice la página. `waiting` mezclaba «sin QR», «con QR» y «código en pantalla».
 * `code` es el estado «esperando código».
 */
export type WhatsAppView = "preparing" | "qr" | "code" | "connected" | "closed";

/** El código de 8 caracteres sale de la página al minuto. WhatsApp no lo deja vivo más tiempo. */
export const PAIRING_CODE_TTL_MS = 60_000;

/** Zona quieta del estándar: 4 módulos. */
export const QR_MARGIN_MODULES = 4;

/**
 * Ancho al que apunta el PNG, en píxeles enteros.
 * La página no lo amplía por CSS: un payload corto no se queda en un cuadro chico.
 */
export const QR_TARGET_PX = 360;

/** 401 logged out, 500 bad session and 403 forbidden cannot reconnect with the same keys. */
export function whatsAppSessionEnded(statusCode: number | undefined): boolean {
  return statusCode === 401 || statusCode === 500 || statusCode === 403;
}

/** Integer pixels per module so the PNG lands near QR_TARGET_PX without a CSS upscale. */
export function qrModuleScale(modules: number): number {
  const span = modules + QR_MARGIN_MODULES * 2;
  if (span < 1) return 1;
  return Math.max(1, Math.floor(QR_TARGET_PX / span));
}

export interface WhatsAppLinkSnapshot {
  phase: WhatsAppPhase;
  /** Raw Baileys payload. The page draws it as an image and does not print it. */
  qr: string | null;
  /** Eight characters, shown as XXXX-XXXX. Null until someone asks for one, and after it expires. */
  pairingCode: string | null;
  /** E.164 of the chip the code was requested for. */
  pairingPhone: string | null;
  /** Epoch ms. Null when no code is on screen. */
  pairingExpiresAt?: number | null;
}

export type PairingFailure =
  | "invalid_phone"
  | "not_ready"
  | "already_connected"
  | "closed"
  | "failed";

export type PairingResult =
  | { ok: true; code: string; phoneE164: string }
  | { ok: false; error: PairingFailure };

export type RestartResult =
  | { ok: true }
  | { ok: false; error: "not_closed" | "failed" };

export type RefreshQrResult =
  | { ok: true }
  | { ok: false; error: "not_waiting" | "failed" };

export interface WhatsAppLinkPort {
  status(): WhatsAppLinkSnapshot;
  /** From BAILEYS_PAIRING_PHONE, already E.164. Empty when unset or invalid. */
  suggestedPhone(): string | null;
  requestPairing(phone: string): Promise<PairingResult>;
  /** Drops the current QR and code and asks the socket for another. Does not wipe a logged-in session. */
  refreshQr(): Promise<RefreshQrResult>;
  restart(): Promise<RestartResult>;
  /** Sets the chip account photo. Bytes stay on the server. */
  setProfilePicture(
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

/** What the browser may see. The QR payload stays on the server. */
export interface WhatsAppPublicStatus {
  phase: WhatsAppPhase | "unavailable";
  view: WhatsAppView | "unavailable";
  qr: boolean;
  /** Short hash of the payload. The browser uses it as an ETag and does not receive the payload. */
  qrTag: string | null;
  pairingCode: string | null;
  pairingExpiresAt: number | null;
}

export function whatsAppView(status: WhatsAppLinkSnapshot): WhatsAppView {
  if (status.phase === "connected") return "connected";
  if (status.phase === "closed") return "closed";
  if (status.pairingCode) return "code";
  if (status.qr) return "qr";
  return "preparing";
}

/** Stable id for one QR payload. Not the payload itself. */
export function qrPayloadTag(payload: string): string {
  return createHash("sha256").update(payload).digest("base64url").slice(0, 22);
}

export function qrEtag(payload: string): string {
  return `"${qrPayloadTag(payload)}"`;
}

export function whatsAppPublicStatus(
  status: WhatsAppLinkSnapshot | null,
): WhatsAppPublicStatus {
  if (!status) {
    return {
      phase: "unavailable",
      view: "unavailable",
      qr: false,
      qrTag: null,
      pairingCode: null,
      pairingExpiresAt: null,
    };
  }
  const qr = status.qr !== null && status.qr.length > 0;
  return {
    phase: status.phase,
    view: whatsAppView(status),
    qr,
    qrTag: qr && status.qr ? qrPayloadTag(status.qr) : null,
    pairingCode: status.pairingCode,
    pairingExpiresAt: status.pairingCode ? status.pairingExpiresAt ?? null : null,
  };
}

export interface WhatsAppLinkState {
  phase(): WhatsAppPhase;
  hasQr(): boolean;
  /** A live QR, or a code still on screen. The second request must not wait for a QR we just cleared. */
  readyForCode(): boolean;
  snapshot(): WhatsAppLinkSnapshot;
  onQr(qr: string): void;
  onOpen(): void;
  onClose(reason: "logged_out" | "dropped"): void;
  notePairing(phoneE164: string, code: string): void;
  discardPairing(): void;
  beginRestart(): void;
}

export function createWhatsAppLinkState(clock: () => number = Date.now): WhatsAppLinkState {
  let phase: WhatsAppPhase = "waiting";
  let qr: string | null = null;
  let pairingCode: string | null = null;
  let pairingPhone: string | null = null;
  let pairingUntil = 0;

  function clearCode(): void {
    pairingCode = null;
    pairingPhone = null;
    pairingUntil = 0;
  }

  function discardPairing(): void {
    clearCode();
    if (phase === "waiting") qr = null;
  }

  /** The code leaves memory, and therefore the HTML. The QR keeps its own rotation. */
  function expirePairing(): void {
    if (!pairingCode || pairingUntil === 0 || clock() < pairingUntil) return;
    clearCode();
  }

  function read(): WhatsAppLinkSnapshot {
    expirePairing();
    return {
      phase,
      qr,
      pairingCode,
      pairingPhone,
      pairingExpiresAt: pairingCode ? pairingUntil : null,
    };
  }

  return {
    phase: () => phase,
    hasQr: () => qr !== null && qr.length > 0,
    readyForCode() {
      const current = read();
      if (current.phase !== "waiting") return false;
      return Boolean(current.qr) || Boolean(current.pairingCode);
    },
    snapshot: read,
    onQr(value) {
      if (phase !== "waiting" || value.length === 0) return;
      qr = value;
    },
    onOpen() {
      discardPairing();
      phase = "connected";
      qr = null;
      clearCode();
    },
    onClose(reason) {
      discardPairing();
      qr = null;
      clearCode();
      if (reason === "logged_out") {
        phase = "closed";
        return;
      }
      if (phase !== "closed") phase = "waiting";
    },
    notePairing(phoneE164, code) {
      if (phase !== "waiting") return;
      discardPairing();
      pairingPhone = phoneE164;
      pairingCode = code;
      pairingUntil = clock() + PAIRING_CODE_TTL_MS;
    },
    discardPairing,
    beginRestart() {
      phase = "waiting";
      discardPairing();
    },
  };
}

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * E.164 for the dedicated chip.
 * A 10-digit number is a Mexican mobile and gains +52.
 * +521 and ten digits is the old WhatsApp form of the same mobile: it
 * becomes +52 and those ten digits, which is what Baileys pairs.
 */
export function normalizePairingPhone(input: string): string | null {
  const compact = input.trim().replace(/[\s().-]/g, "");
  if (!compact) return null;
  let digits = compact.startsWith("+") ? compact.slice(1) : compact;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 10) digits = `52${digits}`;
  if (/^521\d{10}$/.test(digits)) digits = `52${digits.slice(3)}`;
  const phone = `+${digits}`;
  if (!E164.test(phone)) return null;
  return phone;
}

/** Digits Baileys expects: E.164 without the plus. */
export function pairingDigits(phoneE164: string): string {
  return phoneE164.startsWith("+") ? phoneE164.slice(1) : phoneE164;
}

/** Baileys returns eight Crockford characters. The phone UI shows a hyphen. */
export function formatPairingCode(code: string): string | null {
  const compact = code.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (!/^[0-9A-Z]{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/**
 * WhatsApp accepted the link. Baileys 6.7 stores `account` on pair-success
 * and leaves `registered` false; that file is a finished companion session.
 */
export function acceptedPairing(
  creds: { registered?: boolean; me?: unknown; account?: unknown } | null | undefined,
): boolean {
  if (!creds?.me) return false;
  return creds.registered === true || creds.account != null;
}

/**
 * A code request that saved `me` and then died, before WhatsApp accepted it.
 * Baileys would try to log in with that half-written file and never offer a QR again.
 * An accepted pairing is not unfinished, even when `registered` is still false.
 */
export function unfinishedPairing(
  creds: { registered?: boolean; me?: unknown; account?: unknown } | null | undefined,
): boolean {
  return Boolean(creds?.me) && !acceptedPairing(creds);
}

const REFUSED_DIRS = new Set([
  "/",
  "/data",
  "/home",
  "/usr",
  "/var",
  "/etc",
  "/opt",
  "/tmp",
  "/root",
]);

/** Refuses filesystem roots so a bad BAILEYS_SESSION_DIR cannot wipe the volume. */
export function sessionDirAllowed(dir: string): string {
  const resolved = resolve(dir);
  if (resolved.length < 2 || REFUSED_DIRS.has(resolved)) {
    throw new Error("SESSION_DIR_REFUSED");
  }
  const parts = resolved.split(sep).filter(Boolean);
  if (parts.length < 2) throw new Error("SESSION_DIR_REFUSED");
  return resolved;
}

/** Deletes the Baileys session directory and recreates it empty. */
export async function clearSessionDirectory(dir: string): Promise<void> {
  const resolved = sessionDirAllowed(dir);
  try {
    const stat = await lstat(resolved);
    if (stat.isSymbolicLink()) throw new Error("SESSION_DIR_REFUSED");
  } catch (error) {
    if (error instanceof Error && error.message === "SESSION_DIR_REFUSED") throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  await rm(resolved, { recursive: true, force: true });
  await mkdir(resolved, { recursive: true });
}

/** PNG of the current QR payload. Null when the payload cannot be drawn. */
export async function renderQrPng(payload: string): Promise<Buffer | null> {
  if (!payload) return null;
  try {
    const symbol = QRCode.create(payload, { errorCorrectionLevel: "M" });
    return await QRCode.toBuffer(payload, {
      type: "png",
      margin: QR_MARGIN_MODULES,
      scale: qrModuleScale(symbol.modules.size),
      errorCorrectionLevel: "M",
    });
  } catch {
    return null;
  }
}
