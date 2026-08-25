import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SECRET_FILE_STORE_RELATIVE_PATH,
  SECRET_KEY_RELATIVE_PATH,
  loadSecretDataKey,
} from "./workspaceDataKey";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type {
  EngineWorkspace,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";

export type WorkspaceSecretState = "none" | "protected-key-present" | "protected-key-missing";

// `workspace.rootPath` must be the registry's rootPath VERBATIM, never a resolved copy:
// the relay route table is keyed by exact string (`relayForOpen` ->
// `locations.get(rootPath)`), and registry paths are forward-slashed even on
// Windows, so a `resolve()`d spelling misses the route and opens the workspace
// with no relay configuration.
async function protectedRowsExist(
  engineWorkspace: EngineWorkspace,
  sessions: EngineWorkspaceSessions,
): Promise<boolean> {
  return await sessions.run(
    engineWorkspace,
    async ({ client, workspace: handle }) =>
      await new VersionedLiveAdapter(client, handle, {
        workspaceId: engineWorkspace.workspaceId,
      }).secretStateExists({ workspaceId: engineWorkspace.workspaceId }),
    { retryTransportErrors: true },
  );
}

export async function readWorkspaceSecretState(
  workspace: EngineWorkspace,
  sessions: EngineWorkspaceSessions,
): Promise<WorkspaceSecretState> {
  const root = resolve(workspace.rootPath);
  if (!existsSync(join(root, SECRET_FILE_STORE_RELATIVE_PATH))) return "none";
  if (!(await protectedRowsExist(workspace, sessions))) return "none";
  return existsSync(join(root, SECRET_KEY_RELATIVE_PATH))
    ? "protected-key-present"
    : "protected-key-missing";
}

export async function readWorkspaceDataKeyForEnrollment(
  workspace: EngineWorkspace,
  sessions: EngineWorkspaceSessions,
): Promise<Buffer | null> {
  const root = resolve(workspace.rootPath);
  if (!existsSync(join(root, SECRET_FILE_STORE_RELATIVE_PATH))) return null;
  if (!(await protectedRowsExist(workspace, sessions))) return null;
  return await loadSecretDataKey(root, { createIfMissing: false });
}
