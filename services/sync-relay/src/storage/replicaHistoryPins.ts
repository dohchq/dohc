import {randomUUID} from "node:crypto";
import type {ReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import type {StorageContext} from "./context";
import {replicaHistoryAuthors} from "./replicaHistoryAuthors";
import {replicaHistoryReplacement} from "./replicaHistoryPositions";
import {replicaStatement as statement} from "./replicaStatements";
import {deleteUnreferencedReplicaTexts, readReplicaText} from "./replicaTextStorage";

type File = ReplicaCurrentView["files"][number];
export interface ReplicaHistoryObservation {versionId: string; objectId: string; firstChangedAtMs: number; changedAtMs: number; beforeStructuralChange?: boolean}
export const historyObjectKey = (f: {versionId: string; objectId: string}) => JSON.stringify([f.versionId,f.objectId]);
export const historyStateKey = (f: File) => JSON.stringify([f.path,f.sha256,f.contentKind,f.lineageClaimId,f.restoreGeneration]);
export function historyStructuralReason(before: File, after: File | undefined) {
  return !after ? "delete" : before.lineageClaimId !== after.lineageClaimId ? "lineage" :
    before.restoreGeneration !== after.restoreGeneration ? "restore" : before.path !== after.path ? "rename" : null;
}
function fromRow(row: Record<string,unknown>): File {
  return {versionId:String(row.version_id),objectId:String(row.object_id),path:String(row.path),sha256:String(row.sha256),
    byteLength:Number(row.byte_length),contentKind:row.content_kind as File["contentKind"],
    lineageClaimId:row.lineage_claim_id as string | null,restoreGeneration:row.restore_generation as number | null};
}

/** Called only inside the cut flip. No owner log, blob or quota writes. */
export function pinReplicaHistory(storage: StorageContext, view: ReplicaCurrentView, observations: ReplicaHistoryObservation[] = []) {
  const workspace = view.workspaceId, now = Date.now();
  const references=new Map<string,number>();
  const before = statement(storage,"SELECT * FROM sync_relay_replica_cut_files WHERE workspace_id=?").all(workspace).map(fromRow);
  const header = statement(storage,"SELECT log_cursor,journal_cursor FROM sync_relay_replica_cuts WHERE workspace_id=?").get(workspace);
  const next = new Map(view.files.map(f=>[historyObjectKey(f),f]));
  const omitted = new Map(view.omitted.map(f=>[historyObjectKey(f),f]));
  const observed = new Map(observations.map(o=>[historyObjectKey(o),o]));
  const clocks = new Map(statement(storage,"SELECT * FROM sync_relay_history_clocks WHERE workspace_id=?").all(workspace).map(c=>[JSON.stringify([c.version_id,c.object_id]),c]));
  const saveClock = statement(storage,`INSERT INTO sync_relay_history_clocks VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,version_id,object_id)
    DO UPDATE SET changed_at_ms=excluded.changed_at_ms,dirty_since_ms=excluded.dirty_since_ms,last_nonstructural_at_ms=excluded.last_nonstructural_at_ms,
    pin_log_cursor=excluded.pin_log_cursor,pin_journal_cursor=excluded.pin_journal_cursor,state_key=excluded.state_key`);
  const replacement = (file: File, log: number, journal: number) => replicaHistoryReplacement(storage,workspace,file.versionId,file.objectId,
    log,view.logCursor,journal,view.journalCursor);
  const pin = (file: File, reason: string, clock: Record<string,unknown>, log: number, journal: number, superseded: number | null) => {
    const authors = replicaHistoryAuthors(storage,workspace,file.versionId,file.objectId,Number(clock.pin_log_cursor),log,Number(clock.pin_journal_cursor),journal);
    statement(storage,"INSERT INTO sync_relay_history_pins VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(randomUUID(),workspace,file.versionId,file.objectId,file.path,file.contentKind,file.sha256,file.byteLength,file.lineageClaimId,
        file.restoreGeneration,reason,now,superseded,log,journal,JSON.stringify(authors),
        ...(superseded === null ? [null,null] : replacement(file,log,journal)));
    if (file.contentKind === "text") references.set(file.sha256,(references.get(file.sha256) ?? 0)+1);
    clock.pin_log_cursor=log; clock.pin_journal_cursor=journal; clock.dirty_since_ms=null;
    if (reason === "quiet" || reason === "ceiling") clock.last_nonstructural_at_ms=now;
  };
  const previous = new Map(before.map(f=>[historyObjectKey(f),f]));
  // Clocks control sampling and display. Only relay positions authorize History.
  for (const row of statement(storage,"SELECT * FROM sync_relay_history_pins WHERE workspace_id=? AND superseded_at_ms IS NULL").all(workspace)) {
    const file = fromRow(row), after = next.get(historyObjectKey(file));
    const unavailable = omitted.get(historyObjectKey(file));
    if (unavailable?.path === file.path && unavailable.sha256 === file.sha256) continue;
    if (!after || historyStateKey(file) !== historyStateKey(after)) statement(storage,`UPDATE sync_relay_history_pins
      SET superseded_at_ms=?,replaced_stream=?,replaced_position=? WHERE pin_id=?`)
      .run(observed.get(historyObjectKey(file))?.firstChangedAtMs ?? now,...replacement(file,Number(row.log_cursor),Number(row.journal_cursor)),row.pin_id);
  }
  for (const key of new Set([...previous.keys(),...next.keys()])) {
    if (omitted.has(key)) continue;
    const old = previous.get(key), file = next.get(key), times = observed.get(key);
    const savedClock = clocks.get(key);
    const clock = {...(savedClock ?? {changed_at_ms:times?.changedAtMs ?? now,dirty_since_ms:null,
      last_nonstructural_at_ms:null,pin_log_cursor:0,pin_journal_cursor:0,state_key:file ? historyStateKey(file) : null})};
    const structural = old && historyStructuralReason(old,file);
    if (structural) pin(old,structural,clock,Number(header!.log_cursor),Number(header!.journal_cursor),times?.firstChangedAtMs ?? now);
    const state = file ? historyStateKey(file) : null;
    if (clock.state_key !== state) {
      if (clock.dirty_since_ms === null) {
        const first=times?.firstChangedAtMs ?? now;
        clock.dirty_since_ms=!structural && old && clock.last_nonstructural_at_ms !== null && first-Number(clock.changed_at_ms) < 30_000
          ? Math.min(first,Number(clock.last_nonstructural_at_ms)) : first;
      }
      clock.changed_at_ms=times?.changedAtMs ?? now;
      clock.state_key=state;
    }
    if (file && clock.dirty_since_ms !== null) {
      const quiet = now-Number(clock.changed_at_ms) >= 30_000;
      const ceiling = now-Number(clock.dirty_since_ms) >= 300_000;
      if ((quiet || ceiling) && (clock.last_nonstructural_at_ms === null || now-Number(clock.last_nonstructural_at_ms) >= 30_000)) {
        pin(file,quiet ? "quiet" : "ceiling",clock,view.logCursor,view.journalCursor,null);
      }
    }
    if (!file) clock.dirty_since_ms=null;
    const identity = file ?? old!;
    if (!savedClock || ["changed_at_ms","dirty_since_ms","last_nonstructural_at_ms","pin_log_cursor","pin_journal_cursor","state_key"].some(k=>savedClock[k] !== clock[k]))
      saveClock.run(workspace,identity.versionId,identity.objectId,clock.changed_at_ms,clock.dirty_since_ms,clock.last_nonstructural_at_ms,clock.pin_log_cursor,clock.pin_journal_cursor,clock.state_key);
  }
  return references;
}

export function nextReplicaHistoryPinAt(storage: StorageContext, workspace: string): number | null {
  const row = statement(storage,`SELECT min(max(min(changed_at_ms+30000,dirty_since_ms+300000),coalesce(last_nonstructural_at_ms+30000,0))) AS due
    FROM sync_relay_history_clocks c WHERE workspace_id=? AND dirty_since_ms IS NOT NULL
      AND EXISTS (SELECT 1 FROM sync_relay_replica_cut_files f WHERE f.workspace_id=c.workspace_id AND f.version_id=c.version_id AND f.object_id=c.object_id)`).get(workspace);
  return row?.due == null ? null : Number(row.due);
}

export function thinReplicaHistoryPins(storage: StorageContext, workspace: string, budget = {maxBytes:64*1024*1024,maxCount:1024}) {
  const rows = statement(storage,`SELECT pin_id,pinned_at_ms,reason,superseded_at_ms,
    byte_length+length(CAST(authors_json AS BLOB))+length(CAST(path AS BLOB))+256 AS bytes FROM sync_relay_history_pins WHERE workspace_id=? ORDER BY pinned_at_ms,pin_id`).all(workspace);
  const bytes = rows.reduce((n,r)=>n+Number(r.bytes),0);
  if (bytes <= budget.maxBytes && rows.length <= budget.maxCount) return;
  const kept = rows.filter(r=>r.superseded_at_ms === null), optional = rows.filter(r=>r.superseded_at_ms !== null);
  // Keep structural states first, then bisect time intervals within each class.
  const retained = new Set(kept.map(r=>r.pin_id));
  let availableBytes = budget.maxBytes-kept.reduce((n,r)=>n+Number(r.bytes),0), availableCount = budget.maxCount-kept.length;
  for (const structural of [true,false]) {
    const candidates = optional.filter(r=>(!["quiet","ceiling"].includes(String(r.reason))) === structural);
    const keep = (index: number) => {
      const row=candidates[index];
      if (!row || availableCount <= 0 || Number(row.bytes) > availableBytes) return;
      retained.add(row.pin_id); availableBytes-=Number(row.bytes); availableCount--;
    };
    keep(0); if (candidates.length > 1) keep(candidates.length-1);
    const intervals: Array<[number,number]> = candidates.length > 2 ? [[1,candidates.length-2]] : [];
    const span = ([lo,hi]: [number,number]) => Number(candidates[hi]!.pinned_at_ms)-Number(candidates[lo]!.pinned_at_ms);
    while (intervals.length && availableCount > 0 && availableBytes > 0) {
      let widest=0;
      for (let i=1;i<intervals.length;i++) if (span(intervals[i]!) > span(intervals[widest]!)) widest=i;
      const [lo,hi]=intervals.splice(widest,1)[0]!, middle=(Number(candidates[lo]!.pinned_at_ms)+Number(candidates[hi]!.pinned_at_ms))/2;
      let left=lo,right=hi;
      while (left < right) {const mid=Math.floor((left+right)/2); if (Number(candidates[mid]!.pinned_at_ms) < middle) left=mid+1; else right=mid;}
      keep(left);
      if (left > lo) intervals.push([lo,left-1]);
      if (left < hi) intervals.push([left+1,hi]);
    }
  }
  const remove = statement(storage,"DELETE FROM sync_relay_history_pins WHERE workspace_id=? AND pin_id=?");
  for (const row of optional) if (!retained.has(row.pin_id)) remove.run(workspace,row.pin_id);
  deleteUnreferencedReplicaTexts(storage,workspace);
}

/** Full text seam shared by pin reads; encoding changes stay here. Caller authorized the pin in this transaction. */
export function readReplicaHistoryText(storage: StorageContext, workspace: string, sha: string): string | null {
  return readReplicaText(storage,workspace,sha);
}
