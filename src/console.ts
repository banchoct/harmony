import { createAnthropicModel } from "./anthropic-model.js";
import { createHarmony } from "./app.js";
import { createConsoleChannel } from "./channels/console.js";
import { openDb } from "./db.js";
import { DEMO_PHONES, seedDemoHouse } from "./demo-house.js";
import { formatSummary, logSummary } from "./log.js";
import { hasCoordinator } from "./people.js";
import { KEY_FILE, loadSettings } from "./settings.js";

/**
 * Harmony in the console, for trying things out. It never touches the production database.
 *   npm run consola -- --demo    the invented house, in memory
 *   npm run consola              the house saved in ./data/harmony
 * To put who runs the home into that saved house:  DATABASE_URL= npm run alta -- "Nombre" +5215500000001
 * Each line is a phone and a message: +5215500000003 ¿a qué hora comen los niños?
 * `registro` prints the log report. Ctrl+D ends.
 */

loadSettings();
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(`Falta la llave de Anthropic. Guárdala en ${KEY_FILE} como ANTHROPIC_API_KEY=... (chmod 600).`);
  process.exit(1);
}

const demo = process.argv.includes("--demo");
const db = await openDb(demo ? undefined : "./data/harmony");

if (demo) {
  await seedDemoHouse(db);
  console.log("Casa Jacaranda (inventada). Quién es quién:");
  console.log(`  ${DEMO_PHONES.mariana}  Mariana, lleva la casa`);
  console.log(`  ${DEMO_PHONES.tomas}  Tomás, lleva la casa`);
  console.log(`  ${DEMO_PHONES.lupita}  Lupita, limpieza y cocina`);
  console.log(`  ${DEMO_PHONES.chuy}  Don Chuy, chofer`);
}

if (!(await hasCoordinator(db))) {
  console.error('La casa está vacía. Usa --demo, o primero: DATABASE_URL= npm run alta -- "Nombre" +5215500000001');
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
