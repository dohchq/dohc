import { readWorkspaceText } from "../workspaces/workspaceAssets";
import {
  applyDatabaseEdit,
  readDatabaseSnapshot,
} from "../workspaces/workspaceDatabase";
import { listFiles } from "../workspaces/workspaceFiles";
import { createOwnedWorkspaceSdkReadPort } from "../workspaces/ownedWorkspaceSdkReadPort";
import type {
  WorkspaceSdkHostContext,
  WorkspaceSdkReadPort,
} from "../workspaces/workspaceSdkHost";

/** Explicit raw-disk read authority for local-workspace test fixtures. */
export function localWorkspaceSdkReads(
  workspaceRoot: string,
): WorkspaceSdkReadPort {
  const noEngine = () =>
    Promise.reject(
      new Error("This test fixture has no workspace engine for collections."),
    );
  return createOwnedWorkspaceSdkReadPort({
    readText: (path) => readWorkspaceText(workspaceRoot, path),
    listFiles: () => listFiles(workspaceRoot),
    readDatabase: (path) => readDatabaseSnapshot(workspaceRoot, path),
    collections: {
      list: noEngine,
      get: noEngine,
      query: noEngine,
      getRecord: noEngine,
    },
    hasShareState: false,
    searchSources: [],
    repairProjection: async () => undefined,
  });
}

/** Explicit in-process database writer for tests that do not boot Electron main. */
export function localWorkspaceSdkDatabaseEditor(
  workspaceRoot: string,
): WorkspaceSdkHostContext["editDatabase"] {
  return ({ path, edit, author, nowMs, operationId, signal }) =>
    applyDatabaseEdit(workspaceRoot, path, edit, author, nowMs, {
      ...(signal ? { signal } : {}),
      ...(operationId ? { createId: () => operationId } : {}),
    });
}
