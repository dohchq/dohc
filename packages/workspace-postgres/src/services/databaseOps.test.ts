import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultPostgresUrl } from "../db/client";
import {
  createMemoryBlobStore,
  createPostgresDatabaseServices,
  type DatabaseSnapshot,
} from "./databaseFiles";

const migrationUrl = new URL("../db/migrations/0001_initial.sql", import.meta.url);

const actor = {
  userId: "phase12_db_alice",
  workspaceId: "phase12_db_workspace",
};

const otherActor = {
  userId: "phase12_db_bob",
  workspaceId: "phase12_db_other_workspace",
};

const WORKSPACE_SCOPED_TABLES = [
  "agent_approvals",
  "agent_runs",
  "app_trust_grants",
  "app_packages",
  "database_operations",
  "database_files",
  "assets",
  "document_states",
  "atom_revisions",
  "atoms",
  "locks",
  "shares",
  "permissions",
  "folders",
  "workspace_events",
  "workspace_members",
  "workspaces",
] as const;

const ledgerSnapshot: DatabaseSnapshot = {
  transactions: {
    columns: [
      { name: "id", type: "TEXT", primaryKey: true },
      { name: "merchant", type: "TEXT" },
      { name: "amount", type: "REAL" },
      { name: "category", type: "TEXT" },
      { name: "reviewed", type: "TEXT" },
    ],
    rows: [
      {
        id: "txn_001",
        merchant: "Grab",
        amount: 420,
        category: "Uncategorized",
        reviewed: "No",
      },
    ],
  },
};

let pool: pg.Pool;

beforeEach(async () => {
  pool = new pg.Pool({
    connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl,
  });
  await pool.query(await readFile(migrationUrl, "utf8"));
  await clearWorkspace(pool, actor.workspaceId, actor.userId);
  await seedWorkspace(pool, actor.workspaceId, actor.userId);
});

afterEach(async () => {
  await clearWorkspace(pool, actor.workspaceId, actor.userId);
  await clearWorkspace(pool, otherActor.workspaceId, otherActor.userId);
  await pool?.end();
});

async function seedWorkspace(db: pg.Pool, workspaceId: string, userId: string) {
  await db.query(
    `
      insert into users (id, workspace_id, token_identifier, email, name)
      values ($1, $2, $3, $4, $5)
      on conflict (id) do nothing
    `,
    [userId, workspaceId, `token:${userId}`, `${userId}@example.com`, userId],
  );
  await db.query(
    `
      insert into workspaces (id, workspace_id, owner_user_id, slug, name, kind)
      values ($1, $1, $2, $3, $4, 'personal')
      on conflict (id) do nothing
    `,
    [workspaceId, userId, workspaceId, workspaceId],
  );
  await db.query(
    `
      insert into workspace_members (id, workspace_id, user_id, role)
      values ($1, $2, $3, 'owner')
      on conflict (workspace_id, user_id) do nothing
    `,
    [`member_${workspaceId}_${userId}`, workspaceId, userId],
  );
}

async function clearWorkspace(db: pg.Pool, workspaceId: string, userId: string) {
  for (const table of WORKSPACE_SCOPED_TABLES) {
    await db.query(`delete from ${quotePgIdent(table)} where workspace_id = $1`, [
      workspaceId,
    ]);
  }
  await db.query("delete from users where id = $1", [userId]);
}

function quotePgIdent(value: (typeof WORKSPACE_SCOPED_TABLES)[number]) {
  if (!/^[a-z_]+$/.test(value)) throw new Error(`Unsafe table name: ${value}`);
  return `"${value}"`;
}

