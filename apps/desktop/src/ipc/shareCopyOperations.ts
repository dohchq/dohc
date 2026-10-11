import { ShareCopyInput, ShareCopyResult } from "@dohc/workspace-contracts/share-copy";
import type { OperationTable } from "./operationTable";
export { ShareCopyInput, ShareCopyResult } from "@dohc/workspace-contracts/share-copy";

export const shareCopyOperations = {
  getShareCopyDetails: {
    capabilityId: "share.copy.read", channel: "desktop:get-share-copy-details", scope: "workspace", guard: "trusted-sender",
    handlerCheck: { check: "shareCopyHandler.withRendererWorkspaceOperation", reason: "Main derives the workspace from the registered window and guards its session and account through the response." },
    payload: ShareCopyInput, result: ShareCopyResult,
  },
} satisfies OperationTable;
