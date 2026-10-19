import type {StorageContext} from "./context";
import {replicaStatement as statement} from "./replicaStatements";

export function replicaGrantFloor(storage: StorageContext, grant: string, workspace: string) {
  const row = statement(storage,`SELECT f.log_floor,f.journal_floor,
      w.replication_epoch=f.replication_epoch AND w.stream_identity=f.stream_identity AS identity_matches
    FROM sync_relay_history_grant_floors f JOIN sync_relay_workspaces w ON w.workspace_id=f.workspace_id
    WHERE f.grant_id=? AND f.workspace_id=?`).get(grant,workspace);
  return row ? {logCursor:Number(row.log_floor),journalCursor:Number(row.journal_floor),identityMatches:row.identity_matches===1} : null;
}
export function replicaViewReachesFloor(view: {logCursor:number; journalCursor:number} | null,
  floor: {logCursor:number; journalCursor:number; identityMatches?:boolean}) {
  return floor.identityMatches !== false && view !== null && view.logCursor >= floor.logCursor && view.journalCursor >= floor.journalCursor;
}
