import test from "node:test";
import assert from "node:assert/strict";
import {
  lidUserFromJid,
  maskPhone,
  normalizePhone,
  phoneFromDirectKey,
  phoneFromWhatsAppAddress,
  phoneFromWhatsAppJid,
  phoneLookupKeys,
} from "../../src/whatsapp/wa-phone.js";
import { textFromBaileysMessage } from "../../src/whatsapp/baileys-message.js";

test("normalizes phones to E.164", () => {
  assert.equal(normalizePhone("+5215500000001"), "+5215500000001");
  assert.equal(normalizePhone("5215500000001"), "+5215500000001");
  assert.equal(normalizePhone("+52 155 000 000 01"), "+5215500000001");
  assert.equal(normalizePhone("no-es-telefono"), null);
  assert.equal(normalizePhone("+0123"), null);
});

test("a Mexican mobile matches with or without the legacy 1", () => {
  const seeded = "+5215500000001";
  const whatsapp = "+525500000001";
  assert.deepEqual(phoneLookupKeys(seeded), [seeded, whatsapp]);
  assert.deepEqual(phoneLookupKeys(whatsapp), [seeded, whatsapp]);
  assert.deepEqual(phoneLookupKeys("+14155552671"), ["+14155552671"]);
});

test("accepts only direct WhatsApp jids", () => {
  assert.equal(
    phoneFromWhatsAppJid("5215500000001@s.whatsapp.net"),
    "+5215500000001",
  );
  assert.equal(
    phoneFromWhatsAppJid("5215500000001:14@s.whatsapp.net"),
    "+5215500000001",
  );
  assert.equal(phoneFromWhatsAppJid("1203630@g.us"), null);
  assert.equal(phoneFromWhatsAppJid("status@broadcast"), null);
  assert.equal(phoneFromWhatsAppJid("123@newsletter"), null);
  assert.equal(phoneFromWhatsAppJid(null), null);
});

test("reads plain and extended WhatsApp text", () => {
  assert.equal(textFromBaileysMessage({ conversation: "hola" }), "hola");
  assert.equal(
    textFromBaileysMessage({ extendedTextMessage: { text: "eco" } }),
    "eco",
  );
  assert.equal(textFromBaileysMessage(null), "");
  assert.equal(textFromBaileysMessage({}), "");
});

test("an @lid is not a phone, even when the user looks like one", () => {
  const lid = "155500000000001@lid";
  assert.equal(phoneFromWhatsAppJid(lid), null);
  assert.equal(phoneFromWhatsAppAddress(lid), null);
  assert.equal(phoneFromWhatsAppAddress("155500000000001:14@lid"), null);
  assert.deepEqual(phoneFromDirectKey({ remoteJid: lid }), {
    ok: false,
    reason: "sin número",
    server: "lid",
  });
  assert.equal(maskPhone("+5215500000001"), "…0001");
  assert.equal(maskPhone("+5215500000001").includes("5215500000001"), false);
});

test("an @lid resolves when WhatsApp sends the phone beside it", () => {
  const lid = "155500000000001@lid";
  const byAlt = phoneFromDirectKey({
    remoteJid: lid,
    remoteJidAlt: "5215500000001@s.whatsapp.net",
  });
  assert.equal(byAlt.ok, true);
  if (byAlt.ok) {
    assert.equal(byAlt.phone, "+5215500000001");
    assert.deepEqual(byAlt.lids, ["155500000000001"]);
  }
  const bySender = phoneFromDirectKey({
    remoteJid: "155500000000001:14@lid",
    senderPn: "525500000001:14@s.whatsapp.net",
  });
  assert.equal(bySender.ok, true);
  if (bySender.ok) {
    assert.equal(bySender.phone, "+525500000001");
    assert.deepEqual(bySender.lids, ["155500000000001"]);
  }
  const byParticipant = phoneFromDirectKey({
    remoteJid: lid,
    participantPn: "+5215500000001",
  });
  assert.equal(byParticipant.ok && byParticipant.phone, "+5215500000001");
  const learned = phoneFromDirectKey({ remoteJid: lid }, () => "+5215500000001");
  assert.equal(learned.ok && learned.phone, "+5215500000001");
  const altWins = phoneFromDirectKey(
    { remoteJid: lid, remoteJidAlt: "5215500000001@s.whatsapp.net" },
    () => "+14155552671",
  );
  assert.equal(altWins.ok && altWins.phone, "+5215500000001");
});

test("a phone jid is kept and a group stays out even with a participant phone", () => {
  const direct = phoneFromDirectKey({
    remoteJid: "5215500000001:14@s.whatsapp.net",
    senderLid: "155500000000001@lid",
  });
  assert.equal(direct.ok, true);
  if (direct.ok) {
    assert.equal(direct.phone, "+5215500000001");
    assert.deepEqual(direct.lids, ["155500000000001"]);
  }
  const legacy = phoneFromDirectKey({ remoteJid: "5215500000001@c.us" });
  assert.equal(legacy.ok && legacy.phone, "+5215500000001");
  assert.deepEqual(
    phoneFromDirectKey({
      remoteJid: "1203630287654321@g.us",
      participantPn: "5215500000001@s.whatsapp.net",
    }),
    { ok: false, reason: "jid no soportado", server: "g.us" },
  );
  assert.equal(phoneFromDirectKey({ remoteJid: "status@broadcast" }).ok, false);
  assert.equal(phoneFromDirectKey({ remoteJid: "123@newsletter" }).ok, false);
  assert.deepEqual(phoneFromDirectKey(null), {
    ok: false,
    reason: "sin jid",
    server: null,
  });
  assert.equal(phoneFromDirectKey({ remoteJid: "no-es-jid" }).ok, false);
  assert.equal(lidUserFromJid("155500000000001:14@lid"), "155500000000001");
  assert.equal(lidUserFromJid("5215500000001@s.whatsapp.net"), null);
});
