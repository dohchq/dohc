import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SECRET_FILE_STORE_RELATIVE_PATH,
  SECRET_KEY_RELATIVE_PATH,
  loadSecretDataKey,
  type WorkspaceSecretState,
} from "@dohc/workspace-engine";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { EngineWorkspaceSessions } from "./engineWorkspaceSessions";

export type { WorkspaceSecretState };

async function protectedRowsExist(
  rootDir: string,
  workspaceId: string,
  sessions: EngineWorkspaceSessions,
): Promise<boolean> {
  return await sessions.run(
    { workspaceId, rootPath: rootDir },
    async ({ client, workspace }) =>
      await new VersionedLiveAdapter(client, workspace, {
        workspaceId,
      }).secretStateExists({ workspaceId }),
    { retryTransportErrors: true },
  );
}

export async function readWorkspaceSecretState(
  rootDir: string,
  workspaceId: string,
  sessions: EngineWorkspaceSessions,
): Promise<WorkspaceSecretState> {
  const root = resolve(rootDir);
  if (!existsSync(join(root, SECRET_FILE_STORE_RELATIVE_PATH))) return "none";
  if (!(await protectedRowsExist(root, workspaceId, sessions))) return "none";
  return existsSync(join(root, SECRET_KEY_RELATIVE_PATH))
    ? "protected-key-present"
    : "protected-key-missing";
}

export async function readWorkspaceDataKeyForEnrollment(
  rootDir: string,
  workspaceId: string,
  sessions: EngineWorkspaceSessions,
): Promise<Buffer | null> {
  const root = resolve(rootDir);
  if (!existsSync(join(root, SECRET_FILE_STORE_RELATIVE_PATH))) return null;
  if (!(await protectedRowsExist(root, workspaceId, sessions))) return null;
  return await loadSecretDataKey(root, { createIfMissing: false });
}
