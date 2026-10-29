import {createHash} from "node:crypto";
import {prepareSharePath, visibleSharePath} from "@dohc/security-contract/share-selector";
import type {ReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import {createAccountlessPathProjection} from "./accountlessPathProjection";
import {authorizeShareGrantAction, type AuthorizedShareAction} from "./shareAuthorization";
import {fileSideOf, targetVersionId} from "./shareFilter";
import type {StorageContext} from "./storage/context";
import type {CurrentShareGrantPrincipal} from "./storage/currentShareGrant";
import {replicaGrantFloor, replicaViewReachesFloor} from "./storage/replicaGrantFloors";
import {currentViewFileAtFence, forgetReplicaCurrentViewStoredCache, readReplicaCurrentViewRowText, readReplicaCurrentViewHead, isReplicaStoredHead, replicaFileFromRow} from "./storage/replicaCurrentViews";
import {replicaStatement as statement} from "./storage/replicaStatements";
import {ReplicaMap} from "./replicaMap";

export interface ReplicaCurrentViewReadInput {
  readonly grantId: string;
  readonly generation: number;
  readonly principal: Extract<CurrentShareGrantPrincipal, {kind:"user"}> | {kind:"link"; requireSession:()=>{grantId:string;generation:number}};
}
export interface ReplicaCurrentViewSource {
  currentReadView(workspaceId: string, readStored?:()=>ReplicaCurrentView|null): {view: ReplicaCurrentView; previous?: ReplicaCurrentView} | null;
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
type ViewIndex = {files: ReplicaMap<ReplicaMap<IndexedFile>>; texts: ReplicaMap<string>;
  textChecks: Map<string, boolean>;
  lineages: ReplicaMap<IndexedFile>; omittedPaths: ReplicaMap<string>;
  inventories: Array<{files: ReplicaCurrentViewFile[]; etag: string}>;
  decoded: Map<string,{text:string; bytes:number}>; decodedBytes: number; omitted: ReplicaMap<{row: ReplicaCurrentView["omitted"][number]; path: NonNullable<ReturnType<typeof prepareSharePath>>}>};
const indexes = new WeakMap<ReplicaCurrentView, ViewIndex | null>();
const latestIndexes = new WeakMap<StorageContext, Map<string, ViewIndex["files"]>>();
const MAX_INDEX_WORKSPACES = 4;
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
    statement=storage.db.prepare(`SELECT main_version_id,object_id,lineage_claim_id,current_path,restore_fence_generation,admission_state
      FROM sync_relay_live_documents WHERE lineage_state='current' AND ${where}`);
    statements.set(where,statement);
  }
  return statement.all(...args);
}

type Row = ViewFile | ReplicaCurrentView["omitted"][number];
const preparedPaths = new WeakMap<Row,IndexedFile["path"]>();
function validRow(file:Row, path:IndexedFile["path"]|null, same=false) {
  if (!path || path.path !== file.path || !file.objectId || !same && !shaPattern.test(file.sha256)) return false;
  return "contentKind" in file ? same || ["text","binary"].includes(file.contentKind) && Number.isSafeInteger(file.byteLength) && file.byteLength >= 0 &&
    (file.lineageClaimId === null ? file.restoreGeneration === null : shaPattern.test(file.lineageClaimId) && Number.isSafeInteger(file.restoreGeneration) && file.restoreGeneration! >= 1)
    : file.reason === "text-frame-limit";
}

function validateChanges(changes:ReplicaCurrentView) {
  for(const file of [...changes.files,...changes.omitted]) {
    const path=prepareSharePath(file.path);
    if(!path || !validRow(file,path))throw new Error("Invalid replica read index.");
    Object.freeze(file);
    preparedPaths.set(file,path);
  }
  const shas=new Set<string>();
  for(const text of changes.texts) {
    if(shas.has(text.sha256) || !shaPattern.test(text.sha256))throw new Error("Invalid replica read index.");
    shas.add(text.sha256);Object.freeze(text);
  }
}

