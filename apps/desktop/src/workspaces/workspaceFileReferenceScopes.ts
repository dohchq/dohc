import { isReceivedSource, isReceivedObject, type WorkspaceFileRef } from "@dohc/workspace-contracts/workspace-ref";
import type { ShareViewInfo, ShareViewSelector } from "./shareViewInfo";
import { recordedShareSelector } from "./shareViewRecords";
import { shareViewIsPresent } from "./shareViewMarker";

export interface ReceivedReferencePin { receivedSource: string; grantId: string; generation: number }
export function receivedReferencePin(value: unknown): ReceivedReferencePin | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  return isReceivedSource(row.receivedSource) && typeof row.grantId === "string" && row.grantId.length > 0 &&
    typeof row.generation === "number" && Number.isSafeInteger(row.generation) && row.generation >= 0
    ? { receivedSource: row.receivedSource, grantId: row.grantId, generation: row.generation } : undefined;
}
export function refreshReceivedReferencePin(previous: unknown, info: Pick<ShareViewInfo, "receivedIdentity">): ReceivedReferencePin | undefined {
  const old = receivedReferencePin(previous), next = receivedReferencePin(info.receivedIdentity);
  if (old && next && old.grantId === next.grantId && next.generation < old.generation) {
    throw new Error("The server returned older access details. Try again.");
  }
  return next;
}
export function workspaceFileRefs(workspace: { workspaceId: string; shareView?: unknown; shareMounts?: readonly unknown[] }, objectId: string): WorkspaceFileRef[] {
  const labels = { name: "", displayKind: "binary" as const };
  const target = { kind: "file" as const, objectId };
  if (!isReceivedObject(objectId)) return shareViewIsPresent(workspace.shareView) ? [] : [{ source: { workspaceId: workspace.workspaceId }, target, labels }];
  const sources = [workspace.shareView, ...(workspace.shareMounts ?? [])].flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const row = value as { ended?: boolean; receivedIdentity?: unknown; grantedSelector?: unknown };
    const pin = receivedReferencePin(row.receivedIdentity);
    return pin && !row.ended && recordedShareSelector(row.grantedSelector) ? [pin.receivedSource] : [];
  });
  return [...new Set(sources)].map(receivedSource => ({ source: { receivedSource }, target, labels }));
}
export interface ReceivedFileReferenceScope<Workspace> {
  workspace: Workspace; pin: ReceivedReferencePin; selector: ShareViewSelector;
  pathPrefix?: string; assertCurrent(): void;
}
