import { readFile } from "node:fs/promises";
import pg from "pg";

const url =
  process.env.POSTGRES_URL ?? "postgres://dohc:dohc@localhost:54329/dohc_v2";
const migrationUrls = [
  "0001_initial.sql",
  "0002_better_auth.sql",
  "0003_partial_path_unique.sql",
  "0004_invitations.sql",
  "0005_share_audience_unique.sql",
  "0006_data_fragments.sql",
].map(
  (name) =>
    new URL(`../packages/workspace-postgres/src/db/migrations/${name}`, import.meta.url),
);

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  await client.query(`
    create table if not exists dohc_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `);
  for (const migrationUrl of migrationUrls) {
    const migrationId = migrationUrl.pathname.split("/").at(-1)!.replace(/\.sql$/, "");
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
      data_fragment_shares,
      data_fragments,
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