function indexView(view: ReplicaCurrentView, previous?: Lookup<Lookup<IndexedFile>>, heldTexts?:ReplicaMap<string>): ViewIndex | null {
  if (indexes.has(view)) return indexes.get(view)!;
  indexes.set(view,null);
  const paths = new Set<string>(), objects = new Set<string>();
  const byteLengths = new Map<string,number>();
  const lineages = new Map<string,IndexedFile>(), omittedPaths = new Map<string,string>();
  const files = new Map<string,Map<string,IndexedFile>>(), texts = new Map<string,string>(), omitted = new Map<string,{row:ReplicaCurrentView["omitted"][number];path:IndexedFile["path"]}>();
  for (const file of [...view.files, ...view.omitted]) {
    const key = JSON.stringify([file.versionId,file.path]), object = JSON.stringify([file.versionId,file.objectId]);
    const prior = "contentKind" in file ? previous?.get(file.versionId)?.get(file.path) : undefined;
    const same = prior && "contentKind" in file && prior.row.objectId === file.objectId && prior.row.contentKind === file.contentKind &&
      prior.row.sha256 === file.sha256 && prior.row.byteLength === file.byteLength && prior.row.lineageClaimId === file.lineageClaimId &&
      prior.row.restoreGeneration === file.restoreGeneration;
    const path = same ? prior.path : preparedPaths.get(file) ?? prepareSharePath(file.path);
    if (!path || !validRow(file,path,!!same) || paths.has(key) || objects.has(object)) return null;
    paths.add(key); objects.add(object); Object.freeze(file);
    if ("contentKind" in file) {
      if (byteLengths.has(file.sha256) && byteLengths.get(file.sha256) !== file.byteLength) return null;
      byteLengths.set(file.sha256,file.byteLength);
      let version = files.get(file.versionId);
      if (!version) files.set(file.versionId,version = new Map());
      const indexed: IndexedFile = same ? prior : {row:file,path,lineage:lineageKey(file.versionId,file.objectId,file.lineageClaimId),projected:new Map()};
      projectedFile(indexed,file.path);
      version.set(file.path,indexed); lineages.set(indexed.lineage,indexed);
    } else {
      omitted.set(object,{row:file,path});
      omittedPaths.set(key,file.objectId);
    }
  }
  for (const text of view.texts) {
    if (texts.has(text.sha256) || !shaPattern.test(text.sha256)) return null;
    texts.set(text.sha256,text.text); Object.freeze(text);
  }
  // Metadata and verified text only. No grant or selector decision is cached.
  Object.freeze(view.files); Object.freeze(view.omitted); Object.freeze(view.texts); Object.freeze(view);
  const index: ViewIndex = {files:new ReplicaMap([...files].map(([version,rows])=>[version,new ReplicaMap(rows)])),texts:heldTexts ?? new ReplicaMap(texts),textChecks:new Map<string,boolean>(),lineages:new ReplicaMap(lineages),omittedPaths:new ReplicaMap(omittedPaths),inventories:[],decoded:new Map<string,{text:string; bytes:number}>(),decodedBytes:0,omitted:new ReplicaMap(omitted)}; indexes.set(view,index);
  return index;
}

