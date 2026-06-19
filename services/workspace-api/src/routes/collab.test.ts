import { readFile } from "node:fs/promises";
import { verifyCollabToken } from "@dohc/hocuspocus/auth";
import { decodeDocName } from "@dohc/hocuspocus/doc-name";
import { defaultPostgresUrl } from "@dohc/workspace-postgres";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintCollabToken } from "./collab";

// Live-pg proof that the minted token verifies with the EXACT verifier
// hocuspocus runs, and that documentName round-trips through decodeDocName.
const migrationUrl = new URL(
  "../../../../packages/workspace-postgres/src/db/migrations/0001_initial.sql",
  import.meta.url,
);

const workspaceId = "phase10-collab-ws";
const member = { userId: "phase10_collab_member", workspaceId };
const stranger = { userId: "phase10_collab_stranger", workspaceId };
const atomId = "phase10-collab-atom";
const jwtSecret = "phase10-collab-shared-secret";

let pool: pg.Pool;

beforeEach(async () => {
  pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl });
  await pool.query(await readFile(migrationUrl, "utf8"));
  await clearWorkspace();
  await pool.query(
    `insert into workspaces (id, workspace_id, owner_user_id, slug, name, kind)
     values ($1, $1, $2, $1, 'Collab', 'personal')`,
    [workspaceId, member.userId],
  );
  await pool.query(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ('phase10-collab-membership', $1, $2, 'owner')`,
    [workspaceId, member.userId],
  );
  await pool.query(
    `insert into atoms (id, workspace_id, path, kind, body, revision)
     values ($2, $1, 'notes/live.md', 'markdown', '# Live', 1)`,
    [workspaceId, atomId],
  );
});

afterEach(async () => {
  await clearWorkspace();
  await pool?.end();
});

async function clearWorkspace() {
  for (const table of ["atoms", "workspace_members", "workspaces"]) {
    await pool.query(`delete from ${table} where workspace_id = $1`, [workspaceId]);
  }
}

describe("POST /workspaces/:id/collab/token (live pg)", () => {
  it("mints a token hocuspocus verifies, keyed to the stable atom id", async () => {
    const result = await mintCollabToken({ pool, jwtSecret }, member, {
      atomPath: "notes/live.md",
    });

    expect(result.ok).toBe(true);
    expect(decodeDocName(result.documentName)).toEqual({ workspaceId, atomId });
    expect(result.baseMarkdown).toBe("# Live");
    await expect(verifyCollabToken(result.token, jwtSecret)).resolves.toMatchObject({
      sub: member.userId,
      ws: workspaceId,
      actorKind: "user",
      authzVersion: 1,
    });
  });

  it("rejects strangers and unknown or deleted paths", async () => {
    await expect(
      mintCollabToken({ pool, jwtSecret }, stranger, { atomPath: "notes/live.md" }),
    ).rejects.toMatchObject({ code: "forbidden" });

    await pool.query("update atoms set deleted_at = now() where id = $1", [atomId]);
    await expect(
      mintCollabToken({ pool, jwtSecret }, member, { atomPath: "notes/live.md" }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("only mints rich collaboration tokens for markdown atoms", async () => {
    await pool.query(
      `insert into atoms (id, workspace_id, path, kind, body, revision)
       values ('phase10-collab-csv', $1, 'data/live.csv', 'csv', 'id,name\\n1,Ice', 1)`,
      [workspaceId],
    );

    await expect(
      mintCollabToken({ pool, jwtSecret }, member, { atomPath: "data/live.csv" }),
    ).rejects.toMatchObject({ code: "unsupported-kind" });
  });
});
