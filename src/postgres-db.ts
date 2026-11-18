import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import postgres from "postgres";
import { migrate, type Db } from "./db.js";

const REMOTE_TLS = new Set(["require", "verify-ca", "verify-full"]);
const SUPABASE_CA = new URL("../certs/prod-ca-2021.crt", import.meta.url);

export type PostgresSsl = false | { rejectUnauthorized: true; ca: string[] };

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * TLS with verification for any database that is not on this machine. Supabase's public root
 * is not in Node's store, so it is added to those roots. `sslmode=require` passed alone would
 * make postgres.js skip verification, which is why this returns an object.
 */
export function postgresSsl(databaseUrl: string): PostgresSsl {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("INVALID_DATABASE_URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("INVALID_DATABASE_URL");
  if (isLocalHost(url.hostname)) return false;
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode == null || !REMOTE_TLS.has(sslmode)) throw new Error("TLS_REQUIRED");
  return { rejectUnauthorized: true, ca: [...rootCertificates, readFileSync(SUPABASE_CA, "utf8")] };
}

/** The production database, reached with postgres.js. */
export async function openPostgres(databaseUrl: string): Promise<Db> {
  const sql = postgres(databaseUrl, {
    ssl: postgresSsl(databaseUrl),
    max: 3,
    // Fail with an error instead of waiting in silence when the database cannot be reached.
    connect_timeout: 15,
    // Supabase's connection pooler does not keep prepared statements between queries.
    prepare: false,
    onnotice: () => {},
  });
  const query = async <Row>(text: string, params: unknown[] = []): Promise<Row[]> => {
    const rows = await sql.unsafe(text, params as never[]);
    return [...rows] as Row[];
  };
  await migrate({
    query,
    async applyMigration(name, text) {
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx.unsafe("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      });
    },
  });
  return { query, close: () => sql.end() };
}
