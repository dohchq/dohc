import { prepareVisibilityPolicy, type VisibilityPolicyRule } from "@dohc/security-contract/effective-policy";
import type { WorkspaceListingVisibility, WorkspacePathListing } from "../ipc/bridgeContract";
import type { RegistryEntry } from "./registryStore";
import { readWorkspaceVisibilityPolicy } from "./workspaceEnginePolicyFile";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";
import { usableShareMountRecord } from "./shareMounts";
import { storedShareMounts } from "./shareViewFilesTarget";
import { shareViewIsPresent } from "./shareViewMarker";

/** Exact paths cover file rows and every listed folder, including app and Collection roots. */
export async function resolveWorkspaceListingVisibility(
  listing: Pick<WorkspacePathListing, "files" | "folders">,
  policy: { rules: readonly VisibilityPolicyRule[] | null; errors: readonly string[] },
  receivedRoots: readonly string[] = [],
): Promise<WorkspaceListingVisibility> {
  if (policy.errors.length) return { status: "degraded", hiddenHostPaths: [] };
  const hiddenHostPaths: string[] = [];
  if (!policy.rules?.some(rule => rule.visibility === "hidden")) return { status: "ready", hiddenHostPaths };
  const visibilityForPath = prepareVisibilityPolicy(policy.rules);
  let count = 0;
  for (const paths of [listing.files.map(file => file.path), listing.folders ?? []]) {
    for (const path of paths) {
      if (visibilityForPath(path).visibility === "hidden" &&
        !receivedRoots.some(root => path === root || path.startsWith(root + "/"))) hiddenHostPaths.push(path);
      if (++count % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  return { status: "ready", hiddenHostPaths };
}

export async function readWorkspaceListingVisibility(
  workspace: Pick<RegistryEntry, "rootPath" | "shareView" | "shareMounts">,
  listing: Pick<WorkspacePathListing, "files" | "folders">,
): Promise<WorkspaceListingVisibility> {
  // Received-share selectors already govern their canonical listing, not the recipient's policy file.
  if (shareViewIsPresent(workspace.shareView)) return { status: "ready", hiddenHostPaths: [] };
  try {
    const mounts = storedShareMounts(workspace);
    const receivedRoots = mounts.filter(mount => usableShareMountRecord(mounts, mount))
      .map(mount => `${SHARED_WITH_ME_FOLDER}/${mount.label}`);
    return await resolveWorkspaceListingVisibility(listing, await readWorkspaceVisibilityPolicy(workspace.rootPath), receivedRoots);
  } catch {
    return { status: "unavailable", hiddenHostPaths: [] };
  }
}
