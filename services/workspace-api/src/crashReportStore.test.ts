import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresCrashReportStore } from "./crashReports";

// Runs against the development Postgres (`pnpm dev:postgres`) in a throwaway
// schema, and skips when no Postgres answers, like applyMigrations.test.ts.
const POSTGRES_URL = process.env.POSTGRES_URL ?? "postgres://dohc:dohc@localhost:54329/dohc";
const MIGRATION = new URL(
  "../../../packages/workspace-postgres/src/db/migrations/0003_crash_reports.sql",
  import.meta.url,
);

async function postgresReachable(): Promise<boolean> {
  const probe = new pg.Client({ connectionString: POSTGRES_URL, connectionTimeoutMillis: 2000 });
  try {
    await probe.connect();
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!(await postgresReachable()))("crash report store", () => {
  const schema = `crash_reports_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let client: pg.Client;
  // The store takes a pool, as main.ts gives it, pointed at the same schema.
  let pool: pg.Pool;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: POSTGRES_URL });
    await client.connect();
    await client.query(`create schema "${schema}"`);
    await client.query(`set search_path to "${schema}"`);
    await client.query(await readFile(MIGRATION, "utf8"));
    pool = new pg.Pool({ connectionString: POSTGRES_URL, options: `-c search_path=${schema}`, max: 8 });
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await client?.query(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await client?.end().catch(() => undefined);
  });

  beforeEach(async () => {
    await client.query("delete from crash_reports");
  });

  it("stores a report with its version and the time it arrived", async () => {
    const store = createPostgresCrashReportStore(pool);
    expect(await store.insert({ id: "r1", appVersion: "0.9.0", body: "dohc crash report\n\nx" })).toBe(true);
    const rows = await client.query<{ id: string; app_version: string; body: string; recent: boolean }>(
      "select id, app_version, body, received_at > now() - interval '1 minute' as recent from crash_reports",
    );
    expect(rows.rows).toEqual([{ id: "r1", app_version: "0.9.0", body: "dohc crash report\n\nx", recent: true }]);
  });

  it("refuses a report once storage holds the most it keeps", async () => {
    const store = createPostgresCrashReportStore(pool, 2);
    expect(await store.insert({ id: "a", appVersion: null, body: "dohc crash report" })).toBe(true);
    expect(await store.insert({ id: "b", appVersion: null, body: "dohc crash report" })).toBe(true);
    expect(await store.insert({ id: "c", appVersion: null, body: "dohc crash report" })).toBe(false);
    expect((await client.query("select id from crash_reports order by id")).rows).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("never stores past the cap, however many inserts run at once", async () => {
    const store = createPostgresCrashReportStore(pool, 3);
    await store.insert({ id: "first", appVersion: null, body: "dohc crash report" });
    await store.insert({ id: "second", appVersion: null, body: "dohc crash report" });
    // Eight connections race for the one place left.
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      store.insert({ id: `racer-${index}`, appVersion: null, body: "dohc crash report" })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await client.query("select count(*)::int as n from crash_reports")).rows).toEqual([{ n: 3 }]);
  });

  it("deletes only reports older than 90 days", async () => {
    const store = createPostgresCrashReportStore(pool);
    for (const id of ["old", "recent"]) {
      await store.insert({ id, appVersion: null, body: "dohc crash report" });
    }
    await client.query("update crash_reports set received_at = now() - interval '91 days' where id = 'old'");
    await client.query("update crash_reports set received_at = now() - interval '89 days' where id = 'recent'");
    expect(await store.deleteExpired()).toBe(1);
    expect((await client.query("select id from crash_reports")).rows).toEqual([{ id: "recent" }]);
  });

  it("deletes more expired reports than one batch holds", async () => {
    const store = createPostgresCrashReportStore(pool, undefined, 2);
    for (const id of ["a", "b", "c", "d", "e", "recent"]) {
      await store.insert({ id, appVersion: null, body: "dohc crash report" });
    }
    await client.query("update crash_reports set received_at = now() - interval '91 days' where id <> 'recent'");
    expect(await store.deleteExpired()).toBe(5);
    expect((await client.query("select id from crash_reports")).rows).toEqual([{ id: "recent" }]);
  });
});
