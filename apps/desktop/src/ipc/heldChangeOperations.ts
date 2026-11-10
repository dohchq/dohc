import { HeldChange } from "@dohc/workspace-contracts/held-changes";
import { z } from "zod";
import type { OperationTable } from "./operationTable";

const workspace = { workspaceId: z.string().min(1).max(256) };
const path = z.string().min(1).max(4096);

export const heldChangeOperations = {
  readHeldChange: {
    capabilityId: "document.held.read",
    channel: "desktop:read-held-change",
    scope: "workspace",
    guard: "active-workspace",
    inactiveMessage: "dohc stopped reading this held change because this window changed workspaces.",
    payload: z.object({ ...workspace, path }).strict(),
    result: z.object({ change: HeldChange.nullable() }).strict(),
  },
} satisfies OperationTable;
