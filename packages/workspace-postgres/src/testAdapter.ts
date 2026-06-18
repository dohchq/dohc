import { readFile } from "node:fs/promises";
import pg from "pg";
import type { WorkspaceBackendTestAdapter } from "@dohc/workspace-contracts";
import { createPostgresWorkspaceBackend } from "./services/backend";
import { defaultPostgresUrl } from "./db/client";
import {
  seedWorkspaceMembershipFixtures,
  workspaceFixtureIds,
} from "./repositories/workspaces";

let currentPool: pg.Pool | null = null;

// Live tests apply the full migration chain so the partial path-unique indexes
// (0003) are present — without them delete-then-recreate wedges (see phase-09).
const migrationUrls = [
  new URL("./db/migrations/0001_initial.sql", import.meta.url),
  new URL("./db/migrations/0003_partial_path_unique.sql", import.meta.url),
];

export const postgresTestAdapter: WorkspaceBackendTestAdapter = {
  name: "postgres",
  async setup() {
    const pool = new pg.Pool({
      connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl,
    });
    try {
      await migrateAndReset(pool);
      await seedWorkspaceMembershipFixtures(pool);
    } catch (error) {
      await pool.end().catch(() => {});
      throw error;
    }

    currentPool = pool;

    return {
      backend: createPostgresWorkspaceBackend(currentPool),
      actor: {
        userId: workspaceFixtureIds.aliceUserId,
        workspaceId: workspaceFixtureIds.aliceWorkspaceId,
      },
      otherActor: {
        userId: workspaceFixtureIds.bobUserId,
        workspaceId: workspaceFixtureIds.bobWorkspaceId,
      },
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
  for (const url of migrationUrls) {
    await pool.query(await readFile(url, "utf8"));
  }
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
}
