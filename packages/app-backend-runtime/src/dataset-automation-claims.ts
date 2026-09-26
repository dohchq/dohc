import { createHash } from "node:crypto";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import { datasetChangeFacts, DatasetChangeFactsError, type DatasetChangeFact, type DatasetFieldChange } from "./dataset-change-facts.js";
import type { DatasetCursor, DatasetScope, JournalDb } from "./journal.js";
import type { DatasetCommit } from "./supervisor.js";

// Automation claims for dataset commits (ADR 0008).
//
// The host that commits a dataset change claims it, inside the commit's own
// transaction: each subscribed automation gets one claim per changed record,
// keyed by (automation, host epoch, revision, table, record). Only a new
// commit reaches this ledger. Receipt replays, recovery, replicas, and
// materialization never commit, so they never claim.
//
// A change the facts reader refuses, such as a value no field type holds,
// still commits. It claims no record: each automation that watches a table
// and change kind the change holds gets one failed claim that says why. A claim carries the values of the fields its
// automation watches, whoever can read them; the executor's reach check
// filters them before a step uses them.
//
// A claim moves from pending to running to done or failed. The reaper at open
// requeues claims a dead process left running, and fails a claim that keeps
// dying. Try again queues a failed claim again and raises its run. Every claim
// and History row is charged to the dataset's storage and refunded when
// trimmed; deleting a dataset refunds everything it retained.
//
// Each automation also counts its failures on one instance of a dataset,
// its host epoch, a generation that only grows: trimming and Try again never
// lower it. A failure notice the owner dismissed at generation N comes back
// when the count passes N. A dataset deleted and made again, or restored,
// has a new epoch, so its count starts over under a new instance and no
// earlier dismissal applies to it. The count is charged to the dataset once,
// and deleting the dataset forgets it with its claims.
//
// A press of a Button field claims too, through `press`, with no commit: one
// pending claim keyed `press:<press id>` that acts for the person who
// pressed. The ledger remembers each press 30 days, so the same press sent
// again after a lost reply answers its claim instead of running twice, and
// trimming keeps a claim a remembered press names. While the button runs on
// a record, the same person's new press of the same automation joins that
// claim, and any other press is busy. A press also names the definition of
// the automation it was checked against, so its run can refuse another.

/** A change at this depth runs no automation. Its claims fail at once and say why. */
export const DATASET_AUTOMATION_CHAIN_DEPTH = 4;
/** The most claims one commit makes. Past it, one failed claim says so. */
export const DATASET_AUTOMATION_CLAIMS_PER_COMMIT = 200;
/** How many times a claim can start. The reaper fails a claim that died this often. */
export const DATASET_AUTOMATION_ATTEMPTS = 2;
/** Settled claims kept per automation, as its run history. Its newest failure also stays. */
export const DATASET_AUTOMATION_HISTORY = 100;
/** How long the ledger remembers a press, so the same press sent again finds its claim. */
export const DATASET_AUTOMATION_PRESS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** History names the automation behind each of a dataset's newest revisions, this many back. */
export const DATASET_AUTOMATION_ATTRIBUTED_REVISIONS = 10_000;
export const DATASET_AUTOMATION_CHAIN_STOPPED = "chain-stopped";
export const DATASET_AUTOMATION_CLAIM_LIMIT = "claim-limit";
export const DATASET_AUTOMATION_RECORD_ID_TOO_LONG = "record-id-too-long";
export const DATASET_AUTOMATION_RECLAIM_EXHAUSTED = "reclaim-exhausted";
// A served claim, as JSON, fits one response, as the engine's claims do. A
// value travels whole up to the engine's bound. A record id is JSON, so a
// claim names its record whole or not at all.
const CLAIM_BYTES = 64 * 1024, VALUE_BYTES = 8 * 1024, RECORD_ID_BYTES = 1024;
// A failure keeps at most this much JSON. Each claim's charge and size reserve
// it, so settling a claim never changes what it costs or makes it too large.
const ERROR_BYTES = 1024, ROW_BYTES = 256;

export type DatasetChangeKind = DatasetChangeFact["kind"];
/**
 * Who made a commit or pressed a button. The host derives it from the
 * invoking context, never from input. A link visitor stays anonymous. A
 * press names the owner's account too, since the run acts for the person
 * who pressed.
 */
export type DatasetActor =
  | { kind: "owner"; userId?: string; appId?: string }
  | { kind: "named"; userId: string; appId?: string }
  | { kind: "link"; appId?: string }
  | { kind: "automation"; automationId: string; depth: number }
  // The owner's agent, in a run an automation started, at the run's chain depth.
  | { kind: "agent"; depth: number };
/** The person who pressed a button: the owner or a named person, by account. */
export type DatasetPresser = { kind: "owner" | "named"; userId: string };
export interface DatasetAutomationSubscription {
  automationId: string;
  tableId: string;
  kinds: DatasetChangeKind[];
  /**
   * The fields the automation watches. A changed record claims only when one
   * of them changed, and a claim carries only their values. Null watches every field.
   */
  fieldIds: string[] | null;
  /** The executor's hash of the automation entry, so its reconcile can tell a subscription is current. */
  definitionHash: string;
}
/** A value too large for a claim reads null, with `truncated`. The executor reads the record instead. */
export interface DatasetClaimFieldChange extends DatasetFieldChange { truncated?: true }
/** A committed change to one record, as its claim carries it. */
export interface DatasetChangeClaimFact extends Omit<DatasetChangeFact, "fields"> { fields: DatasetClaimFieldChange[] }
/**
 * A press of the Button field `fieldId` on one record. The run reads the
 * record as it is then, and runs only the automation `definitionHash` names.
 */
