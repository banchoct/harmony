import { createAnthropicModel } from "./anthropic-model.js";
import { createHarmony } from "./app.js";
import { deliverPending } from "./delivery.js";
import { recordEvent } from "./log.js";
import { hasCoordinator } from "./people.js";
import { loadSettings, openHouseDb } from "./settings.js";
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
 * WhatsApp allows several linked devices: an older Harmony linked to the same number keeps
 * receiving until it is removed on the phone. Nothing here is in git.
 */

/** One line per step, so the service log shows how far it got. */
const say = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const fail = (what: string, error?: unknown): never => {
  const detail = error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
  console.error(`${new Date().toISOString()} ${what}${detail}`);
  process.exit(1);
};
process.on("uncaughtException", (error) => fail("Error no atrapado", error));
process.on("unhandledRejection", (error) => fail("Promesa rechazada", error));
say("Harmony arrancando.");

loadSettings();
if (!process.env.ANTHROPIC_API_KEY) fail("Falta ANTHROPIC_API_KEY.");

say(process.env.DATABASE_URL ? "Conectando a la base de datos." : "Sin DATABASE_URL: se usa la base en ./data/harmony.");
const db = await openHouseDb();
say("Base de datos lista.");

/** A step of the service: printed, and also kept in the log table, which outlives the host's log. */
const report = (line: string, kind: string, data: Record<string, unknown> = {}) => {
  say(line);
  void recordEvent(db, kind, null, data).catch(() => undefined);
};
report("Servicio iniciado.", "service_started", { commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null });
if (!(await hasCoordinator(db))) fail('La casa está vacía. Primero: npm run alta -- "Nombre" +5215500000001');

const openaiKey = process.env.OPENAI_API_KEY?.trim();
if (!openaiKey) say("Sin OPENAI_API_KEY: Harmony pedirá que le escriban en vez de notas de voz.");

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
const MAX_CODES = 10;
const pairingPhone = process.env.WHATSAPP_PAIRING_PHONE?.trim();
let codesAsked = 0;
const linking = setInterval(() => {
  const view = whatsAppView(channel.whatsapp.status());
  if (view === "connected") {
    clearInterval(linking);
    report("WhatsApp conectado.", "whatsapp_connected");
    return;
  }
  if (!pairingPhone || view !== "qr" || codesAsked >= MAX_CODES) return;
  const attempt = ++codesAsked;
  void channel.whatsapp.requestPairing(pairingPhone).then((result) => {
    // The code is useless a minute later, so it is safe to keep in the log table.
    if (result.ok) report(`Código para vincular WhatsApp (vale un minuto): ${result.code}`, "pairing_code", { code: result.code, attempt });
    else report(`No se pudo pedir el código de vinculación: ${result.error}`, "pairing_failed", { error: result.error, attempt });
  });
}, 3000);

const stop = async () => {
  clearInterval(retry);
  clearInterval(linking);
  await channel.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

say("Conectando a WhatsApp.");
await channel.start();
// If it is not linked after a minute, say in what state the link is.
setTimeout(() => {
  const status = channel.whatsapp.status();
  const view = whatsAppView(status);
  if (view !== "connected") report(`WhatsApp sigue sin conectar: ${view} (fase ${status.phase}).`, "whatsapp_status", { view, phase: status.phase });
}, 60_000);
