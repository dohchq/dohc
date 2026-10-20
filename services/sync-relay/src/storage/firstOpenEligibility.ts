import {DatabaseSync} from "node:sqlite";
import type {StorageContext} from "./context";
import type {SqliteDb} from "./types";
import {hostedDocumentRows} from "./hostedDocumentIndex";
import {SYNC_RELAY_BUSY_TIMEOUT_MS} from "./limits";
import {ORDINARY_ACTIVATION_BASES} from "./ordinaryActivationBasis";
import {SERVICE_ACTIVATIONS} from "./serviceActivationSchema";
import {LIVE_RESTORE_OPERATIONS} from "./liveRestoreOperationSchema";

/**
 * What a document's durable history says about giving it a first live base.
 * `prior-authority`: it has had live-document authority before.
 * `deletion`: it was deleted or replaced at some point, even if it was restored since.
 */
export type FirstOpenEligibility = "eligible" | "prior-authority" | "deletion";

/** The current Markdown a first live base would be built from. */
export interface FirstOpenSource {
  readonly workspaceId: string;
  readonly objectId: string;
  readonly path: string;
  readonly sourceMomentId: string;
  readonly sourceDigest: string;
}

/** A read of the workspace's history after `afterRelaySeq`, from the relay database at `database`. */
export interface FirstOpenHistoryRead extends FirstOpenSource {
  readonly database: string;
  readonly afterRelaySeq: number;
}

/** One snapshot: the history's answer, whether the source is current, and the workspace log's head. */
export interface FirstOpenHistory {
  readonly kind: "history";
  readonly eligibility: FirstOpenEligibility;
  readonly current: boolean;
  /** The workspace's owner, replication epoch and stream. */
  readonly identity: string;
  /** The whole workspace log's highest relay sequence, or null while it has none. */
  readonly head: number | null;
}

/** Runs a history read off the relay writer, normally on the first-open worker. */
export type FirstOpenHistoryReader = (read: FirstOpenHistoryRead, signal: AbortSignal) => Promise<FirstOpenHistory | {kind: "busy"}>;

const target = (table: string) => `${table} WHERE workspace_id=t.workspace_id AND main_version_id='main' AND object_id=t.object_id`;
const settled = "COALESCE(json_extract(settlement_admission_json,'$.status'),'')<>'refused'";
// Stop/restore operations are indexed under their namespace first, and rows
// from every namespace count, so `n` steps through the namespaces present.
const REQUEST = `WITH RECURSIVE t(workspace_id,object_id,path,moment_id,digest,after) AS (SELECT ?,?,?,?,?,?),
  n(namespace) AS (SELECT min(relay_database_namespace) FROM ${LIVE_RESTORE_OPERATIONS} UNION ALL
    SELECT (SELECT min(relay_database_namespace) FROM ${LIVE_RESTORE_OPERATIONS} WHERE relay_database_namespace>n.namespace) FROM n WHERE n.namespace IS NOT NULL)`;
const AUTHORITY = `(EXISTS(SELECT 1 FROM ${target("sync_relay_live_documents")})
    OR EXISTS(SELECT 1 FROM ${target(ORDINARY_ACTIVATION_BASES)})
    OR EXISTS(SELECT 1 FROM ${target(SERVICE_ACTIVATIONS)})
    OR EXISTS(SELECT 1 FROM n JOIN ${target(LIVE_RESTORE_OPERATIONS)} AND relay_database_namespace=n.namespace))`;
// The source is current while it is the object's latest main moment.
// The head covers every row of the workspace, so any later row moves it.
const STATE = `EXISTS(SELECT 1 FROM (SELECT path,moment_id,blob_sha256 FROM sync_relay_object_moments INDEXED BY idx_sync_relay_object_moments_latest
      WHERE workspace_id=t.workspace_id AND version_id='main' AND object_id=t.object_id ORDER BY relay_seq DESC LIMIT 1) m
    WHERE m.path=t.path AND m.moment_id=t.moment_id AND m.blob_sha256=t.digest) AS current,
  json_array(w.owner_user_id,w.replication_epoch,w.stream_identity) AS identity,
  (SELECT max(relay_seq) FROM sync_relay_log INDEXED BY idx_sync_relay_log_page WHERE workspace_id=t.workspace_id) AS head
FROM t JOIN sync_relay_workspaces w ON w.workspace_id=t.workspace_id`;
// The object's whole history after `after`: no path, scope, epoch-floor, stream,
// lineage or version filter, and departed publications count. A relay refusal is
// stored as `relay.refused`, so it never matches; a refused settlement is not a deletion.
// `h` reads the object's own rows once: 2 when one is a Y.Doc update or live
// audit, 1 when one is a deletion. A replacement names the displaced object
// only as `beforeObjectId`, so it is found by scanning the workspace's log.
// One statement, so the answer and the head come from one snapshot.
const HISTORY = `${REQUEST},
  h(history) AS MATERIALIZED (SELECT (SELECT max(CASE WHEN op_kind<>'moment.append' THEN 2
    WHEN json_extract(payload_json,'$.operation')='delete' AND ${settled} THEN 1 ELSE 0 END)
    FROM ${hostedDocumentRows("t.workspace_id", "t.object_id")} AND relay_seq>t.after) FROM t)
SELECT CASE WHEN h.history=2 OR ${AUTHORITY} THEN 'prior-authority'
  WHEN h.history=1 OR EXISTS(SELECT 1 FROM sync_relay_log INDEXED BY idx_sync_relay_log_page WHERE workspace_id=t.workspace_id AND relay_seq>t.after
    AND op_kind='moment.append' AND json_extract(payload_json,'$.beforeObjectId')=t.object_id
    AND json_extract(payload_json,'$.objectId') NOT IN (t.object_id,'') AND ${settled})
  THEN 'deletion' ELSE 'eligible' END AS eligibility, ${STATE}, h`;
