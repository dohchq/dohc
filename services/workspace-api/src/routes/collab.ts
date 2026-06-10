import { mintCollabToken as signCollabToken } from "@dohc/hocuspocus/auth";
import { encodeDocName } from "@dohc/hocuspocus/doc-name";
import type { Actor } from "@dohc/workspace-contracts";
import { hasWorkspaceMembership } from "@dohc/workspace-postgres";
import type pg from "pg";

export type CollabTokenDeps = {
  pool: pg.Pool;
  // The HS256 secret SHARED with the hocuspocus service. Unset means this
  // deployment runs without a collab server, so the route fails closed
  // instead of minting tokens nothing can verify.
  jwtSecret?: string;
};

export type CollabTokenRequest = { workspaceId?: string; atomPath?: string };

// Auth Option A (phase 10): the workspace API is the only collab-token
// minter. Claim names/TTL come from the same @dohc/hocuspocus/auth module the
// server verifies with, and authzVersion 1 matches the postgres ACL's
// hardcoded getWorkspaceAuthzVersion (equality stale-check).
export async function mintCollabToken(
  deps: CollabTokenDeps | undefined,
  actor: Actor,
  body: CollabTokenRequest,
) {
  if (!deps?.jwtSecret) {
    throw coded("collab-disabled", "live collaboration is not configured on this server");
  }
  if (body.workspaceId !== undefined && body.workspaceId !== actor.workspaceId) {
    throw coded("forbidden", "workspaceId does not match the request route");
  }
  if (typeof body.atomPath !== "string" || !body.atomPath) {
    throw coded("invalid-path", "atomPath is required");
  }
  // Membership before existence so non-members can't probe atom paths.
  if (!(await hasWorkspaceMembership(deps.pool, actor.userId, actor.workspaceId))) {
    throw coded("forbidden", "not a member of this workspace");
  }
  // Paths are mutable; the doc name is keyed by the STABLE atoms.id.
  const atom = await deps.pool.query<{ id: string }>(
    `select id from atoms
     where workspace_id = $1 and path = $2 and deleted_at is null
     limit 1`,
    [actor.workspaceId, body.atomPath],
  );
  const atomId = atom.rows[0]?.id;
  if (!atomId) throw coded("not-found", "atom not found");

  return {
    ok: true,
    token: await signCollabToken(
      { sub: actor.userId, ws: actor.workspaceId, actorKind: "user", authzVersion: 1 },
      deps.jwtSecret,
    ),
    documentName: encodeDocName({ workspaceId: actor.workspaceId, atomId }),
  };
}

function coded(code: string, message: string) {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}
