import {createHash} from "node:crypto";
import type {ReplicaCurrentView, ReplicaCurrentViewSelector} from "@dohc/workspace-engine-client/daemon";
import {visibleSharePath} from "@dohc/security-contract/share-selector";
import {parseStoredAnyShareSelectorJson, targetVersionId} from "../shareFilter";
import {selectorTargetsBlockedChannel} from "../shareAuthorization";
import type {ReplicaReadLease} from "../replicaReadPrincipal";
import type {StorageContext} from "./context";
import {currentShareGrantSql} from "./currentShareGrant";
import {readReplicaStanding} from "./replicaReads";

const STAGE_BYTES = 8 * 1024 * 1024;
const incarnations = new WeakMap<StorageContext, Map<string, ReplicaReadLease>>();
export interface StagedCurrentView {readonly staged: true}
const stagedViews = new WeakMap<StagedCurrentView, {storage: StorageContext; lease: ReplicaReadLease; view: ReplicaCurrentView}>();
export class ReplicaCurrentViewRefused extends Error {
  constructor() {super("Replica current view is stale or invalid.");}
}
function fail(): never {throw new ReplicaCurrentViewRefused();}
function current(storage: StorageContext, lease: ReplicaReadLease) {
  const standing = readReplicaStanding(storage, lease.workspaceId);
  if (!standing || standing.ownerUserId !== lease.ownerUserId || standing.replicationEpoch !== lease.replicationEpoch ||
      standing.streamIdentity !== lease.streamIdentity || incarnations.get(storage)?.get(lease.workspaceId)?.incarnation !== lease.incarnation) fail();
  return standing;
}
export function bindReplicaCurrentView(storage: StorageContext, lease: ReplicaReadLease) {
  const standing = readReplicaStanding(storage, lease.workspaceId, lease.shareGrantBindings);
  if (!standing || standing.replicationEpoch !== lease.replicationEpoch || standing.streamIdentity !== lease.streamIdentity || standing.ownerUserId !== lease.ownerUserId) fail();
  let bindings = incarnations.get(storage);
  if (!bindings) incarnations.set(storage, bindings = new Map());
  bindings.set(lease.workspaceId, lease);
}
export function releaseReplicaCurrentView(storage: StorageContext, lease: ReplicaReadLease) {
  const bindings = incarnations.get(storage);
  if (bindings?.get(lease.workspaceId)?.incarnation === lease.incarnation) bindings.delete(lease.workspaceId);
}
export function replicaCurrentViewSelectors(storage: StorageContext, workspace: string): ReplicaCurrentViewSelector[] {
  return storage.db.prepare(`SELECT DISTINCT s.selector_json FROM sync_relay_shares s JOIN sync_relay_share_grants g ON g.share_id=s.share_id
    WHERE s.workspace_id=? AND ${currentShareGrantSql("g", "s")}`).all(workspace).flatMap(row => {
    const selector = parseStoredAnyShareSelectorJson(String(row.selector_json));
    if (!selector || "kind" in selector && selector.kind === "chat" ||
        selectorTargetsBlockedChannel(storage, workspace, selector) ||
        selector.paths.length === 0 && selector.versionId === null) return [];
    return [{versionId: selector.versionId, paths: selector.paths}];
  });
}
export function currentViewFileVisible(selectors: ReplicaCurrentViewSelector[], file: {versionId: string; path: string}) {
  return selectors.some(selector => file.versionId === targetVersionId(selector) && visibleSharePath(selector, file.path) === file.path);
}
function storedFiles(storage: StorageContext, workspace: string): ReplicaCurrentView["files"] {
  return storage.db.prepare("SELECT * FROM sync_relay_replica_cut_files WHERE workspace_id=? ORDER BY version_id,path").all(workspace).map(row => ({
    versionId: String(row.version_id), objectId: String(row.object_id), path: String(row.path), contentKind: row.content_kind as "text" | "binary", sha256: String(row.sha256), byteLength: Number(row.byte_length),
    lineageClaimId: row.lineage_claim_id === null ? null : String(row.lineage_claim_id), restoreGeneration: row.restore_generation === null ? null : Number(row.restore_generation)}));
}
const filePathKey = (file: ReplicaCurrentView["files"][number]) => JSON.stringify([file.versionId, file.path]);
function carriedPathAvailable(file: ReplicaCurrentView["files"][number], currentPaths: Map<string, string>) {
  const owner = currentPaths.get(filePathKey(file));
  return owner === undefined || owner === file.objectId;
}
export function currentViewFilesAtFences(storage: StorageContext, workspace: string, files: ReplicaCurrentView["files"], previous: ReplicaCurrentView["files"]) {
  const key = (f: ReplicaCurrentView["files"][number]) => JSON.stringify([f.versionId, f.objectId, f.lineageClaimId]);
  const saved = new Map(previous.map(f => [key(f), f]));
  const currentPaths = new Map(files.map(f => [filePathKey(f), f.objectId]));
  const fences = new Map(storage.db.prepare("SELECT main_version_id,object_id,lineage_claim_id,restore_fence_generation FROM sync_relay_live_documents WHERE workspace_id=? AND lineage_state='current'")
    .all(workspace).map(row => [JSON.stringify([row.main_version_id, row.object_id, row.lineage_claim_id]), Number(row.restore_fence_generation)]));
  return files.flatMap(file => {
    if (file.lineageClaimId === null || file.restoreGeneration === (fences.get(key(file)) ?? 1)) return [file];
    const old = saved.get(key(file));
    return old && carriedPathAvailable(old, currentPaths) ? [old] : [];
  });
}
function validateReplicaCurrentView(storage: StorageContext, lease: ReplicaReadLease, view: ReplicaCurrentView) {
  const standing = current(storage, lease);
  if (view.workspaceId !== lease.workspaceId || [view.revision, view.logCursor, view.journalCursor].some(v => !Number.isSafeInteger(v) || v < 0) ||
      view.logCursor > standing.logSeq || view.journalCursor > standing.journalCursor) fail();
  const saved = storage.db.prepare("SELECT * FROM sync_relay_replica_cuts WHERE workspace_id=?").get(lease.workspaceId);
  if (saved && (view.logCursor < Number(saved.log_cursor) || view.journalCursor < Number(saved.journal_cursor))) fail();
  const selectors = replicaCurrentViewSelectors(storage, lease.workspaceId), paths = new Set<string>(), objects = new Set<string>();
  const key = (f: ReplicaCurrentView["files"][number]) => JSON.stringify([f.versionId, f.objectId, f.lineageClaimId]);
  const previous = new Map(storedFiles(storage, lease.workspaceId).map(f => [key(f), f]));
  const currentPaths = new Map(view.files.map(f => [filePathKey(f), f.objectId]));
  const fence = storage.db.prepare("SELECT restore_fence_generation FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND lineage_state='current'");
  const files: ReplicaCurrentView["files"] = [];
  for (let file of view.files) {
    if (!file.objectId || !currentViewFileVisible(selectors, file) || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || !["text", "binary"].includes(file.contentKind) ||
        (file.lineageClaimId === null) !== (file.restoreGeneration === null)) fail();
    const old = previous.get(key(file));
    if (old?.restoreGeneration != null && (file.restoreGeneration === null || file.restoreGeneration < old.restoreGeneration)) fail();
    if (file.lineageClaimId !== null) {
      if (!/^[a-f0-9]{64}$/.test(file.lineageClaimId) || !Number.isSafeInteger(file.restoreGeneration) || file.restoreGeneration! < 0) fail();
      const row = fence.get(lease.workspaceId, file.versionId, file.objectId, file.lineageClaimId);
      const generation = row ? Number(row.restore_fence_generation) : 1;
      if (file.restoreGeneration! > generation) fail();
      if (file.restoreGeneration! < generation) {
        if (!old || !currentViewFileVisible(selectors, old) || !carriedPathAvailable(old, currentPaths)) continue;
        file = old;
      }
    }
    const object = JSON.stringify([file.versionId, file.objectId]), path = filePathKey(file);
    if (objects.has(object) || paths.has(path)) fail();
    objects.add(object); paths.add(path); files.push(file);
  }
  for (const omitted of view.omitted) {
    const object = JSON.stringify([omitted.versionId, omitted.objectId]), path = JSON.stringify([omitted.versionId, omitted.path]);
    if (!omitted.objectId || !currentViewFileVisible(selectors, omitted) || !/^[a-f0-9]{64}$/.test(omitted.sha256) || omitted.reason !== "text-frame-limit" || objects.has(object) || paths.has(path)) fail();
    objects.add(object); paths.add(path);
  }
  return {...view, files};
}
export function discardReplicaCurrentView(storage: StorageContext, lease: ReplicaReadLease) {
  if (storage.db.prepare("SELECT 1 FROM sync_relay_replica_cut_texts WHERE workspace_id=? AND ref_count=0 LIMIT 1").get(lease.workspaceId)) {
    storage.replicaViewTx(() => storage.db.prepare("DELETE FROM sync_relay_replica_cut_texts WHERE workspace_id=? AND ref_count=0").run(lease.workspaceId));
  }
}
export function stageReplicaCurrentView(storage: StorageContext, lease: ReplicaReadLease, view: ReplicaCurrentView): StagedCurrentView {
  try {
    current(storage, lease);
    const stored = new Set(storage.db.prepare("SELECT DISTINCT sha256 FROM sync_relay_replica_cut_texts WHERE workspace_id=?").all(lease.workspaceId).map(row => row.sha256));
    const requested = new Map(view.files.filter(f => f.contentKind === "text").map(f => [f.sha256, f.byteLength]));
    const insert = storage.db.prepare("INSERT INTO sync_relay_replica_cut_texts VALUES (?,?,?,?,0) ON CONFLICT(workspace_id,sha256,ordinal) DO NOTHING");
    let batch: Array<{sha: string; ordinal: number; bytes: Buffer}> = [], batchBytes = 0;
    const flush = () => {
      if (!batch.length) return;
      storage.replicaViewTx(() => {
        current(storage, lease);
        for (const chunk of batch) insert.run(lease.workspaceId, chunk.sha, chunk.ordinal, chunk.bytes);
      });
      batch = []; batchBytes = 0;
    };
    for (const text of view.texts) {
      if (stored.has(text.sha256)) continue;
      const bytes = Buffer.from(text.text);
      if (createHash("sha256").update(bytes).digest("hex") !== text.sha256 || requested.get(text.sha256) !== bytes.length) fail();
      for (let offset = 0, ordinal = 0; offset < bytes.length || ordinal === 0; ordinal++) {
        if (batchBytes === STAGE_BYTES) flush();
        const chunk = bytes.subarray(offset, offset + STAGE_BYTES - batchBytes);
        batch.push({sha: text.sha256, ordinal, bytes: chunk}); batchBytes += chunk.length; offset += chunk.length;
      }
      stored.add(text.sha256);
    }
    flush();
    const staged = {staged: true as const};
    stagedViews.set(staged, {storage, lease, view: {...view, files: structuredClone(view.files), omitted: structuredClone(view.omitted), texts: []}});
    return staged;
  } catch (error) {discardReplicaCurrentView(storage, lease); throw error;}
}
export function flipReplicaCurrentView(storage: StorageContext, lease: ReplicaReadLease, staged: StagedCurrentView) {
  const state = stagedViews.get(staged);
  try {
    if (!state || state.storage !== storage || state.lease !== lease) fail();
    stagedViews.delete(staged);
    return storage.replicaViewTx(() => {
      const view = validateReplicaCurrentView(storage, lease, state.view);
      const chunks = storage.db.prepare("SELECT count(*) AS n,min(ordinal) AS first,max(ordinal) AS last,sum(length(bytes)) AS bytes FROM sync_relay_replica_cut_texts WHERE workspace_id=? AND sha256=?");
      const stored = new Map(storage.db.prepare("SELECT sha256,sum(length(bytes)) AS bytes FROM sync_relay_replica_cut_texts WHERE workspace_id=? AND ref_count>0 GROUP BY sha256").all(lease.workspaceId).map(row => [row.sha256, row.bytes]));
      const checked = new Map<string, number>();
      for (const file of view.files) {
        if (file.contentKind !== "text") continue;
        if (checked.has(file.sha256)) {
          if (checked.get(file.sha256) !== file.byteLength) fail();
          continue;
        }
        checked.set(file.sha256, file.byteLength);
        if (stored.has(file.sha256)) {if (stored.get(file.sha256) !== file.byteLength) fail(); continue;}
        const row = chunks.get(lease.workspaceId, file.sha256)!;
        if (!row.n || row.first !== 0 || Number(row.last) !== Number(row.n) - 1 || row.bytes !== file.byteLength) fail();
      }
      storage.db.prepare(`INSERT INTO sync_relay_replica_cuts VALUES (?,?,?,?,1,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET
        replication_epoch=excluded.replication_epoch,stream_identity=excluded.stream_identity,incarnation=excluded.incarnation,
        cut_seq=sync_relay_replica_cuts.cut_seq+1,revision=excluded.revision,log_cursor=excluded.log_cursor,journal_cursor=excluded.journal_cursor,omitted_json=excluded.omitted_json`)
        .run(lease.workspaceId, lease.replicationEpoch, lease.streamIdentity, lease.incarnation, view.revision, view.logCursor, view.journalCursor, JSON.stringify(view.omitted));
      storage.db.prepare("DELETE FROM sync_relay_replica_cut_files WHERE workspace_id=?").run(lease.workspaceId);
      const insert = storage.db.prepare("INSERT INTO sync_relay_replica_cut_files VALUES (?,?,?,?,?,?,?,?,?)");
      for (const f of view.files) insert.run(lease.workspaceId, f.versionId, f.objectId, f.path, f.contentKind, f.sha256, f.byteLength, f.lineageClaimId, f.restoreGeneration);
      storage.db.prepare(`UPDATE sync_relay_replica_cut_texts SET ref_count=(SELECT count(*) FROM sync_relay_replica_cut_files f WHERE f.workspace_id=sync_relay_replica_cut_texts.workspace_id AND f.sha256=sync_relay_replica_cut_texts.sha256 AND f.content_kind='text') WHERE workspace_id=?`).run(lease.workspaceId);
      storage.db.prepare("DELETE FROM sync_relay_replica_cut_texts WHERE workspace_id=? AND ref_count=0").run(lease.workspaceId);
      return view;
    });
  } catch (error) {discardReplicaCurrentView(storage, lease); throw error;}
}
export function readReplicaCurrentView(storage: StorageContext, workspace: string): ReplicaCurrentView | null {
  const standing = readReplicaStanding(storage, workspace);
  const header = storage.db.prepare("SELECT * FROM sync_relay_replica_cuts WHERE workspace_id=?").get(workspace);
  if (!standing || !header || header.replication_epoch !== standing.replicationEpoch || header.stream_identity !== standing.streamIdentity) return null;
  return {workspaceId: workspace, revision: Number(header.revision), logCursor: Number(header.log_cursor), journalCursor: Number(header.journal_cursor), files: storedFiles(storage, workspace), texts: [], omitted: JSON.parse(String(header.omitted_json))};
}
export function readReplicaCurrentViewText(storage: StorageContext, workspace: string, sha: string): string | null {
  if (!readReplicaStanding(storage, workspace)) return null;
  const selectors = replicaCurrentViewSelectors(storage, workspace);
  const files = storage.db.prepare("SELECT version_id,path FROM sync_relay_replica_cut_files WHERE workspace_id=? AND sha256=? AND content_kind='text'").all(workspace, sha);
  if (!files.some(f => currentViewFileVisible(selectors, {versionId: String(f.version_id), path: String(f.path)}))) return null;
  const rows = storage.db.prepare("SELECT bytes FROM sync_relay_replica_cut_texts WHERE workspace_id=? AND sha256=? AND ref_count>0 ORDER BY ordinal").all(workspace, sha);
  return rows.length ? Buffer.concat(rows.map(row => Buffer.from(row.bytes as Uint8Array))).toString("utf8") : null;
}