export interface DatasetPressFact { kind: "button"; datasetId: string; tableId: string; recordId: string | number; fieldId: string; definitionHash: string }
export type DatasetClaimFact = DatasetChangeClaimFact | DatasetPressFact;
/** A person pressed a Button field on one record of the dataset. */
export interface DatasetPressInput {
  /** The pressing window's id for this press. The same press sent again carries it again. */
  pressId: string;
  /**
   * The hex SHA-256 of the press as its window asked for it. The same press
   * sent again must ask for the same, even after the button's name changed.
   */
  request: string;
  /** The automation the button runs. */
  automationId: string;
  /** The executor's hash of that automation's entry, as it was checked for this press. */
  definitionHash: string;
  tableId: string;
  fieldId: string;
  /** The record's primary key. */
  recordId: string | number;
  presser: DatasetPresser;
}
/** A press the ledger remembers, with the claim it names and its request. */
export interface DatasetRememberedPress { claim: DatasetAutomationClaim; request: string }
/** What a press did: made a claim, joined one for the same press or person, or found the button busy. */
export type DatasetPressed = { kind: "claimed" | "joined"; claim: DatasetAutomationClaim } | { kind: "busy" };
export type DatasetAutomationClaimState = "pending" | "running" | "done" | "failed";
export interface DatasetAutomationClaim {
  claimId: string;
  workspaceId: string;
  datasetId: string;
  automationId: string;
  hostEpoch: string;
  revision: number;
  /** Null on a claim that failed before it started because it cannot carry its change. The error says why. */
  fact: DatasetClaimFact | null;
  actor: DatasetActor;
  /** The triggering change's chain depth. The automation's own writes declare depth + 1. */
  depth: number;
  state: DatasetAutomationClaimState;
  /** How many times the claim started, across every run. The reaper's cap counts these. */
  attempts: number;
  /** 1, plus one per Try again. A crash requeue keeps the run. */
  run: number;
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}
export type DatasetAutomationClaims = ReturnType<typeof createDatasetAutomationClaims>;
/** An automation's newest failure, as its notice shows it. */
export interface DatasetAutomationFailure {
  automationId: string;
  claimId: string;
  /**
   * The dataset instance the count belongs to: its id and host epoch. It
   * survives restarts and changes when the dataset is made again.
   */
  datasetInstance: string;
  /** It failed before it started, as a chain stop or a change too large to claim, so Try again cannot run it. */
  neverStarted: boolean;
  error: string;
  updatedAtMs: number;
  /** How many times the automation's claims have failed. It only grows. */
  generation: number;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const KINDS: readonly DatasetChangeKind[] = ["added", "changed", "removed"];
const COLUMNS = "claim_id,workspace_id,dataset_id,automation_id,host_epoch,revision,fact,actor,depth,state,attempts,run,error,created_at_ms,updated_at_ms";
// An automation's newest failure is the one it settled last: its failure notice offers that one.
const NEWEST = "ORDER BY updated_at_ms DESC, rowid DESC";

function text(value: unknown, name: string, maximum = 1024): string {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > maximum) throw new Error(`Invalid automation ${name}.`);
  return value;
}
function sync<T>(run: () => T): T {
  if (run.constructor.name === "AsyncFunction") throw new Error("Automation claim callbacks must be synchronous.");
  const result = run();
  if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("Automation claim callbacks must be synchronous.");
  return result;
}
// Failure text never refuses a settle, which would leave its claim running
// until the reaper. It keeps whole characters while its JSON fits ERROR_BYTES.
function failure(value: string): string {
  const trimmed = typeof value === "string" ? value.replaceAll("\0", "").trim() : "";
  let kept = "", size = 2;
  for (const character of trimmed || "The automation failed without saying why.") {
    size += bytes(character) - 2;
    if (size > ERROR_BYTES) break;
    kept += character;
  }
  return kept;
}

function wants(subscription: Pick<DatasetAutomationSubscription, "tableId" | "kinds" | "fieldIds">, fact: DatasetChangeFact): boolean {
  if (subscription.tableId !== fact.tableId || !subscription.kinds.includes(fact.kind)) return false;
  const fieldIds = subscription.fieldIds;
  return fact.kind !== "changed" || fieldIds === null || fact.fields.some(field => fieldIds.includes(field.fieldId));
}
// Only the watched fields, each named. Values travel in field order while the
// claim fits CLAIM_BYTES; the rest read null with `truncated`. `envelope` is
// the served claim's size without its fact, at its largest. With at most 128
// fields of about 90 bytes each when bare, a record id within RECORD_ID_BYTES,
// and identifiers within their bounds, the bare claim stays far under
// CLAIM_BYTES, so the budget never goes negative.
function bounded(fact: DatasetChangeFact, fieldIds: readonly string[] | null, envelope: number): DatasetChangeClaimFact {
  const fields = fieldIds === null ? fact.fields : fact.fields.filter(field => fieldIds.includes(field.fieldId));
  const bare = (field: DatasetFieldChange): DatasetClaimFieldChange => ({ fieldId: field.fieldId, previous: null, next: null, truncated: true });
  let budget = CLAIM_BYTES - envelope - bytes({ ...fact, fields: fields.map(bare) });
  return { ...fact, fields: fields.map(field => {
    const extra = bytes(field) - bytes(bare(field));
    if (bytes(field.previous) > VALUE_BYTES || bytes(field.next) > VALUE_BYTES || extra > budget) return bare(field);
    budget -= extra;
    return field;
  }) };
}

