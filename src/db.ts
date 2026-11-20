import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { openPostgres } from "./postgres-db.js";

/** The only door to the database. Postgres SQL: PGlite in console and tests, Supabase in production. */
export interface Db {
  query<Row>(sql: string, params?: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

/** A database the migrations can be applied to. */
export interface Migratable extends Pick<Db, "query"> {
  /** Runs a whole migration file and records its name, together or not at all. */
  applyMigration(name: string, sql: string): Promise<void>;
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations/", import.meta.url));

export async function migrate(target: Migratable): Promise<void> {
  await target.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)");
  const applied = new Set((await target.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    await target.applyMigration(name, await readFile(MIGRATIONS_DIR + name, "utf8"));
  }
}

function pgliteDb(pg: PGlite): Db & Migratable {
  return {
    async query<Row>(sql: string, params: unknown[] = []) {
      return (await pg.query<Row>(sql, params)).rows;
    },
    async applyMigration(name, sql) {
      await pg.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      });
    },
    close: () => pg.close(),
  };
}

/** A migrated, empty database, built once per process. Creating one from scratch takes seconds. */
let emptyDatabase: Promise<Blob | File> | null = null;

async function openInMemory(): Promise<PGlite> {
  emptyDatabase ??= (async () => {
    const seed = new PGlite();
    await migrate(pgliteDb(seed));
    const snapshot = await seed.dumpDataDir("none");
    await seed.close();
    return snapshot;
  })();
  return new PGlite({ loadDataDir: await emptyDatabase });
}

/**
 * Opens the database with every migration applied.
 *   a postgres:// address  the production database (Supabase)
 *   a directory            a database saved in that folder
 *   nothing                a database in memory, for tests and the demo
 */
export async function openDb(target?: string): Promise<Db> {
  if (target && /^postgres(ql)?:\/\//.test(target)) return openPostgres(target);
  if (!target) return pgliteDb(await openInMemory());
  await mkdir(dirname(resolve(target)), { recursive: true });
  const db = pgliteDb(new PGlite(target));
  await migrate(db);
  return db;
}
