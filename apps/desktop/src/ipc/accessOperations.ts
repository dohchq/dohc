import { z } from "zod";
import { AccessAnswer, AccessRefreshInput, ObjectAccessInput, SharingAccessInput } from "@dohc/workspace-contracts/access";
import type { OperationTable } from "./operationTable";

const workspaceId = z.string().min(1).max(256);
export const accessOperations = {
  getObjectAccess: {
    capabilityId: "access.object.read", channel: "desktop:get-object-access", scope: "workspace", guard: "active-workspace",
    inactiveMessage: "This workspace is no longer open in this window.",
    payload: ObjectAccessInput.extend({ workspaceId }), result: AccessAnswer,
  },
  listSharingAccess: {
    capabilityId: "access.sharing.read", channel: "desktop:list-sharing-access", scope: "workspace", guard: "active-workspace",
    inactiveMessage: "This workspace is no longer open in this window.",
    payload: SharingAccessInput.extend({ workspaceId }), result: AccessAnswer,
  },
  requestAccessRefresh: {
    capabilityId: "access.refresh", channel: "desktop:request-access-refresh", scope: "workspace", guard: "active-workspace",
    inactiveMessage: "This workspace is no longer open in this window.",
    payload: AccessRefreshInput.extend({ workspaceId }),
  },
} satisfies OperationTable;
