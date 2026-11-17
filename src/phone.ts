const E164 = /^\+[1-9]\d{7,14}$/;
const MEXICAN_MOBILE_OLD_FORM = /^\+521(\d{10})$/;

/**
 * The one stored and compared form of a phone number, or null when the input is not one.
 * A Mexican mobile is written +521 and ten digits by people and +52 and the same ten digits
 * by WhatsApp. Both name one number, so both normalize to the WhatsApp form.
 */
export function normalizePhone(input: string): string | null {
  const compact = input.trim().replace(/[\s().-]/g, "");
  const phone = compact.startsWith("+") ? compact : `+${compact}`;
  if (!E164.test(phone)) return null;
  const mexican = MEXICAN_MOBILE_OLD_FORM.exec(phone);
  return mexican ? `+52${mexican[1]}` : phone;
}
