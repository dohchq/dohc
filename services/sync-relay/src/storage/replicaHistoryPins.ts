import {randomUUID} from "node:crypto";
import type {ReplicaCurrentView} from "@dohc/workspace-engine-client/daemon";
import type {StorageContext} from "./context";
import {replicaHistoryAuthors} from "./replicaHistoryAuthors";
import {replicaHistoryReplacement} from "./replicaHistoryPositions";
import {replicaHistoryPinsToDrop} from "./replicaHistoryThinning";
import {historyPinDue} from "./replicaHistoryWorkSchema";
import {replicaStatement as statement} from "./replicaStatements";
import {deleteUnreferencedReplicaTexts} from "./replicaTextStorage";

type File = ReplicaCurrentView["files"][number];
export type ReplicaHistoryChanges = Map<string,{before?: File; after?: File; omitted?: ReplicaCurrentView["omitted"][number]; departed?: ReplicaCurrentView["omitted"][number]}>;
export interface ReplicaHistoryObservation {versionId: string; objectId: string; firstChangedAtMs: number; changedAtMs: number; beforeStructuralChange?: boolean}
export const historyObjectKey = (f: {versionId: string; objectId: string}) => `${f.versionId.length}:${f.versionId}${f.objectId}`;
export const historyStateKey = (f: File) => JSON.stringify([f.path,f.sha256,f.contentKind,f.lineageClaimId,f.restoreGeneration]);
export const sameHistoryState = (a: File, b: File) => a.path===b.path && a.sha256===b.sha256 && a.contentKind===b.contentKind &&
  a.lineageClaimId===b.lineageClaimId && a.restoreGeneration===b.restoreGeneration;
export function historyStructuralReason(before: File, after: File | undefined) {
  return !after ? "delete" : before.lineageClaimId !== after.lineageClaimId ? "lineage" :
    before.restoreGeneration !== after.restoreGeneration ? "restore" : before.path !== after.path ? "rename" : null;
}
function fromRow(row: Record<string,unknown>): File {
  return {versionId:String(row.version_id),objectId:String(row.object_id),path:String(row.path),sha256:String(row.sha256),
    byteLength:Number(row.byte_length),contentKind:row.content_kind as File["contentKind"],
    lineageClaimId:row.lineage_claim_id as string | null,restoreGeneration:row.restore_generation as number | null};
}

