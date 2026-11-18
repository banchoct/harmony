import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { addPerson } from "./people.js";

/**
 * Registers who runs the home, the one thing that cannot be done by message because an empty
 * house has nobody with authority yet.   npm run alta -- "Nombre" +5215500000001
 */
const KEY_FILE = join(homedir(), ".harmony.env");
if (existsSync(KEY_FILE)) process.loadEnvFile(KEY_FILE);

const [name, phone] = process.argv.slice(2);
if (!name || !phone) {
  console.error('Uso: npm run alta -- "Nombre" +5215500000001');
  process.exit(1);
}
const db = await openDb(process.env.DATABASE_URL?.trim() || "./data/harmony");
const person = await addPerson(db, { name, kind: "coordinator", phone });
console.log(`${person.name} quedó registrada como quien lleva la casa.`);
await db.close();
