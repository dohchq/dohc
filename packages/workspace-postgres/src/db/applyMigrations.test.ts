import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The shared migration runner used by `pnpm migrate`, the dev-data reset, and
// the self-host compose init container. Proving it here is the G2-C-3
// blocker-2 guard: a fresh Postgres must gain the Better Auth schema (0002)
// the surviving auth/relay stack queries, not just 0001.
import { applyMigrations, listMigrations } from "../../../../scripts/lib/apply-migrations.mjs";

const POSTGRES_URL =
  process.env.POSTGRES_URL ?? "postgres://dohc:dohc@localhost:54329/dohc_v2";

// Runs against the live dev Postgres (same requirement as the workspace-auth
// betterAuth conformance test: `pnpm dev:postgres` first). When no Postgres is
// reachable the whole suite skips rather than failing, so unit CI without a
// database stays green.
async function postgresReachable(): Promise<boolean> {
  const probe = new pg.Client({ connectionString: POSTGRES_URL });
  try {
    await probe.connect();
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

const pgAvailable = await postgresReachable();

describe.skipIf(!pgAvailable)("applyMigrations bootstraps the full Postgres schema", () => {
  let client: pg.Client;
  // An isolated schema keeps the assertions non-destructive: the migration SQL
  // is unqualified, so with search_path pointed at a throwaway schema every
  // `create table if not exists` lands there and is dropped on teardown —
  // the shared dev `public` schema is never touched.
  const schema = `mig_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: POSTGRES_URL });
    await client.connect();
    await client.query(`create schema "${schema}"`);
    await client.query(`set search_path to "${schema}"`);
  });

  afterAll(async () => {
    if (client) {
      await client.query(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  });

  it("applies every migration in order, including the Better Auth schema", async () => {
    const migrations = await listMigrations();
    // Sanity: the migration set includes the auth migration this blocker is about.
    expect(migrations.map((m) => m.id)).toContain("0002_better_auth");

    const ran = await applyMigrations(client);
    // A fresh schema gains ALL migrations on the first run, in filename order.
    expect(ran).toEqual(migrations.map((m) => m.id));

    // The Better Auth tables the auth server and sync-relay query now exist,
    // alongside the 0001 workspace core.
    const tables = await client.query<{ rel: string | null }>(
      `select
         to_regclass('"${schema}"."user"') as user_tbl,
         to_regclass('"${schema}"."session"') as session_tbl,
         to_regclass('"${schema}"."deviceCode"') as device_tbl,
         to_regclass('"${schema}".workspaces') as workspaces_tbl`,
    );
    const row = tables.rows[0] as unknown as Record<string, string | null>;
    expect(row.user_tbl).not.toBeNull();
    expect(row.session_tbl).not.toBeNull();
    expect(row.device_tbl).not.toBeNull();
    expect(row.workspaces_tbl).not.toBeNull();

    // The ledger records every applied migration.
    const ledger = await client.query<{ id: string }>(
      `select id from "${schema}".dohc_migrations order by id`,
    );
    expect(ledger.rows.map((r) => r.id)).toEqual(migrations.map((m) => m.id));
  });

  it("is idempotent: a second run applies nothing", async () => {
    const ranAgain = await applyMigrations(client);
    expect(ranAgain).toEqual([]);
  });
});
