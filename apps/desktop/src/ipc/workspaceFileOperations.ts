import { DuplicateWorkspaceFilePayload, DuplicateWorkspaceFileResult } from "./bridgeContract";
import {
  ListWorkspaceFilesPayload,
  ListWorkspaceFilesResult,
  CreateWorkspaceFilePayload,
  CreateWorkspaceFileResult,
  CreateWorkspaceFolderPayload,
  MoveWorkspacePathPayload,
  MoveWorkspacePathResult,
  DeleteWorkspacePathPayload,
  DeleteWorkspacePathResult,
  UndoHistoryOperationPayload,
  UndoHistoryOperationResult,
  ExportWorkspaceZipPayload,
  ExportWorkspaceZipResult,
  ExportDocumentFilePayload,
  ExportDocumentFileResult,
  ImportWorkspaceFilesPayload,
  ImportWorkspaceFilesResult,
  ReadWorkspaceTextPayload,
  ReadWorkspaceTextResult,
  WriteWorkspaceTextPayload,
  WriteWorkspaceTextResult,
  WriteWorkspaceAssetPayload,
  PickImageFilesPayload,
  PickImageFilesResult,
  OpenFileExternallyPayload,
} from "./bridgeContract";
import type { OperationTable } from "./operationTable";

export const workspaceFileOperations = {
  listWorkspaceFiles: {
    capabilityId: "file.list", channel: "desktop:list-workspace-files",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "File listing stopped because this window changed workspaces.",
    payload: ListWorkspaceFilesPayload, result: ListWorkspaceFilesResult,
  },
  createWorkspaceFile: {
    capabilityId: "file.create", channel: "desktop:create-workspace-file",
    scope: "workspace", guard: "trusted-sender",
    handlerCheck: {
      check: "workspaceFileMutationOwner.runAdmittedMutation + withStaleSensitiveWorkspaceOperation",
      reason: "The mutation owner retains renderer admission, writable/share checks, and its mutation lease.",
    },
    payload: CreateWorkspaceFilePayload, result: CreateWorkspaceFileResult,
  },
  createWorkspaceFolder: {
    capabilityId: "folder.create", channel: "desktop:create-workspace-folder",
    scope: "workspace", guard: "trusted-sender",
    handlerCheck: {
      check: "workspaceFileMutationOwner.runAdmittedMutation + withStaleSensitiveWorkspaceOperation",
      reason: "The mutation owner retains renderer admission, writable/share checks, and its mutation lease.",
    },
    payload: CreateWorkspaceFolderPayload, result: CreateWorkspaceFileResult,
  },
  duplicateWorkspaceFile: {
    capabilityId: "file.duplicate", channel: "desktop:duplicate-workspace-file",
    scope: "workspace", guard: "trusted-sender",
    handlerCheck: {check: "workspaceFileMutationOwner.runAdmittedMutation + duplicateWorkspaceFile/withExclusiveWorkspaceOperation", reason: "The mutation owner admits the workspace and holds the same mutation lease as moves."},
    payload: DuplicateWorkspaceFilePayload, result: DuplicateWorkspaceFileResult,
  },
  moveWorkspacePath: {
    capabilityId: "file.move", channel: "desktop:move-workspace-path",
    scope: "workspace", guard: "trusted-sender",
    handlerCheck: {
      check: "workspaceFileMutationOwner.runAdmittedMutation + moveWorkspacePathByHand/withExclusiveWorkspaceOperation",
      reason: "The mutation owner retains renderer admission, writable/share checks, and its mutation lease.",
    },
    payload: MoveWorkspacePathPayload, result: MoveWorkspacePathResult,
  },
  deleteWorkspacePath: {
    capabilityId: "file.delete", channel: "desktop:delete-workspace-path",
    scope: "workspace", guard: "trusted-sender",
    handlerCheck: {
      check: "workspaceFileMutationOwner.runAdmittedMutation + deleteWorkspacePathByHand/withExclusiveWorkspaceOperation",
      reason: "The mutation owner retains renderer admission, writable/share checks, and its mutation lease.",
    },
    payload: DeleteWorkspacePathPayload, result: DeleteWorkspacePathResult,
  },
  undoHistoryOperation: {
    capabilityId: "history.operation.undo", channel: "desktop:undo-history-operation",
    scope: "workspace", guard: "trusted-sender",
    handlerCheck: {
      check: "workspaceFileMutationOwner.runAdmittedMutation + undoWorkspaceHistoryOperation/withExclusiveWorkspaceOperation",
      reason: "The mutation owner retains renderer admission, writable/share checks, and its mutation lease.",
    },
    payload: UndoHistoryOperationPayload, result: UndoHistoryOperationResult,
  },
  exportWorkspaceZip: {
    capabilityId: "file.zip.export", channel: "desktop:export-workspace-zip",
    scope: "workspace", guard: "trusted-sender",
    handlerCheck: {
      check: "exactRendererWorkspaceReferences.capture/withReference",
      reason: "The handler captures the workspace before the native dialog and rechecks that exact reference after it closes.",
    },
    payload: ExportWorkspaceZipPayload, result: ExportWorkspaceZipResult,
  },
  exportDocumentFile: {
    capabilityId: "document.file.export", channel: "desktop:export-document-file",
    scope: "workspace", guard: "trusted-sender",
    handlerCheck: {
      check: "exactRendererWorkspaceReferences.capture/withReference",
      reason: "The handler captures the workspace before the native dialog and rechecks that exact reference after it closes.",
    },
    payload: ExportDocumentFilePayload, result: ExportDocumentFileResult,
  },
  importWorkspaceFiles: {
    capabilityId: "file.import", channel: "desktop:import-workspace-files",
    scope: "workspace", guard: "trusted-sender",
    handlerCheck: {
      check: "exactRendererWorkspaceReferences.capture/withReference + withRendererWorkspaceOperation + withStaleSensitiveWorkspaceOperation",
      reason: "Native picks retain the captured workspace reference; dropped paths retain renderer admission and the import lease.",
    },
    payload: ImportWorkspaceFilesPayload, result: ImportWorkspaceFilesResult,
  },
  readWorkspaceText: {
    capabilityId: "file.text.read", channel: "desktop:read-workspace-text",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "File read stopped because this window changed workspaces.",
    payload: ReadWorkspaceTextPayload, result: ReadWorkspaceTextResult,
  },
  writeWorkspaceText: {
    capabilityId: "file.text.write", channel: "desktop:write-workspace-text",
    scope: "workspace", guard: "trusted-sender",
    handlerCheck: {
      check: "workspaceFileMutationOwner.runAdmittedMutation + withStaleSensitiveWorkspaceOperation",
      reason: "The mutation owner retains renderer admission, writable/share checks, and its mutation lease.",
    },
    payload: WriteWorkspaceTextPayload, result: WriteWorkspaceTextResult,
  },
  writeWorkspaceAsset: {
    capabilityId: "file.asset.write", channel: "desktop:write-workspace-asset",
    scope: "workspace", guard: "trusted-sender",
    handlerCheck: {
      check: "workspaceFileMutationOwner.runAdmittedMutation + withStaleSensitiveWorkspaceOperation",
      reason: "The mutation owner retains renderer admission, writable/share checks, and its mutation lease.",
    },
    payload: WriteWorkspaceAssetPayload,
  },
  pickImageFiles: {
    capabilityId: "file.image.pick", channel: "desktop:pick-image-files",
    scope: "workspace", guard: "trusted-sender",
    handlerCheck: {
      check: "exactRendererWorkspaceReferences.capture/withReference",
      reason: "The handler captures the workspace before the native dialog and rechecks that exact reference after it closes.",
    },
    payload: PickImageFilesPayload, result: PickImageFilesResult,
  },
  openFileExternally: {
    capabilityId: "file.external.open", channel: "desktop:open-file-externally",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "External file open stopped because this window changed workspaces.",
    payload: OpenFileExternallyPayload,
  },
} satisfies OperationTable;
