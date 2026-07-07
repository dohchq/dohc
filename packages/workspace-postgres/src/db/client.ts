import pg from "pg";

// Local development fallback only; production/self-hosted services must set
// POSTGRES_URL explicitly rather than consuming these hardcoded credentials.
export const defaultPostgresUrl =
  "postgres://dohc:dohc@localhost:54329/dohc_v2";

export function createPgPool(
  connectionString = process.env.POSTGRES_URL ?? defaultPostgresUrl,
) {
  return new pg.Pool({ connectionString });
}
