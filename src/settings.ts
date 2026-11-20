import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "./db.js";

/** Keys and addresses live here on a developer's machine: outside git, readable by its owner only. */
export const KEY_FILE = join(homedir(), ".harmony.env");

/** Loads the settings file when there is one. On Railway the settings are already in the environment. */
export function loadSettings(): void {
  if (existsSync(KEY_FILE)) process.loadEnvFile(KEY_FILE);
}

/** The house's database: Supabase when DATABASE_URL is set, otherwise the one saved in ./data/harmony. */
export function openHouseDb(): Promise<Db> {
  return openDb(process.env.DATABASE_URL?.trim() || "./data/harmony");
}
