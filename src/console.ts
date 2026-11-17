import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAnthropicModel } from "./anthropic-model.js";
import { createHarmony } from "./app.js";
import { createConsoleChannel } from "./channels/console.js";
import { openDb } from "./db.js";
import { DEMO_PHONES, seedDemoHouse } from "./demo-house.js";
import { formatSummary, logSummary } from "./log.js";
import { addPerson } from "./people.js";

/**
 * Harmony in the console.
 *   npm run consola -- --demo                         the invented house, in memory
 *   npm run consola -- --alta "Nombre" +5215500000001  registers who runs the home, then starts
 *   npm run consola                                   the house saved in ./data/harmony
 * Each line is a phone and a message: +5215500000003 ¿a qué hora comen los niños?
 * `registro` prints the log report. Ctrl+D ends.
 */

// The API key lives outside git and outside the vault, in a file only the owner can read.
const KEY_FILE = join(homedir(), ".harmony.env");
if (existsSync(KEY_FILE)) process.loadEnvFile(KEY_FILE);
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(`Falta la llave de Anthropic. Guárdala en ${KEY_FILE} como ANTHROPIC_API_KEY=... (chmod 600).`);
  process.exit(1);
}

const args = process.argv.slice(2);
const demo = args.includes("--demo");
const db = await openDb(demo ? undefined : "./data/harmony");

if (demo) {
  await seedDemoHouse(db);
  console.log("Casa Jacaranda (inventada). Quién es quién:");
  console.log(`  ${DEMO_PHONES.mariana}  Mariana, lleva la casa`);
  console.log(`  ${DEMO_PHONES.tomas}  Tomás, lleva la casa`);
  console.log(`  ${DEMO_PHONES.lupita}  Lupita, limpieza y cocina`);
  console.log(`  ${DEMO_PHONES.chuy}  Don Chuy, chofer`);
}

const alta = args.indexOf("--alta");
if (alta >= 0) {
  const [name, phone] = [args[alta + 1], args[alta + 2]];
  if (!name || !phone) throw new Error('Uso: --alta "Nombre" +5215500000001');
  await addPerson(db, { name, kind: "coordinator", phone });
}

const [{ people } = { people: 0 }] = await db.query<{ people: number }>(
  "SELECT count(*)::int AS people FROM people WHERE kind = 'coordinator' AND active",
);
if (people === 0) {
  console.error('La casa está vacía. Empieza con: npm run consola -- --alta "Nombre" +5215500000001, o usa --demo.');
  process.exit(1);
}

const channel = createConsoleChannel(undefined, async (line) =>
  line === "registro" ? formatSummary(await logSummary(db)) : null,
);
createHarmony({ db, channel, model: createAnthropicModel() });
console.log("Escribe el teléfono y el mensaje. `registro` muestra el reporte. Ctrl+D para salir.\n");
await channel.start();
await channel.finished;
await db.close();
