import assert from "node:assert/strict";
import test from "node:test";
import { contactsFromBaileysMessage, parseVcard } from "../../src/whatsapp/contact-card.js";

const card = (...lines: string[]) => ["BEGIN:VCARD", "VERSION:3.0", ...lines, "END:VCARD"].join("\n");

test("the WhatsApp id on a card is the phone, ahead of any other number on it", () => {
  const parsed = parseVcard(
    card("N:Ejemplo;Nuria;;;", "FN:Nuria Ejemplo", "TEL;type=CELL:+1 202 555 0101", "item1.TEL;waid=525500000000:+52 55 0000 0000"),
  );
  assert.deepEqual(parsed, { name: "Nuria Ejemplo", phone: "+525500000000" });
});

test("without a WhatsApp id the first number written with its country code is used", () => {
  const parsed = parseVcard(card("FN:Cora Ejemplo", "TEL;type=HOME:55 0000 0009", "TEL;type=CELL:+52 1 55 0000 0002"));
  assert.deepEqual(parsed, { name: "Cora Ejemplo", phone: "+525500000002" });
});

test("a ten-digit number with no country code is taken as Mexican", () => {
  assert.equal(parseVcard(card("FN:Cora Ejemplo", "TEL;type=CELL:55 0000 0002")).phone, "+525500000002");
});

test("a card with no usable number has no phone", () => {
  assert.deepEqual(parseVcard(card("FN:Nuria Ejemplo")), { name: "Nuria Ejemplo", phone: null });
  assert.equal(parseVcard(card("FN:Nuria Ejemplo", "TEL:12345")).phone, null);
});

test("one card or several come out as a list; a message without cards as null", () => {
  const one = card("FN:Nuria Ejemplo", "TEL;waid=525500000000:+52 55 0000 0000");
  const two = card("FN:Cora Ejemplo", "TEL;waid=525500000002:+52 55 0000 0002");
  assert.equal(contactsFromBaileysMessage({ conversation: "hola" } as never), null);
  assert.deepEqual(contactsFromBaileysMessage({ contactMessage: { vcard: one } }), [
    { name: "Nuria Ejemplo", phone: "+525500000000" },
  ]);
  assert.deepEqual(
    contactsFromBaileysMessage({ contactsArrayMessage: { contacts: [{ vcard: one }, { vcard: two }] } })?.map((c) => c.name),
    ["Nuria Ejemplo", "Cora Ejemplo"],
  );
});
