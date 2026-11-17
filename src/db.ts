import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

/** The only door to the database. Postgres SQL; PGlite here, Supabase in production. */
export interface Db {
  query<Row>(sql: string, params?: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations/", import.meta.url));

async function migrate(pg: PGlite): Promise<void> {
  await pg.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)");
  const applied = new Set(
    (await pg.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = await readFile(MIGRATIONS_DIR + name, "utf8");
    await pg.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    });
  }
}

/** A migrated, empty database, built once per process. Creating one from scratch takes seconds. */
let emptyDatabase: Promise<Blob | File> | null = null;

async function openInMemory(): Promise<PGlite> {
  emptyDatabase ??= (async () => {
    const seed = new PGlite();
    await migrate(seed);
    const snapshot = await seed.dumpDataDir("none");
    await seed.close();
    return snapshot;
  })();
  return new PGlite({ loadDataDir: await emptyDatabase });
}

/** Opens the database with every migration applied. Without a directory it lives in memory. */
export async function openDb(dataDir?: string): Promise<Db> {
  let pg: PGlite;
  if (dataDir) {
    pg = new PGlite(dataDir);
    await migrate(pg);
  } else {
    pg = await openInMemory();
  }
  return {
    async query<Row>(sql: string, params: unknown[] = []) {
      return (await pg.query<Row>(sql, params)).rows;
    },
    close: () => pg.close(),
  };
}
