import {
  InboxCaptureFilesInput,
  InboxCaptureFilesResult,
  InboxUndoArchiveInput,
  InboxUndoArchiveResult,
  InboxUndoMoveInput,
  InboxUndoMoveResult,
} from "@dohc/workspace-contracts/inbox";
import { WORKSPACE_ID } from "./bridgeContract";
import { declaredRows, declaredWriteRows, type OperationTable } from "./operationTable";

export const inboxReadOperations = declaredRows("inbox", WORKSPACE_ID) satisfies OperationTable;

export const inboxWriteOperations = declaredWriteRows(
  "inbox",
  WORKSPACE_ID,
) satisfies OperationTable;

export const inboxDesktopOperations = {
  inboxCaptureFiles: {
    capabilityId: "inbox.capture.files",
    scope: "workspace",
    handlerCheck: {
      check: "inboxHandlers.currentWorkspaceOperation",
      reason:
        "File picker dialogs open before taking the workspace lease, then verify the same workspace.",
    },
    channel: "desktop:inbox-capture-files",
    payload: InboxCaptureFilesInput.extend({ workspaceId: WORKSPACE_ID }).strict(),
    result: InboxCaptureFilesResult,
    guard: "trusted-sender",
  },
  inboxUndoArchive: {
    capabilityId: "inbox.archive.undo",
    scope: "workspace",
    channel: "desktop:inbox-undo-archive",
    inactiveMessage: "Undo stopped because this window changed workspaces.",
    payload: InboxUndoArchiveInput.extend({ workspaceId: WORKSPACE_ID }).strict(),
    result: InboxUndoArchiveResult,
    guard: "active-workspace",
  },
  inboxUndoMove: {
    capabilityId: "inbox.move.undo",
    scope: "workspace",
    channel: "desktop:inbox-undo-move",
    inactiveMessage: "Undo stopped because this window changed workspaces.",
    payload: InboxUndoMoveInput.extend({ workspaceId: WORKSPACE_ID }).strict(),
    result: InboxUndoMoveResult,
    guard: "active-workspace",
  },
} as const satisfies OperationTable;