// SQLite's INSERT, UPDATE, and DELETE codes, as change kinds.
const KIND_OF: Readonly<Record<number, DatasetChangeKind>> = { 18: "added", 23: "changed", 9: "removed" };
const tableNames = new TextDecoder("utf-8", { fatal: true });
// Each approved table and change kind a changeset holds, read from its
// structure alone: values are skipped, never decoded, so a value the reader
// refuses does not hide them. Null when the structure itself is unreadable.
// The layout is the one dataset-change-facts.ts describes.
function touched(definition: DatasetDefinition, changeset: Uint8Array): Set<string> | null {
  const found = new Set<string>();
  let offset = 0;
  const byte = () => { if (offset >= changeset.byteLength) throw new RangeError(); return changeset[offset++]!; };
  const skip = (length: number) => { if (length > changeset.byteLength - offset) throw new RangeError(); offset += length; };
  const varint = () => {
    let value = 0;
    for (let index = 0; index < 8; index++) {
      const next = byte();
      value = value * 128 + (next & 0x7f);
      if (!(next & 0x80)) return value;
    }
    return value * 256 + byte();
  };
  try {
    while (offset < changeset.byteLength) {
      if (byte() !== 0x54) return null;
      const columns = varint();
      skip(columns);
      const end = changeset.indexOf(0, offset);
      if (end < 0) return null;
      const name = tableNames.decode(changeset.subarray(offset, end)).toLowerCase();
      offset = end + 1;
      const table = definition.tables.find(candidate => candidate.sqlName.toLowerCase() === name);
      while (offset < changeset.byteLength && changeset[offset] !== 0x54) {
        const kind = KIND_OF[byte()];
        if (kind === undefined) return null;
        skip(1);
        for (let value = 0; value < (kind === "changed" ? 2 : 1) * columns; value++) {
          const type = byte();
          if (type === 1 || type === 2) skip(8);
          else if (type === 3 || type === 4) skip(varint());
          else if (type !== 0 && type !== 5) return null;
        }
        if (table) found.add(`${table.tableId} ${kind}`);
      }
    }
    return found;
  } catch {
    // A short read or a table name that is not UTF-8.
    return null;
  }
}

// A served claim's size without its fact, at its largest state, counters, and failure.
function envelope(claim: Omit<DatasetAutomationClaim, "fact" | "state" | "attempts" | "run" | "error" | "createdAtMs" | "updatedAtMs">): number {
  const most = Number.MAX_SAFE_INTEGER;
  return bytes({ ...claim, fact: null, state: "pending", attempts: most, run: most, error: null, createdAtMs: most, updatedAtMs: most }) - bytes(null) * 2 + ERROR_BYTES;
}

function claim(row: Record<string, unknown>): DatasetAutomationClaim {
  return { claimId: String(row.claim_id), workspaceId: String(row.workspace_id), datasetId: String(row.dataset_id),
    automationId: String(row.automation_id), hostEpoch: String(row.host_epoch), revision: Number(row.revision),
    fact: row.fact === null ? null : JSON.parse(String(row.fact)), actor: JSON.parse(String(row.actor)), depth: Number(row.depth),
    state: String(row.state) as DatasetAutomationClaimState, attempts: Number(row.attempts), run: Number(row.run),
    error: row.error === null ? null : String(row.error), createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms) };
}

/**
 * The claim ledger in the dataset host's database. The host creates it on the
 * journal's database at open, while it owns the store and no executor runs:
 * creating it reaps. Scope and authority come only from the trusted host.
 */
