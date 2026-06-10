import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// Local development fallback only; production/self-hosted services must set
// POSTGRES_URL explicitly rather than consuming these hardcoded credentials.
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
