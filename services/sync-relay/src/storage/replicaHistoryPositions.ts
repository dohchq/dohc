import type {StorageContext} from "./context";
import {replicaStatement as statement} from "./replicaStatements";

/** Ambiguous evidence fails closed; unrelated streams cannot be ordered. */
export function replicaHistoryReplacement(storage: StorageContext, workspace: string, version: string, object: string,
  fromLog: number, toLog: number, fromJournal: number, toJournal: number): [string | null, number | null] {
  const log = statement(storage,`SELECT relay_seq FROM sync_relay_log WHERE workspace_id=?
    AND json_extract(payload_json,'$.versionId')=? AND json_extract(payload_json,'$.objectId')=?
    AND relay_seq>? AND relay_seq<=? AND op_kind IN ('moment.append','ydoc.update') AND relay_admission IS NULL
    AND (settlement_admission_json IS NULL OR json_extract(settlement_admission_json,'$.status')<>'refused')
    ORDER BY relay_seq LIMIT 2`).all(workspace,version,object,fromLog,toLog);
  const journal = statement(storage,`SELECT journal_cursor FROM sync_relay_live_update_journal
    WHERE workspace_id=? AND main_version_id=? AND object_id=? AND journal_cursor>? AND journal_cursor<=?
    ORDER BY journal_cursor LIMIT 2`).all(workspace,version,object,fromJournal,toJournal);
  if (log.length === 1 && !journal.length) return ["log",Number(log[0]!.relay_seq)];
  if (journal.length === 1 && !log.length) return ["journal",Number(journal[0]!.journal_cursor)];
  return [null,null];
}
