import {withReplicaCurrentView, type ReplicaCurrentViewReadInput, type ReplicaCurrentViewSource} from "./replicaCurrentViewReads";
import type {StorageContext} from "./storage/context";
import {readReplicaText} from "./storage/replicaTextStorage";
import {replicaViewReachesFloor} from "./storage/replicaGrantFloors";
import {replicaStatement as statement} from "./storage/replicaStatements";

export interface ReplicaHistoryPin {
  pinId: string; path: string; kind: "text" | "binary"; byteLength: number;
  pinnedAtMs: number; reason: string; authors: Array<Record<string,unknown>>;
}
type Unavailable = {status:"denied" | "not-ready" | "updating"};
export type ReplicaHistoryList = Unavailable | {status:"ready"; pins: ReplicaHistoryPin[]};
export type ReplicaHistoryRead = Unavailable | {status:"not-found" | "not-text"} | {status:"ready"; pin: ReplicaHistoryPin; text: string};

function readHistory<T>(storage: StorageContext, input: ReplicaCurrentViewReadInput, source: ReplicaCurrentViewSource | undefined,
  read: (rows: Array<{pin: ReplicaHistoryPin; sha: string}>, workspace: string) => T, pinId?: string): T | Unavailable {
  return withReplicaCurrentView(storage,input,source,({rows,workspace,visiblePath,floor})=>{
    if (!floor) return read([],workspace);
    // An uncollected replacement must not pass as an unsuperseded pin.
    const cut = statement(storage,"SELECT log_cursor,journal_cursor FROM sync_relay_replica_cuts WHERE workspace_id=?").get(workspace);
    if (!replicaViewReachesFloor(cut ? {logCursor:Number(cut.log_cursor),journalCursor:Number(cut.journal_cursor)} : null,floor))
      return {status:"updating" as const};
    const currentObjects = new Set([...rows.values()].map(f=>JSON.stringify([f.versionId,f.objectId])));
    const pins = statement(storage,`SELECT * FROM sync_relay_history_pins WHERE workspace_id=?
      ${pinId === undefined ? "" : "AND pin_id=?"} ORDER BY pinned_at_ms DESC,pin_id`)
      .all(workspace,...(pinId === undefined ? [] : [pinId]));
    const visible = pins.flatMap(row=>{
      if (!currentObjects.has(JSON.stringify([row.version_id,row.object_id]))) return [];
      const path = visiblePath(String(row.version_id),String(row.path));
      if (path === null) return [];
      const pin: ReplicaHistoryPin = {pinId:String(row.pin_id),path,kind:row.content_kind as "text" | "binary",byteLength:Number(row.byte_length),
        pinnedAtMs:Number(row.pinned_at_ms),reason:String(row.reason),authors:input.principal.kind === "link" ? [] : JSON.parse(String(row.authors_json))};
      return [{pin,sha:String(row.sha256)}];
    });
    return read(visible,workspace);
  },undefined,true,{history:true});
}
export function listReplicaHistoryPins(storage: StorageContext, input: ReplicaCurrentViewReadInput, source?: ReplicaCurrentViewSource): ReplicaHistoryList {
  return readHistory(storage,input,source,pins=>({status:"ready" as const,pins:pins.map(p=>p.pin)}));
}
export function readReplicaHistoryPin(storage: StorageContext, input: ReplicaCurrentViewReadInput & {pinId: string}, source?: ReplicaCurrentViewSource): ReplicaHistoryRead {
  return readHistory(storage,input,source,(pins,workspace): ReplicaHistoryRead=>{
    const row = pins[0];
    if (!row) return {status:"not-found"};
    if (row.pin.kind !== "text") return {status:"not-text"};
    const text = readReplicaText(storage,workspace,row.sha);
    return text === null ? {status:"updating"} : {status:"ready",pin:row.pin,text};
  },input.pinId);
}
