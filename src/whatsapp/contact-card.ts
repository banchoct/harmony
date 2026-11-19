import { normalizePhone } from "../phone.js";

/** A person on a contact card shared in a chat. `phone` is null when the card has no usable number. */
export interface SharedContact {
  name: string;
  phone: string | null;
}

export interface BaileysContactCarrier {
  contactMessage?: { vcard?: string | null } | null;
  contactsArrayMessage?: { contacts?: Array<{ vcard?: string | null } | null> | null } | null;
}

/** The cards in a WhatsApp message, or null when it carries none. */
export function contactsFromBaileysMessage(message: BaileysContactCarrier | null | undefined): SharedContact[] | null {
  if (!message) return null;
  const many = message.contactsArrayMessage?.contacts;
  const single = message.contactMessage;
  if (!many && !single) return null;
  const cards = many ?? (single ? [single] : []);
  return cards.map((card) => {
    const vcard = typeof card?.vcard === "string" ? card.vcard : "";
    return vcard.trim() ? parseVcard(vcard) : { name: "", phone: null };
  });
}

export function parseVcard(vcard: string): SharedContact {
  const tels: Array<{ waid: string | null; value: string }> = [];
  let name = "";
  for (const line of unfold(vcard)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const key = parsed.name.toUpperCase();
    if (key === "FN" && !name) name = cleanName(parsed.value);
    if (key === "TEL") tels.push({ waid: waidOf(parsed.params), value: parsed.value.replace(/^tel:/i, "").trim() });
  }
  return { name, phone: phoneFromTels(tels) };
}

/**
 * The number WhatsApp itself marks on the card (waid) is the one the person writes from, so it
 * wins. Otherwise the first number written with a country code, and last a ten-digit number,
 * taken as Mexican.
 */
function phoneFromTels(tels: Array<{ waid: string | null; value: string }>): string | null {
  for (const tel of tels) {
    const phone = tel.waid ? normalizePhone(tel.waid) : null;
    if (phone) return phone;
  }
  for (const tel of tels) {
    const phone = tel.value.startsWith("+") ? normalizePhone(tel.value) : null;
    if (phone) return phone;
  }
  for (const tel of tels) {
    const digits = tel.value.replace(/\D/g, "");
    if (digits.length === 10) return normalizePhone(`+52${digits}`);
  }
  return null;
}

function unfold(vcard: string): string[] {
  const raw = vcard.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] = (lines[lines.length - 1] ?? "") + line.slice(1);
    } else if (line.trim()) {
      lines.push(line.trim());
    }
  }
  return lines;
}

function parseLine(line: string): { name: string; params: string; value: string } | null {
  const match = /^(?:[A-Za-z0-9-]+\.)?([A-Za-z0-9-]+)((?:;[^:]*)?):(.*)$/.exec(line.trim());
  if (!match?.[1]) return null;
  return { name: match[1], params: match[2] ?? "", value: (match[3] ?? "").trim() };
}

function waidOf(params: string): string | null {
  return /(?:^|;)waid=(\d+)/i.exec(params)?.[1] ?? null;
}

function cleanName(value: string): string {
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.includes("\0")) return "";
  return [...name].slice(0, 100).join("");
}
