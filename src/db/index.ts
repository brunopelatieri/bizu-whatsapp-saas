import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { POOL_MAX } from "@/db/nested-section";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

type Database = PostgresJsDatabase<typeof schema>;

let db: Database | undefined;

/**
 * Conexão de runtime: `DATABASE_URL`, papel `bizu_app` (sem BYPASSRLS).
 * Migrations e seed usam `DIRECT_URL` (`bizu_owner`) fora deste módulo.
 */
export function getDb(): Database {
  if (!db) {
    const client = postgres(getEnv().DATABASE_URL, { max: POOL_MAX });
    db = drizzle(client, { schema });
  }

  return db;
}