export function createDatasetAutomationClaims(options: {
  db: JournalDb;
  transaction<T>(run: () => T): T;
  /** Charge or refund (negative) the dataset's retained bytes, in the ledger's transaction. */
  account(scope: DatasetScope, bytes: number): void;
  nowMs?: () => number;
  /** Called after a commit that made claims. A hint only: the executor also drains at open. */
  wake?(scope: DatasetScope): void;
}) {
  const { db } = options, now = options.nowMs ?? Date.now;
  const tx = <T>(run: () => T) => sync(() => options.transaction(() => sync(run)));
  const account = (scope: DatasetScope, delta: number) => { if (delta) sync(() => options.account({ workspaceId: scope.workspaceId, datasetId: scope.datasetId }, delta)); };
  const read = (workspaceId: string, claimId: string) =>
    db.prepare(`SELECT ${COLUMNS} FROM dohc_dataset_automation_claims WHERE workspace_id=? AND claim_id=?`).get(workspaceId, claimId);
  const refunded = (rows: Array<Record<string, unknown>>) => rows.reduce((sum, row) => sum + Number(row.storage_bytes), 0);
  // Counts one failure. Returns the bytes a first failure's row retains, for the caller to charge.
  const countFailure = (scope: DatasetScope, hostEpoch: string, automationId: string): number => {
    const storageBytes = bytes([scope.workspaceId, scope.datasetId, hostEpoch, automationId]) + ROW_BYTES;
    const row = db.prepare(`INSERT INTO dohc_dataset_automation_failure_generations VALUES(?,?,?,?,1,?)
      ON CONFLICT(workspace_id,dataset_id,host_epoch,automation_id) DO UPDATE SET generation=generation+1 RETURNING generation`)
      .get(scope.workspaceId, scope.datasetId, hostEpoch, automationId, storageBytes);
    return Number(row?.generation) === 1 ? storageBytes : 0;
  };
  // An automation keeps its newest settled claims, its newest failure, and
  // each claim a remembered press names. Returns the bytes removed.
  function trim(scope: DatasetScope, automationId: string): number {
    const owned = "workspace_id=?1 AND dataset_id=?2 AND automation_id=?3";
    return refunded(db.prepare(`DELETE FROM dohc_dataset_automation_claims WHERE ${owned} AND state IN('done','failed')
      AND rowid NOT IN(SELECT rowid FROM dohc_dataset_automation_claims WHERE ${owned} AND state IN('done','failed') ORDER BY rowid DESC LIMIT ?4)
      AND rowid IS NOT (SELECT rowid FROM dohc_dataset_automation_claims WHERE ${owned} AND state='failed' ${NEWEST} LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM dohc_dataset_automation_presses p WHERE p.claim_id=dohc_dataset_automation_claims.claim_id) RETURNING storage_bytes`)
      .all(scope.workspaceId, scope.datasetId, automationId, DATASET_AUTOMATION_HISTORY));
  }
  // A press this ledger still remembers, with the claim it names, or null.
  const remembered = (workspaceId: string, pressId: string): DatasetRememberedPress | null => {
    const row = db.prepare("SELECT claim_id,request FROM dohc_dataset_automation_presses WHERE workspace_id=? AND press_id=? AND pressed_at_ms>=?")
      .get(workspaceId, pressId, now() - DATASET_AUTOMATION_PRESS_RETENTION_MS);
    const found = row ? read(workspaceId, String(row.claim_id)) : undefined;
    return row && found ? { claim: claim(found), request: String(row.request) } : null;
  };
  // An unfinished claim for this press's button and record, of any automation, or undefined.
  const activePress = (workspaceId: string, fact: DatasetPressFact, other?: string): DatasetAutomationClaim | undefined =>
    db.prepare(`SELECT ${COLUMNS} FROM dohc_dataset_automation_claims WHERE workspace_id=? AND state IN('pending','running') AND dataset_id=?`)
      .all(workspaceId, fact.datasetId).map(claim)
      .find(({ claimId, fact: found }) => claimId !== other && found?.kind === "button" && found.datasetId === fact.datasetId &&
        found.tableId === fact.tableId && found.fieldId === fact.fieldId && found.recordId === fact.recordId);
  tx(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS dohc_dataset_automation_subscriptions(
      workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,automation_id TEXT NOT NULL,table_id TEXT NOT NULL,
      kinds TEXT NOT NULL,field_ids TEXT,definition_hash TEXT NOT NULL,
      PRIMARY KEY(workspace_id,dataset_id,automation_id)) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_automation_claims(
      claim_id TEXT PRIMARY KEY NOT NULL,workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,automation_id TEXT NOT NULL,
      host_epoch TEXT NOT NULL,revision INTEGER NOT NULL,table_id TEXT NOT NULL,record_id TEXT NOT NULL,
      fact TEXT,actor TEXT NOT NULL,depth INTEGER NOT NULL CHECK(depth>=0),
      state TEXT NOT NULL CHECK(state IN('pending','running','done','failed')),attempts INTEGER NOT NULL CHECK(attempts>=0),
      run INTEGER NOT NULL CHECK(run>=1),error TEXT,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,
      storage_bytes INTEGER NOT NULL CHECK(storage_bytes>0),
      UNIQUE(workspace_id,dataset_id,automation_id,host_epoch,revision,table_id,record_id)) STRICT;
    CREATE INDEX IF NOT EXISTS dohc_dataset_automation_claims_state ON dohc_dataset_automation_claims(workspace_id,state);
    CREATE TABLE IF NOT EXISTS dohc_dataset_automation_failure_generations(
      workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,host_epoch TEXT NOT NULL,automation_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation>0),storage_bytes INTEGER NOT NULL CHECK(storage_bytes>0),
      PRIMARY KEY(workspace_id,dataset_id,host_epoch,automation_id)) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_automation_revisions(
      workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,revision INTEGER NOT NULL,automation_id TEXT NOT NULL,depth INTEGER NOT NULL,
      storage_bytes INTEGER NOT NULL CHECK(storage_bytes>0),
      PRIMARY KEY(workspace_id,dataset_id,revision)) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_automation_presses(
      workspace_id TEXT NOT NULL,press_id TEXT NOT NULL,dataset_id TEXT NOT NULL,claim_id TEXT NOT NULL,request TEXT NOT NULL,
      pressed_at_ms INTEGER NOT NULL,storage_bytes INTEGER NOT NULL CHECK(storage_bytes>0),
      PRIMARY KEY(workspace_id,press_id)) STRICT;
    CREATE INDEX IF NOT EXISTS dohc_dataset_automation_presses_claim ON dohc_dataset_automation_presses(claim_id);
    CREATE INDEX IF NOT EXISTS dohc_dataset_automation_presses_age ON dohc_dataset_automation_presses(workspace_id,pressed_at_ms);`);
    // The reaper. A running claim here belongs to a process that no longer runs.
    const reaped = db.prepare(`UPDATE dohc_dataset_automation_claims SET state=CASE WHEN attempts>=?1 THEN 'failed' ELSE 'pending' END,
      error=CASE WHEN attempts>=?1 THEN ?2 END,updated_at_ms=?3 WHERE state='running' RETURNING workspace_id,dataset_id,host_epoch,automation_id,state`)
      .all(DATASET_AUTOMATION_ATTEMPTS, DATASET_AUTOMATION_RECLAIM_EXHAUSTED, now());
    const exhausted = new Map(reaped.filter(row => row.state === "failed").map(row => [JSON.stringify([row.workspace_id, row.dataset_id, row.automation_id]), row]));
    for (const row of reaped) {
      if (row.state !== "failed") continue;
      const scope = { workspaceId: String(row.workspace_id), datasetId: String(row.dataset_id) };
      account(scope, countFailure(scope, String(row.host_epoch), String(row.automation_id)));
    }
    for (const row of exhausted.values()) {
      const scope = { workspaceId: String(row.workspace_id), datasetId: String(row.dataset_id) };
      account(scope, -trim(scope, String(row.automation_id)));
    }
  });
  return {
    /**
     * Claim one commit for its subscribed automations. Runs inside the commit
     * transaction, so the claims and their charge commit or roll back with it.
     * Returns how many claims it made. With no subscription it returns after
     * one indexed read, unless an automation made the commit, which it also
     * records for History.
     */
    recordCommit(input: DatasetCommit & { approved: DatasetRevision; actor: DatasetActor }): number {
      const { cursor, actor } = input, scope = { workspaceId: cursor.workspaceId, datasetId: cursor.datasetId };
      const self = actor.kind === "automation" ? actor.automationId : undefined;
      const depth = actor.kind === "automation" || actor.kind === "agent" ? actor.depth : 0;
      const subscriptions = db.prepare("SELECT automation_id,table_id,kinds,field_ids FROM dohc_dataset_automation_subscriptions WHERE workspace_id=? AND dataset_id=? ORDER BY automation_id")
        .all(cursor.workspaceId, cursor.datasetId).filter(row => row.automation_id !== self).map(row => ({ automationId: String(row.automation_id),
          tableId: String(row.table_id), kinds: JSON.parse(String(row.kinds)) as DatasetChangeKind[], fieldIds: row.field_ids === null ? null : JSON.parse(String(row.field_ids)) as string[] }));
      let delta = 0, made = 0;
      if (self !== undefined) {
        const row = [cursor.workspaceId, cursor.datasetId, cursor.revision, self, depth], storageBytes = bytes(row) + ROW_BYTES;
        db.prepare("INSERT INTO dohc_dataset_automation_revisions VALUES(?,?,?,?,?,?)").run(...row, storageBytes);
        delta += storageBytes - refunded(db.prepare("DELETE FROM dohc_dataset_automation_revisions WHERE workspace_id=? AND dataset_id=? AND revision<=? RETURNING storage_bytes")
          .all(cursor.workspaceId, cursor.datasetId, cursor.revision - DATASET_AUTOMATION_ATTRIBUTED_REVISIONS));
      }
      if (subscriptions.length) {
        if (input.approved.datasetId !== cursor.datasetId || input.approved.revisionSha256 !== cursor.approvedRevisionHash) throw new Error("Collection rules changed during this change. Try it again.");
        // Read the whole change before claiming any of it, so a refusal anywhere claims no record.
        const planned: Array<{ subscription: (typeof subscriptions)[number]; fact: DatasetChangeFact }> = [];
        let refusal: string | undefined;
        try {
          for (const fact of datasetChangeFacts({ definition: input.approved.definition, changeset: input.changeset, columns: input.columns })) {
            for (const subscription of subscriptions) {
              if (planned.length <= DATASET_AUTOMATION_CLAIMS_PER_COMMIT && wants(subscription, fact)) planned.push({ subscription, fact });
            }
          }
        } catch (error) {
          if (!(error instanceof DatasetChangeFactsError)) throw error;
          refusal = failure(error.message);
        }
        const at = now(), stopped = depth >= DATASET_AUTOMATION_CHAIN_DEPTH, actorJson = JSON.stringify(actor), failed = new Set<string>();
        const statement = db.prepare("INSERT INTO dohc_dataset_automation_claims VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,1,?,?,?,?)");
        const insert = (automationId: string, tableId: string, recordKey: string, error: string | null, change?: { fact: DatasetChangeFact; fieldIds: string[] | null }) => {
          const key = [cursor.workspaceId, cursor.datasetId, automationId, cursor.hostEpoch, cursor.revision, tableId, recordKey];
          const claimId = digest(["dohc-dataset-automation-claim-v1", ...key]);
          const largest = envelope({ claimId, workspaceId: cursor.workspaceId, datasetId: cursor.datasetId, automationId, hostEpoch: cursor.hostEpoch, revision: cursor.revision, actor, depth });
          const factJson = change === undefined ? null : JSON.stringify(bounded(change.fact, change.fieldIds, largest));
          const storageBytes = bytes([claimId, ...key, factJson, actorJson]) + ERROR_BYTES + ROW_BYTES;
          statement.run(claimId, ...key, factJson, actorJson, depth, error ? "failed" : "pending", error, at, at, storageBytes);
          delta += storageBytes; made++;
          if (error) { failed.add(automationId); delta += countFailure(scope, cursor.hostEpoch, automationId); }
        };
        if (refusal !== undefined) {
          const reached = touched(input.approved.definition, input.changeset);
          for (const { automationId, tableId, kinds } of subscriptions) {
            if (reached === null || kinds.some(kind => reached.has(`${tableId} ${kind}`))) insert(automationId, "", "", refusal);
          }
        }
        else planned.forEach(({ subscription, fact }, index) => {
          const recordKey = JSON.stringify(fact.recordId), tooLong = Buffer.byteLength(recordKey) > RECORD_ID_BYTES;
          const error = index === DATASET_AUTOMATION_CLAIMS_PER_COMMIT ? DATASET_AUTOMATION_CLAIM_LIMIT
            : tooLong ? DATASET_AUTOMATION_RECORD_ID_TOO_LONG : stopped ? DATASET_AUTOMATION_CHAIN_STOPPED : null;
          insert(subscription.automationId, fact.tableId, digest(recordKey), error, tooLong ? undefined : { fact, fieldIds: subscription.fieldIds });
        });
        for (const automationId of failed) delta -= trim(scope, automationId);
      }
      account(scope, delta);
      // The commit transaction is synchronous, so this runs after it commits,
      // or after a rollback, where the executor finds nothing new.
      if (made && options.wake) queueMicrotask(() => {
        try { options.wake!(scope); } catch { /* A wake is a hint. */ }
      });
      return made;
    },
    /** Add or replace one automation's subscription. */
    subscribe(scope: DatasetScope, raw: DatasetAutomationSubscription): void {
      const workspaceId = text(scope.workspaceId, "workspace"), datasetId = text(scope.datasetId, "dataset");
      const automationId = text(raw.automationId, "id"), tableId = text(raw.tableId, "table", 256);
      if (!Array.isArray(raw.kinds) || !raw.kinds.length || raw.kinds.some(kind => !KINDS.includes(kind)) || new Set(raw.kinds).size !== raw.kinds.length) throw new Error("Invalid automation change kinds.");
      if (raw.fieldIds !== null && (!Array.isArray(raw.fieldIds) || !raw.fieldIds.length || raw.fieldIds.length > 128 || new Set(raw.fieldIds).size !== raw.fieldIds.length)) throw new Error("Invalid automation fields.");
      raw.fieldIds?.forEach(fieldId => text(fieldId, "field", 256));
      if (typeof raw.definitionHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.definitionHash)) throw new Error("Invalid automation definition hash.");
      tx(() => db.prepare(`INSERT INTO dohc_dataset_automation_subscriptions VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_id,dataset_id,automation_id)
        DO UPDATE SET table_id=excluded.table_id,kinds=excluded.kinds,field_ids=excluded.field_ids,definition_hash=excluded.definition_hash`)
        .run(workspaceId, datasetId, automationId, tableId, JSON.stringify([...raw.kinds].sort()), raw.fieldIds === null ? null : JSON.stringify([...raw.fieldIds].sort()), raw.definitionHash));
    },
    unsubscribe(scope: DatasetScope, automationId: string): void {
      tx(() => db.prepare("DELETE FROM dohc_dataset_automation_subscriptions WHERE workspace_id=? AND dataset_id=? AND automation_id=?").run(scope.workspaceId, scope.datasetId, automationId));
    },
    /** Every subscription in the workspace, with the dataset it watches. */
    subscriptions(workspaceId: string): Array<DatasetAutomationSubscription & { datasetId: string }> {
      return tx(() => db.prepare("SELECT * FROM dohc_dataset_automation_subscriptions WHERE workspace_id=? ORDER BY dataset_id,automation_id").all(workspaceId))
        .map(row => ({ datasetId: String(row.dataset_id), automationId: String(row.automation_id), tableId: String(row.table_id), kinds: JSON.parse(String(row.kinds)),
          fieldIds: row.field_ids === null ? null : JSON.parse(String(row.field_ids)), definitionHash: String(row.definition_hash) }));
    },
    /** An automation's newest claims in every state, newest first: its run history. */
    claims(workspaceId: string, automationId: string): DatasetAutomationClaim[] {
      return tx(() => db.prepare(`SELECT ${COLUMNS} FROM dohc_dataset_automation_claims WHERE workspace_id=? AND automation_id=? ORDER BY rowid DESC LIMIT ?`)
        .all(workspaceId, automationId, DATASET_AUTOMATION_HISTORY)).map(claim);
    },
    /** One of an automation's claims, in any state, however old, or null. */
    claim(workspaceId: string, automationId: string, claimId: string): DatasetAutomationClaim | null {
      const row = tx(() => read(workspaceId, claimId));
      return row && String(row.automation_id) === automationId ? claim(row) : null;
    },
    /** A press the ledger remembers, by its press id, with its claim, or null. */
    pressed(workspaceId: string, pressId: string): DatasetRememberedPress | null {
      return tx(() => remembered(workspaceId, pressId));
    },
    /**
     * Record one press and answer the claim that runs it, in one transaction.
     * `cursor` is the dataset's head, whose epoch the claim belongs to. The
     * host checks the table and button against the approved rules, and
     * derives who pressed.
     */
    press(input: DatasetPressInput & { cursor: Pick<DatasetCursor, "workspaceId" | "datasetId" | "hostEpoch" | "revision"> }): DatasetPressed {
      const { cursor } = input, scope = { workspaceId: text(cursor.workspaceId, "workspace"), datasetId: text(cursor.datasetId, "dataset") };
      const pressId = text(input.pressId, "press", 256), automationId = text(input.automationId, "id");
      if (typeof input.request !== "string" || !/^[a-f0-9]{64}$/.test(input.request)) throw new Error("Invalid automation press request.");
      if (typeof input.definitionHash !== "string" || !/^[a-f0-9]{64}$/.test(input.definitionHash)) throw new Error("Invalid automation definition hash.");
      const fact: DatasetPressFact = { kind: "button", datasetId: scope.datasetId, tableId: text(input.tableId, "table", 256),
        recordId: input.recordId, fieldId: text(input.fieldId, "field", 256), definitionHash: input.definitionHash };
      if ((typeof fact.recordId !== "string" && !Number.isSafeInteger(fact.recordId)) || bytes(fact.recordId) > RECORD_ID_BYTES) throw new Error("Invalid automation record.");
      if (input.presser.kind !== "owner" && input.presser.kind !== "named") throw new Error("Invalid automation presser.");
      const presser: DatasetPresser = { kind: input.presser.kind, userId: text(input.presser.userId, "presser") };
      const samePresser = ({ actor }: DatasetAutomationClaim) =>
        (actor.kind === "owner" || actor.kind === "named") && actor.kind === presser.kind && actor.userId === presser.userId;
      const another = () => new Error("This press id already names another press.");
      return tx(() => {
        const at = now();
        // Presses past retention are forgotten, and their claims can trim.
        const forgotten = db.prepare("DELETE FROM dohc_dataset_automation_presses WHERE workspace_id=? AND pressed_at_ms<? RETURNING dataset_id,storage_bytes")
          .all(scope.workspaceId, at - DATASET_AUTOMATION_PRESS_RETENTION_MS);
        for (const row of forgotten) account({ workspaceId: scope.workspaceId, datasetId: String(row.dataset_id) }, -Number(row.storage_bytes));
        // The same press sent again is the same request, whatever the rules or automations say now.
        const known = remembered(scope.workspaceId, pressId);
        if (known !== null) {
          if (known.request !== input.request || !samePresser(known.claim)) throw another();
          return { kind: "joined", claim: known.claim };
        }
        // One run per button and record at a time: a double click, or two windows, run once.
        const active = activePress(scope.workspaceId, fact);
        if (active !== undefined && (active.automationId !== automationId || !samePresser(active))) return { kind: "busy" };
        let pressed = active;
        let delta = 0;
        if (pressed === undefined) {
          // The key names the request, so only the same press can meet its claim again.
          const key = [scope.workspaceId, scope.datasetId, automationId, cursor.hostEpoch, cursor.revision, fact.tableId, `press:${pressId}:${input.request}`];
          const claimId = digest(["dohc-dataset-automation-claim-v1", ...key]);
          // A press the ledger forgot can still have its claim, when nothing committed since.
          const kept = read(scope.workspaceId, claimId);
          if (kept) {
            pressed = claim(kept);
            if (!samePresser(pressed)) throw another();
          } else {
            const factJson = JSON.stringify(fact), actorJson = JSON.stringify(presser);
            const storageBytes = bytes([claimId, ...key, factJson, actorJson]) + ERROR_BYTES + ROW_BYTES;
            db.prepare("INSERT INTO dohc_dataset_automation_claims VALUES(?,?,?,?,?,?,?,?,?,?,0,'pending',0,1,NULL,?,?,?)")
              .run(claimId, ...key, factJson, actorJson, at, at, storageBytes);
            delta += storageBytes;
            pressed = claim(read(scope.workspaceId, claimId)!);
          }
        }
        const storageBytes = bytes([scope.workspaceId, pressId, scope.datasetId, pressed.claimId, input.request]) + ROW_BYTES;
        db.prepare("INSERT INTO dohc_dataset_automation_presses VALUES(?,?,?,?,?,?,?)").run(scope.workspaceId, pressId, scope.datasetId, pressed.claimId, input.request, at, storageBytes);
        account(scope, delta + storageBytes);
        return { kind: delta > 0 ? "claimed" : "joined", claim: pressed };
      });
    },
    /**
     * Each automation's newest failed claim, the one its failure notice
     * offers to try again, with its failure count. A claim that failed
     * before it started cannot run again.
     */
    failures(workspaceId: string): DatasetAutomationFailure[] {
      return tx(() => db.prepare(`SELECT f.automation_id,f.claim_id,f.dataset_id,f.host_epoch,f.attempts,f.error,f.updated_at_ms,COALESCE(c.generation,1) AS generation FROM (
          SELECT dataset_id,host_epoch,automation_id,claim_id,attempts,error,updated_at_ms,ROW_NUMBER() OVER (PARTITION BY automation_id ${NEWEST}) AS newest
          FROM dohc_dataset_automation_claims WHERE workspace_id=?1 AND state='failed') f
        LEFT JOIN dohc_dataset_automation_failure_generations c
          ON c.workspace_id=?1 AND c.dataset_id=f.dataset_id AND c.host_epoch=f.host_epoch AND c.automation_id=f.automation_id
        WHERE f.newest=1 ORDER BY f.automation_id`).all(workspaceId))
        .map(row => ({ automationId: String(row.automation_id), claimId: String(row.claim_id),
          datasetInstance: JSON.stringify([String(row.dataset_id), String(row.host_epoch)]), neverStarted: Number(row.attempts) === 0,
          error: String(row.error ?? ""), updatedAtMs: Number(row.updated_at_ms), generation: Number(row.generation) }));
    },
    /** Start the oldest pending claim in the workspace, or return null. */
    next(workspaceId: string): DatasetAutomationClaim | null {
      return tx(() => {
        const row = db.prepare(`SELECT ${COLUMNS} FROM dohc_dataset_automation_claims WHERE workspace_id=? AND state='pending' ORDER BY rowid LIMIT 1`).get(workspaceId);
        if (!row) return null;
        const at = now();
        db.prepare("UPDATE dohc_dataset_automation_claims SET state='running',attempts=attempts+1,updated_at_ms=? WHERE claim_id=? AND state='pending'").run(at, row.claim_id);
        return claim({ ...row, state: "running", attempts: Number(row.attempts) + 1, updated_at_ms: at });
      });
    },
    /** Finish the attempt `next` started. A requeued or restarted claim refuses an older attempt. A long failure keeps its first 1 KiB. */
    settle(started: Pick<DatasetAutomationClaim, "workspaceId" | "claimId" | "attempts">, outcome: { state: "done" } | { state: "failed"; error: string }): DatasetAutomationClaim {
      const error = outcome.state === "failed" ? failure(outcome.error) : null;
      return tx(() => {
        const changed = db.prepare("UPDATE dohc_dataset_automation_claims SET state=?,error=?,updated_at_ms=? WHERE workspace_id=? AND claim_id=? AND state='running' AND attempts=?")
          .run(outcome.state, error, now(), started.workspaceId, started.claimId, started.attempts);
        if (Number(changed.changes) !== 1) throw new Error("This automation run is no longer current.");
        const settled = claim(read(started.workspaceId, started.claimId)!);
        const counted = outcome.state === "failed" ? countFailure(settled, settled.hostEpoch, settled.automationId) : 0;
        account(settled, counted - trim(settled, settled.automationId));
        return settled;
      });
    },
    /** Hands a claim `next` started back to pending, without counting its attempt: it waits for something else. */
    release(started: Pick<DatasetAutomationClaim, "workspaceId" | "claimId" | "attempts">): void {
      tx(() => {
        const changed = db.prepare("UPDATE dohc_dataset_automation_claims SET state='pending',attempts=attempts-1,updated_at_ms=? WHERE workspace_id=? AND claim_id=? AND state='running' AND attempts=?")
          .run(now(), started.workspaceId, started.claimId, started.attempts);
        if (Number(changed.changes) !== 1) throw new Error("This automation run is no longer current.");
      });
    },
    /**
     * Try again: a failed claim runs again with the facts it holds, as its
     * next run. A press cannot while its button runs on the record again.
     */
    retry(input: Pick<DatasetAutomationClaim, "workspaceId" | "claimId">): DatasetAutomationClaim {
      return tx(() => {
        const row = read(input.workspaceId, input.claimId);
        if (!row) throw new Error("This automation run no longer exists.");
        const current = claim(row);
        if (current.state === "done") throw new Error("This automation run already finished.");
        if (current.state === "failed" && current.attempts === 0) throw new Error("This automation run stopped before it started, so it cannot run again.");
        if (current.state !== "failed") return current;
        if (current.fact?.kind === "button" && activePress(current.workspaceId, current.fact, current.claimId) !== undefined) {
          throw new Error("This button is already running for this record.");
        }
        db.prepare("UPDATE dohc_dataset_automation_claims SET state='pending',error=NULL,run=run+1,updated_at_ms=? WHERE workspace_id=? AND claim_id=? AND state='failed'")
          .run(now(), input.workspaceId, input.claimId);
        return claim(read(input.workspaceId, input.claimId)!);
      });
    },
    /**
     * Remove a deleted dataset's automation state, inside the deletion
     * transaction. It refunds nothing: the host refunds all the dataset retained.
     */
    forget(scope: DatasetScope): void {
      for (const table of ["dohc_dataset_automation_subscriptions", "dohc_dataset_automation_claims", "dohc_dataset_automation_revisions", "dohc_dataset_automation_failure_generations", "dohc_dataset_automation_presses"])
        db.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND dataset_id=?`).run(scope.workspaceId, scope.datasetId);
    },
  };
}