describe("Postgres database services", () => {
  it("creates SQLite database files, applies transactional row ops, logs operations, and materializes bytes", async () => {
    const databases = createPostgresDatabaseServices(pool, {
      blobStore: createMemoryBlobStore(),
    });

    const created = await databases.createFromSnapshot(actor, {
      path: "finance/ledger.sqlite",
      snapshot: ledgerSnapshot,
    });
    expect(created).toMatchObject({
      ok: true,
      path: "finance/ledger.sqlite",
      version: 1,
    });

    await expect(
      databases.tables(actor, "finance/ledger.sqlite"),
    ).resolves.toMatchObject({
      ok: true,
      tables: ["transactions"],
    });

    await expect(
      databases.query(actor, {
        path: "finance/ledger.sqlite",
        sql: "select merchant, amount from transactions where id = ?",
        params: ["txn_001"],
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [{ merchant: "Grab", amount: 420 }],
    });

    await expect(
      databases.apply(actor, {
        path: "finance/ledger.sqlite",
        operationId: "op-insert",
        expectedVersion: 1,
        op: "insert",
        table: "transactions",
        payload: {
          id: "txn_002",
          merchant: "Bookstore",
          amount: 900,
          category: "Books",
          reviewed: "No",
        },
      }),
    ).resolves.toMatchObject({ ok: true, version: 2 });

    await expect(
      databases.apply(actor, {
        path: "finance/ledger.sqlite",
        operationId: "op-review",
        expectedVersion: 2,
        op: "update",
        table: "transactions",
        rowId: "txn_002",
        payload: { reviewed: "Yes" },
      }),
    ).resolves.toMatchObject({ ok: true, version: 3 });

    await expect(
      databases.apply(actor, {
        path: "finance/ledger.sqlite",
        operationId: "op-stale",
        expectedVersion: 1,
        op: "update",
        table: "transactions",
        rowId: "txn_002",
        payload: { category: "Office" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "database-version-conflict",
      currentVersion: 3,
    });

    await expect(
      databases.listOperations(actor, "finance/ledger.sqlite"),
    ).resolves.toMatchObject({
      ok: true,
      operations: [
        expect.objectContaining({ operationId: "op-insert", resultVersion: 2 }),
        expect.objectContaining({ operationId: "op-review", resultVersion: 3 }),
      ],
    });

    const materialized = await databases.materialize(actor, "finance/ledger.sqlite");
    expect(materialized).toMatchObject({
      ok: true,
      mediaType: "application/vnd.sqlite3",
    });
    expect(new TextDecoder().decode(materialized.ok ? materialized.bytes.slice(0, 16) : new Uint8Array())).toBe(
      "SQLite format 3\0",
    );

    await expect(
      databases.ingestSqlite(actor, {
        path: "finance/ledger-copy.sqlite",
        bytes: materialized.ok ? materialized.bytes : new Uint8Array(),
      }),
    ).resolves.toMatchObject({ ok: true, version: 1 });

    await expect(
      databases.query(actor, {
        path: "finance/ledger-copy.sqlite",
        sql: "select reviewed from transactions where id = ?",
        params: ["txn_002"],
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [{ reviewed: "Yes" }],
    });
  });

  it("treats a reused operation id as idempotent ONLY for the identical operation", async () => {
    const databases = createPostgresDatabaseServices(pool, {
      blobStore: createMemoryBlobStore(),
    });
    await databases.createFromSnapshot(actor, {
      path: "finance/ledger.sqlite",
      snapshot: ledgerSnapshot,
    });

    const operation = {
      path: "finance/ledger.sqlite",
      operationId: "op-retry",
      expectedVersion: 1,
      op: "insert" as const,
      table: "transactions",
      payload: {
        id: "txn_002",
        merchant: "Bookstore",
        amount: 900,
        category: "Books",
        reviewed: "No",
      },
    };
    await expect(databases.apply(actor, operation)).resolves.toMatchObject({
      ok: true,
      version: 2,
    });

    // A true retry (identical op/payload; jsonb may reorder keys) replays the
    // recorded success without re-applying.
    await expect(
      databases.apply(actor, { ...operation, payload: { ...operation.payload } }),
    ).resolves.toMatchObject({ ok: true, version: 2, idempotent: true });

    // The same id with a DIFFERENT payload is rejected, not silently "ok".
    await expect(
      databases.apply(actor, {
        ...operation,
        payload: { ...operation.payload, amount: 1 },
      }),
    ).resolves.toMatchObject({ ok: false, code: "operation-id-conflict" });
    // ...and a different op kind under the same id is rejected too.
    await expect(
      databases.apply(actor, {
        ...operation,
        op: "delete",
        rowId: "txn_002",
        payload: {},
      }),
    ).resolves.toMatchObject({ ok: false, code: "operation-id-conflict" });

    // Neither conflict mutated anything: the version is still 2 and the row
    // kept its original amount.
    await expect(
      databases.query(actor, {
        path: "finance/ledger.sqlite",
        sql: "select amount from transactions where id = ?",
        params: ["txn_002"],
      }),
    ).resolves.toMatchObject({ ok: true, rows: [{ amount: 900 }] });
    await expect(
      databases.apply(actor, {
        ...operation,
        operationId: "op-after-conflicts",
        expectedVersion: 2,
        op: "update",
        rowId: "txn_002",
        payload: { reviewed: "Yes" },
      }),
    ).resolves.toMatchObject({ ok: true, version: 3 });
  });

  it("isolates database files and rows by workspace", async () => {
    await seedWorkspace(pool, otherActor.workspaceId, otherActor.userId);
    const databases = createPostgresDatabaseServices(pool, {
      blobStore: createMemoryBlobStore(),
    });

    await databases.createFromSnapshot(actor, {
      path: "finance/ledger.sqlite",
      snapshot: ledgerSnapshot,
    });
    await databases.createFromSnapshot(otherActor, {
      path: "finance/ledger.sqlite",
      snapshot: {
        transactions: {
          columns: ledgerSnapshot.transactions.columns,
          rows: [
            {
              id: "txn_001",
              merchant: "Other workspace",
              amount: 999,
              category: "Private",
              reviewed: "No",
            },
          ],
        },
      },
    });

    await expect(
      databases.query(actor, {
        path: "finance/ledger.sqlite",
        sql: "select merchant from transactions where id = ?",
        params: ["txn_001"],
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [{ merchant: "Grab" }],
    });
    await expect(
      databases.query(otherActor, {
        path: "finance/ledger.sqlite",
        sql: "select merchant from transactions where id = ?",
        params: ["txn_001"],
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [{ merchant: "Other workspace" }],
    });
  });
});
