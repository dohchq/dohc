import { readFile } from "node:fs/promises";
import pg from "pg";

const url =
  process.env.POSTGRES_URL ?? "postgres://dohc:dohc@localhost:54329/dohc_v2";
const migrationUrl = new URL(
  "../packages/workspace-postgres/src/db/migrations/0001_initial.sql",
  import.meta.url,
);

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  const migrationId = "0001_initial";
  await client.query(`
    create table if not exists dohc_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `);
  const applied = await client.query(
    "select 1 from dohc_migrations where id = $1",
    [migrationId],
  );
  if (applied.rowCount === 0) {
    await client.query(await readFile(migrationUrl, "utf8"));
    await client.query("insert into dohc_migrations (id) values ($1)", [
      migrationId,
    ]);
  }
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
