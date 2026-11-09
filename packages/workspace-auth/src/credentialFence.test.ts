import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresCredentialFence, type CredentialFenceChange } from "./credentialFence";

// Runs against the dev Postgres, as the migration test does, in a throwaway
// schema. Without a reachable Postgres the suite skips, unless
// DOHC_REQUIRE_POSTGRES=1 makes that a failure.
const POSTGRES_URL = process.env.POSTGRES_URL ?? "postgres://dohc:dohc@localhost:54329/dohc";
const MIGRATIONS = new URL("../../workspace-postgres/src/db/migrations/", import.meta.url);
const probe = new pg.Client({ connectionString: POSTGRES_URL, connectionTimeoutMillis: 30_000 });
let pgAvailable = false;
try {
  await probe.connect();
  await probe.end();
  pgAvailable = true;
} catch (error) {
  if (process.env.DOHC_REQUIRE_POSTGRES === "1") {
    throw new Error(`DOHC_REQUIRE_POSTGRES=1 but no Postgres is reachable at ${POSTGRES_URL}.`, { cause: error });
  }
}

describe.skipIf(!pgAvailable)("the credential fence", () => {
  const schema = `fence_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let pool: pg.Pool;
  const fence = () => createPostgresCredentialFence(pool, {
    verifyPassword: async ({ hash, password }) => hash === `hash:${password}`,
  });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: POSTGRES_URL, options: `-c search_path=${schema}` });
    await pool.query(`create schema "${schema}"`);
    for (const migration of ["0001_better_auth.sql", "0005_credential_fences.sql"]) {
      await pool.query(await readFile(new URL(migration, MIGRATIONS), "utf8"));
    }
  });

  afterAll(async () => {
    await pool?.query(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  async function account(userId: string, password: string): Promise<void> {
    await pool.query(`insert into "user" (id, name, email, "emailVerified") values ($1, $1, $1 || '@example.test', true)`, [userId]);
    await pool.query(`insert into "account" (id, "accountId", "providerId", "userId", password, "updatedAt")
      values ($1, $1, 'credential', $1, $2, now())`, [userId, `hash:${password}`]);
  }

  async function session(userId: string, sessionId: string): Promise<void> {
    await pool.query(`insert into "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
      values ($1, now() + interval '1 day', $1, clock_timestamp(), now(), $2)`, [sessionId, userId]);
  }

  it("increases the epoch in the transaction that changes the password, and only then", async () => {
    await account("fence-change", "first");
    expect(await fence().readEpoch("fence-change")).toBe(1);
    await pool.query(`update "account" set "updatedAt" = now() where "userId" = 'fence-change'`);
    expect(await fence().readEpoch("fence-change")).toBe(1);

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`update "account" set password = 'hash:rolled-back' where "userId" = 'fence-change'`);
      await client.query("rollback");
    } finally {
      client.release();
    }
    expect(await fence().readEpoch("fence-change")).toBe(1);

    await pool.query(`update "account" set password = 'hash:second' where "userId" = 'fence-change'`);
    expect(await fence().readEpoch("fence-change")).toBe(2);
    expect(await fence().readEpoch("no-such-account")).toBe(0);
  });

  it("notifies listeners when a change commits", async () => {
    await account("fence-listen", "first");
    let up!: () => void;
    const listening = new Promise<void>(resolve => { up = resolve; });
    let changed!: (change: CredentialFenceChange) => void;
    const change = new Promise<CredentialFenceChange>(resolve => { changed = resolve; });
    const listener = fence().listen({
      onUp: () => up(),
      onDown: () => undefined,
      onChange: (next) => { if (next.userId === "fence-listen") changed(next); },
    });
    try {
      await listening;
      await pool.query(`update "account" set password = 'hash:second' where "userId" = 'fence-listen'`);
      expect(await change).toMatchObject({ userId: "fence-listen", epoch: 2 });
    } finally {
      await listener.close();
    }
  });

  it("reads the hash, epoch, and session for consent from one statement", async () => {
    await account("fence-consent", "first");
    await session("fence-consent", "fence-consent-old");
    await pool.query(`update "account" set password = 'hash:second' where "userId" = 'fence-consent'`);
    await session("fence-consent", "fence-consent-new");

    const old = await fence().readConsentCredentials("fence-consent", "fence-consent-old");
    expect(old).toEqual({ passwordHash: "hash:second", epoch: 2, sessionCurrent: false });
    const current = await fence().readConsentCredentials("fence-consent", "fence-consent-new");
    expect(current).toEqual({ passwordHash: "hash:second", epoch: 2, sessionCurrent: true });
    expect(await fence().verifyPassword(current!.passwordHash!, "first")).toBe(false);
    expect(await fence().verifyPassword(current!.passwordHash!, "second")).toBe(true);
    // Another account's session is not this account's.
    await account("fence-consent-other", "other");
    expect((await fence().readConsentCredentials("fence-consent-other", "fence-consent-new"))?.sessionCurrent).toBe(false);
    expect(await fence().readConsentCredentials("no-such-account", "fence-consent-new")).toBeNull();
  });

  it("lists the fences changed at or after a position", async () => {
    await account("fence-position", "first");
    const [latest] = (await fence().changedSince(0)).filter(change => change.userId === "fence-position");
    expect(latest).toMatchObject({ userId: "fence-position", epoch: 1 });
    expect((await fence().changedSince(latest!.changedAtMs)).map(change => change.userId)).toContain("fence-position");
    expect((await fence().changedSince(latest!.changedAtMs + 60_000)).map(change => change.userId)).not.toContain("fence-position");
  });
});
