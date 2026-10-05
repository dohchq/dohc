import type { EngineWorkspace } from "@dohc/workspace-engine-client/daemon";
import type { CollectionQueryResult, CollectionRecord, CollectionSchema } from "@dohc/workspace-contracts";
import type { RegistryEntry } from "./registryStore";
import type { createReceivedShareEngineAccess } from "./receivedShareEngineAccess";
import { resolveShareMountPath, usableShareMountRecord } from "./shareMounts";
import { resolveRegisteredShareViewFilesTarget, shareMountRegistryIsPresent, storedShareMounts } from "./shareViewFilesTarget";
import { shareViewIsPresent } from "./shareViewMarker";
import { recordedShareSelector } from "./shareViewRecords";

type ShareEngine = Pick<ReturnType<typeof createReceivedShareEngineAccess>, "workspaceFor" | "workspaceForRegistered">;
type Workspace = RegistryEntry & { attachmentId: symbol };

export interface CollectionReadSource {
  workspace: EngineWorkspace;
  prefix: string;
  selected(path: string): boolean;
}

function receivedSource(workspace: Workspace, shareEngine: ShareEngine, shareId?: string): CollectionReadSource {
  const target = resolveRegisteredShareViewFilesTarget(workspace, shareId
    ? { kind: "mount", workspaceId: workspace.workspaceId, shareId }
    : { kind: "standalone", workspaceId: workspace.workspaceId });
  const grant = recordedShareSelector(target?.grantedSelector);
  if (!target || !grant) throw new Error("This share is no longer available.");
  return {
    workspace: target.kind === "standalone" ? shareEngine.workspaceForRegistered(workspace)
      : shareEngine.workspaceFor({ engineWorkspaceId: target.storeWorkspaceId, rootPath: target.rootPath }),
    prefix: target.kind === "mount" ? `shared-with-me/${target.mountLabel}/` : "",
    selected: path => grant.paths.length === 0 ? grant.versionId !== null
      : grant.paths.some(root => path === root || path.startsWith(`${root}/`)),
  };
}

export async function collectionReadSource(workspace: Workspace, path: string, shareEngine: ShareEngine) {
  if (shareViewIsPresent(workspace.shareView)) {
    const source = receivedSource(workspace, shareEngine);
    if (!source.selected(`${path}/collection.yaml`)) throw new Error("This Collection is outside the files shared with you.");
    return { source, path };
  }
  const found = await resolveShareMountPath(workspace.rootPath, path, storedShareMounts(workspace), shareMountRegistryIsPresent(workspace));
  if (found) {
    const source = receivedSource(workspace, shareEngine, found.mount.shareId);
    if (!source.selected(`${found.path}/collection.yaml`)) throw new Error("This Collection is outside the files shared with you.");
    return { source, path: found.path };
  }
  return { source: { workspace: shareEngine.workspaceForRegistered(workspace), prefix: "", selected: () => true }, path };
}

export function collectionListSources(workspace: Workspace, shareEngine: ShareEngine): CollectionReadSource[] {
  if (shareViewIsPresent(workspace.shareView)) return [receivedSource(workspace, shareEngine)];
  const mounts = storedShareMounts(workspace);
  return [
    { workspace: shareEngine.workspaceForRegistered(workspace), prefix: "", selected: () => true },
    ...mounts.filter(mount => usableShareMountRecord(mounts, mount) && recordedShareSelector(mount.grantedSelector))
      .map(mount => receivedSource(workspace, shareEngine, mount.shareId)),
  ];
}

export function mountedCollectionSchema(schema: CollectionSchema, prefix: string): CollectionSchema {
  return prefix ? { ...schema, fields: schema.fields.map(field => field.type === "relation"
    ? { ...field, collection: prefix + field.collection } : field) } : schema;
}

export function receivedCollectionQuery(result: CollectionQueryResult, source: CollectionReadSource): CollectionQueryResult {
  const records = (items: CollectionRecord[]) => items.filter(record => source.selected(record.path))
    .map(record => ({ ...record, path: source.prefix + record.path }));
  return {
    ...result,
    collection: { ...result.collection, path: source.prefix + result.collection.path },
    records: records(result.records),
    groups: result.groups?.map(group => ({ ...group, records: records(group.records) })) ?? null,
    nextCursor: result.nextCursor && source.selected(result.nextCursor.recordPath) ? { ...result.nextCursor, recordPath: source.prefix + result.nextCursor.recordPath } : null,
  };
}
