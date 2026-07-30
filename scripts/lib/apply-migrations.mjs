// The single Postgres migration runner shared by `pnpm migrate`
// (scripts/migrate-postgres.mjs), the dev-data reset
// (scripts/reset-postgres-dev-data.mjs), and the self-host compose init
// container. It applies EVERY `*.sql` under
// packages/workspace-postgres/src/db/migrations in filename order. Each
// migration is safe to run once, and every applied id is recorded in
// `dohc_migrations`, so re-running is a no-op.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../packages/workspace-postgres/src/db/migrations/", import.meta.url),
);

// Migration ids are the filenames without `.sql`. The `NNNN_` numeric prefix
// makes lexical sort equal apply order (0001 -> 0002 -> 0003 -> ...).
export async function listMigrations() {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return files.map((file) => ({
    id: file.replace(/\.sql$/, ""),
    file,
    path: join(MIGRATIONS_DIR, file),
  }));
}

// Applies every not-yet-recorded migration, each in its own transaction, and
// records it in `dohc_migrations`. Accepts any pg client/pool (anything with a
// `.query`). Returns the ids applied on THIS call (empty when already current).
export async function applyMigrations(client) {
  await client.query(`
    create table if not exists dohc_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `);
  const existing = await client.query("select id from dohc_migrations");
  const applied = new Set(existing.rows.map((row) => row.id));

  const migrations = await listMigrations();
  const ranNow = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const sql = await readFile(migration.path, "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into dohc_migrations (id) values ($1)", [migration.id]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    ranNow.push(migration.id);
  }
  return ranNow;
}
