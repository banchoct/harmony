import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAnthropicModel } from "./anthropic-model.js";
import { createHarmony } from "./app.js";
import { openDb } from "./db.js";
import { deliverPending } from "./delivery.js";
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

const KEY_FILE = join(homedir(), ".harmony.env");
if (existsSync(KEY_FILE)) process.loadEnvFile(KEY_FILE);
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(`Falta la llave de Anthropic en ${KEY_FILE}.`);
  process.exit(1);
}

const db = await openDb(process.env.DATABASE_URL?.trim() || "./data/harmony");
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
    return;
  }
  if (view !== "qr") return;
  codesAsked += 1;
  void channel.whatsapp.requestPairing(pairingPhone).then((result) => {
    if (result.ok) console.log(`Código para vincular WhatsApp (vale un minuto): ${result.code}`);
    else console.log(`No se pudo pedir el código de vinculación: ${result.error}`);
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

await channel.start();
