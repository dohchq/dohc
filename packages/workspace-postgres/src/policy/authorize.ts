import type { Actor } from "@dohc/workspace-contracts";
import { WorkspaceError } from "@dohc/workspace-contracts";

export async function assertWorkspaceMember(args: {
  actor: Actor;
  workspaceId: string;
  hasMembership: (userId: string, workspaceId: string) => Promise<boolean>;
}) {
  if (args.actor.workspaceId !== args.workspaceId) {
    throw new WorkspaceError(
      "forbidden",
      "Actor workspace does not match target workspace",
    );
  }

  const allowed = await args.hasMembership(
    args.actor.userId,
    args.workspaceId,
  );
  if (!allowed) {
    throw new WorkspaceError("forbidden", "User is not a workspace member");
  }
}
