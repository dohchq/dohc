import pg from "pg";
import { applyMigrations } from "./lib/apply-migrations.mjs";

const url =
  process.env.POSTGRES_URL ?? "postgres://dohc:dohc@localhost:54329/dohc_v2";

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  // Ensure the FULL schema is present before truncating — notably the Better
  // Auth tables in 0002 that the surviving auth/relay stack queries.
  // Previously this script applied only 0001, so a fresh dev Postgres was left
  // without the auth schema. applyMigrations is idempotent (create-if-not-
  // exists SQL + a dohc_migrations ledger), so this is safe to re-run.
  await applyMigrations(client);
  await client.query(`
    truncate table
      agent_approvals,
      agent_runs,
      app_trust_grants,
      app_packages,
      database_operations,
      database_files,
      assets,
      document_states,
      atom_revisions,
      atoms,
      locks,
      shares,
      permissions,
      folders,
      workspace_events,
      workspace_members,
      workspaces,
      users
    restart identity cascade
  `);
} finally {
  await client.end();
}
