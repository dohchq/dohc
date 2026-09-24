import { createHash } from "node:crypto";
import type { DatasetRevision } from "@dohc/security-contract/dataset";
import { datasetChangeFacts, DatasetChangeFactsError, type DatasetChangeFact, type DatasetFieldChange } from "./dataset-change-facts.js";
import type { DatasetScope, JournalDb } from "./journal.js";
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
// still commits. It claims no record: each subscribed automation gets one
// failed claim that says why. A claim carries the values of the fields its
// automation watches, whoever can read them; the executor's reach check
// filters them before a step uses them.
//
// A claim moves from pending to running to done or failed. The reaper at open
// requeues claims a dead process left running, and fails a claim that keeps
// dying. Try again queues a failed claim again and raises its run. Every claim
// and History row is charged to the dataset's storage and refunded when
// trimmed; deleting a dataset refunds everything it retained.

/** A change at this depth runs no automation. Its claims fail at once and say why. */
export const DATASET_AUTOMATION_CHAIN_DEPTH = 4;
/** The most claims one commit makes. Past it, one failed claim says so. */
export const DATASET_AUTOMATION_CLAIMS_PER_COMMIT = 200;
/** How many times a claim can start. The reaper fails a claim that died this often. */
export const DATASET_AUTOMATION_ATTEMPTS = 2;
/** Settled claims kept per automation, as its run history. Its newest failure also stays. */
export const DATASET_AUTOMATION_HISTORY = 100;
/** History names the automation behind each of a dataset's newest revisions, this many back. */
export const DATASET_AUTOMATION_ATTRIBUTED_REVISIONS = 10_000;
export const DATASET_AUTOMATION_CHAIN_STOPPED = "chain-stopped";
export const DATASET_AUTOMATION_CLAIM_LIMIT = "claim-limit";
export const DATASET_AUTOMATION_RECORD_ID_TOO_LONG = "record-id-too-long";
export const DATASET_AUTOMATION_RECLAIM_EXHAUSTED = "reclaim-exhausted";
// The same bounds as the engine's claim facts. A record id is JSON, so a claim
// names its record whole or not at all.
const VALUE_BYTES = 8 * 1024, FACT_BYTES = 64 * 1024, RECORD_ID_BYTES = 1024;
// A failure keeps at most this much text. Each claim's charge reserves it, so
// settling a claim never changes what it costs.
const ERROR_BYTES = 1024, ROW_BYTES = 256;

export type DatasetChangeKind = DatasetChangeFact["kind"];
/**
 * Who made a commit. The host derives it from the invoking context, never
 * from input. A link visitor stays anonymous.
 */
export type DatasetActor =
  | { kind: "owner"; appId?: string }
  | { kind: "named"; userId: string; appId?: string }
  | { kind: "link"; appId?: string }
  | { kind: "automation"; automationId: string; depth: number };
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
export interface DatasetClaimFact extends Omit<DatasetChangeFact, "fields"> { fields: DatasetClaimFieldChange[] }
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

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const KINDS: readonly DatasetChangeKind[] = ["added", "changed", "removed"];
const COLUMNS = "claim_id,workspace_id,dataset_id,automation_id,host_epoch,revision,fact,actor,depth,state,attempts,run,error,created_at_ms,updated_at_ms";

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
function failure(value: string): string {
  const whole = Buffer.from(text(value.trim(), "failure", Number.POSITIVE_INFINITY));
  let end = Math.min(whole.byteLength, ERROR_BYTES);
  // Cut before a character, never inside one.
  while (end < whole.byteLength && (whole[end]! & 0xc0) === 0x80) end--;
  return whole.subarray(0, end).toString();
}

