import {liveAuthorIdentity, type LiveAuthorEntry, type LiveUpdateStructRange} from "@dohc/live-session-contract";
import type {StorageContext} from "./context";
import {liveContentAuthors} from "./liveAuthorWindow";
import {subtractJournalRanges} from "./liveUpdateJournal";
import {sharedMomentAuthors} from "../sharedMomentAuthors";
import {parseSettlementAuthors} from "./hostedSettlement";
import {OTHER_LINEAGE_UPDATE} from "./otherLineageUpdate";
import {replicaStatement as statement} from "./replicaStatements";

const SCAN_LIMIT = 10_000;
/** Credits the pinned state's lineage. A file with no lineage kept no row that names one. */
export function replicaHistoryAuthors(storage: StorageContext, workspace: string, version: string, object: string, lineage: string | null,
  fromLog: number, toLog: number, fromJournal: number, toJournal: number) {
  const authors = new Map<string,LiveAuthorEntry>();
  const snapshots = new Set<unknown>();
  const add = (raw: unknown) => {
    if (snapshots.has(raw)) return;
    snapshots.add(raw);
    const snapshot = raw == null ? [] : parseSettlementAuthors(JSON.parse(String(raw)));
    for (const author of liveContentAuthors(snapshot)) {
      const key = liveAuthorIdentity(author), prior = authors.get(key);
      if (prior?.kind === "agent" && author.kind === "agent") authors.set(key,{...prior,depth:Math.max(prior.depth ?? 0,author.depth ?? 0)});
      else if (prior?.kind === "automation" && author.kind === "automation") authors.set(key,{...prior,attribution:{...prior.attribution,depth:Math.max(prior.attribution.depth,author.attribution.depth)}});
      else if (!prior) authors.set(key,author);
    }
  };
  const logs = statement(storage,`SELECT admitted_author_snapshot_json
    FROM sync_relay_log WHERE workspace_id=? AND json_extract(payload_json,'$.versionId')=?
      AND json_extract(payload_json,'$.objectId')=? AND relay_seq>? AND relay_seq<=?
      AND op_kind IN ('ydoc.update','moment.append') AND relay_admission IS NULL
      AND (settlement_admission_json IS NULL OR json_extract(settlement_admission_json,'$.status')<>'refused')
      AND NOT (${OTHER_LINEAGE_UPDATE})
      ORDER BY relay_seq LIMIT ?`)
    .all(workspace,version,object,fromLog,toLog,lineage,SCAN_LIMIT+1);
  for (const row of logs.slice(0,SCAN_LIMIT)) {
    add(row.admitted_author_snapshot_json);
  }
  const remaining = SCAN_LIMIT-Math.min(logs.length,SCAN_LIMIT);
  const journal = statement(storage,`SELECT journal_cursor,author_snapshot_json,first_seen_deletes_json,seed_first_seen_json
    FROM sync_relay_live_update_journal WHERE workspace_id=? AND main_version_id=? AND object_id=?
      AND journal_cursor>? AND journal_cursor<=? ORDER BY journal_cursor LIMIT ?`)
    .all(workspace,version,object,fromJournal,toJournal,remaining+1);
  for (const row of journal.slice(0,remaining)) {
    const ranges = statement(storage,"SELECT client_id AS clientId,start_clock AS startClock,end_clock AS endClock FROM sync_relay_live_update_struct_provenance WHERE journal_cursor=? ORDER BY client_id,start_clock").all(row.journal_cursor);
    const seed = JSON.parse(String(row.seed_first_seen_json));
    const firstSeen: LiveUpdateStructRange[] = ranges.map(r=>({clientId:Number(r.clientId),startClock:Number(r.startClock),endClock:Number(r.endClock)}));
    if (JSON.parse(String(row.first_seen_deletes_json)).length || subtractJournalRanges(firstSeen,seed).length) add(row.author_snapshot_json);
  }
  if (logs.length > SCAN_LIMIT || journal.length > remaining) add(null);
  return sharedMomentAuthors([...authors.values()]);
}
