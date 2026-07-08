// `pnpm migrate` — the dedicated, idempotent Postgres migration command the dev
// flow and the self-host bootstrap run. It applies every migration under
// packages/workspace-postgres/src/db/migrations (including the Better Auth
// schema in 0002) so a fresh Postgres has the tables the workspace-api auth
// server and the sync-relay query BEFORE either service serves an auth request.
// Non-destructive: creates/records schema only, never truncates.
import pg from "pg";
import { applyMigrations } from "./lib/apply-migrations.mjs";

const url = process.env.POSTGRES_URL ?? "postgres://dohc:dohc@localhost:54329/dohc_v2";

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const ran = await applyMigrations(client);
  if (ran.length === 0) {
    console.log("[migrate] Postgres is up to date — no migrations to apply.");
  } else {
    console.log(`[migrate] applied ${ran.length} migration(s): ${ran.join(", ")}`);
  }
} finally {
  await client.end();
}
