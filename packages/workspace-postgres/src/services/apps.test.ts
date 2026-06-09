import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresWorkspaceBackend } from "./backend";
import { createPostgresAppsService } from "./apps";
import {
  createMemoryBlobStore,
  createPostgresDatabaseServices,
  type DatabaseSnapshot,
} from "./databaseFiles";
import { defaultPostgresUrl } from "../db/client";

const migrationUrl = new URL("../db/migrations/0001_initial.sql", import.meta.url);

const actor = {
  userId: "phase12_apps_alice",
  workspaceId: "phase12_apps_workspace",
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

async function seedTracker() {
  const backend = createPostgresWorkspaceBackend(pool, {
    blobStore: createMemoryBlobStore(),
  });
  await backend.createAtom(actor, {
    path: "finance/.apps/tracker/src/App.tsx",
    kind: "app-source",
    body: "export default function App() { return null }",
  });
  await backend.createAtom(actor, {
    path: "finance/.apps/tracker/app.json",
    kind: "json",
    body: JSON.stringify({
      title: "Finance Tracker",
      read: ["transactions/**", "ledger.sqlite", "receipt.pdf"],
      write: ["transactions/**", "ledger.sqlite"],
      collections: {
        transactions: {
          source: "transactions/*.md",
          write: "transactions/**",
        },
      },
      databases: {
        ledger: {
          source: "ledger.sqlite",
          write: "ledger.sqlite",
        },
      },
    }),
  });
  await backend.createAtom(actor, {
    path: "finance/transactions/2026-06.md",
    kind: "markdown",
    body: "# June\n{Merchant: \"Grab\"}",
  });
  await backend.createAtom(actor, {
    path: "finance/private.md",
    kind: "markdown",
    body: "nope",
  });
  await backend.saveAsset(actor, {
    path: "finance/receipt.pdf",
    kind: "pdf",
    mediaType: "application/pdf",
    bytes: new TextEncoder().encode("receipt bytes"),
  });
  const databases = createPostgresDatabaseServices(pool, {
    blobStore: createMemoryBlobStore(),
  });
  await databases.createFromSnapshot(actor, {
    path: "finance/ledger.sqlite",
    snapshot: ledgerSnapshot,
  });
}

describe("Postgres app services", () => {
  it("discovers app packages and enforces app scope, trust, and source asset access", async () => {
    await seedTracker();
    const apps = createPostgresAppsService(pool, {
      blobStore: createMemoryBlobStore(),
    });

    const discovered = await apps.discoverPackage(actor, "finance/.apps/tracker");
    expect(discovered).toMatchObject({
      ok: true,
      packageRoot: "finance/.apps/tracker",
      title: "Finance Tracker",
      trusted: false,
      writeTargets: ["finance/ledger.sqlite", "finance/transactions/**"],
    });

    await expect(
      apps.readDoc(actor, {
        packageRoot: "finance/.apps/tracker",
        path: "transactions/2026-06.md",
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "finance/transactions/2026-06.md",
      body: expect.stringContaining("Grab"),
    });

    await expect(
      apps.appendDoc(actor, {
        packageRoot: "finance/.apps/tracker",
        path: "transactions/2026-06.md",
        markdown: "\n{Reviewed: true}",
        operationId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "app-trust-required",
    });

    await expect(
      apps.databaseTables(actor, {
        packageRoot: "finance/.apps/tracker",
        path: "ledger.sqlite",
      }),
    ).resolves.toMatchObject({
      ok: true,
      tables: ["transactions"],
    });

    await expect(
      apps.databaseQuery(actor, {
        packageRoot: "finance/.apps/tracker",
        path: "ledger.sqlite",
        sql: "select merchant, reviewed from transactions where id = ?",
        params: ["txn_001"],
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [{ merchant: "Grab", reviewed: "No" }],
    });

    await expect(
      apps.databaseApply(actor, {
        packageRoot: "finance/.apps/tracker",
        path: "ledger.sqlite",
        operationId: "op-before-trust",
        expectedVersion: 1,
        op: "update",
        table: "transactions",
        rowId: "txn_001",
        payload: { reviewed: "Yes" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "app-trust-required",
    });

    await expect(
      apps.grantTrust(actor, "finance/.apps/tracker"),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      apps.appendDoc(actor, {
        packageRoot: "finance/.apps/tracker",
        path: "transactions/2026-06.md",
        markdown: "\n{Reviewed: true}",
        operationId: randomUUID(),
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      apps.readDoc(actor, {
        packageRoot: "finance/.apps/tracker",
        path: "private.md",
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "source-read-not-granted",
    });

    await expect(
      apps.resolveAsset(actor, {
        packageRoot: "finance/.apps/tracker",
        path: "receipt.pdf",
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "finance/receipt.pdf",
      mediaType: "application/pdf",
    });

    await expect(
      apps.databaseApply(actor, {
        packageRoot: "finance/.apps/tracker",
        path: "ledger.sqlite",
        operationId: "op-review",
        expectedVersion: 1,
        op: "update",
        table: "transactions",
        rowId: "txn_001",
        payload: { reviewed: "Yes" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      version: 2,
    });

    await expect(
      apps.databaseQuery(actor, {
        packageRoot: "finance/.apps/tracker",
        path: "ledger.sqlite",
        sql: "select reviewed from transactions where id = ?",
        params: ["txn_001"],
      }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [{ reviewed: "Yes" }],
    });

    await expect(
      apps.databaseApply(actor, {
        packageRoot: "finance/.apps/tracker",
        path: "private.sqlite",
        operationId: "op-private",
        op: "update",
        table: "transactions",
        rowId: "txn_001",
        payload: { reviewed: "No" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "source-write-not-granted",
    });
  });

  it("resets per-user trust when the manifest write key changes", async () => {
    await seedTracker();
    const apps = createPostgresAppsService(pool);
    const backend = createPostgresWorkspaceBackend(pool);
    const before = await apps.discoverPackage(actor, "finance/.apps/tracker");
    expect(before).toMatchObject({ ok: true, trusted: false });
    await apps.grantTrust(actor, "finance/.apps/tracker");
    await expect(
      apps.discoverPackage(actor, "finance/.apps/tracker"),
    ).resolves.toMatchObject({ ok: true, trusted: true });

    const manifest = await backend.readText(
      actor,
      "finance/.apps/tracker/app.json",
    );
    await backend.writeAtom(actor, {
      path: "finance/.apps/tracker/app.json",
      expectedRevision: manifest.revision,
      body: JSON.stringify({
        title: "Finance Tracker",
        read: ["transactions/**", "budgets.md"],
        write: ["transactions/**", "budgets.md"],
      }),
    });

    await expect(
      apps.discoverPackage(actor, "finance/.apps/tracker"),
    ).resolves.toMatchObject({
      ok: true,
      trusted: false,
      writeTargets: ["finance/budgets.md", "finance/transactions/**"],
    });
  });
});
