import {createHash} from "node:crypto";
import {prepareSharePath, visibleSharePath} from "@dohc/security-contract/share-selector";
import type {ReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import {createAccountlessPathProjection} from "./accountlessPathProjection";
import {authorizeShareGrantAction} from "./shareAuthorization";
import {fileSideOf, targetVersionId} from "./shareFilter";
import type {StorageContext} from "./storage/context";
import type {CurrentShareGrantPrincipal} from "./storage/currentShareGrant";
import {currentViewFileAtFence, readReplicaCurrentViewRowText} from "./storage/replicaCurrentViews";

export interface ReplicaCurrentViewReadInput {
  readonly grantId: string;
  readonly generation: number;
  readonly principal: CurrentShareGrantPrincipal;
}
export interface ReplicaCurrentViewSource {
  currentReadView(workspaceId: string): {view: ReplicaCurrentView; previous?: ReplicaCurrentView} | null;
}
export type ReplicaCurrentViewFile = {
  path: string;
  status: "ready";
  kind: "text" | "binary";
  etag: string;
  byteLength: number;
  sha256?: string;
} | {path: string; status: "updating"};
type Unavailable = {status: "denied" | "not-ready" | "updating"};
export type ReplicaCurrentViewList = Unavailable | {status: "ready"; files: ReplicaCurrentViewFile[]; etag: string};
export type ReplicaCurrentViewRead = Unavailable | {status: "not-found" | "not-text"} |
  {status: "ready"; file: Extract<ReplicaCurrentViewFile, {status: "ready"}>; text: string};

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const etag = (value: unknown) => `"${digest(JSON.stringify(value))}"`;
const shaPattern = /^[a-f0-9]{64}$/;
type ViewFile = ReplicaCurrentView["files"][number];
type ReadyFile = Extract<ReplicaCurrentViewFile,{status:"ready"}>;
type IndexedFile = {row: ViewFile; lineage: string; path: NonNullable<ReturnType<typeof prepareSharePath>>; projected: Map<string, ReadyFile>};
type ViewIndex = {files: Map<string, Map<string, IndexedFile>>; texts: Map<string, string>;
  lineages: Map<string,IndexedFile>; omittedPaths: Map<string,string>;
  inventories: Array<{files: ReplicaCurrentViewFile[]; etag: string}>;
  decoded: Map<string,string>; decodedBytes: number; omitted: Array<{row: ReplicaCurrentView["omitted"][number]; path: NonNullable<ReturnType<typeof prepareSharePath>>}>};
const indexes = new WeakMap<ReplicaCurrentView, ViewIndex | null>();
const latestIndexes = new WeakMap<StorageContext, Map<string, ViewIndex["files"]>>();
const DECODED_TEXT_BYTES = 4 * 1024 * 1024;
const inventoryTags = new WeakMap<ReadyFile,string>();
const pathKey = (version: string, path: string) => JSON.stringify([version,path]);
const lineageKey = (version: string, object: string, lineage: string | null) => JSON.stringify([version,object,lineage]);
const fenceStatements = new WeakMap<StorageContext, Map<string, ReturnType<StorageContext["db"]["prepare"]>>>();
function readFences(storage: StorageContext, where: string, args: unknown[]) {
  let statements = fenceStatements.get(storage);
  if (!statements) fenceStatements.set(storage,statements=new Map());
  let statement = statements.get(where);
  if (!statement) {
    statement=storage.db.prepare(`SELECT main_version_id,object_id,lineage_claim_id,current_path,restore_fence_generation
      FROM sync_relay_live_documents WHERE lineage_state='current' AND ${where}`);
    statements.set(where,statement);
  }
  return statement.all(...args);
}

function indexView(view: ReplicaCurrentView, previous?: ViewIndex["files"]): ViewIndex | null {
  if (indexes.has(view)) return indexes.get(view)!;
  indexes.set(view,null);
  const paths = new Set<string>(), objects = new Set<string>();
  const byteLengths = new Map<string,number>();
  const lineages: ViewIndex["lineages"] = new Map(), omittedPaths = new Map<string,string>();
  const files: ViewIndex["files"] = new Map(), texts = new Map<string,string>(), omitted: ViewIndex["omitted"] = [];
  for (const file of [...view.files, ...view.omitted]) {
    const key = JSON.stringify([file.versionId,file.path]), object = JSON.stringify([file.versionId,file.objectId]);
    const prior = "contentKind" in file ? previous?.get(file.versionId)?.get(file.path) : undefined;
    const same = prior && "contentKind" in file && prior.row.objectId === file.objectId && prior.row.contentKind === file.contentKind &&
      prior.row.sha256 === file.sha256 && prior.row.byteLength === file.byteLength && prior.row.lineageClaimId === file.lineageClaimId &&
      prior.row.restoreGeneration === file.restoreGeneration;
    const path = same ? prior.path : prepareSharePath(file.path);
    if (!path || path.path !== file.path || !file.objectId || !same && !shaPattern.test(file.sha256) || paths.has(key) || objects.has(object)) return null;
    paths.add(key); objects.add(object); Object.freeze(file);
    if ("contentKind" in file) {
      if (!same && (!["text","binary"].includes(file.contentKind) || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 ||
        (file.lineageClaimId === null ? file.restoreGeneration !== null : !shaPattern.test(file.lineageClaimId) ||
          !Number.isSafeInteger(file.restoreGeneration) || file.restoreGeneration! < 1))) return null;
      if (byteLengths.has(file.sha256) && byteLengths.get(file.sha256) !== file.byteLength) return null;
      byteLengths.set(file.sha256,file.byteLength);
      let version = files.get(file.versionId);
      if (!version) files.set(file.versionId,version = new Map());
      const indexed: IndexedFile = same ? prior : {row:file,path,lineage:lineageKey(file.versionId,file.objectId,file.lineageClaimId),projected:new Map()};
      projectedFile(indexed,file.path);
      version.set(file.path,indexed); lineages.set(indexed.lineage,indexed);
    } else {
      if (file.reason !== "text-frame-limit") return null;
      omitted.push({row:file,path});
      omittedPaths.set(key,file.objectId);
    }
  }
  for (const text of view.texts) {
    if (texts.has(text.sha256) || !shaPattern.test(text.sha256) || digest(text.text) !== text.sha256 ||
      byteLengths.has(text.sha256) && byteLengths.get(text.sha256) !== Buffer.byteLength(text.text)) return null;
    texts.set(text.sha256,text.text); Object.freeze(text);
  }
  // Metadata and verified text only. No grant or selector decision is cached.
  Object.freeze(view.files); Object.freeze(view.omitted); Object.freeze(view.texts); Object.freeze(view);
  const index: ViewIndex = {files,texts,lineages,omittedPaths,inventories:[],decoded:new Map<string,string>(),decodedBytes:0,omitted}; indexes.set(view,index);
  return index;
}

function projectedFile(indexed: IndexedFile, path: string) {
  let result = indexed.projected.get(path);
  if (!result) {
    const file = indexed.row;
    result = Object.freeze({path,status:"ready" as const,kind:file.contentKind,byteLength:file.byteLength,
      etag:etag([file.sha256,file.restoreGeneration,path]),...(file.contentKind === "binary" ? {sha256:file.sha256} : {})});
    indexed.projected.set(path,result);
    inventoryTags.set(result,`${result.etag}:${result.kind}:${result.byteLength}`);
  }
  return result;
}

function inventoryEtag(index: ViewIndex, files: ReplicaCurrentViewFile[]) {
  // Compare freshly authorized output, never a selector or a cached grant decision.
  const prior = index.inventories.find(saved => saved.files.length === files.length && files.every((file,i) =>
    file === saved.files[i] || file.status === "updating" && saved.files[i]!.status === "updating" && file.path === saved.files[i]!.path));
  if (prior) return prior.etag;
  const tag = etag(files.map(file => file.status === "ready" ? inventoryTags.get(file)! : ["updating",file.path]));
  index.inventories.unshift({files:files.map(file => file.status === "ready" ? file : {...file}),etag:tag});
  if (index.inventories.length > 4) index.inventories.pop();
  return tag;
}

// The accessor, grant and text never leave this synchronous read transaction.
function withCurrentView<T>(storage: StorageContext, input: ReplicaCurrentViewReadInput,
  source: ReplicaCurrentViewSource | undefined,
  read: (snapshot: {
    files: ReplicaCurrentViewFile[];
    rows: Map<string, ViewFile>;
    readText: (row: ViewFile) => string | null;
    inventoryEtag: () => string;
  }) => T, requestedPath?: string,
): T | Unavailable {
  return storage.readTx(() => {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) return {status:"denied"};
    const authorized = authorizeShareGrantAction({storage, grantId:input.grantId, generation:input.generation, principal:input.principal, action:"read"});
    if (!authorized.ok) return {status:"denied"};
    const selector = fileSideOf(authorized.effectiveSelector);
    if (!selector) return {status:"denied"};
    const workspace = authorized.share.workspaceId;
    const standing = storage.readReplicaStanding(workspace);
    if (!standing) return {status:"not-ready"};
    if (standing.ownerUserId !== authorized.share.granterUserId) return {status:"denied"};
    const projection = input.principal.kind === "link" ? createAccountlessPathProjection(selector) : null;
    const realPath = requestedPath === undefined ? undefined : projection ? projection.resolvePath(requestedPath) ?? "" : requestedPath;
    const stored = source ? null : storage.readReplicaCurrentView(workspace);
    const snapshot = source ? source.currentReadView(workspace) : stored && {view:stored,previous:stored};
    if (!snapshot) return {status:"not-ready"};
    const {view} = snapshot;
    if (view.workspaceId !== workspace || [view.revision, view.logCursor, view.journalCursor].some(n => !Number.isSafeInteger(n) || n < 0) ||
      view.logCursor > standing.logSeq || view.journalCursor > standing.journalCursor) return {status:"updating"};
    let latest = latestIndexes.get(storage);
    if (!latest) latestIndexes.set(storage,latest = new Map());
    const index = indexView(view,latest.get(workspace));
    if (!index) return {status:"updating"};
    // Keep only metadata for reuse, so retired live texts can be collected.
    latest.set(workspace,index.files);
    const version = targetVersionId(selector);
    const visible = (v: string, path: string | NonNullable<ReturnType<typeof prepareSharePath>>) => v === version && visibleSharePath(selector, path) !== null;
    const project = (path: string) => projection ? projection.projectPath(path) : path;
    const files = new Map<string, ReplicaCurrentViewFile>(), rows = new Map<string, ViewFile>();
    const previous = snapshot.previous && indexView(snapshot.previous,index.files);
    if (snapshot.previous && !previous) return {status:"updating"};
    // An open needs only the incoming row and a row that can carry the saved path.
    const direct = realPath === undefined ? undefined : index.files.get(version)?.get(realPath);
    const saved = realPath === undefined ? undefined : previous?.files.get(version)?.get(realPath);
    const returning = saved && index.lineages.get(saved.lineage);
    const selected = realPath === undefined ? index.files.get(version)?.values() ?? [] : [...new Set([direct,returning].filter((f): f is IndexedFile => !!f))];
    const objects = new Set<string>();
    if (realPath !== undefined) for (const f of selected) {
      if (f.row.lineageClaimId === null) continue;
      objects.add(f.row.objectId);
      const old = previous?.lineages.get(f.lineage)?.row;
      const occupant = old && index.files.get(version)?.get(old.path)?.row;
      if (occupant?.lineageClaimId != null) objects.add(occupant.objectId);
    }
    let fences = realPath === undefined ? readFences(storage,"workspace_id=?",[workspace]) : objects.size ?
      readFences(storage,"workspace_id=? AND main_version_id=? AND object_id IN (SELECT value FROM json_each(?))",[workspace,version,JSON.stringify([...objects])]) : [];
    const generations = new Map(fences.map(f=>[lineageKey(String(f.main_version_id),String(f.object_id),String(f.lineage_claim_id)),Number(f.restore_fence_generation)]));
    const current = (f: IndexedFile) => f.row.lineageClaimId === null || f.row.restoreGeneration === (generations.get(f.lineage) ?? 1);
    for (const incoming of selected) {
      const old = current(incoming) ? undefined : previous?.lineages.get(incoming.lineage);
      const occupant = old && index.files.get(version)?.get(old.row.path);
      const reservedBy = old && (index.omittedPaths.get(pathKey(version,old.row.path)) ?? (occupant && current(occupant) ? occupant.row.objectId : undefined));
      const row = currentViewFileAtFence(incoming.row,generations.get(incoming.lineage) ?? 1,old?.row,reservedBy);
      const indexed = row === incoming.row ? incoming : old;
      if (!row || !indexed) continue;
      const file = row;
      if (!visible(file.versionId, indexed.path)) continue;
      const path = project(file.path);
      if (path === null || requestedPath !== undefined && path !== requestedPath) continue;
      if (!current(indexed)) {files.set(path, {path, status:"updating"}); continue;}
      files.set(path,projectedFile(indexed,path));
      if (requestedPath !== undefined) rows.set(path, file);
    }
    for (const omitted of index.omitted) {
      if (!visible(omitted.row.versionId, omitted.path)) continue;
      const path = project(omitted.row.path);
      if (path !== null && (requestedPath === undefined || path === requestedPath)) files.set(path, {path, status:"updating"});
    }
    if (realPath !== undefined && files.size === 0) fences = readFences(storage,
      "workspace_id=? AND main_version_id=? AND current_path=? AND restore_fence_generation>1",[workspace,version,realPath]);
    // A restore can remove an unfenced row before its replacement reaches the view.
    for (const fence of fences) {
      if (Number(fence.restore_fence_generation) <= 1 || !visible(String(fence.main_version_id), String(fence.current_path))) continue;
      const path = project(String(fence.current_path));
      if (path !== null && (requestedPath === undefined || path === requestedPath) && !files.has(path)) files.set(path, {path, status:"updating"});
    }
    const sorted = [...files.values()].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return read({files:sorted, rows, inventoryEtag:()=>inventoryEtag(index,sorted), readText:row => {
      const text = index.texts.get(row.sha256);
      if (text !== undefined) return text;
      const cached = index.decoded.get(row.sha256);
      if (cached !== undefined) return cached;
      const decoded = readReplicaCurrentViewRowText(storage,workspace,row);
      // Cache only opened stored texts, with a fixed per-view byte budget.
      if (decoded !== null && row.byteLength <= DECODED_TEXT_BYTES) {
        while (index.decodedBytes + row.byteLength > DECODED_TEXT_BYTES) {
          const oldest = index.decoded.keys().next().value!;
          index.decodedBytes -= Buffer.byteLength(index.decoded.get(oldest)!); index.decoded.delete(oldest);
        }
        index.decoded.set(row.sha256,decoded); index.decodedBytes += row.byteLength;
      }
      return decoded;
    }});
  });
}

export function listReplicaCurrentViewFiles(storage: StorageContext, input: ReplicaCurrentViewReadInput,
  source?: ReplicaCurrentViewSource): ReplicaCurrentViewList {
  return withCurrentView(storage, input, source, ({files,inventoryEtag}) => ({status:"ready" as const, files,etag:inventoryEtag()}));
}

export function readReplicaCurrentViewFile(storage: StorageContext, input: ReplicaCurrentViewReadInput & {path: string},
  source?: ReplicaCurrentViewSource): ReplicaCurrentViewRead {
  return withCurrentView(storage, input, source, ({files, rows, readText}): ReplicaCurrentViewRead => {
    const file = files.find(f => f.path === input.path);
    if (!file) return {status:"not-found"};
    if (file.status === "updating") return {status:"updating"};
    if (file.kind !== "text") return {status:"not-text"};
    const row = rows.get(input.path)!;
    const text = readText(row);
    if (text === null) return {status:"updating"};
    return {status:"ready", file, text};
  }, input.path);
}
