import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export const defaultPostgresUrl =
  "postgres://dohc:dohc@localhost:54329/dohc_v2";

export function createPgPool(
  connectionString = process.env.POSTGRES_URL ?? defaultPostgresUrl,
) {
  return new pg.Pool({ connectionString });
}

export function createWorkspaceDb(pool = createPgPool()) {
  return drizzle(pool, { schema });
}

export type WorkspacePostgresDb = ReturnType<typeof createWorkspaceDb>;
