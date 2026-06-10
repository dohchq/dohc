import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultPostgresUrl } from "../db/client";
import { hasWorkspaceMembership } from "../repositories/workspaces";
import { createPostgresWorkspaceProvisioner } from "./provisioning";

const migrationUrl = new URL("../db/migrations/0001_initial.sql", import.meta.url);

const workspaceId = "phase9-provision-workspace";
const owner = { userId: "phase9_provision_alice", workspaceId };
const intruder = { userId: "phase9_provision_mallory", workspaceId };

let pool: pg.Pool;

beforeEach(async () => {
  pool = new pg.Pool({
    connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl,
  });
  await pool.query(await readFile(migrationUrl, "utf8"));
  await clearWorkspace();
});

afterEach(async () => {
  await clearWorkspace();
  await pool?.end();
});

async function clearWorkspace() {
  await pool.query("delete from workspace_members where workspace_id = $1", [workspaceId]);
  await pool.query("delete from workspaces where workspace_id = $1", [workspaceId]);
}

describe("Postgres workspace provisioning", () => {
  it("creates once, re-claims idempotently for members, and forbids collisions", async () => {
    const provision = createPostgresWorkspaceProvisioner(pool);
    const input = { workspaceId, name: "Provisioned", kind: "personal" as const };

    await expect(provision(owner, input)).resolves.toEqual({ created: true });
    await expect(hasWorkspaceMembership(pool, owner.userId, workspaceId)).resolves.toBe(true);
    const row = await pool.query(
      "select id, owner_user_id, slug, name, kind from workspaces where workspace_id = $1",
      [workspaceId],
    );
    expect(row.rows).toEqual([{
      id: workspaceId,
      owner_user_id: owner.userId,
      slug: workspaceId,
      name: "Provisioned",
      kind: "personal",
    }]);

    await expect(provision(owner, input)).resolves.toEqual({ created: false });
    const members = await pool.query(
      "select role from workspace_members where workspace_id = $1",
      [workspaceId],
    );
    expect(members.rows).toEqual([{ role: "owner" }]);

    await expect(provision(intruder, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(hasWorkspaceMembership(pool, intruder.userId, workspaceId)).resolves.toBe(false);
  });
});
