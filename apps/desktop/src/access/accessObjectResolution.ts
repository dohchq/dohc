import type { AccessObjectRef } from "@dohc/workspace-contracts/access";
import { isShareablePath, visibleSharePath } from "@dohc/security-contract/share-selector";
import type { RegistryEntry } from "../workspaces/registryStore";
import { classifyResolvedShareProjectionPath } from "../workspaces/shareMounts";
import { recordedShareSelector } from "../workspaces/shareViewRecords";
import type { ResolvedAccessObject } from "./accessOwner";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";

export async function hasAccessChat(workspaceId: string, channelWireId: string,
  store: Pick<DesktopLinkedChatStore, "listChannels" | "getChannelWireId">): Promise<boolean> {
  for (const channel of await store.listChannels({ workspaceId })) {
    if (await store.getChannelWireId({ workspaceId, channelId: channel.id }) === channelWireId) return true;
  }
  return false;
}

export async function resolveAccessObject(workspace: RegistryEntry, ref: AccessObjectRef, ports: {
  filePathForObjectId(objectId: string): Promise<{ path: string; versionId: string } | null>;
  locatePath(path: string, versionId: string | null): Promise<{ path: string; exists: boolean } | null>;
  hasChat(channelWireId: string): Promise<boolean>;
}): Promise<ResolvedAccessObject> {
  if (ref.kind === "collection") return workspace.shareView
    ? { ref, visibility: "unknown" } : { ref, visibility: "visible" };
  if (ref.kind === "chat") {
    if (!await ports.hasChat(ref.channelWireId)) return { ref, visibility: "missing" };
    const channel = workspace.sharedChannels?.find(row => row.channelWireId === ref.channelWireId);
    return { ref, visibility: "visible", ...(channel ? { shareId: channel.shareId, relayUrl: channel.relayUrl,
      recipientUserId: channel.recipientUserId, ended: channel.ended } : {}) };
  }
  let pathRef: Extract<AccessObjectRef, { kind: "path" }>;
  if (ref.kind === "file") {
    const file = await ports.filePathForObjectId(ref.objectId);
    if (!file) return { ref, visibility: "missing" };
    pathRef = { kind: "path", path: file.path, versionId: file.versionId };
  } else pathRef = ref;
  const located = await ports.locatePath(pathRef.path, pathRef.versionId);
  if (!located) return { ref: pathRef, visibility: "unknown" };
  if (!located.exists) return { ref: pathRef, visibility: "missing" };
  pathRef = { ...pathRef, path: located.path };
  if (workspace.shareView) {
    const pin = recordedShareSelector(workspace.shareView.grantedSelector);
    if (!pin || !isShareablePath(pathRef.path) || visibleSharePath(pin, pathRef.path) === null) return { ref: pathRef, visibility: "hidden" };
    return { ref: { ...pathRef, versionId: pin.versionId }, visibility: "visible", shareId: workspace.shareView.shareId,
      relayUrl: workspace.shareView.relayUrl, recipientUserId: workspace.shareView.recipientUserId, ended: workspace.shareView.ended };
  }
  const projection = classifyResolvedShareProjectionPath(pathRef.path, workspace.shareMounts ?? []);
  if (projection.kind === "mount") {
    const pin = recordedShareSelector(projection.mount.grantedSelector);
    if (!pin) return { ref: pathRef, visibility: "unknown" };
    if (projection.path === "") return { ref: pathRef, visibility: "visible", shareRoot: true,
      shareId: projection.mount.shareId, relayUrl: projection.mount.relayUrl, ended: projection.mount.ended };
    if (!isShareablePath(projection.path) || visibleSharePath(pin, projection.path) === null) return { ref: pathRef, visibility: "hidden" };
    return { ref: { ...pathRef, path: projection.path, versionId: pin.versionId }, visibility: "visible",
      shareId: projection.mount.shareId, relayUrl: projection.mount.relayUrl, ended: projection.mount.ended };
  }
  return { ref: pathRef, visibility: isShareablePath(pathRef.path) ? "visible" : "hidden" };
}