/** Runs in the flip or History-only transaction. No owner log, blob or quota writes. */
export function pinReplicaHistory(storage: StorageContext, view: Pick<ReplicaCurrentView,"workspaceId" | "logCursor" | "journalCursor">, changes: ReplicaHistoryChanges, observations: ReplicaHistoryObservation[] = []) {
  const workspace = view.workspaceId, now = Date.now();
  const references=new Map<string,number>();
  const header = statement(storage,"SELECT log_cursor,journal_cursor FROM sync_relay_replica_cuts WHERE workspace_id=?").get(workspace);
  const observed = new Map(observations.map(o=>[historyObjectKey(o),o]));
  const clocks = new Map<string,Record<string,unknown>>(), currentPins = new Map<string,Record<string,unknown>>();
  const pending = new Map(changes);
  for (const [key,change] of changes) {
    const file=(change.after ?? change.before ?? change.omitted ?? change.departed)!;
    const clock=statement(storage,"SELECT * FROM sync_relay_history_clocks WHERE workspace_id=? AND version_id=? AND object_id=?").get(workspace,file.versionId,file.objectId);
    if (clock) clocks.set(key,clock);
    const pin=statement(storage,`SELECT * FROM sync_relay_history_pins
      WHERE workspace_id=? AND version_id=? AND object_id=? AND superseded_at_ms IS NULL`).get(workspace,file.versionId,file.objectId);
    if (pin) currentPins.set(key,pin);
  }
  for (const clock of statement(storage,`SELECT * FROM sync_relay_history_clocks c WHERE workspace_id=? AND dirty_since_ms IS NOT NULL
    AND ${historyPinDue}<=? AND EXISTS (SELECT 1 FROM sync_relay_replica_cut_files f
      WHERE f.workspace_id=c.workspace_id AND f.version_id=c.version_id AND f.object_id=c.object_id)`).all(workspace,now)) {
    const key=historyObjectKey({versionId:String(clock.version_id),objectId:String(clock.object_id)});
    clocks.set(key,clock);
    if (!pending.has(key)) {
      const row=statement(storage,"SELECT * FROM sync_relay_replica_cut_files WHERE workspace_id=? AND version_id=? AND object_id=?")
        .get(workspace,clock.version_id,clock.object_id)!;
      const file=fromRow(row); pending.set(key,{before:file,after:file});
    }
  }
  const saveClock = statement(storage,`INSERT INTO sync_relay_history_clocks VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,version_id,object_id)
    DO UPDATE SET changed_at_ms=excluded.changed_at_ms,dirty_since_ms=excluded.dirty_since_ms,last_nonstructural_at_ms=excluded.last_nonstructural_at_ms,
    pin_log_cursor=excluded.pin_log_cursor,pin_journal_cursor=excluded.pin_journal_cursor,state_key=excluded.state_key,
    state_log_cursor=excluded.state_log_cursor,state_journal_cursor=excluded.state_journal_cursor`);
  const replacement = (file: File, clock: Record<string,unknown> | undefined) => clock ? replicaHistoryReplacement(storage,workspace,file.versionId,file.objectId,
    Number(clock.state_log_cursor),view.logCursor,Number(clock.state_journal_cursor),view.journalCursor,file) : [null,null];
  const pin = (file: File, reason: string, clock: Record<string,unknown>, log: number, journal: number, superseded: number | null) => {
    const existing = currentPins.get(historyObjectKey(file));
    if (superseded !== null && existing && sameHistoryState(fromRow(existing),file)) {
      statement(storage,"UPDATE sync_relay_history_pins SET reason=? WHERE pin_id=?").run(reason,existing.pin_id);
      clock.pin_log_cursor=log; clock.pin_journal_cursor=journal;
      clock.dirty_since_ms=null;
      return;
    }
    const authors = replicaHistoryAuthors(storage,workspace,file.versionId,file.objectId,file.lineageClaimId,Number(clock.pin_log_cursor),log,Number(clock.pin_journal_cursor),journal);
    statement(storage,"INSERT INTO sync_relay_history_pins VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(randomUUID(),workspace,file.versionId,file.objectId,file.path,file.contentKind,file.sha256,file.byteLength,file.lineageClaimId,
        file.restoreGeneration,reason,now,superseded,log,journal,JSON.stringify(authors),
        ...(superseded === null ? [null,null] : replacement(file,clock)));
    if (file.contentKind === "text") references.set(file.sha256,(references.get(file.sha256) ?? 0)+1);
    clock.pin_log_cursor=log; clock.pin_journal_cursor=journal; clock.dirty_since_ms=null;
    if (reason === "quiet" || reason === "ceiling") clock.last_nonstructural_at_ms=now;
  };
  // Clocks control sampling and display. Only relay positions authorize History.
  for (const row of currentPins.values()) {
    const file = fromRow(row), change=changes.get(historyObjectKey(file))!, after = change.after;
    const unavailable = change.omitted;
    if (unavailable?.path === file.path && unavailable.sha256 === file.sha256) continue;
    if (!after || !sameHistoryState(file,after)) statement(storage,`UPDATE sync_relay_history_pins
      SET superseded_at_ms=?,replaced_log_position=?,replaced_journal_position=? WHERE pin_id=?`)
      .run(observed.get(historyObjectKey(file))?.firstChangedAtMs ?? now,...replacement(file,clocks.get(historyObjectKey(file))),row.pin_id);
  }
  for (const [key,change] of pending) {
    if (change.omitted) continue;
    const old = change.before, file = change.after, times = observed.get(key);
    const savedClock = clocks.get(key);
    const clock = {...(savedClock ?? {changed_at_ms:times?.changedAtMs ?? now,dirty_since_ms:null,
      last_nonstructural_at_ms:null,pin_log_cursor:header?.log_cursor ?? view.logCursor,pin_journal_cursor:header?.journal_cursor ?? view.journalCursor,
      state_log_cursor:old ? 0 : header?.log_cursor ?? view.logCursor,state_journal_cursor:old ? 0 : header?.journal_cursor ?? view.journalCursor,
      state_key:old ? historyStateKey(old) : !header && file ? historyStateKey(file) : null})};
    const structural = old && historyStructuralReason(old,file);
    if (structural) pin(old,structural,clock,Number(header!.log_cursor),Number(header!.journal_cursor),times?.firstChangedAtMs ?? now);
    const state = file ? historyStateKey(file) : null;
    if (clock.state_key !== state) {
      if (clock.dirty_since_ms === null) clock.dirty_since_ms=times?.firstChangedAtMs ?? now;
      clock.changed_at_ms=times?.changedAtMs ?? now;
      clock.state_key=state;
      clock.state_log_cursor=view.logCursor; clock.state_journal_cursor=view.journalCursor;
    }
    if (file && clock.dirty_since_ms !== null) {
      const quiet = now-Number(clock.changed_at_ms) >= 30_000;
      const ceiling = now-Number(clock.dirty_since_ms) >= 300_000;
      if ((quiet || ceiling) && (clock.last_nonstructural_at_ms === null || now-Number(clock.last_nonstructural_at_ms) >= 30_000)) {
        pin(file,quiet ? "quiet" : "ceiling",clock,view.logCursor,view.journalCursor,null);
      }
    }
    const identity = (file ?? old ?? change.departed)!;
    if (!file) {
      statement(storage,"DELETE FROM sync_relay_history_clocks WHERE workspace_id=? AND version_id=? AND object_id=?").run(workspace,identity.versionId,identity.objectId);
      continue;
    }
    if (!savedClock || ["changed_at_ms","dirty_since_ms","last_nonstructural_at_ms","pin_log_cursor","pin_journal_cursor","state_key","state_log_cursor","state_journal_cursor"].some(k=>savedClock[k] !== clock[k]))
      saveClock.run(workspace,identity.versionId,identity.objectId,clock.changed_at_ms,clock.dirty_since_ms,clock.last_nonstructural_at_ms,clock.pin_log_cursor,clock.pin_journal_cursor,clock.state_key,clock.state_log_cursor,clock.state_journal_cursor);
  }
  return references;
}

