import { addPerson } from "./people.js";
import { loadSettings, openHouseDb } from "./settings.js";

/**
 * Registers who runs the home, the one thing that cannot be done by message because an empty
 * house has nobody with authority yet.   npm run alta -- "Nombre" +5215500000001
 */
loadSettings();
const [name, phone] = process.argv.slice(2);
if (!name || !phone) {
  console.error('Uso: npm run alta -- "Nombre" +5215500000001');
  process.exit(1);
}
const db = await openHouseDb();
try {
  const person = await addPerson(db, { name, kind: "coordinator", phone });
  console.log(`${person.name} ya está en la casa como quien la lleva.`);
} catch (error) {
  const code = error instanceof Error ? error.message : "";
  if (code === "PHONE_INVALID") console.error("Ese teléfono no es válido. Escríbelo con clave de país, por ejemplo +5215500000001.");
  else if (code === "PHONE_TAKEN") console.error("Ese teléfono ya es de alguien de la casa. Los cambios a una persona que ya existe se piden por mensaje a Harmony.");
  else throw error;
  process.exitCode = 1;
} finally {
  await db.close();
}
