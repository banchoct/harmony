export interface BaileysAudioFields {
  mimetype?: string | null;
  ptt?: boolean | null;
  seconds?: number | null;
  fileLength?: unknown;
  /** Present on the wire. Never copy it into logs or into BaileysContent. */
  url?: string | null;
}

export interface BaileysInnerMessage {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null } | null;
  audioMessage?: BaileysAudioFields | null;
  pttMessage?: BaileysAudioFields | null;
  imageMessage?: { mimetype?: string | null; caption?: string | null } | null;
  documentMessage?: {
    mimetype?: string | null;
    fileName?: string | null;
    caption?: string | null;
    fileLength?: unknown;
    seconds?: number | null;
    url?: string | null;
  } | null;
  protocolMessage?: {
    type?: number | null;
    historySyncNotification?: unknown;
  } | null;
  ephemeralMessage?: { message?: BaileysInnerMessage | null } | null;
  viewOnceMessage?: { message?: BaileysInnerMessage | null } | null;
  viewOnceMessageV2?: { message?: BaileysInnerMessage | null } | null;
  viewOnceMessageV2Extension?: { message?: BaileysInnerMessage | null } | null;
  documentWithCaptionMessage?: { message?: BaileysInnerMessage | null } | null;
  contactMessage?: { displayName?: string | null; vcard?: string | null } | null;
  contactsArrayMessage?: {
    displayName?: string | null;
    contacts?: Array<{ displayName?: string | null; vcard?: string | null } | null> | null;
  } | null;
}

export interface BaileysAudio {
  mimeType: string;
  seconds: number | null;
  fileLength: number | null;
}

export interface BaileysContent {
  text: string;
  /** Same as audio.mimeType. Kept so callers can branch on a string. */
  audioMime: string | null;
  audio: BaileysAudio | null;
  attachment: { kind: "pdf" | "foto"; name: string } | null;
}

const WRAPPERS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
] as const;

export function textFromBaileysMessage(
  message: BaileysInnerMessage | null | undefined,
): string {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.documentMessage?.caption ||
    ""
  );
}

/**
 * Text wins. A voice note without text is audio to transcribe.
 * A file at the top level keeps its name.
 * Audio wrapped by WhatsApp (disappearing chat, view-once, captioned
 * document) is still audio. The media URL is not returned.
 */
export function describeBaileysMessage(
  message: BaileysInnerMessage | null | undefined,
): BaileysContent {
  const text = textFromBaileysMessage(message);
  const attachment = attachmentFrom(message);
  if (text || attachment) return { text, audioMime: null, audio: null, attachment };
  const audio = findAudio(message, 0);
  if (!audio) return { text: "", audioMime: null, audio: null, attachment: null };
  return { text: "", audioMime: audio.mimeType, audio, attachment: null };
}

function findAudio(
  message: BaileysInnerMessage | null | undefined,
  depth: number,
): BaileysAudio | null {
  if (!message || depth > 4) return null;
  const direct = audioInfo(message.audioMessage) ?? audioInfo(message.pttMessage);
  if (direct) return direct;
  for (const key of WRAPPERS) {
    const found = findAudio(message[key]?.message, depth + 1);
    if (found) return found;
  }
  if (depth > 0) return audioDocument(message.documentMessage);
  return null;
}

function audioInfo(raw: BaileysAudioFields | null | undefined): BaileysAudio | null {
  if (!raw || typeof raw !== "object") return null;
  const mime = typeof raw.mimetype === "string" ? raw.mimetype : "";
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const audioMime = base.startsWith("audio/");
  const ogg = base.includes("ogg");
  const voice = raw.ptt === true || base.length === 0;
  if (!audioMime && !ogg && !voice) return null;
  return {
    mimeType: audioMime ? base : "audio/ogg",
    seconds: readSeconds(raw.seconds),
    fileLength: readByteLength(raw.fileLength),
  };
}

function audioDocument(
  document: BaileysInnerMessage["documentMessage"],
): BaileysAudio | null {
  if (!document) return null;
  const mime = typeof document.mimetype === "string" ? document.mimetype : "";
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!base.startsWith("audio/")) return null;
  return {
    mimeType: base,
    seconds: readSeconds(document.seconds),
    fileLength: readByteLength(document.fileLength),
  };
}

function attachmentFrom(
  message: BaileysInnerMessage | null | undefined,
): { kind: "pdf" | "foto"; name: string } | null {
  if (!message) return null;
  const image = message.imageMessage;
  if (image && typeof image.mimetype === "string" && image.mimetype.startsWith("image/")) {
    return { kind: "foto", name: "foto" };
  }
  const document = message.documentMessage;
  if (!document) return null;
  const name = typeof document.fileName === "string" && document.fileName.trim()
    ? document.fileName.trim()
    : "manual";
  return { kind: "pdf", name };
}

export function readByteLength(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  if (typeof value === "string" && /^\d{1,16}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (value && typeof value === "object" && "toString" in value) {
    const text = String(value);
    if (/^\d{1,16}$/.test(text)) {
      const parsed = Number(text);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
  }
  return null;
}

function readSeconds(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d{1,6}(?:\.\d+)?$/.test(value)
      ? Number(value)
      : null;
  if (parsed == null || !Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}
