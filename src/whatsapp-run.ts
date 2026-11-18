import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAnthropicModel } from "./anthropic-model.js";
import { createHarmony } from "./app.js";
import { openDb } from "./db.js";
import { deliverPending } from "./delivery.js";
import { recordEvent } from "./log.js";
import { createOpenAITranscriber } from "./voice.js";
import { createBaileysChannel, installSignalLogFilter } from "./whatsapp/baileys.js";
import { whatsAppView } from "./whatsapp/link.js";

/**
 * Harmony on WhatsApp, on the dedicated number. `npm run whatsapp`.
 * Settings come from the environment (on Railway) or from ~/.harmony.env:
 *   ANTHROPIC_API_KEY        required
 *   DATABASE_URL             the memory (Supabase). Without it, a database in ./data/harmony
 *   OPENAI_API_KEY           voice notes. Without it Harmony asks people to write
 *   WHATSAPP_SESSION_DIR     where the WhatsApp login keys live. Default ./data/whatsapp-session
 *   WHATSAPP_PAIRING_PHONE   the dedicated number. With it, linking is by an eight-character
 *                            code printed here; without it, by a QR printed here
 * Linking the number here disconnects any other Harmony linked to it. Nothing here is in git.
 */

/** One line per step of the start, so the service log shows how far it got. */
const say = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const fail = (what: string, error: unknown) => {
  console.error(`${new Date().toISOString()} ${what}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
};
process.on("uncaughtException", (error) => fail("Error no atrapado", error));
process.on("unhandledRejection", (error) => fail("Promesa rechazada", error));
say("Harmony arrancando.");

const KEY_FILE = join(homedir(), ".harmony.env");
if (existsSync(KEY_FILE)) process.loadEnvFile(KEY_FILE);
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(`Falta la llave de Anthropic en ${KEY_FILE}.`);
  process.exit(1);
}

say(process.env.DATABASE_URL ? "Conectando a la base de datos." : "Sin DATABASE_URL: se usa la base en ./data/harmony.");
const db = await openDb(process.env.DATABASE_URL?.trim() || "./data/harmony");
say("Base de datos lista.");
// The service's own steps also go to the log table, so they can be read when the host's
// log screen shows nothing.
const note = (kind: string, data: Record<string, unknown> = {}) =>
  recordEvent(db, kind, null, data).catch(() => undefined);
await note("service_started", { commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null });
const [{ people } = { people: 0 }] = await db.query<{ people: number }>(
  "SELECT count(*)::int AS people FROM people WHERE kind = 'coordinator' AND active",
);
if (people === 0) {
  console.error('La casa está vacía. Primero: npm run alta -- "Nombre" +5215500000001');
  process.exit(1);
}

const openaiKey = process.env.OPENAI_API_KEY?.trim();
if (!openaiKey) console.log("Sin OPENAI_API_KEY: Harmony pedirá que le escriban en vez de notas de voz.");

installSignalLogFilter();
const channel = createBaileysChannel({
  sessionDir: process.env.WHATSAPP_SESSION_DIR?.trim() || "./data/whatsapp-session",
});
createHarmony({
  db,
  channel,
  model: createAnthropicModel(),
  transcriber: openaiKey ? createOpenAITranscriber({ apiKey: openaiKey }) : undefined,
});

// A message that could not be sent is tried again here, not only when someone next writes.
const retry = setInterval(() => void deliverPending(db, channel).catch(() => undefined), 30_000);

// Linking by code: WhatsApp > Dispositivos vinculados > Vincular con el número de teléfono.
const pairingPhone = process.env.WHATSAPP_PAIRING_PHONE?.trim();
let codesAsked = 0;
const pairing = setInterval(() => {
  const view = whatsAppView(channel.whatsapp.status());
  if (view === "connected" || !pairingPhone || codesAsked >= 10) {
    if (view === "connected" || codesAsked >= 10) clearInterval(pairing);
    if (view === "connected") void note("whatsapp_connected");
    return;
  }
  if (view !== "qr") return;
  codesAsked += 1;
  void channel.whatsapp.requestPairing(pairingPhone).then((result) => {
    if (result.ok) {
      console.log(`Código para vincular WhatsApp (vale un minuto): ${result.code}`);
      // Useless a minute later, so it is safe to keep in the log table.
      void note("pairing_code", { code: result.code, attempt: codesAsked });
    } else {
      console.log(`No se pudo pedir el código de vinculación: ${result.error}`);
      void note("pairing_failed", { error: result.error, attempt: codesAsked });
    }
  });
}, 3000);

const stop = async () => {
  clearInterval(retry);
  clearInterval(pairing);
  await channel.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

say("Conectando a WhatsApp.");
await channel.start();
say("WhatsApp iniciado. Esperando el código o el QR de vinculación, o la sesión ya guardada.");
// If nothing has happened after a minute, say in what state the link is.
setTimeout(() => {
  const status = channel.whatsapp.status();
  say(`Estado de WhatsApp al minuto: ${whatsAppView(status)} (fase ${status.phase}).`);
  void note("whatsapp_status", { view: whatsAppView(status), phase: status.phase });
}, 60_000);
