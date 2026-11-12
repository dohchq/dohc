import { z } from "zod";
import { MEMBERS_CAPABILITIES, MembersRequest, MembersResult } from "@dohc/cli/members";
import type { OperationTable } from "./operationTable";

export const MEMBERS_INACTIVE_MESSAGE = "Members stopped because this window changed workspaces.";

export const memberOperations = {
  // The Members page in Settings. Main names the relay workspace from the
  // window's workspace and its signed-in account; the relay decides.
  workspaceMembers: {
    capabilityIdsByAction: MEMBERS_CAPABILITIES,
    channel: "desktop:workspace-members",
    payload: z.object({ workspaceId: z.string().min(1).max(256), request: MembersRequest }).strict(),
    result: MembersResult,
    guard: "active-workspace", scope: "workspace",
    inactiveMessage: MEMBERS_INACTIVE_MESSAGE,
  },
} as const satisfies OperationTable;
