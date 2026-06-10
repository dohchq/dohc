import { randomUUID } from "node:crypto";
import type { Actor } from "@dohc/workspace-contracts";
import type { PgQueryable } from "./workspaces";

export async function insertWorkspaceEvent(
  db: PgQueryable,
  args: {
    actor: Actor;
    kind: string;
    targetKind: string;
    targetId: string;
    payload?: Record<string, unknown>;
  },
) {
  await db.query(
    `
      insert into workspace_events (
        id,
        workspace_id,
        actor_user_id,
        kind,
        target_kind,
        target_id,
        payload
      )
      values ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `,
    [
      randomUUID(),
      args.actor.workspaceId,
      args.actor.userId,
      args.kind,
      args.targetKind,
      args.targetId,
      JSON.stringify(args.payload ?? {}),
    ],
  );
}
