import { parseLiveAuthorSnapshot, type LiveAuthorSnapshot } from "@dohc/live-session-contract/live-authorship";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseLiveObjectBinding, type LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";

// WS-G2-C-2 — the one source of truth for the e2e SQLite helpers that read the
// workspace engine.db. These are load-bearing for the "no double-journal"
// invariant (workspace-engine-editor.spec) and the decoupling proof
// (workspace-collab-decoupling.spec); keeping a single copy stops the two specs
// from drifting (e.g. one getting a schema fix the other misses).
const requireModule = createRequire(import.meta.url);

type DatabaseSyncCtor = new (
  path: string,
  options?: { readOnly?: boolean },
) => {
  prepare(sql: string): {
    all(...params: unknown[]): Array<Record<string, unknown>>;
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
  close(): void;
};

const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: DatabaseSyncCtor;
};

export type EngineDb = InstanceType<DatabaseSyncCtor>;

export interface EngineMoment {
  path: string;
  operation: string;
  text: string;
  summary: string | null;
}

// Only a database that cannot be opened reads as "not ready, poll again", and
// only by error code — never by matching message text, which is the rule the
// relay helper already follows.
//
// `node:sqlite` reports every sqlite failure as `code: "ERR_SQLITE_ERROR"` and
// carries the real result code in `errcode`, so an absent engine.db arrives as
// SQLITE_CANTOPEN (14), not as ENOENT. ENOENT stays for a filesystem-level
// failure raised before sqlite sees the path.
const SQLITE_CANTOPEN = 14;

function isDbNotOpenable(error: unknown, dbOpened: boolean): boolean {
  if (dbOpened) return false;
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return true;
  return (error as { errcode?: unknown } | undefined)?.errcode === SQLITE_CANTOPEN;
}

// Every (table, column) this file reads.
const SCHEMA_READ_HERE: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "moments",
    [
      "path",
      "operation",
      "moment_order",
      "payload_after_blob_sha256",
      "payload_after_content_kind",
      "metadata_summary",
    ],
  ],
  ["blobs", ["sha256", "text"]],
  ["snapshots", ["path"]],
  ["ydoc_updates", ["workspace_id", "version_id", "object_id", "seq", "actor_origin_id", "actor_kind"]],
  ["replication_log", ["op_kind", "payload_json"]],
  ["ydoc_docs", ["workspace_id", "version_id", "object_id", "path", "regime", "head_update_seq", "head_snapshot_seq"]],
  ["ydoc_snapshots", ["workspace_id", "version_id", "object_id", "up_to_seq"]],
  ["ydoc_owner_bindings", ["workspace_id", "main_version_id", "object_id", "lineage_claim_id",
    "binding_json", "relay_database_namespace", "binding_revision", "accepted_cursor"]],
  ["live_audit_events", ["relay_database_namespace", "event_count", "evidence_digest", "journal_cursor", "delivery_id",
    "accepting_host_epoch", "record_digest"]],
  ["live_audit_record_manifests", ["record_digest", "manifest_json"]],
  ["live_audit_record_chunks", ["record_digest", "ordinal", "chunk_sha256"]],
  ["binary_blobs", ["sha256", "bytes"]],
];

// Presence is the read gate. The engine ships one transactional migration
// (`v2-baseline` in crates/dohc-engine-storage/src/migration.rs): its DDL and
// its `engine_migrations` row commit together, so a read-only connection sees
// the names above only after the schema is complete. A store whose ledger has
// that row settled but is missing a name is a defect and throws; a store still
// short of it may be migrating and polls. An empty ledger settles nothing.
const BASELINE_MIGRATION_ID = "v2-baseline";