type Lookup<V> = {get(key:string):V|undefined};
type Scan<V> = Lookup<V> & {values():IterableIterator<V>};
type ReadIndex = Omit<ViewIndex,"files"|"lineages"|"omittedPaths"|"omitted"> & {
  files:Lookup<Scan<IndexedFile>>; lineages:Lookup<IndexedFile>; omittedPaths:Lookup<string>;
  omitted:Scan<{row:ReplicaCurrentView["omitted"][number];path:IndexedFile["path"]}>;
};
class InvalidStoredRow extends Error {}
// SQL accessors live only inside the authorization transaction and retain no manifest.
function storedIndex(storage:StorageContext,workspace:string,version:string):ReadIndex {
  const indexed=(row:Record<string,unknown>|undefined):IndexedFile|undefined=>{
    if(!row)return;
    const file=replicaFileFromRow(row),path=prepareSharePath(file.path);
    if(!validRow(file,path))throw new InvalidStoredRow();
    return {row:file,path:path!,lineage:lineageKey(file.versionId,file.objectId,file.lineageClaimId),projected:new Map()};
  };
  function* scan(table:string):Generator<Record<string,unknown>> {
    let path="";
    for(;;) {
      const rows=statement(storage,`SELECT * FROM ${table} WHERE workspace_id=? AND version_id=? AND path>? ORDER BY path LIMIT 256`).all(workspace,version,path);
      yield* rows;
      if(rows.length<256)return;
      path=String(rows.at(-1)!.path);
    }
  }
  const files:Scan<IndexedFile>={
    get:path=>indexed(statement(storage,"SELECT * FROM sync_relay_replica_cut_files WHERE workspace_id=? AND version_id=? AND path=?").get(workspace,version,path)),
    *values(){for(const row of scan("sync_relay_replica_cut_files"))yield indexed(row)!;}
  };
  const omission=(row:Record<string,unknown>)=>{
    const file={versionId:version,objectId:String(row.object_id),path:String(row.path),sha256:String(row.sha256),reason:row.reason as "text-frame-limit"};
    const path=prepareSharePath(file.path);if(!validRow(file,path))throw new InvalidStoredRow();
    return {row:file,path:path!};
  };
  return {files:{get:v=>v===version?files:undefined},lineages:{get:key=>{
    const [v,object,lineage]=JSON.parse(key) as [string,string,string|null];
    return indexed(statement(storage,"SELECT * FROM sync_relay_replica_cut_files WHERE workspace_id=? AND version_id=? AND object_id=? AND lineage_claim_id IS ?").get(workspace,v,object,lineage));
  }},omittedPaths:{get:key=>{
    const [v,path]=JSON.parse(key) as [string,string];
    const row=statement(storage,"SELECT object_id FROM sync_relay_replica_cut_omitted WHERE workspace_id=? AND version_id=? AND path=?").get(workspace,v,path);
    return row ? String(row.object_id) : undefined;
  }},omitted:{get:key=>{
    const [v,object]=JSON.parse(key) as [string,string];
    const row=statement(storage,"SELECT * FROM sync_relay_replica_cut_omitted WHERE workspace_id=? AND version_id=? AND object_id=?").get(workspace,v,object);
    return row ? omission(row) : undefined;
  },*values(){for(const row of scan("sync_relay_replica_cut_omitted"))yield omission(row);}},
    texts:new ReplicaMap(),textChecks:new Map(),inventories:[],decoded:new Map(),decodedBytes:0};
}

/** Validate changes; update an existing index only when at most half the rows changed. */
export function publishReplicaCurrentViewIndex(view:ReplicaCurrentView, previous:ReplicaCurrentView|undefined,
  changes:ReplicaCurrentView, before:Array<Row>, texts:ReplicaMap<string>, smallChange:boolean) {
  const prior=previous && indexes.get(previous);
  if(!prior || !smallChange) {validateChanges(changes);return;}
  const delta=indexView(changes,prior.files,texts);
  if (!delta) throw new Error("Invalid replica read index.");
  const files=prior.files.fork(), lineages=prior.lineages.fork(), omittedPaths=prior.omittedPaths.fork(), omitted=prior.omitted.fork();
  const versions=new Set([...before,...changes.files,...changes.omitted].map(f=>f.versionId));
  for(const version of versions) files.set(version,files.get(version)?.fork() ?? new ReplicaMap());
  for(const old of before) {
    if("contentKind" in old) {files.get(old.versionId)?.delete(old.path);lineages.delete(lineageKey(old.versionId,old.objectId,old.lineageClaimId));}
    else {omittedPaths.delete(pathKey(old.versionId,old.path));omitted.delete(JSON.stringify([old.versionId,old.objectId]));}
  }
  for(const [version,rows] of delta.files) for(const [path,row] of rows) {files.get(version)!.set(path,row);lineages.set(row.lineage,row);}
  for(const version of versions)if(!files.get(version)!.size)files.delete(version);
  for(const [key,row] of delta.omitted) {omitted.set(key,row);omittedPaths.set(pathKey(row.row.versionId,row.row.path),row.row.objectId);}
  indexes.set(view,{...delta,files,lineages,omittedPaths,omitted,texts});
}