export function nextReplicaHistoryPinAt(storage: StorageContext, workspace: string): number | null {
  const row = statement(storage,`SELECT ${historyPinDue} AS due
    FROM sync_relay_history_clocks c WHERE workspace_id=? AND dirty_since_ms IS NOT NULL
      AND EXISTS (SELECT 1 FROM sync_relay_replica_cut_files f WHERE f.workspace_id=c.workspace_id AND f.version_id=c.version_id AND f.object_id=c.object_id)
    ORDER BY ${historyPinDue} LIMIT 1`).get(workspace);
  return row?.due == null ? null : Number(row.due);
}

export function thinReplicaHistoryPins(storage: StorageContext, workspace: string, budget = {maxBytes:64*1024*1024,maxCount:1024}) {
  const usage=statement(storage,"SELECT pin_count,total_bytes FROM sync_relay_history_pin_usage WHERE workspace_id=?").get(workspace);
  if (!usage || Number(usage.pin_count)<=budget.maxCount && Number(usage.total_bytes)<=budget.maxBytes) return;
  const rows = statement(storage,`SELECT pin_id,pinned_at_ms,reason,superseded_at_ms,
    byte_length+length(CAST(authors_json AS BLOB))+length(CAST(path AS BLOB))+256 AS bytes
    FROM sync_relay_history_pins WHERE workspace_id=? AND superseded_at_ms IS NOT NULL ORDER BY pinned_at_ms,pin_id`).all(workspace);
  const remove = statement(storage,"DELETE FROM sync_relay_history_pins WHERE workspace_id=? AND pin_id=?");
  for (const row of replicaHistoryPinsToDrop(rows,budget)) remove.run(workspace,row.pin_id);
  deleteUnreferencedReplicaTexts(storage,workspace);
}
