import { app, dialog, type IpcMainInvokeEvent } from "electron";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import {
  InboxCaptureFilesResult,
  type InboxAddInput,
  type InboxArchiveInput,
  type InboxCaptureFilesInput,
  type InboxListInput,
  type InboxMoveInput,
  type InboxUndoArchiveInput,
  type InboxUndoMoveInput,
} from "@dohc/workspace-contracts/inbox";
import type { LocalPersonAuthor } from "../workspaces/desktopRecordEdits";
import {
  addInboxItem,
  archiveInboxItem,
  captureFilesToInbox,
  listInboxItems,
  moveInboxItem,
  undoArchiveInboxItem,
  undoMoveInboxItem,
  type InboxOperationLike,
  type WorkspaceInboxHost,
} from "../workspaces/workspaceInbox";
import type {
  inboxDesktopOperations,
  inboxReadOperations,
  inboxWriteOperations,
} from "./inboxOperations";
import type { OperationHandlers } from "./operationTable";

function testInboxImportPaths(): string[] | null {
  if (process.env.DOHC_DESKTOP_TEST !== "1" || app.isPackaged) return null;
  const raw = process.env.DOHC_TEST_IMPORT_PATHS;
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return parsed;
    }
  } catch {
    // Fall through to native dialog.
  }
  return null;
}

export interface InboxIpcDependencies<
  Event extends Pick<IpcMainInvokeEvent, "sender">,
  Operation extends InboxOperationLike,
  Reference,
> {
  exactRendererWorkspaceReferences: {
    capture(
      sender: Event["sender"],
      workspaceId: string,
      inactiveMessage: string,
    ): Promise<Reference>;
    withReference<T>(
      sender: Event["sender"],
      reference: Reference,
      inactiveMessage: string,
      work: (operation: Operation) => Promise<T>,
    ): Promise<T>;
  };
  withRendererWorkspaceOperation<T>(
    sender: Event["sender"],
    workspaceId: string,
    inactiveMessage: string,
    work: (operation: Operation) => Promise<T>,
  ): Promise<T>;
  localPerson(): Promise<LocalPersonAuthor>;
  hostFor(operation: Operation): WorkspaceInboxHost;
}

export function createInboxIpcHandlers<
  Event extends Pick<IpcMainInvokeEvent, "sender">,
  Operation extends InboxOperationLike,
  Reference,
>(
  deps: InboxIpcDependencies<Event, Operation, Reference>,
): {
  reads: OperationHandlers<typeof inboxReadOperations, Event, Operation>;
  writes: OperationHandlers<typeof inboxWriteOperations, Event, Operation>;
  desktop: OperationHandlers<typeof inboxDesktopOperations, Event, Operation>;
} {
  return {
    reads: {
      inboxList: async ({ workspaceId: _workspaceId, ...input }, { operation }) =>
        listInboxItems(operation.workspace, input as InboxListInput, deps.hostFor(operation)),
    },
    writes: {
      inboxAdd: async ({ workspaceId: _workspaceId, ...input }, { operation }) => {
        const person = await deps.localPerson();
        const author: MomentWriteAuthor = person;
        return addInboxItem(
          operation,
          input as InboxAddInput,
          author,
          "capture",
          deps.hostFor(operation),
        );
      },
      inboxArchive: async ({ workspaceId: _workspaceId, ...input }, { operation }) => {
        const person = await deps.localPerson();
        return archiveInboxItem(
          operation,
          input as InboxArchiveInput,
          person,
          person,
          deps.hostFor(operation),
        );
      },
      inboxMove: async ({ workspaceId: _workspaceId, ...input }, { operation }) => {
        const person = await deps.localPerson();
        return moveInboxItem(operation, input as InboxMoveInput, person, deps.hostFor(operation));
      },
    },
    desktop: {
      inboxCaptureFiles: async (input, { event }) => {
        const inactiveMessage = "Inbox capture stopped because this window changed workspaces.";
        const { workspaceId, pick, ...rest } = input as InboxCaptureFilesInput & {
          workspaceId: string;
        };
        if (pick) {
          const reference = await deps.exactRendererWorkspaceReferences.capture(
            event.sender,
            workspaceId,
            inactiveMessage,
          );
          const testPaths = testInboxImportPaths();
          const picked =
            testPaths !== null
              ? { canceled: false, filePaths: testPaths }
              : await dialog.showOpenDialog({
                  properties: ["openFile", "multiSelections"],
                  title: "Capture files to Inbox",
                });
          return deps.exactRendererWorkspaceReferences.withReference(
            event.sender,
            reference,
            inactiveMessage,
            async (operation) => {
              if (picked.canceled || picked.filePaths.length === 0) {
                return InboxCaptureFilesResult.parse({
                  items: [],
                  skipped: 0,
                  skippedSources: [],
                  createdInbox: false,
                });
              }
              const person = await deps.localPerson();
              return InboxCaptureFilesResult.parse(
                await captureFilesToInbox(
                  operation,
                  {
                    ...rest,
                    pickedPaths: picked.filePaths,
                  },
                  person,
                  deps.hostFor(operation),
                ),
              );
            },
          );
        }
        return deps.withRendererWorkspaceOperation(
          event.sender,
          workspaceId,
          inactiveMessage,
          async (operation) => {
            const person = await deps.localPerson();
            return InboxCaptureFilesResult.parse(
              await captureFilesToInbox(operation, rest, person, deps.hostFor(operation)),
            );
          },
        );
      },
      inboxUndoArchive: async ({ workspaceId: _workspaceId, ...input }, { operation }) => {
        const person = await deps.localPerson();
        return undoArchiveInboxItem(
          operation,
          input as InboxUndoArchiveInput,
          person,
          deps.hostFor(operation),
        );
      },
      inboxUndoMove: async ({ workspaceId: _workspaceId, ...input }, { operation }) => {
        const person = await deps.localPerson();
        return undoMoveInboxItem(
          operation,
          input as InboxUndoMoveInput,
          person,
          deps.hostFor(operation),
        );
      },
    },
  };
}
