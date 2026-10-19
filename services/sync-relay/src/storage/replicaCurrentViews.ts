import {createHash} from "node:crypto";
import type {ReplicaCurrentView, ReplicaCurrentViewSelector} from "@dohc/workspace-engine-client/daemon";
import {visibleSharePath} from "@dohc/security-contract/share-selector";
import {parseStoredAnyShareSelectorJson, targetVersionId} from "../shareFilter";
import {selectorTargetsBlockedChannel} from "../shareAuthorization";
import type {ReplicaReadLease} from "../replicaReadPrincipal";
import type {StorageContext} from "./context";
import {currentShareGrantSql} from "./currentShareGrant";
import {readReplicaStanding} from "./replicaReads";
import {historyObjectKey, sameHistoryState, pinReplicaHistory, thinReplicaHistoryPins, type ReplicaHistoryObservation, type ReplicaHistoryChanges} from "./replicaHistoryPins";
import {replicaStatement as statement} from "./replicaStatements";
import {deleteUnreferencedReplicaTexts, hasReplicaText, readReplicaText} from "./replicaTextStorage";

const STAGE_BYTES = 8 * 1024 * 1024;
const incarnations = new WeakMap<StorageContext, Map<string, ReplicaReadLease>>();
const readCaches = new WeakMap<StorageContext, Map<string, {key: string; view: ReplicaCurrentView}>>();
const MAX_READ_CACHE_WORKSPACES = 4;
const headerSql = "SELECT replication_epoch,stream_identity,incarnation,cut_seq,revision,log_cursor,journal_cursor FROM sync_relay_replica_cuts WHERE workspace_id=?";
export interface StagedCurrentView {readonly staged: true}
const stagedViews = new WeakMap<StagedCurrentView, {storage: StorageContext; lease: ReplicaReadLease; view: ReplicaCurrentView; observations: ReplicaHistoryObservation[]}>();
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
  forgetReplicaCurrentViewStoredCache(storage,lease.workspaceId);
}
export function replicaCurrentViewSelectors(storage: StorageContext, workspace: string): ReplicaCurrentViewSelector[] {
  return statement(storage,`SELECT DISTINCT s.selector_json FROM sync_relay_shares s JOIN sync_relay_share_grants g ON g.share_id=s.share_id
    WHERE s.workspace_id=? AND ${currentShareGrantSql("g", "s")} ORDER BY s.selector_json`).all(workspace).flatMap(row => {
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
  return statement(storage, "SELECT * FROM sync_relay_replica_cut_files WHERE workspace_id=? ORDER BY version_id,path").all(workspace).map(row => ({
    versionId: String(row.version_id), objectId: String(row.object_id), path: String(row.path), contentKind: row.content_kind as "text" | "binary", sha256: String(row.sha256), byteLength: Number(row.byte_length),
    lineageClaimId: row.lineage_claim_id === null ? null : String(row.lineage_claim_id), restoreGeneration: row.restore_generation === null ? null : Number(row.restore_generation)}));
}
const filePathKey = (file: {versionId: string; path: string}) => JSON.stringify([file.versionId, file.path]);
const fileLineageKey = (file: ReplicaCurrentView["files"][number]) => JSON.stringify([file.versionId, file.objectId, file.lineageClaimId]);
function currentViewFences(storage: StorageContext, workspace: string) {
  return new Map(statement(storage,"SELECT main_version_id,object_id,lineage_claim_id,restore_fence_generation FROM sync_relay_live_documents WHERE workspace_id=? AND lineage_state='current'")
    .all(workspace).map(row => [JSON.stringify([row.main_version_id, row.object_id, row.lineage_claim_id]), Number(row.restore_fence_generation)]));
}
function currentViewPaths(files: ReplicaCurrentView["files"], omitted: ReplicaCurrentView["omitted"], fences: Map<string, number>) {
  const currentFiles = files.filter(file => file.lineageClaimId === null || file.restoreGeneration === (fences.get(fileLineageKey(file)) ?? 1));
  return new Map([...currentFiles, ...omitted].map(file => [filePathKey(file), file.objectId]));
}
function carriedPathAvailable(file: ReplicaCurrentView["files"][number], owner: string | undefined) {
  return owner === undefined || owner === file.objectId;
}
export function currentViewFileAtFence(file: ReplicaCurrentView["files"][number], generation: number,
  previous: ReplicaCurrentView["files"][number] | undefined, reservedBy: string | undefined) {
  if (file.lineageClaimId === null || file.restoreGeneration === generation) return file;
  return previous && carriedPathAvailable(previous,reservedBy) ? previous : undefined;
}
export function currentViewFilesAtFences(storage: StorageContext, workspace: string, files: ReplicaCurrentView["files"], previous: ReplicaCurrentView["files"], omitted: ReplicaCurrentView["omitted"]) {
  const saved = new Map(previous.map(f => [fileLineageKey(f), f]));
  const fences = currentViewFences(storage, workspace);
  const currentPaths = currentViewPaths(files, omitted, fences);
  return files.flatMap(file => {
    const old = saved.get(fileLineageKey(file));
    const row = currentViewFileAtFence(file,fences.get(fileLineageKey(file)) ?? 1,old,old && currentPaths.get(filePathKey(old)));
    return row ? [row] : [];
  });
}
function validateReplicaPosition(storage: StorageContext, lease: ReplicaReadLease, view: ReplicaCurrentView) {
  const standing = current(storage, lease);
  if (view.workspaceId !== lease.workspaceId || [view.revision, view.logCursor, view.journalCursor].some(v => !Number.isSafeInteger(v) || v < 0) ||
      view.logCursor > standing.logSeq || view.journalCursor > standing.journalCursor) fail();
  const saved = statement(storage,"SELECT * FROM sync_relay_replica_cuts WHERE workspace_id=?").get(lease.workspaceId);
  if (saved && (view.logCursor < Number(saved.log_cursor) || view.journalCursor < Number(saved.journal_cursor))) fail();
  return saved;
}
function validateReplicaCurrentView(storage: StorageContext, lease: ReplicaReadLease, view: ReplicaCurrentView, observations: ReplicaHistoryObservation[]) {
  const saved = validateReplicaPosition(storage,lease,view);
  const selectors = replicaCurrentViewSelectors(storage, lease.workspaceId), paths = new Set<string>(), objects = new Set<string>();
  const previous = new Map(storedFiles(storage, lease.workspaceId).map(f => [fileLineageKey(f), f]));
  const remaining = new Map([...previous.values()].map(f=>[historyObjectKey(f),f]));
  const previousOmitted = new Map<string,ReplicaCurrentView["omitted"][number]>(JSON.parse(String(saved?.omitted_json ?? "[]")).map((f: ReplicaCurrentView["omitted"][number])=>[historyObjectKey(f),f]));
  const changes: ReplicaHistoryChanges = new Map();
  const fences = currentViewFences(storage, lease.workspaceId);
  const currentPaths = currentViewPaths(view.files, view.omitted, fences);
  const predecessors=new Set(observations.filter(o=>o.beforeStructuralChange).map(o=>JSON.stringify([o.versionId,o.objectId])));
  const files: ReplicaCurrentView["files"] = [];
  for (let file of view.files) {
    if (!file.objectId || !currentViewFileVisible(selectors, file) || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || !["text", "binary"].includes(file.contentKind) ||
        (file.lineageClaimId === null) !== (file.restoreGeneration === null)) fail();
    const old = previous.get(fileLineageKey(file));
    if (old?.restoreGeneration != null && (file.restoreGeneration === null || file.restoreGeneration < old.restoreGeneration)) fail();
    if (file.lineageClaimId !== null) {
      if (!/^[a-f0-9]{64}$/.test(file.lineageClaimId) || !Number.isSafeInteger(file.restoreGeneration) || file.restoreGeneration! < 0) fail();
      const generation = fences.get(fileLineageKey(file)) ?? 1;
      // Save the supervisor's pre-change frame for a structural pin. Reads still enforce the raised fence.
      const predecessor=predecessors.has(JSON.stringify([file.versionId,file.objectId])) && old?.restoreGeneration === file.restoreGeneration && old.path === file.path;
      if (file.restoreGeneration! > generation && !predecessor) fail();
      if (file.restoreGeneration! < generation && !predecessor) {
        if (!old || !currentViewFileVisible(selectors, old) || !carriedPathAvailable(old, currentPaths.get(filePathKey(old)))) continue;
        file = old;
      }
    }
    const object = historyObjectKey(file), path = filePathKey(file);
    if (objects.has(object) || paths.has(path)) fail();
    objects.add(object); paths.add(path); files.push(file);
    const before=remaining.get(object);
    if (!before || !sameHistoryState(before,file)) changes.set(object,{before,after:file});
    remaining.delete(object); previousOmitted.delete(object);
  }
  for (const omitted of view.omitted) {
    const object = historyObjectKey(omitted), path = filePathKey(omitted);
    if (!omitted.objectId || !currentViewFileVisible(selectors, omitted) || !/^[a-f0-9]{64}$/.test(omitted.sha256) || omitted.reason !== "text-frame-limit" || objects.has(object) || paths.has(path)) fail();
    objects.add(object); paths.add(path);
    const unavailable=previousOmitted.get(object);
    if (remaining.has(object) || unavailable?.path !== omitted.path || unavailable.sha256 !== omitted.sha256)
      changes.set(object,{before:remaining.get(object),omitted});
    remaining.delete(object); previousOmitted.delete(object);
  }
  for (const [key,before] of remaining) changes.set(key,{before});
  for (const [key,omitted] of previousOmitted) changes.set(key,{departed:omitted});
  return {view:{...view, files},changes};
}
export function discardReplicaCurrentView(storage: StorageContext, lease: ReplicaReadLease) {
  if (statement(storage,"SELECT 1 FROM sync_relay_replica_cut_text_refs WHERE workspace_id=? AND ref_count=0 LIMIT 1").get(lease.workspaceId)) {
    storage.replicaViewTx(() => deleteUnreferencedReplicaTexts(storage,lease.workspaceId));
  }
}
export function stageReplicaCurrentView(storage: StorageContext, lease: ReplicaReadLease, view: ReplicaCurrentView, observations: ReplicaHistoryObservation[] = []): StagedCurrentView {
  try {
    current(storage, lease);
    const stored = new Set<string>();
    const requested = new Map(view.files.filter(f => f.contentKind === "text").map(f => [f.sha256, f.byteLength]));
    const insert = statement(storage,"INSERT INTO sync_relay_replica_cut_texts VALUES (?,?,?,?) ON CONFLICT(workspace_id,sha256,ordinal) DO NOTHING");
    const reference = statement(storage,"INSERT INTO sync_relay_replica_cut_text_refs VALUES (?,?,0) ON CONFLICT(workspace_id,sha256) DO NOTHING");
    let batch: Array<{sha: string; ordinal: number; bytes: Buffer}> = [], batchBytes = 0;
    const flush = () => {
      if (!batch.length) return;
      storage.replicaViewTx(() => {
        current(storage, lease);
        for (const chunk of batch) {
          insert.run(lease.workspaceId, chunk.sha, chunk.ordinal, chunk.bytes);
          if (chunk.ordinal === 0) reference.run(lease.workspaceId, chunk.sha);
        }
      });
      batch = []; batchBytes = 0;
    };
    for (const text of view.texts) {
      if (stored.has(text.sha256) || hasReplicaText(storage,lease.workspaceId,text.sha256)) {
        stored.add(text.sha256); continue;
      }
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
    stagedViews.set(staged, {storage, lease, view: {...view, files: structuredClone(view.files), omitted: structuredClone(view.omitted), texts: []}, observations:structuredClone(observations)});
    return staged;
  } catch (error) {discardReplicaCurrentView(storage, lease); throw error;}
}
export function flipReplicaCurrentView(storage: StorageContext, lease: ReplicaReadLease, staged: StagedCurrentView) {
  const state = stagedViews.get(staged);
  try {
    if (!state || state.storage !== storage || state.lease !== lease) fail();
    stagedViews.delete(staged);
    return storage.replicaViewTx(() => {
      const {view,changes} = validateReplicaCurrentView(storage, lease, state.view,state.observations);
      const chunks = statement(storage,"SELECT count(*) AS n,min(ordinal) AS first,max(ordinal) AS last,sum(length(bytes)) AS bytes FROM sync_relay_replica_cut_texts WHERE workspace_id=? AND sha256=?");
      const checked = new Map<string, number>();
      for (const file of view.files) {
        if (file.contentKind !== "text") continue;
        if (checked.has(file.sha256)) {
          if (checked.get(file.sha256) !== file.byteLength) fail();
          continue;
        }
        checked.set(file.sha256, file.byteLength);
        const row = chunks.get(lease.workspaceId, file.sha256)!;
        if (!row.n || row.first !== 0 || Number(row.last) !== Number(row.n) - 1 || row.bytes !== file.byteLength) fail();
      }
      const saved=statement(storage,"SELECT omitted_json FROM sync_relay_replica_cuts WHERE workspace_id=?").get(lease.workspaceId);
      if (!changes.size && saved?.omitted_json===JSON.stringify(view.omitted)) return writeReplicaHeader(storage,lease,view);
      // Also invalidate when deletion/recreation repeats a cut sequence and header.
      readCaches.get(storage)?.delete(lease.workspaceId);
      const references=pinReplicaHistory(storage,view,changes,state.observations);
      for (const row of statement(storage,"SELECT sha256,count(*) AS n FROM sync_relay_replica_cut_files WHERE workspace_id=? AND content_kind='text' GROUP BY sha256").all(lease.workspaceId))
        references.set(String(row.sha256),(references.get(String(row.sha256)) ?? 0)-Number(row.n));
      for (const file of view.files) if (file.contentKind === "text") references.set(file.sha256,(references.get(file.sha256) ?? 0)+1);
      statement(storage,`INSERT INTO sync_relay_replica_cuts VALUES (?,?,?,?,1,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET
        replication_epoch=excluded.replication_epoch,stream_identity=excluded.stream_identity,incarnation=excluded.incarnation,
        cut_seq=sync_relay_replica_cuts.cut_seq+1,revision=excluded.revision,log_cursor=excluded.log_cursor,journal_cursor=excluded.journal_cursor,omitted_json=excluded.omitted_json`)
        .run(lease.workspaceId, lease.replicationEpoch, lease.streamIdentity, lease.incarnation, view.revision, view.logCursor, view.journalCursor, JSON.stringify(view.omitted));
      statement(storage,"DELETE FROM sync_relay_replica_cut_files WHERE workspace_id=?").run(lease.workspaceId);
      const insert = statement(storage,"INSERT INTO sync_relay_replica_cut_files VALUES (?,?,?,?,?,?,?,?,?)");
      for (const f of view.files) insert.run(lease.workspaceId, f.versionId, f.objectId, f.path, f.contentKind, f.sha256, f.byteLength, f.lineageClaimId, f.restoreGeneration);
      const reference=statement(storage,"UPDATE sync_relay_replica_cut_text_refs SET ref_count=ref_count+? WHERE workspace_id=? AND sha256=?");
      for (const [sha,delta] of references) if (delta) reference.run(delta,lease.workspaceId,sha);
      thinReplicaHistoryPins(storage,lease.workspaceId);
      deleteUnreferencedReplicaTexts(storage,lease.workspaceId);
      return view;
    });
  } catch (error) {discardReplicaCurrentView(storage, lease); throw error;}
}
function sampleStoredReplicaHistory(storage: StorageContext, view: Pick<ReplicaCurrentView,"workspaceId" | "logCursor" | "journalCursor">) {
  const references=pinReplicaHistory(storage,view,new Map());
  for (const [sha,delta] of references)
    statement(storage,"UPDATE sync_relay_replica_cut_text_refs SET ref_count=ref_count+? WHERE workspace_id=? AND sha256=?").run(delta,view.workspaceId,sha);
}
function writeReplicaHeader(storage: StorageContext, lease: ReplicaReadLease, view: ReplicaCurrentView) {
  const header=statement(storage,headerSql).get(lease.workspaceId)!;
  const version=statement(storage,"PRAGMA data_version").get();
  const cached=readCaches.get(storage)?.get(lease.workspaceId);
  const reusable=cached?.key===JSON.stringify([header,version]);
  sampleStoredReplicaHistory(storage,view);
  statement(storage,`UPDATE sync_relay_replica_cuts SET log_cursor=?,journal_cursor=?,revision=?,cut_seq=cut_seq+1 WHERE workspace_id=?`)
    .run(view.logCursor,view.journalCursor,view.revision,lease.workspaceId);
  if (cached && reusable) {
    const position={revision:view.revision,logCursor:view.logCursor,journalCursor:view.journalCursor};
    cached.key=JSON.stringify([{...header,revision:view.revision,log_cursor:view.logCursor,journal_cursor:view.journalCursor,cut_seq:Number(header.cut_seq)+1},version]);
    cached.view=Object.freeze({...cached.view,...position});
  } else readCaches.get(storage)?.delete(lease.workspaceId);
  return view;
}
/** Internal: the supervisor has proved that files and omissions did not change. */
export function advanceReplicaCurrentView(storage: StorageContext, lease: ReplicaReadLease, view: ReplicaCurrentView, previous: ReplicaCurrentView) {
  return storage.replicaViewTx(() => {
    const saved=validateReplicaPosition(storage,lease,view);
    if (!saved || saved.replication_epoch!==lease.replicationEpoch || saved.stream_identity!==lease.streamIdentity ||
        saved.revision!==previous.revision || saved.log_cursor!==previous.logCursor || saved.journal_cursor!==previous.journalCursor ||
        saved.omitted_json!==JSON.stringify(view.omitted)) fail();
    return writeReplicaHeader(storage,lease,view);
  });
}
export function sampleReplicaHistory(storage: StorageContext, lease: ReplicaReadLease) {
  storage.replicaViewTx(() => {
    current(storage,lease);
    const header=statement(storage,"SELECT log_cursor,journal_cursor FROM sync_relay_replica_cuts WHERE workspace_id=?").get(lease.workspaceId);
    if (!header) return;
    sampleStoredReplicaHistory(storage,{workspaceId:lease.workspaceId,logCursor:Number(header.log_cursor),journalCursor:Number(header.journal_cursor)});
  });
}
export function readReplicaCurrentView(storage: StorageContext, workspace: string): ReplicaCurrentView | null {
  const standing = readReplicaStanding(storage, workspace);
  const header = statement(storage,headerSql).get(workspace);
  let cache = readCaches.get(storage);
  if (!cache) readCaches.set(storage, cache = new Map());
  if (!standing || !header || header.replication_epoch !== standing.replicationEpoch || header.stream_identity !== standing.streamIdentity) {
    forgetReplicaCurrentViewStoredCache(storage,workspace); return null;
  }
  // data_version detects flips/deletions by other connections, within this read snapshot.
  const key = JSON.stringify([header, statement(storage, "PRAGMA data_version").get()]);
  const saved = cache.get(workspace);
  if (saved?.key === key) { cache.delete(workspace); cache.set(workspace,saved); return saved.view; }
  const omitted = statement(storage,"SELECT omitted_json FROM sync_relay_replica_cuts WHERE workspace_id=?").get(workspace)!;
  const view = {workspaceId: workspace, revision: Number(header.revision), logCursor: Number(header.log_cursor), journalCursor: Number(header.journal_cursor), files: storedFiles(storage, workspace), texts: [], omitted: JSON.parse(String(omitted.omitted_json))};
  for (const file of [...view.files, ...view.omitted]) Object.freeze(file);
  Object.freeze(view.files); Object.freeze(view.texts); Object.freeze(view.omitted); Object.freeze(view);
  cache.delete(workspace); cache.set(workspace, {key, view});
  while (cache.size > MAX_READ_CACHE_WORKSPACES) cache.delete(cache.keys().next().value!);
  return view;
}

/** Drop a stored snapshot without changing the replica lease. */
export function forgetReplicaCurrentViewStoredCache(storage: StorageContext, workspace: string) {
  readCaches.get(storage)?.delete(workspace);
}

/** @internal Test-only cache accounting. */
export function replicaCurrentViewStoredCacheSize(storage: StorageContext) {
  return readCaches.get(storage)?.size ?? 0;
}

/** Internal only: the reader has authorized this exact row in the same read transaction. */
export function readReplicaCurrentViewRowText(storage: StorageContext, workspace: string, file: ReplicaCurrentView["files"][number]): string | null {
  const rows = statement(storage, `SELECT t.bytes FROM sync_relay_replica_cut_files f JOIN sync_relay_replica_cut_texts t
    ON t.workspace_id=f.workspace_id AND t.sha256=f.sha256
    JOIN sync_relay_replica_cut_text_refs r ON r.workspace_id=t.workspace_id AND r.sha256=t.sha256 AND r.ref_count>0
    WHERE f.workspace_id=? AND f.version_id=? AND f.path=? AND f.sha256=? AND f.byte_length=? AND f.content_kind='text' ORDER BY t.ordinal`)
    .all(workspace, file.versionId, file.path, file.sha256, file.byteLength);
  const chunks = rows.map(row => {const b = row.bytes as Uint8Array; return Buffer.from(b.buffer,b.byteOffset,b.byteLength);});
  return chunks.length ? (chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)).toString("utf8") : null;
}
export function readReplicaCurrentViewText(storage: StorageContext, workspace: string, sha: string): string | null {
  if (!readReplicaStanding(storage, workspace)) return null;
  const selectors = replicaCurrentViewSelectors(storage, workspace);
  const files = statement(storage,"SELECT version_id,path FROM sync_relay_replica_cut_files WHERE workspace_id=? AND sha256=? AND content_kind='text'").all(workspace, sha);
  if (!files.some(f => currentViewFileVisible(selectors, {versionId: String(f.version_id), path: String(f.path)}))) return null;
  return readReplicaText(storage,workspace,sha);
}