function wants(subscription: Pick<DatasetAutomationSubscription, "tableId" | "kinds" | "fieldIds">, fact: DatasetChangeFact): boolean {
  if (subscription.tableId !== fact.tableId || !subscription.kinds.includes(fact.kind)) return false;
  const fieldIds = subscription.fieldIds;
  return fact.kind !== "changed" || fieldIds === null || fact.fields.some(field => fieldIds.includes(field.fieldId));
}
// Only the watched fields, each named. Values travel in field order while
// they fit; the rest read null with `truncated`. With at most 128 fields of
// about 90 bytes each when bare, and a record id within RECORD_ID_BYTES, the
// bare fact stays far under FACT_BYTES, so the budget never goes negative.
function bounded(fact: DatasetChangeFact, fieldIds: readonly string[] | null): DatasetClaimFact {
  const fields = fieldIds === null ? fact.fields : fact.fields.filter(field => fieldIds.includes(field.fieldId));
  const bare = (field: DatasetFieldChange): DatasetClaimFieldChange => ({ fieldId: field.fieldId, previous: null, next: null, truncated: true });
  let budget = FACT_BYTES - bytes({ ...fact, fields: fields.map(bare) });
  return { ...fact, fields: fields.map(field => {
    const extra = bytes(field) - bytes(bare(field));
    if (bytes(field.previous) > VALUE_BYTES || bytes(field.next) > VALUE_BYTES || extra > budget) return bare(field);
    budget -= extra;
    return field;
  }) };
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
  // An automation keeps its newest settled claims and its newest failure. Returns the bytes removed.
  function trim(scope: DatasetScope, automationId: string): number {
    const owned = "workspace_id=?1 AND dataset_id=?2 AND automation_id=?3";
    return refunded(db.prepare(`DELETE FROM dohc_dataset_automation_claims WHERE ${owned} AND state IN('done','failed')
      AND rowid NOT IN(SELECT rowid FROM dohc_dataset_automation_claims WHERE ${owned} AND state IN('done','failed') ORDER BY rowid DESC LIMIT ?4)
      AND rowid IS NOT (SELECT max(rowid) FROM dohc_dataset_automation_claims WHERE ${owned} AND state='failed') RETURNING storage_bytes`)
      .all(scope.workspaceId, scope.datasetId, automationId, DATASET_AUTOMATION_HISTORY));
  }
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
    CREATE TABLE IF NOT EXISTS dohc_dataset_automation_revisions(
      workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,revision INTEGER NOT NULL,automation_id TEXT NOT NULL,depth INTEGER NOT NULL,
      storage_bytes INTEGER NOT NULL CHECK(storage_bytes>0),
      PRIMARY KEY(workspace_id,dataset_id,revision)) STRICT;`);
    // The reaper. A running claim here belongs to a process that no longer runs.
    db.prepare(`UPDATE dohc_dataset_automation_claims SET state=CASE WHEN attempts>=?1 THEN 'failed' ELSE 'pending' END,
      error=CASE WHEN attempts>=?1 THEN ?2 END,updated_at_ms=?3 WHERE state='running'`)
      .run(DATASET_AUTOMATION_ATTEMPTS, DATASET_AUTOMATION_RECLAIM_EXHAUSTED, now());
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
      const self = actor.kind === "automation" ? actor.automationId : undefined, depth = actor.kind === "automation" ? actor.depth : 0;
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
        const insert = (automationId: string, tableId: string, recordKey: string, fact: DatasetClaimFact | null, error: string | null) => {
          const key = [cursor.workspaceId, cursor.datasetId, automationId, cursor.hostEpoch, cursor.revision, tableId, recordKey];
          const claimId = digest(["dohc-dataset-automation-claim-v1", ...key]), factJson = fact === null ? null : JSON.stringify(fact);
          const storageBytes = bytes([claimId, ...key, factJson, actorJson]) + ERROR_BYTES + ROW_BYTES;
          statement.run(claimId, ...key, factJson, actorJson, depth, error ? "failed" : "pending", error, at, at, storageBytes);
          delta += storageBytes; made++;
          if (error) failed.add(automationId);
        };
        if (refusal !== undefined) for (const { automationId } of subscriptions) insert(automationId, "", "", null, refusal);
        else planned.forEach(({ subscription, fact }, index) => {
          const recordKey = JSON.stringify(fact.recordId), tooLong = Buffer.byteLength(recordKey) > RECORD_ID_BYTES;
          const error = index === DATASET_AUTOMATION_CLAIMS_PER_COMMIT ? DATASET_AUTOMATION_CLAIM_LIMIT
            : tooLong ? DATASET_AUTOMATION_RECORD_ID_TOO_LONG : stopped ? DATASET_AUTOMATION_CHAIN_STOPPED : null;
          insert(subscription.automationId, fact.tableId, digest(recordKey), tooLong ? null : bounded(fact, subscription.fieldIds), error);
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
    subscriptions(scope: DatasetScope): DatasetAutomationSubscription[] {
      return tx(() => db.prepare("SELECT * FROM dohc_dataset_automation_subscriptions WHERE workspace_id=? AND dataset_id=? ORDER BY automation_id").all(scope.workspaceId, scope.datasetId))
        .map(row => ({ automationId: String(row.automation_id), tableId: String(row.table_id), kinds: JSON.parse(String(row.kinds)),
          fieldIds: row.field_ids === null ? null : JSON.parse(String(row.field_ids)), definitionHash: String(row.definition_hash) }));
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
        account(settled, -trim(settled, settled.automationId));
        return settled;
      });
    },
    /** Try again: a failed claim runs again with the facts it holds, as its next run. */
    retry(input: Pick<DatasetAutomationClaim, "workspaceId" | "claimId">): DatasetAutomationClaim {
      return tx(() => {
        const row = read(input.workspaceId, input.claimId);
        if (!row) throw new Error("This automation run no longer exists.");
        const current = claim(row);
        if (current.state === "done") throw new Error("This automation run already finished.");
        if (current.state === "failed" && current.attempts === 0) throw new Error("This automation run stopped before it started, so it cannot run again.");
        if (current.state !== "failed") return current;
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
      for (const table of ["dohc_dataset_automation_subscriptions", "dohc_dataset_automation_claims", "dohc_dataset_automation_revisions"])
        db.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND dataset_id=?`).run(scope.workspaceId, scope.datasetId);
    },
  };
}
