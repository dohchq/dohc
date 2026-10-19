import type { CloudCredentials } from "./cloudCredentialStore";
import type { RegistryEntry } from "./registryStore";
import { workspaceRemoteMatchesCredentials } from "./chatRelayIdentity";
import { shareViewIsPresent } from "./shareViewMarker";

export function localPersonOwnsWorkspace(
  entry: Pick<RegistryEntry, "remote" | "pausedRemote" | "shareView"> | null | undefined,
  credentials: CloudCredentials | null,
): boolean {
  if (!entry || shareViewIsPresent(entry.shareView)) return false;
  const remote = entry.remote ?? entry.pausedRemote;
  return !remote || workspaceRemoteMatchesCredentials(remote, credentials);
}
