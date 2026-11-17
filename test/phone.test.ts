import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone } from "../src/phone.js";

test("normalizePhone turns digits with spaces and dashes into E.164", () => {
  assert.equal(normalizePhone(" 1 415 555-0100 "), "+14155550100");
  assert.equal(normalizePhone("+14155550100"), "+14155550100");
});

test("normalizePhone rejects what is not a phone number", () => {
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone("soy la señora de la casa"), null);
  assert.equal(normalizePhone("+12"), null);
});

test("both forms of a Mexican mobile normalize to the one WhatsApp sends", () => {
  assert.equal(normalizePhone("+5215500000001"), "+525500000001");
  assert.equal(normalizePhone("52 55 0000 0001"), "+525500000001");
});