// Inside the writer: indexed lookups only, whatever the log's length.
const GUARD = `${REQUEST} SELECT ${AUTHORITY} AS authority, ${STATE}`;

const parameters = (source: FirstOpenSource, after: number) =>
  [source.workspaceId, source.objectId, source.path, source.sourceMomentId, source.sourceDigest, after];
const unknownWorkspace = () => new Error("The relay holds no history for this workspace.");
const head = (row: Record<string, unknown>) => row.head === null ? null : Number(row.head);

type HistoryDb = {prepare(sql: string): {get(...parameters: Array<string | number>): Record<string, unknown> | undefined}};

/** Throws, never answers `eligible`, when the relay holds no history for the workspace. */
export function readFirstOpenHistory(db: HistoryDb, read: Omit<FirstOpenHistoryRead, "database">): FirstOpenHistory {
  const row = db.prepare(HISTORY).get(...parameters(read, read.afterRelaySeq));
  if (!row) throw unknownWorkspace();
  return {kind: "history", eligibility: row.eligibility as FirstOpenEligibility, current: row.current === 1, identity: String(row.identity), head: head(row)};
}

/** Reads on its own read-only connection, which neither creates nor initializes the database. */
export function readFirstOpenHistoryFile(read: FirstOpenHistoryRead): FirstOpenHistory {
  const db = new DatabaseSync(read.database, {readOnly: true});
  try {
    db.exec(`PRAGMA busy_timeout = ${SYNC_RELAY_BUSY_TIMEOUT_MS}`);
    return readFirstOpenHistory(db, read);
  } finally {
    db.close();
  }
}

declare const proven: unique symbol;
/** Storage's evidence that a source was eligible against its workspace log up to a cutoff. Only storage makes one. */
export interface FirstOpenProof {readonly [proven]: true}
interface Prepared {
  /** The storage owner's lifetime; a reopened or replaced database has another. */
  readonly lifetime: AbortSignal;
  readonly source: FirstOpenSource;
  readonly identity: string;
  readonly cutoff: number | null;
}
const proofs = new WeakMap<FirstOpenProof, Prepared>();

export type FirstOpenPreparation =
  | {kind: "prepared"; proof: FirstOpenProof}
  | {kind: "refused"; reason: "prior-authority" | "deletion" | "stale-source"}
  | {kind: "busy"};
export type FirstOpenWrite<T> =
  | {kind: "published"; result: T}
  /** The workspace log moved since preparation. Catch up outside the writer, then write again. */
  | {kind: "retry"}
  | {kind: "refused"; reason: "prior-authority" | "stale-source"};

function prepared(storage: StorageContext, proof: FirstOpenProof): Prepared {
  const state = proofs.get(proof);
  if (!state || state.lifetime !== storage.unavailable) throw new Error("This first-open preparation belongs to another relay storage.");
  return state;
}

async function readHistory(storage: StorageContext, source: FirstOpenSource, previous: Prepared | null,
  read: FirstOpenHistoryReader, signal?: AbortSignal): Promise<FirstOpenPreparation> {
  const lifetime = storage.unavailable;
  storage.captureStanding();
  const history = await read({...source, database: storage.databasePath, afterRelaySeq: previous?.cutoff ?? 0},
    signal ? AbortSignal.any([signal, lifetime]) : lifetime);
  storage.captureStanding();
  if (history.kind === "busy") return history;
  if (history.eligibility !== "eligible") return {kind: "refused", reason: history.eligibility};
  if (!history.current || (previous && history.identity !== previous.identity)) return {kind: "refused", reason: "stale-source"};
  const proof = Object.freeze({}) as FirstOpenProof;
  proofs.set(proof, Object.freeze({lifetime, source, identity: history.identity, cutoff: history.head}));
  return {kind: "prepared", proof};
}

/** Reads the whole history off the writer. A reader failure rejects; it never prepares. */
export function prepareFirstOpen(storage: StorageContext, source: FirstOpenSource, read: FirstOpenHistoryReader, signal?: AbortSignal) {
  const {workspaceId, objectId, path, sourceMomentId, sourceDigest} = source;
  return readHistory(storage, Object.freeze({workspaceId, objectId, path, sourceMomentId, sourceDigest}), null, read, signal);
}

/** Reads only the rows after the proof's cutoff, and moves the cutoff to this read's head. */
export async function catchUpFirstOpen(storage: StorageContext, proof: FirstOpenProof, read: FirstOpenHistoryReader, signal?: AbortSignal) {
  const state = prepared(storage, proof);
  return readHistory(storage, state.source, state, read, signal);
}

const guards = new WeakMap<SqliteDb, ReturnType<SqliteDb["prepare"]>>();

/** Publishes in the writer only while the proof still holds; otherwise appends nothing. Never retries itself. */
export function writeFirstOpen<T>(storage: StorageContext, proof: FirstOpenProof, publish: () => T): FirstOpenWrite<T> {
  const state = prepared(storage, proof);
  return storage.tx(() => {
    let guard = guards.get(storage.db);
    if (!guard) guards.set(storage.db, guard = storage.db.prepare(GUARD));
    const row = guard.get(...parameters(state.source, 0));
    if (!row) throw unknownWorkspace();
    if (row.authority === 1) return {kind: "refused", reason: "prior-authority"};
    if (row.current !== 1 || row.identity !== state.identity) return {kind: "refused", reason: "stale-source"};
    if (head(row) !== state.cutoff) return {kind: "retry"};
    return {kind: "published", result: publish()};
  });
}
