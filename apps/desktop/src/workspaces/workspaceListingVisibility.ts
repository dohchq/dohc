import type { WorkspaceListingVisibility } from "../ipc/bridgeContract";
import type { RegistryEntry } from "./registryStore";
import { readWorkspaceVisibilityPolicy } from "./workspaceEnginePolicyFile";
import { shareViewIsPresent } from "./shareViewMarker";

// Go to applies visibility.toml only. A broken files.toml blocks search, but
// does not block Go to: capture and search admission never govern its names.
export async function readWorkspaceListingVisibility(
  workspace: Pick<RegistryEntry, "rootPath" | "shareView">,
): Promise<WorkspaceListingVisibility> {
  // Received-share selectors govern their canonical listing, not the recipient's policy.
  if (shareViewIsPresent(workspace.shareView)) return { status: "ready", rules: [] };
  try {
    const policy = await readWorkspaceVisibilityPolicy(workspace.rootPath);
    return policy.errors.length
      ? { status: "degraded", rules: [] }
      : { status: "ready", rules: policy.rules ?? [] };
  } catch {
    return { status: "unavailable", rules: [] };
  }
}
