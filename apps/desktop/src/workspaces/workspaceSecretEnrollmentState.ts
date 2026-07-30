import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SECRET_FILE_STORE_RELATIVE_PATH,
  SECRET_KEY_RELATIVE_PATH,
  loadSecretDataKey,
} from "./workspaceDataKey";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";

export type WorkspaceSecretState = "none" | "protected-key-present" | "protected-key-missing";

// `rootDir` must be the registry's rootPath VERBATIM, never a resolved copy:
// the relay route table is keyed by exact string (`relayForOpen` ->
// `locations.get(rootPath)`), and registry paths are forward-slashed even on
// Windows, so a `resolve()`d spelling misses the route and opens the workspace
// with no relay configuration.
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
  if (!(await protectedRowsExist(rootDir, workspaceId, sessions))) return "none";
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
  if (!(await protectedRowsExist(rootDir, workspaceId, sessions))) return null;
  return await loadSecretDataKey(root, { createIfMissing: false });
}
