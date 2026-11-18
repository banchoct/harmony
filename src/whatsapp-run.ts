import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAnthropicModel } from "./anthropic-model.js";
import { createHarmony } from "./app.js";
import { openDb } from "./db.js";
import { deliverPending } from "./delivery.js";
import { createOpenAITranscriber } from "./voice.js";
import { createBaileysChannel, installSignalLogFilter } from "./whatsapp/baileys.js";

/**
 * Harmony on WhatsApp, on the dedicated number. `npm run whatsapp`.
 * The first run prints a QR to scan with the WhatsApp of that number. Linking it here
 * disconnects any other Harmony linked to the same number.
 * The house is the one saved in ./data/harmony; the WhatsApp login keys live in
 * ./data/whatsapp-session. Both stay out of git.
 */

const KEY_FILE = join(homedir(), ".harmony.env");
if (existsSync(KEY_FILE)) process.loadEnvFile(KEY_FILE);
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(`Falta la llave de Anthropic en ${KEY_FILE}.`);
  process.exit(1);
}

const db = await openDb("./data/harmony");
const [{ people } = { people: 0 }] = await db.query<{ people: number }>(
  "SELECT count(*)::int AS people FROM people WHERE kind = 'coordinator' AND active",
);
if (people === 0) {
  console.error('La casa está vacía. Primero: npm run consola -- --alta "Nombre" +5215500000001');
  process.exit(1);
}

const openaiKey = process.env.OPENAI_API_KEY?.trim();
if (!openaiKey) console.log("Sin OPENAI_API_KEY: Harmony pedirá que le escriban en vez de notas de voz.");

installSignalLogFilter();
const channel = createBaileysChannel({ sessionDir: "./data/whatsapp-session" });
createHarmony({
  db,
  channel,
  model: createAnthropicModel(),
  transcriber: openaiKey ? createOpenAITranscriber({ apiKey: openaiKey }) : undefined,
});

// A message that could not be sent is tried again here, not only when someone next writes.
const retry = setInterval(() => void deliverPending(db, channel).catch(() => undefined), 30_000);

const stop = async () => {
  clearInterval(retry);
  await channel.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

await channel.start();
