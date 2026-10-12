import type { EngineWorkspace } from "@dohc/workspace-engine-client/daemon";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import type { FileReferenceScope } from "./resolveEngineFiles";
import type { ReceivedInventory } from "./receivedShareStore";
import type { RegistryEntry } from "./registryStore";
import { shareViewIsPresent } from "./shareViewMarker";
import { recordedShareSelector } from "./shareViewRecords";
import { storedShareMounts } from "./shareViewFilesTarget";
import { mountRootFor, mountStoreWorkspaceIdFor, usableShareMountRecord } from "./shareMounts";

/** Bind references to admitted projections. Labels never select an identity lookup. */
export function workspaceFileReferenceScopes(
  workspace: EngineWorkspace,
  dependencies: {
    current(): RegistryEntry | null;
    liveGrants?(): ReceivedInventory | null;
    assertCurrent(): void;
    shareWorkspace(input: { engineWorkspaceId: string; rootPath: string; attachmentId?: symbol }): EngineWorkspace;
  },
): FileReferenceScope<EngineWorkspace>[] {
  const admitted = dependencies.current();
  const assertAttachment = () => {
    dependencies.assertCurrent();
    const current = dependencies.current();
    if (current?.rootPath !== admitted?.rootPath || shareViewIsPresent(current?.shareView) !== shareViewIsPresent(admitted?.shareView)) {
      throw new Error("The workspace changed while dohc looked up the file. Try again.");
    }
  };
  const shareScope = (marker: unknown, engineWorkspace: EngineWorkspace, prefix?: string): FileReferenceScope<EngineWorkspace> => {
    const row = marker as { sourceWorkspaceId?: unknown; grantId?: unknown; grantGeneration?: unknown; shareId?: unknown; grantedSelector?: unknown } | null;
    const selector = recordedShareSelector(row?.grantedSelector);
    const provenance = (value: unknown) => {
      const source = value as typeof row & { label?: unknown; relayUrl?: unknown; recipientUserId?: unknown; recipientEmail?: unknown; ended?: unknown };
      return JSON.stringify(source && [source.shareId, source.label, source.relayUrl, source.recipientUserId, source.recipientEmail,
        source.sourceWorkspaceId, source.grantId, source.grantGeneration, source.grantedSelector, source.ended]);
    };
    const currentMarker = () => {
      const current = dependencies.current();
      return prefix === undefined ? current?.shareView : storedShareMounts(current ?? {}).find(mount => mount.shareId === row?.shareId);
    };
    const stamp = provenance(marker);
    const grantState = () => {
      const inventory = dependencies.liveGrants?.();
      const grant = inventory?.received.find(grant => grant.shareId === row?.shareId);
      const removed = inventory?.removed.find(grant => grant.shareId === row?.shareId);
      return grant ? [grant.grantId, grant.generation, grant.selector, grant.access] : removed ? [removed.grantId, "removed"] : null;
    };
    const initialGrant = grantState();
    const grantMatches = initialGrant === null || (initialGrant[0] === row?.grantId && initialGrant[1] === row?.grantGeneration);
    const sourceWorkspaceId = typeof row?.sourceWorkspaceId === "string" && row.sourceWorkspaceId &&
      typeof row.grantId === "string" && row.grantId && typeof row.grantGeneration === "number" &&
      Number.isSafeInteger(row.grantGeneration) && row.grantGeneration > 0 && selector && grantMatches ? row.sourceWorkspaceId : null;
    return {
      workspace: engineWorkspace, sourceWorkspaceId, prefix, versionId: "main",
      assertCurrent: () => {
        assertAttachment();
        const currentGrant = grantState();
        const grantChanged = JSON.stringify(currentGrant) !== JSON.stringify(initialGrant);
        if (provenance(currentMarker()) !== stamp || grantChanged) {
          throw new Error("This share changed while dohc looked up the file. Try again.");
        }
      },
      allowsPath: path => classifyEngineFilePathForRead(path, process.platform).kind === "tracked" && selector !== null &&
        (selector.paths.length === 0 ? selector.versionId !== null : selector.paths.some(selected => path === selected || path.startsWith(selected + "/"))),
    };
  };
  if (admitted && shareViewIsPresent(admitted.shareView)) return [shareScope(admitted.shareView, workspace)];
  const scopes: FileReferenceScope<EngineWorkspace>[] = [{ workspace, sourceWorkspaceId: workspace.workspaceId, assertCurrent: assertAttachment }];
  if (!admitted) return scopes;
  const mounts = storedShareMounts(admitted);
  for (const mount of mounts) {
    if (!usableShareMountRecord(mounts, mount)) continue;
    scopes.push(shareScope(mount, dependencies.shareWorkspace({
      engineWorkspaceId: mountStoreWorkspaceIdFor(workspace.workspaceId, mount.shareId),
      rootPath: mountRootFor(admitted.rootPath, mount.label),
    }), "shared-with-me/" + mount.label));
  }
  return scopes;
}
