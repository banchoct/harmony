const E164 = /^\+[1-9]\d{7,14}$/;

/** Accepts a phone already in E.164 or a string of digits, spaces and dashes. */
export function normalizePhone(input: string): string | null {
  const compact = input.trim().replace(/[\s().-]/g, "");
  if (!compact) return null;
  const withPlus = compact.startsWith("+") ? compact : `+${compact}`;
  if (!E164.test(withPlus)) return null;
  return withPlus;
}

/**
 * The seed stores a Mexican mobile as +521 and ten digits.
 * WhatsApp sends 52 and the same ten digits, without that 1.
 * Both keys name one number. Anything else stays a single key.
 */
export function phoneLookupKeys(input: string): string[] {
  const phone = normalizePhone(input);
  if (!phone) return [];
  const legacy = /^\+521(\d{10})$/.exec(phone);
  if (legacy?.[1]) return [phone, `+52${legacy[1]}`];
  const current = /^\+52(\d{10})$/.exec(phone);
  if (current?.[1]) return [`+521${current[1]}`, phone];
  return [phone];
}

/** True when both strings are the same number, including the Mexican mobile pair. */
export function samePhone(left: string, right: string): boolean {
  const keys = phoneLookupKeys(left);
  if (keys.length === 0) return left === right;
  return keys.includes(right);
}

const SEED_MOBILE = /^\+521\d{10}$/;

/**
 * Lookup order when both forms are stored.
 * An active row wins. If both are active, or both are inactive, the seed
 * form +521 and ten digits wins. phoneE164 is the last tie-break.
 * The WhatsApp form is kept in the table but is not the one we answer as.
 */
export function compareActorPhones(
  left: { phoneE164: string; active: boolean },
  right: { phoneE164: string; active: boolean },
): number {
  if (left.active !== right.active) return left.active ? -1 : 1;
  const leftSeed = SEED_MOBILE.test(left.phoneE164) ? 0 : 1;
  const rightSeed = SEED_MOBILE.test(right.phoneE164) ? 0 : 1;
  if (leftSeed !== rightSeed) return leftSeed - rightSeed;
  if (left.phoneE164 < right.phoneE164) return -1;
  if (left.phoneE164 > right.phoneE164) return 1;
  return 0;
}

/**
 * Direct phone jid only. Groups, broadcasts, newsletters and @lid return null.
 * Identity is the WhatsApp account jid, never text inside the message.
 * An @lid chat is resolved by phoneFromDirectKey, not here.
 */
export function phoneFromWhatsAppJid(
  jid: string | null | undefined,
): string | null {
  if (!jid) return null;
  const at = jid.lastIndexOf("@");
  if (at <= 0) return null;
  const server = jid.slice(at + 1);
  if (server !== "s.whatsapp.net") return null;
  const user = jid.slice(0, at).split(":")[0]?.split("_")[0] ?? "";
  if (!/^[1-9]\d{7,14}$/.test(user)) return null;
  return `+${user}`;
}

/** Last four digits. Logs must not carry a full number. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const tail = digits.slice(-4);
  return tail ? `…${tail}` : "…";
}

/**
 * A phone jid, a legacy @c.us jid, or digits. An @lid is not a phone.
 */
export function phoneFromWhatsAppAddress(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const jid = trimmed.includes("@")
    ? trimmed.replace(/@c\.us$/, "@s.whatsapp.net")
    : `${trimmed.replace(/^\+/, "")}@s.whatsapp.net`;
  return phoneFromWhatsAppJid(jid);
}

export interface WhatsAppDirectKey {
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  senderPn?: string | null;
  senderLid?: string | null;
  participantPn?: string | null;
}

export type DirectPhoneResult =
  | { ok: true; phone: string; lids: string[] }
  | {
      ok: false;
      reason: "sin jid" | "jid no soportado" | "sin número";
      server: string | null;
    };

const DROPPED_SERVERS = new Set(["g.us", "broadcast", "newsletter"]);

/**
 * Phone of a direct chat.
 * A PN jid is the account. An @lid is the same chat when WhatsApp also sends
 * the phone on remoteJidAlt, senderPn or participantPn, or we already learned
 * that lid. Groups, broadcasts and newsletters stay out even if a participant
 * phone is attached.
 * Estado: implementado. Falta una validación independiente con un chip real.
 */
export function phoneFromDirectKey(
  key: WhatsAppDirectKey | null | undefined,
  knownLidPhone?: (lidUser: string) => string | null,
): DirectPhoneResult {
  const remote = key?.remoteJid?.trim() ?? "";
  if (!remote) return { ok: false, reason: "sin jid", server: null };
  const parsed = splitJid(remote);
  if (!parsed) return { ok: false, reason: "jid no soportado", server: null };
  if (DROPPED_SERVERS.has(parsed.server)) {
    return { ok: false, reason: "jid no soportado", server: parsed.server };
  }
  if (parsed.server === "s.whatsapp.net" || parsed.server === "c.us") {
    const phone = phoneFromWhatsAppAddress(remote);
    if (!phone) return { ok: false, reason: "jid no soportado", server: parsed.server };
    return { ok: true, phone, lids: lidUsersOf(key) };
  }
  if (parsed.server === "lid") {
    const offered =
      phoneFromWhatsAppAddress(key?.remoteJidAlt) ??
      phoneFromWhatsAppAddress(key?.senderPn) ??
      phoneFromWhatsAppAddress(key?.participantPn);
    const learned = offered ? null : normalizePhone(knownLidPhone?.(parsed.user) ?? "");
    const phone = offered ?? learned;
    if (!phone) return { ok: false, reason: "sin número", server: "lid" };
    return { ok: true, phone, lids: lidUsersOf(key) };
  }
  return { ok: false, reason: "jid no soportado", server: parsed.server };
}

/** User part of an @lid jid, without device. Anything else is null. */
export function lidUserFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const parsed = splitJid(jid.trim());
  if (!parsed || parsed.server !== "lid" || !parsed.user) return null;
  return parsed.user;
}

function lidUsersOf(key: WhatsAppDirectKey | null | undefined): string[] {
  const lids: string[] = [];
  for (const value of [key?.remoteJid, key?.remoteJidAlt, key?.senderLid]) {
    const lid = lidUserFromJid(value);
    if (lid && !lids.includes(lid)) lids.push(lid);
  }
  return lids;
}

function splitJid(jid: string): { user: string; server: string } | null {
  const at = jid.lastIndexOf("@");
  if (at <= 0) return null;
  const server = jid.slice(at + 1);
  const user = jid.slice(0, at).split(":")[0]?.split("_")[0] ?? "";
  if (!server || !user) return null;
  return { user, server };
}
