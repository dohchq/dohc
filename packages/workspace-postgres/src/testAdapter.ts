import { readFile } from "node:fs/promises";
import pg from "pg";
import type { WorkspaceBackendTestAdapter } from "@dohc/workspace-contracts";
import { createPostgresWorkspaceBackend } from "./services/backend";
import { defaultPostgresUrl } from "./db/client";
import { seedWorkspaceMembershipFixtures } from "./repositories/workspaces";

let currentPool: pg.Pool | null = null;

const migrationUrl = new URL(
  "./db/migrations/0001_initial.sql",
  import.meta.url,
);

export const postgresTestAdapter: WorkspaceBackendTestAdapter = {
  name: "postgres",
  async setup() {
    currentPool = new pg.Pool({
      connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl,
    });
    await migrateAndReset(currentPool);
    await seedWorkspaceMembershipFixtures(currentPool);

    return {
      backend: createPostgresWorkspaceBackend(currentPool),
      actor: { userId: "alice", workspaceId: "workspace_a" },
      otherActor: { userId: "bob", workspaceId: "workspace_b" },
    };
  },
  async teardown() {
    if (!currentPool) return;
    try {
      await truncateWorkspaceTables(currentPool);
    } finally {
      await currentPool.end();
      currentPool = null;
    }
  },
};

async function migrateAndReset(pool: pg.Pool) {
  await pool.query(await readFile(migrationUrl, "utf8"));
  await truncateWorkspaceTables(pool);
}

async function truncateWorkspaceTables(pool: pg.Pool) {
  await pool.query(`
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
}
