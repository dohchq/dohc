import { isReceivedSource, isReceivedObject, type WorkspaceFileRef } from "@dohc/workspace-contracts/workspace-ref";
import type { ShareViewInfo, ShareViewSelector } from "./shareViewInfo";
import { recordedShareSelector } from "./shareViewRecords";
import { shareViewIsPresent } from "./shareViewMarker";
import { relayUrlsMatch } from "./syncCode";
import { storedShareMounts } from "./shareViewFilesTarget";
import { workspaceRootsMatch } from "./workspaceRootsMatch";

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


interface ReferenceWorkspace { workspaceId: string; rootPath: string; attachmentId?: symbol }
interface ReferenceRegistry {
  rootPath: string;
  shareView?: import("./registryStore").ShareViewIdentity;
  shareMounts?: unknown;
}
export interface ReceivedScopeDependencies<Workspace extends ReferenceWorkspace> {
  findWorkspace(workspaceId: string): ReferenceRegistry | null | undefined;
  currentAttachment(workspaceId: string): symbol;
  isCurrentAttachment(workspaceId: string, attachmentId: symbol): boolean;
  warmCredentials(): Promise<void>;
  credentials(): { userId?: string; relayUrl?: string | null } | null;
  credentialGeneration(): number;
  mountWorkspace(host: Workspace, mount: import("./registryStore").ShareMountRecord): Workspace;
}

export function createReceivedFileReferenceScopes<Workspace extends ReferenceWorkspace>(dependencies: ReceivedScopeDependencies<Workspace>) {
  return async (workspace: Workspace): Promise<ReceivedFileReferenceScope<Workspace>[]> => {
    const captured = dependencies.findWorkspace(workspace.workspaceId);
    if (!captured || !workspaceRootsMatch(captured.rootPath, workspace.rootPath)) return [];
    const attachment = dependencies.currentAttachment(workspace.workspaceId);
    if (workspace.attachmentId && workspace.attachmentId !== attachment) return [];
    await dependencies.warmCredentials();
    const credentials = dependencies.credentials(), generation = dependencies.credentialGeneration();
    const scopes: ReceivedFileReferenceScope<Workspace>[] = [];
    for (const record of [captured.shareView, ...storedShareMounts(captured)]) {
      if (!record) continue;
      const pin = receivedReferencePin(record.receivedIdentity), selector = recordedShareSelector(record.grantedSelector);
      if (!pin || !selector || record.ended || !credentials?.userId || !credentials.relayUrl || !record.relayUrl ||
        record.recipientUserId !== credentials.userId || !relayUrlsMatch(record.relayUrl, credentials.relayUrl)) continue;
      const snapshot = JSON.stringify(record);
      const assertCurrent = () => {
        const current = dependencies.findWorkspace(workspace.workspaceId);
        const latest = record === captured.shareView ? current?.shareView : storedShareMounts(current ?? {}).find(row => row.shareId === record.shareId);
        if (!current || !dependencies.isCurrentAttachment(workspace.workspaceId, attachment) || current.rootPath !== captured.rootPath || generation !== dependencies.credentialGeneration() || JSON.stringify(latest) !== snapshot) {
          throw new Error("The shared file session changed.");
        }
      };
      assertCurrent();
      const mount = "label" in record ? record : undefined;
      scopes.push({ workspace: mount ? dependencies.mountWorkspace(workspace, mount) : workspace, pin, selector, assertCurrent,
        ...(mount ? { pathPrefix: 'shared-with-me/' + mount.label + '/' } : {}) });
    }
    return scopes;
  };
}
