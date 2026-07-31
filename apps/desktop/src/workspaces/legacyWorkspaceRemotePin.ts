import type { CloudCredentials } from "./cloudCredentialStore";
import type { RegistryEntry, RemoteIdentity } from "./registryStore";

function serverUrlsMatch(left: string, right: string): boolean {
  return left.replace(/\/+$/u, "") === right.replace(/\/+$/u, "");
}

export function syncEnrollmentRemoteWorkspaceId(
  workspace: Pick<RegistryEntry, "workspaceId" | "remote">,
  credentials: Pick<CloudCredentials, "serverUrl">,
): string {
  const remote = workspace.remote;
  if (!remote) return workspace.workspaceId;
  if (!serverUrlsMatch(remote.serverUrl, credentials.serverUrl)) {
    throw new Error("Sign in to the cloud server this workspace uses.");
  }
  return remote.remoteWorkspaceId;
}

export async function pinVerifiedLegacyWorkspaceRemotes(input: {
  workspaces: RegistryEntry[];
  credentials: CloudCredentials | null;
  verifyOwnership: (workspace: RegistryEntry) => Promise<void>;
  isCurrent: (
    workspace: RegistryEntry,
    credentials: CloudCredentials,
  ) => boolean;
  pin: (
    workspaceId: string,
    remote: RemoteIdentity & { ownerUserId: string },
  ) => void;
}): Promise<{ pinned: string[]; unverified: string[] }> {
  const credentials = input.credentials;
  if (!credentials?.relayUrl) return { pinned: [], unverified: [] };

  const pinned: string[] = [];
  const unverified: string[] = [];
  for (const workspace of input.workspaces) {
    const remote = workspace.remote;
    if (
      !remote ||
      remote.ownerUserId !== undefined ||
      !serverUrlsMatch(remote.serverUrl, credentials.serverUrl)
    ) {
      continue;
    }
    try {
      await input.verifyOwnership(workspace);
    } catch {
      unverified.push(workspace.workspaceId);
      continue;
    }
    if (!input.isCurrent(workspace, credentials)) continue;
    input.pin(workspace.workspaceId, {
      ...remote,
      ownerUserId: credentials.userId,
    });
    pinned.push(workspace.workspaceId);
  }
  return { pinned, unverified };
}
