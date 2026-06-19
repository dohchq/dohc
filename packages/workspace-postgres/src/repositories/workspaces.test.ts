import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultPostgresUrl } from "../db/client";
import { listUserWorkspaces } from "./workspaces";

// Live-pg: the workspace list the web shell renders for a session user —
// ownership and live membership included, soft deletes excluded.
const migrationUrl = new URL("../db/migrations/0001_initial.sql", import.meta.url);

const owner = "wslist_owner";
const member = "wslist_member";
const stranger = "wslist_stranger";
const wsA = "wslist_ws_a";
const wsB = "wslist_ws_b";

let pool: pg.Pool;

beforeEach(async () => {
  pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl });
  await pool.query(await readFile(migrationUrl, "utf8"));
  await clear();
  await pool.query(
    `insert into workspaces (id, workspace_id, owner_user_id, slug, name, kind)
     values ($1, $1, $2, $1, 'Workspace A', 'personal'),
            ($3, $3, $2, $3, 'Workspace B', 'shared')`,
    [wsA, owner, wsB],
  );
  await pool.query(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ('wslist_m_owner_a', $1, $2, 'owner'),
            ('wslist_m_member_a', $1, $3, 'member')`,
    [wsA, owner, member],
  );
});

afterEach(async () => {
  await clear();
  await pool?.end();
});

async function clear() {
  for (const table of ["workspace_members", "workspaces"]) {
    await pool.query(`delete from ${table} where workspace_id = any($1)`, [[wsA, wsB]]);
  }
}

describe("listUserWorkspaces (live pg)", () => {
  it("lists owned and member workspaces, nothing for strangers", async () => {
    await expect(listUserWorkspaces(pool, owner)).resolves.toEqual([
      { workspaceId: wsA, name: "Workspace A" },
      // Owned even without a membership row.
      { workspaceId: wsB, name: "Workspace B" },
    ]);
    await expect(listUserWorkspaces(pool, member)).resolves.toEqual([
      { workspaceId: wsA, name: "Workspace A" },
    ]);
    await expect(listUserWorkspaces(pool, stranger)).resolves.toEqual([]);
  });

  it("hides soft-deleted memberships and workspaces", async () => {
    await pool.query(
      "update workspace_members set deleted_at = now() where id = 'wslist_m_member_a'",
    );
    await expect(listUserWorkspaces(pool, member)).resolves.toEqual([]);

    await pool.query("update workspaces set deleted_at = now() where workspace_id = $1", [wsB]);
    await expect(listUserWorkspaces(pool, owner)).resolves.toEqual([
      { workspaceId: wsA, name: "Workspace A" },
    ]);
  });
});