function schemaSettled(db: EngineDb): boolean {
  const ledger = db
    .prepare("SELECT name FROM pragma_table_info('engine_migrations')")
    .all();
  if (ledger.length === 0) return false;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM engine_migrations
       WHERE id = ? AND completed_at IS NOT NULL`,
    )
    .get(BASELINE_MIGRATION_ID) as { n: number } | undefined;
  return Number(row?.n ?? 0) === 1;
}

// Which of the names above this store does not have.
function missingSchemaNames(db: EngineDb): string[] {
  const missing: string[] = [];
  for (const [table, columns] of SCHEMA_READ_HERE) {
    const present = new Set(
      db
        .prepare("SELECT name FROM pragma_table_info(?)")
        .all(table)
        .map((row) => String(row.name)),
    );
    if (present.size === 0) {
      missing.push(table);
      continue;
    }
    for (const column of columns) if (!present.has(column)) missing.push(`${table}.${column}`);
  }
  return missing;
}

export function withEngineDb<T>(rootPath: string, fn: (db: EngineDb) => T): T | null {
  let db: EngineDb | null = null;
  try {
    db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), { readOnly: true });
    if (missingSchemaNames(db).length === 0) return fn(db);
    if (!schemaSettled(db)) return null;
    // Every read above is its own snapshot, so the daemon can commit the rest
    // of the chain between them and leave "name absent" and "ledger finished"
    // describing two different instants. Settling is final, so re-reading the
    // names after the ledger is the whole guard: still absent now means never.
    const missing = missingSchemaNames(db);
    if (missing.length === 0) return fn(db);
    // Absent after settling is a defect, and it says which name and where the
    // ledger stopped. Returning "not ready" instead would leave the gate shut
    // forever, every helper would answer 0/[]/false, and the `toBe(0)` and
    // `toEqual([])` call sites would pass on nothing — the shape this file
    // exists to remove.
    throw new Error(
      `engine.db has no ${missing.join(", ")}, and its migration ledger has settled ` +
        `${BASELINE_MIGRATION_ID}: these e2e readers query a schema the engine no longer has.`,
    );
  } catch (error) {
    if (isDbNotOpenable(error, db !== null)) return null;
    throw error;
  } finally {
    db?.close();
  }
}

export function ydocUpdateCount(rootPath: string): number {
  return (
    withEngineDb(rootPath, (db) => {
      const row = db.prepare("SELECT COUNT(*) AS n FROM ydoc_updates").get() as
        | { n: number }
        | undefined;
      return Number(row?.n ?? 0);
    }) ?? 0
  );
}

export interface OwnerEnrollment {
  binding: LiveObjectBinding;
  relayDatabaseNamespace: string;
  revision: number;
  acceptedCursor: number;
}

/** The owner's persisted row for this exact object and lineage, including an older restore fence while enrollment catches up. */
export function ownerEnrollment(rootPath: string, expected: LiveObjectBinding): OwnerEnrollment | null {
  return withEngineDb(rootPath, (db) => {
    const row = db.prepare(
      `SELECT binding_json, relay_database_namespace, binding_revision, accepted_cursor
       FROM ydoc_owner_bindings
       WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`,
    ).get(expected.workspaceId, expected.mainVersionId, expected.objectId, expected.lineageClaimId);
    if (!row) return null;
    if (typeof row.binding_json !== "string") throw new Error("Owner enrollment binding is not JSON text.");
    const binding = parseLiveObjectBinding(JSON.parse(row.binding_json));
    const relayDatabaseNamespace = parseLiveUpdateIdentifier(row.relay_database_namespace, "relayDatabaseNamespace");
    const revision = row.binding_revision;
    const acceptedCursor = row.accepted_cursor;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
      throw new Error("Owner enrollment revision must be a positive safe integer.");
    }
    if (typeof acceptedCursor !== "number" || !Number.isSafeInteger(acceptedCursor) || acceptedCursor < 0) {
      throw new Error("Owner enrollment cursor must be a nonnegative safe integer.");
    }
    return { binding, relayDatabaseNamespace, revision, acceptedCursor };
  });
}

// Who each journaled Y.Doc update is recorded under.
export function ydocUpdateAuthors(
  rootPath: string,
): Array<{ actorOriginId: string | null; actorKind: string | null }> {
  return (
    withEngineDb(rootPath, (db) =>
      db
        .prepare("SELECT actor_origin_id, actor_kind FROM ydoc_updates")
        .all()
        .map((row) => ({
          actorOriginId: row.actor_origin_id === null ? null : String(row.actor_origin_id),
          actorKind: row.actor_kind === null ? null : String(row.actor_kind),
        })),
    ) ?? []
  );
}

// Counts and cursors only: where this owner's copy of its host's live
// settlements stands against its accepted cursor. Pulled settlement records
// and settlement moments, by disposition; settlements
// parked for a later accepted cursor; and any pulled operation deferred for a
// retry, such as one waiting for an open document.
export function ownerSettlementState(rootPath: string) {
  return withEngineDb(rootPath, (db) => {
    const count = (sql: string) => Number(db.prepare(sql).get()?.n ?? 0);
    return {
      // The cursor each pulled settlement covers, and whether its moment is here.
      settlementRecords: db
        .prepare(
          `SELECT json_extract(l.payload_json,'$.record.terminalCursor') AS cursor,
             EXISTS(SELECT 1 FROM moments m
               WHERE m.moment_id=json_extract(l.payload_json,'$.record.momentId')) AS moment_here
           FROM replication_log l WHERE l.imported=1 AND l.op_kind='live.audit.settlement'
           ORDER BY cursor`,
        )
        .all()
        .map((row) => ({ terminalCursor: Number(row.cursor), momentHere: Number(row.moment_here) === 1 })),
      acceptedCursor: count("SELECT COALESCE(MAX(accepted_cursor),-1) AS n FROM ydoc_owner_bindings"),
      settlementMoments: db
        .prepare(
          `SELECT apply_disposition AS disposition, COUNT(*) AS n FROM replication_log
           WHERE imported=1 AND op_kind='moment.append'
             AND json_extract(payload_json,'$.momentId') LIKE 'moment-ydoc-%'
           GROUP BY apply_disposition`,
        )
        .all()
        .map((row) => ({ disposition: String(row.disposition), count: Number(row.n) })),
      parked: count("SELECT COUNT(*) AS n FROM owner_pending_settlements WHERE applied=0"),
      parkedApplied: count("SELECT COUNT(*) AS n FROM owner_pending_settlements WHERE applied=1"),
      deferred: count("SELECT COUNT(*) AS n FROM relay_deferred_ops"),
    };
  });
}

// Every text-carrying moment with its blob text, ordered by moment_order.
//
// A moment's `payload_after_blob_sha256` holds a `blobs` digest for text and a
// `binary_blobs` digest for binary, so binary moments have no `blobs` row.
// Filter them out BY KIND rather than letting an inner join drop them: a text
// moment whose blob is missing is then an impossible state — a wrong join or a
// corrupt store — and it throws. Returning a shorter list instead would quietly
// satisfy the "exactly one settle moment" double-journal check in
// workspace-engine-editor.spec, the assertion this join feeds.
function readMoments(db: EngineDb, path?: string): EngineMoment[] {
  const rows = db
    .prepare(
      `SELECT m.path AS path, m.operation AS operation,
              m.payload_after_blob_sha256 AS sha, b.text AS text,
              m.metadata_summary AS summary
       FROM moments m
       LEFT JOIN blobs b ON b.sha256 = m.payload_after_blob_sha256
       WHERE m.payload_after_blob_sha256 IS NOT NULL
         AND m.payload_after_content_kind IS NOT 'binary'
         ${path === undefined ? "" : "AND m.path = ?"}
       ORDER BY m.moment_order`,
    )
    .all(...(path === undefined ? [] : [path]));
  return rows.map((row) => {
    if (typeof row.text !== "string") {
      throw new Error(
        `engine moment ${String(row.path)} carries text payload ${String(row.sha)}, ` +
          "but blobs holds no row for that digest: the moments->blobs join is " +
          "wrong or the store is corrupt.",
      );
    }
    return {
      path: String(row.path),
      operation: String(row.operation),
      text: row.text,
      summary: typeof row.summary === "string" ? row.summary : null,
    };
  });
}

export function engineMomentsOrEmpty(rootPath: string): EngineMoment[] {
  return withEngineDb(rootPath, (db) => readMoments(db)) ?? [];
}

// The projected settle-moment texts for one path (settle points are engine
// history) — moment payloads reference text by blob sha, so the moment→blob
// join is how the content is read.
export function momentTextsForPath(rootPath: string, path: string): string[] {
  return (
    withEngineDb(rootPath, (db) => readMoments(db, path).map((moment) => moment.text)) ?? []
  );
}

// Does the engine still hold a HEAD for this path in the active version? A
// retirement (deleteIfTracked) removes the snapshot row, so this goes false
// the moment a reconcile pass decides the path is no longer engine-ownable.
export function textFileTrackedByEngine(rootPath: string, path: string): boolean {
  return (
    withEngineDb(rootPath, (db) => {
      // No join on active_versions: that table only gains a row once a
      // version is explicitly switched, so joining it reports "untracked"
      // for every ordinary single-version workspace.
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM snapshots WHERE path = ?")
        .get(path) as { n: number } | undefined;
      return Number(row?.n ?? 0) > 0;
    }) ?? false
  );
}

// Replication ops whose payload carries the given plaintext needle, grouped by
// op_kind. A ydoc.update payload is opaque Yjs binary (plaintext is not
// searchable), so the only way typed plaintext lands in a replication op is a
// moment.append — this list therefore proves whether a double-journal happened.
export function replicationOpKindsMentioning(rootPath: string, needle: string): string[] {
  return (
    withEngineDb(rootPath, (db) => {
      const rows = db
        .prepare("SELECT op_kind AS opKind, payload_json AS payload FROM replication_log")
        .all() as Array<{ opKind: string; payload: string }>;
      return rows
        .filter((row) => typeof row.payload === "string" && row.payload.includes(needle))
        .map((row) => row.opKind);
    }) ?? []
  );
}

/** Where one path's live document stands against its last compaction. Read-only. */
export interface LiveDocumentFold {
  regime: string;
  head: number;
  snapshot: number;
  // The newest stored snapshot row, and the journaled updates it should have pruned.
  snapshotRow: number | null;
  updatesAtOrBelowSnapshot: number;
}

// A compaction writes a snapshot row up to the head, moves head_snapshot_seq to
// it and prunes every update it folded (durable.rs `maybe_compact`).
export function liveDocumentFold(rootPath: string, path: string): LiveDocumentFold | null {
  return withEngineDb(rootPath, (db) => {
    const rows = db.prepare(`SELECT workspace_id, version_id, object_id, regime, head_update_seq AS head, head_snapshot_seq AS snapshot
      FROM ydoc_docs WHERE path = ?`).all(path);
    if (rows.length > 1) throw new Error(`engine.db holds ${rows.length} live documents at ${path}.`);
    const row = rows[0];
    if (!row) return null;
    const key = [row.workspace_id, row.version_id, row.object_id];
    const snapshotRow = db.prepare(`SELECT MAX(up_to_seq) AS seq FROM ydoc_snapshots
      WHERE workspace_id = ? AND version_id = ? AND object_id = ?`).get(...key)?.seq;
    const folded = db.prepare(`SELECT COUNT(*) AS n FROM ydoc_updates
      WHERE workspace_id = ? AND version_id = ? AND object_id = ? AND seq <= ?`).get(...key, row.snapshot)?.n;
    return {
      regime: String(row.regime), head: Number(row.head), snapshot: Number(row.snapshot),
      snapshotRow: snapshotRow === null || snapshotRow === undefined ? null : Number(snapshotRow),
      updatesAtOrBelowSnapshot: Number(folded ?? 0),
    };
  });
}

// The fixture document is small. A record past this bound is not one this test wrote.
const MAX_AUDIT_RECORD_BYTES = 1024 * 1024;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** One accepted change's durable audit record, with every stored length and hash verified before it is parsed. */
export interface LiveAuditRecord {
  namespace: string;
  eventCount: number;
  evidenceDigest: string;
  journalCursor: number;
  deliveryId: string;
  acceptingHostEpoch: number;
  recordDigest: string;
  authorSnapshot: LiveAuthorSnapshot;
  accepted: {
    receipt: { deliveryId: string; updateDigest: string; journalCursor: number; acceptingHostEpoch: number };
    binding: { restoreFenceGeneration: number; currentPath: string };
    authority: { principalKind: string; principalId: string };
  };
}

/** Reads from an owner's imported audit or the service host's own. Read-only; it never repairs a record. */
export function readLiveAuditRecord(db: Pick<EngineDb, "prepare">, deliveryId: string): LiveAuditRecord | null {
  const events = db.prepare(`SELECT relay_database_namespace AS namespace, event_count, evidence_digest, journal_cursor,
      delivery_id, accepting_host_epoch, record_digest FROM live_audit_events WHERE delivery_id = ?`).all(deliveryId);
  if (events.length > 1) throw new Error(`Audit holds ${events.length} events for delivery ${deliveryId}.`);
  const event = events[0];
  if (!event) return null;
  const recordDigest = String(event.record_digest);
  const manifestRow = db.prepare("SELECT manifest_json FROM live_audit_record_manifests WHERE record_digest = ?").get(recordDigest);
  if (!manifestRow) throw new Error(`Audit event ${deliveryId} has no record manifest.`);
  const manifest = JSON.parse(String(manifestRow.manifest_json)) as {
    formatVersion: number; recordDigest: string; byteLength: number; chunks: { sha256: string; byteLength: number }[];
  };
  if (manifest.formatVersion !== 1 || manifest.recordDigest !== recordDigest || manifest.byteLength > MAX_AUDIT_RECORD_BYTES) {
    throw new Error(`Audit record ${recordDigest} is not a bounded version 1 record.`);
  }
  const stored = db.prepare("SELECT ordinal, chunk_sha256 FROM live_audit_record_chunks WHERE record_digest = ? ORDER BY ordinal").all(recordDigest);
  if (stored.length !== manifest.chunks.length) throw new Error(`Audit record ${recordDigest} has ${stored.length} of ${manifest.chunks.length} chunks.`);
  const parts = manifest.chunks.map((chunk, ordinal) => {
    const row = stored[ordinal]!;
    if (Number(row.ordinal) !== ordinal || row.chunk_sha256 !== chunk.sha256) throw new Error(`Audit chunk ${ordinal} of ${recordDigest} differs from its manifest.`);
    const blob = db.prepare("SELECT bytes FROM binary_blobs WHERE sha256 = ?").get(chunk.sha256)?.bytes;
    if (!(blob instanceof Uint8Array) || blob.byteLength !== chunk.byteLength || sha256(blob) !== chunk.sha256) {
      throw new Error(`Audit chunk ${ordinal} of ${recordDigest} is missing or damaged.`);
    }
    return blob;
  });
  const bytes = Buffer.concat(parts);
  if (bytes.byteLength !== manifest.byteLength || sha256(bytes) !== recordDigest) throw new Error(`Audit record ${recordDigest} does not match its digest.`);
  const record = JSON.parse(bytes.toString("utf8")) as { metadata?: { accepted?: LiveAuditRecord["accepted"]; authorSnapshot?: LiveAuthorSnapshot } };
  const accepted = record.metadata?.accepted;
  if (!accepted || accepted.receipt.deliveryId !== deliveryId) throw new Error(`Audit record ${recordDigest} names another delivery.`);
  return {
    namespace: String(event.namespace), eventCount: Number(event.event_count), evidenceDigest: String(event.evidence_digest),
    journalCursor: Number(event.journal_cursor), deliveryId, acceptingHostEpoch: Number(event.accepting_host_epoch), recordDigest, accepted, authorSnapshot: parseLiveAuthorSnapshot(record.metadata?.authorSnapshot ?? []),
  };
}

// Failure evidence only: how many changes this owner queued for the server,
// how many still wait, and how many declared an agent. Its columns are newer
// than the read gate above, so a store without them reports the error instead.
export function ownerOutboxDeclarations(rootPath: string): { entries: number; pending: number; declared: number } | { error: string } | null {
  try {
    return withEngineDb(rootPath, (db) => {
      const row = db.prepare(`SELECT COUNT(*) AS entries, COALESCE(SUM(pending), 0) AS pending,
        COUNT(agent_declaration_json) AS declared FROM owner_ydoc_outbox_entries`).get();
      return { entries: Number(row?.entries ?? 0), pending: Number(row?.pending ?? 0), declared: Number(row?.declared ?? 0) };
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// The owner's imported copy of one accepted change's audit record.
export function ownerAuditRecord(rootPath: string, deliveryId: string): LiveAuditRecord | null {
  return withEngineDb(rootPath, (db) => readLiveAuditRecord(db, deliveryId));
}

// The last operation this engine applied from each service host origin of the workspace.
export function appliedServiceHostSeqs(rootPath: string, workspaceId: string): Record<string, number> {
  return withEngineDb(rootPath, (db) => Object.fromEntries(db
    .prepare("SELECT origin_id, acked_seq FROM replication_peers WHERE workspace_id=? AND origin_id LIKE 'service-host:%'")
    .all(workspaceId)
    .map((row) => [String(row.origin_id), Number(row.acked_seq)]))) ?? {};
}

// Each update the engine refused for the workspace's Notices, with its own reason.
// A Notices row shows only one reason for all the refusals it folds together.
export function noticedRefusals(rootPath: string, workspaceId: string): { originId: string; originSeq: number; reason: string }[] {
  return withEngineDb(rootPath, (db) => db
    .prepare("SELECT origin_id, origin_seq, reason_message FROM replication_pending_refusals WHERE workspace_id=? AND COALESCE(report_id,'') != 'direct-rpc'")
    .all(workspaceId)
    .map((row) => ({ originId: String(row.origin_id), originSeq: Number(row.origin_seq), reason: String(row.reason_message) }))) ?? [];
}

export function replicationOpKindCount(rootPath: string, opKind: string): number {
  return (
    withEngineDb(rootPath, (db) => {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM replication_log WHERE op_kind = ?")
        .get(opKind) as { n: number } | undefined;
      return Number(row?.n ?? 0);
    }) ?? 0
  );
}

/** The committed ordinary pull position and native kept-copy records. Read-only. */
export function outsideWriteRecoveryState(rootPath: string, workspaceId: string) {
  return withEngineDb(rootPath, db => ({
    pull: db.prepare("SELECT * FROM sync_relay_cursors WHERE workspace_id = ?").all(workspaceId),
    displacements: db.prepare("SELECT * FROM materialization_displacements WHERE workspace_id = ?").all(workspaceId),
    retained: db.prepare("SELECT * FROM materialization_retained WHERE workspace_id = ?").all(workspaceId),
  }));
}

export function outsideCopyPushed(rootPath: string, workspaceId: string, path: string): boolean {
  return withEngineDb(rootPath, db => {
    const row = db.prepare(`SELECT EXISTS(SELECT 1 FROM replication_log l
      JOIN sync_relay_push_state p ON p.workspace_id=l.workspace_id AND p.origin_id=l.origin_id
      WHERE l.workspace_id=? AND l.imported=0 AND l.op_kind='moment.append'
      AND json_extract(l.payload_json,'$.path')=? AND p.pushed_seq >= l.origin_seq) AS pushed`).get(workspaceId, path);
    return Number(row?.pushed) === 1;
  }) ?? false;
}
