import type { Db } from "./db.js";
import { saveNote } from "./memory.js";
import { addPerson } from "./people.js";

/**
 * Casa Jacaranda: an invented house for the console demo and the bank of cases.
 * Nobody and nothing here is real. The phones are made up.
 */
export const DEMO_PHONES = {
  mariana: "+5215500000001",
  tomas: "+5215500000002",
  lupita: "+5215500000003",
  chuy: "+5215500000004",
};

export async function seedDemoHouse(db: Db): Promise<void> {
  const mariana = await addPerson(db, { name: "Mariana", kind: "coordinator", phone: DEMO_PHONES.mariana });
  await addPerson(db, { name: "Tomás", kind: "coordinator", phone: DEMO_PHONES.tomas });
  const lupita = await addPerson(db, { name: "Lupita", kind: "staff", phone: DEMO_PHONES.lupita });
  const chuy = await addPerson(db, { name: "Don Chuy", kind: "staff", phone: DEMO_PHONES.chuy });
  const emi = await addPerson(db, { name: "Emi", kind: "member" });
  const sofi = await addPerson(db, { name: "Sofi", kind: "member" });

  const everyone = (body: string, about: string[] = []) =>
    saveNote(db, { body, audience: "all", about, taughtBy: mariana.id });

  await everyone("Lupita se encarga de la limpieza y la cocina, de lunes a viernes de 8:00 a 17:00.", [lupita.id]);
  await everyone("Don Chuy es el chofer, de lunes a viernes de 7:00 a 15:00.", [chuy.id]);
  await everyone("Emi tiene 8 años y Sofi tiene 5. Los dos entran a la escuela a las 8:00 y salen a las 14:00. Don Chuy los lleva y los recoge.", [emi.id, sofi.id, chuy.id]);
  await everyone("Emi tiene futbol martes y jueves de 16:00 a 17:00 en el deportivo. Lo lleva y lo recoge Mariana.", [emi.id]);
  await everyone("La basura se saca martes, jueves y sábado antes de las 7:00.");
  await everyone("Los niños comen a las 14:30 y cenan a las 19:30.", [emi.id, sofi.id]);
  await everyone("La ropa blanca se lava aparte, con agua fría.");
  await everyone("Nunca se le abre la puerta a alguien que no esté anunciado por Mariana o Tomás.");
  await saveNote(db, {
    body: "Emi es alérgico a la nuez. No puede comer nada que la tenga.",
    health: true,
    audience: "restricted",
    viewers: [lupita.id],
    about: [emi.id],
    taughtBy: mariana.id,
  });
  await saveNote(db, {
    body: "Sofi toma su jarabe para la tos a las 20:00, 5 ml, hasta el viernes.",
    health: true,
    audience: "restricted",
    viewers: [lupita.id],
    about: [sofi.id],
    taughtBy: mariana.id,
  });
  await saveNote(db, {
    body: "A Don Chuy se le paga por quincena, los días 15 y último.",
    audience: "restricted",
    viewers: [chuy.id],
    about: [chuy.id],
    taughtBy: mariana.id,
  });
}
