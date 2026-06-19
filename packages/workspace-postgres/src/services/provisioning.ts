import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Actor } from "@dohc/workspace-contracts";
import { WorkspaceError } from "@dohc/workspace-contracts";
import { hasWorkspaceMembership } from "../repositories/workspaces";
import { withTransaction } from "./backend";

export type ProvisionWorkspaceInput = {
  workspaceId: string;
  name: string;
  kind: "personal" | "shared";
};

// Enabling cloud sync claims the desktop's local workspace id. The claim is
// atomic (unique workspace_id): members re-claim idempotently; anyone else
// hitting an existing id is forbidden — a collision never grants access.
export function createPostgresWorkspaceProvisioner(pool: pg.Pool) {
  return async (actor: Actor, input: ProvisionWorkspaceInput) => {
    const claimed = await withTransaction(pool, async (client) => {
      const inserted = await client.query(
        `
          insert into workspaces (id, workspace_id, owner_user_id, slug, name, kind)
          values ($1, $1, $2, $1, $3, $4)
          on conflict do nothing
        `,
        [input.workspaceId, actor.userId, input.name, input.kind],
      );
      if ((inserted.rowCount ?? 0) === 0) return false;
      await client.query(
        `
          insert into workspace_members (id, workspace_id, user_id, role)
          values ($1, $2, $3, 'owner')
        `,
        [randomUUID(), input.workspaceId, actor.userId],
      );
      return true;
    });
    if (claimed) return { created: true };
    if (await hasWorkspaceMembership(pool, actor.userId, input.workspaceId)) {
      return { created: false };
    }
    throw new WorkspaceError("forbidden", "workspace id belongs to another user");
  };
}