export function publishPersistedReplicaIndex(readSaved:()=>ReplicaCurrentView|null, source:ReplicaCurrentView, unchanged:boolean) {
  if(!unchanged)return;
  const index=indexes.get(source);
  if(!index)return;
  const saved=readSaved();
  if(!saved || saved===source)return;
  indexes.set(saved,{...index,texts:new ReplicaMap(),textChecks:new Map(),inventories:[],decoded:new Map(),decodedBytes:0});
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

function inventoryEtag(index: ReadIndex, files: ReplicaCurrentViewFile[]) {
  // Compare freshly authorized output, never a selector or a cached grant decision.
  const prior = index.inventories.find(saved => saved.files.length === files.length && files.every((file,i) =>
    file === saved.files[i] || file.status === "updating" && saved.files[i]!.status === "updating" && file.path === saved.files[i]!.path));
  if (prior) return prior.etag;
  const tag = etag(files.map(file => file.status === "ready" ? inventoryTags.get(file)! : ["updating",file.path]));
  index.inventories.unshift({files:files.map(file => file.status === "ready" ? file : {...file}),etag:tag});
  if (index.inventories.length > 4) index.inventories.pop();
  return tag;
}

function touchLatestIndex(storage: StorageContext, workspace: string, files?: ViewIndex["files"]) {
  let latest = latestIndexes.get(storage);
  if (!latest) latestIndexes.set(storage,latest = new Map());
  if (files) { latest.delete(workspace); latest.set(workspace,files); }
  while (latest.size > MAX_INDEX_WORKSPACES) latest.delete(latest.keys().next().value!);
  return latest;
}

/** Release the per-workspace read index when replica retirement ends its lease. */
export function forgetReplicaCurrentViewReadCache(storage: StorageContext, workspace: string) {
  latestIndexes.get(storage)?.delete(workspace);
}

/** Drop both immutable read caches when a share or workspace mutation removes their authority. */
export function forgetReplicaCurrentViewCaches(storage: StorageContext, workspace: string) {
  forgetReplicaCurrentViewReadCache(storage,workspace);
  forgetReplicaCurrentViewStoredCache(storage,workspace);
}

/** @internal Test-only cache accounting. */
export function replicaCurrentViewReadCacheSize(storage: StorageContext) {
  return latestIndexes.get(storage)?.size ?? 0;
}

// The accessor, grant and text never leave this synchronous read transaction.
export function withReplicaCurrentView<T>(storage: StorageContext, input: ReplicaCurrentViewReadInput,
  source: ReplicaCurrentViewSource | undefined,
  read: (snapshot: {
    files: ReplicaCurrentViewFile[];
    rows: Map<string, ViewFile>;
    workspace: string;
    authorized: AuthorizedShareAction;
    view: ReplicaCurrentView;
    floor: ReturnType<typeof replicaGrantFloor>;
    visiblePath: (version: string, path: string) => string | null;
    readText: (row: ViewFile) => string | null;
    inventoryEtag: () => string;
  }) => T, requestedPath?: string, includeRows = false,
  authority?:{history?:boolean;onStanding?:(authorized:AuthorizedShareAction)=>void},
): T | Unavailable {
  try {return storage.readTx(() => {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) return {status:"denied"};
    const authorized = authorizeShareGrantAction({storage, grantId:input.grantId, generation:input.generation, principal:input.principal, action:"read"});
    if (!authorized.ok) return {status:"denied"};
    const selector = fileSideOf(authorized.effectiveSelector);
    if (!selector) return {status:"denied"};
    if (authority?.history && selector.access !== "edit") return {status:"denied"};
    if (input.principal.kind === "link") {
      const session = input.principal.requireSession();
      if (session.grantId !== input.grantId || session.generation !== input.generation) return {status:"denied"};
    }
    const workspace = authorized.share.workspaceId;
    const standing = storage.readReplicaStanding(workspace);
    if (!standing) { forgetReplicaCurrentViewCaches(storage,workspace); return {status:"not-ready"}; }
    if (standing.ownerUserId !== authorized.share.granterUserId) return {status:"denied"};
    authority?.onStanding?.(authorized);
    const projection = input.principal.kind === "link" ? createAccountlessPathProjection(selector) : null;
    const realPath = requestedPath === undefined ? undefined : projection ? projection.resolvePath(requestedPath) ?? "" : requestedPath;
    const stored = readReplicaCurrentViewHead(storage,workspace);
    const snapshot = source ? source.currentReadView(workspace,()=>stored) : stored && {view:stored,previous:stored};
    if (!snapshot) { forgetReplicaCurrentViewCaches(storage,workspace); return {status:"not-ready"}; }
    const {view} = snapshot;
    const floor = replicaGrantFloor(storage,input.grantId,workspace);
    if (floor && !replicaViewReachesFloor(view,floor)) return {status:"updating"};
    if (view.workspaceId !== workspace || [view.revision, view.logCursor, view.journalCursor].some(n => !Number.isSafeInteger(n) || n < 0) ||
      view.logCursor > standing.logSeq || view.journalCursor > standing.journalCursor) return {status:"updating"};
    const version = targetVersionId(selector);
    const latest = touchLatestIndex(storage,workspace);
    const indexFor=(v:ReplicaCurrentView,previous?:Lookup<Lookup<IndexedFile>>):ReadIndex|null=>isReplicaStoredHead(v) ? storedIndex(storage,workspace,version) : indexView(v,previous);
    const index = indexFor(view,latest.get(workspace));
    if (!index) return {status:"updating"};
    // Keep only metadata for reuse, so retired live texts can be collected.
    touchLatestIndex(storage,workspace,indexes.get(view)?.files);
    const visible = (v: string, path: string | NonNullable<ReturnType<typeof prepareSharePath>>) => {
      if (v !== version) return false;
      const canonical = visibleSharePath(selector, path);
      return canonical !== null && canonical === (typeof path === "string" ? path : path.path);
    };
    const project = (path: string) => projection ? projection.projectPath(path) : path;
    const files = new Map<string, ReplicaCurrentViewFile>(), rows = new Map<string, ViewFile>();
    if (snapshot.previous && snapshot.previous.workspaceId !== workspace) return {status:"updating"};
    const previousView = snapshot.previous && (!floor || replicaViewReachesFloor(snapshot.previous,floor)) ? snapshot.previous : undefined;
    const previous = previousView===view ? index : previousView && indexFor(previousView,index.files);
    if (previousView && !previous) return {status:"updating"};
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
    let fences = realPath === undefined ? readFences(storage,"workspace_id=? AND main_version_id=? AND restore_fence_generation>1",[workspace,version]) : objects.size ?
      readFences(storage,"workspace_id=? AND main_version_id=? AND object_id IN (SELECT value FROM json_each(?))",[workspace,version,JSON.stringify([...objects])]) : [];
    const generations = new Map(fences.map(f=>[String(f.object_id),{lineageClaimId:String(f.lineage_claim_id),generation:Number(f.restore_fence_generation)}]));
    const generationFor = (row: ViewFile) => {
      const fence = row.lineageClaimId === null ? undefined : generations.get(row.objectId);
      return fence?.lineageClaimId === row.lineageClaimId ? fence.generation : 1;
    };
    const current = (f: IndexedFile) => f.row.lineageClaimId === null || f.row.restoreGeneration === generationFor(f.row);
    for (const incoming of selected) {
      const old = current(incoming) ? undefined : previous?.lineages.get(incoming.lineage);
      const occupant = old && index.files.get(version)?.get(old.row.path);
      const reservedBy = old && (index.omittedPaths.get(pathKey(version,old.row.path)) ?? (occupant && current(occupant) ? occupant.row.objectId : undefined));
      const row = currentViewFileAtFence(incoming.row,generationFor(incoming.row),old?.row,reservedBy);
      const indexed = row === incoming.row ? incoming : old;
      if (!row || !indexed) continue;
      const file = row;
      if (!visible(file.versionId, indexed.path)) continue;
      const path = project(file.path);
      if (path === null || requestedPath !== undefined && path !== requestedPath) continue;
      if (!current(indexed)) {files.set(path, {path, status:"updating"}); continue;}
      files.set(path,projectedFile(indexed,path));
      if (requestedPath !== undefined || includeRows) rows.set(path, file);
    }
    const omittedObject=realPath===undefined ? undefined : index.omittedPaths.get(pathKey(version,realPath));
    const directOmitted=omittedObject===undefined ? undefined : index.omitted.get(JSON.stringify([version,omittedObject]));
    for (const omitted of realPath===undefined ? index.omitted.values() : directOmitted ? [directOmitted] : []) {
      if (!visible(omitted.row.versionId, omitted.path)) continue;
      const path = project(omitted.row.path);
      if (path !== null && (requestedPath === undefined || path === requestedPath)) files.set(path, {path, status:"updating"});
    }
    if (realPath !== undefined && files.size === 0) fences = readFences(storage,
      "workspace_id=? AND main_version_id=? AND current_path=? AND restore_fence_generation>1",[workspace,version,realPath]);
    // A restore can remove an unfenced row before its replacement reaches the view.
    for (const fence of fences) {
      const fenceLineage = lineageKey(String(fence.main_version_id),String(fence.object_id),String(fence.lineage_claim_id));
      const inView = index.lineages.get(fenceLineage), generation = Number(fence.restore_fence_generation);
      const pending = inView ? inView.row.restoreGeneration! < generation : fence.admission_state === "closed";
      if (!pending) continue;
      const currentPath = String(fence.current_path);
      if (realPath !== undefined && currentPath !== realPath) continue;
      const path = project(currentPath);
      if (path === null || files.has(path) || !visible(String(fence.main_version_id), currentPath)) continue;
      if (requestedPath === undefined || path === requestedPath) files.set(path, {path, status:"updating"});
    }
    const sorted = [...files.values()].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return read({files:sorted, rows, workspace, authorized, view, floor,
      visiblePath:(v,path)=>visible(v,path) ? project(path) : null, inventoryEtag:()=>inventoryEtag(index,sorted), readText:row => {
      const textKey = JSON.stringify([row.sha256,row.byteLength]);
      const text = index.texts.get(row.sha256);
      if (text !== undefined) {
        let checked = index.textChecks.get(textKey);
        if (checked === undefined) {
          checked = digest(text) === row.sha256 && Buffer.byteLength(text) === row.byteLength;
          index.textChecks.set(textKey,checked);
        }
        return checked ? text : null;
      }
      const cached = index.decoded.get(textKey);
      if (cached !== undefined) return cached.text;
      const decoded = readReplicaCurrentViewRowText(storage,workspace,row);
      // Cache only opened stored texts, with a fixed per-view byte budget.
      if (decoded !== null && row.byteLength <= DECODED_TEXT_BYTES) {
        while (index.decodedBytes + row.byteLength > DECODED_TEXT_BYTES) {
          const oldest = index.decoded.keys().next().value!;
          index.decodedBytes -= index.decoded.get(oldest)!.bytes; index.decoded.delete(oldest);
        }
        index.decoded.set(textKey,{text:decoded,bytes:row.byteLength}); index.decodedBytes += row.byteLength;
      }
      return decoded;
    }});
  });} catch(error) {if(error instanceof InvalidStoredRow)return {status:"updating"};throw error;}
}

export function listReplicaCurrentViewFiles(storage: StorageContext, input: ReplicaCurrentViewReadInput,
  source?: ReplicaCurrentViewSource): ReplicaCurrentViewList {
  return withReplicaCurrentView(storage,input,source,({files,inventoryEtag}):ReplicaCurrentViewList=>({status:"ready",files,etag:inventoryEtag()}));
}

export function readReplicaCurrentViewFile(storage: StorageContext, input: ReplicaCurrentViewReadInput & {path: string},
  source?: ReplicaCurrentViewSource): ReplicaCurrentViewRead {
  return withReplicaCurrentView(storage, input, source, ({files, rows, readText}): ReplicaCurrentViewRead => {
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
