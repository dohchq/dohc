// WS-G2-B — the Y.Doc engine content driver.
//
// A rich doc's canonical state, while a session is LIVE, is a Y.Doc persisted
// in `.dohc/engine/engine.db` beside the versioned text store; the settled .md
// file on disk is its PROJECTION. This module ports the storage + projection
// shapes the legacy Hocuspocus stack proved (sequential update log + periodic
// full-state snapshots, services/hocuspocus/src/persistence.ts) onto engine.db,
// content-addressing every update/snapshot blob into `binary_blobs` exactly
// like every other engine artifact.
//
// REPLICATION SCOPE (G2-B): these ydoc_* blobs are LOCAL-ONLY today — NO
// replication op references them, so they do NOT ride the 0P relay yet. The
// content-addressed layout means G2-C can add an `ydoc.update` replication op
// and get dedup/transport for free, but until that ships a Y.Doc replicates
// only via its settled .md (markdown-is-the-artifact). The blob GC must still
// treat a blob referenced by a live ydoc_updates/ydoc_snapshots row as a ROOT
// (see engineDbSchema.ts ENGINE_YDOC_DDL) so local resume state is never
// collected out from under a live head.
//
// SINGLE-WRITER SAFETY: every engine.db WRITE this driver makes (blob puts,
// update/snapshot rows, head pointers) is routed through the store's engine
// write lane (VersionedTextStore.runInEngineWriteLane) so it shares the store's
// connection, serialized queue, and single BEGIN IMMEDIATE. A settle
// (writeTextFile) and a Y.Doc update-append therefore can never hold two
// concurrent in-process write transactions — node:sqlite busy-waits block the
// JS thread, so two same-process writers on separate connections would deadlock
// until busy_timeout. The driver keeps its own connection for READS only (WAL
// readers never block a writer).
//
// BINDING DECISION — MARKDOWN-IS-THE-ARTIFACT: the settled .md is the durable,
// searchable, restorable, diffable artifact of record. Full Y.Doc CRDT state is
// NOT persisted past a closed session (the update log is a fast-resume cache; a
// closed session prunes it and reopening reseeds from the file with zero loss).
// The storage is nonetheless ADDITIVE-COMPATIBLE with a future persistent-
// threads layer: flip `persistClosedSessionState` and close keeps the CRDT
// bytes durable — no schema change (see engineDbSchema.ts ENGINE_YDOC_DDL).
//
// SINGLE-CANONICAL HANDOFF (never two canonical at once): at any instant a rich
// doc has exactly one canonical source. Closed -> the file is canonical; live
// (session open) -> the Y.Doc is canonical and the file is its projection. The
// flip file->Y.Doc happens on session OPEN (seed from the current file, never a
// stale cache); Y.Doc->file happens on session CLOSE (settle then teardown).
// The invariant is enforced STRUCTURALLY: one live session per object, keyed by
// objectId (not version), so a version switch of the same object must close
// (settle) the live session first — never two live Y.Docs for two versions of
// one object.
//
// SCOPE: substrate only. No editor/renderer binding (the provider swap is
// G2-C). The methods here are what a future engine provider will drive.

import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import {
  markdownToYDoc,
  plainTextToYDoc,
  yDocToMarkdown,
} from "@dohc/ydoc-projection";
import { mergeMarkdown } from "@dohc/workspace-core/mergeMarkdown";
import type {
  ActorNeutralWriteMetadata,
  EngineWriteLaneConnection,
  VersionedTextStore,
  VersionId,
  VersionedTextMomentId,
  WorkspaceId,
  WorkspaceObjectId,
} from "@dohc/workspace-contracts/engine";
import {
  ENGINE_SQLITE_BUSY_TIMEOUT_MS,
  assertEngineSqliteIntegrity,
  assertRequiredEngineTables,
  trackEngineDbHandleForTest,
} from "./engineDbSchema";
import { canonicalEngineDbPath } from "./versionedTextStore";

export type YDocContentKind = "richdoc" | "plaintext";

export class YDocEngineDriverError extends Error {
  readonly code: YDocEngineDriverErrorCode;
  constructor(code: YDocEngineDriverErrorCode, message: string) {
    super(message);
    this.name = "YDocEngineDriverError";
    this.code = code;
  }
}

export type YDocEngineDriverErrorCode =
  | "state-corrupt"
  | "not-found"
  | "already-live"
  | "session-closed"
  | "invalid-input";

// ---- Sqlite seam (mirrors versionedTextStore / linkedChatStore) ------------

interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number };
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  readonly isOpen?: boolean;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb;
}

const requireModule = createRequire(import.meta.url);

function nodeSqlite(): SqliteModule {
  return requireModule("node:sqlite") as SqliteModule;
}

function corruptStore(cause?: unknown): YDocEngineDriverError {
  const error = new YDocEngineDriverError("state-corrupt", "Y.Doc engine store is corrupt.");
  if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

// READS-ONLY driver connection (single-writer safety). The store is the SOLE
// schema + write owner: it creates engine.db and every table (including the
// lazy-additive ydoc_* tables) on its own connection under one BEGIN IMMEDIATE.
// This driver handle is opened SQLITE_OPEN_READONLY so it can never run DDL, set
// journal_mode, or take a write lock — a lazy open on a fresh schema must not
// reintroduce a second write connection that could deadlock the store's writer.
// Returns null when engine.db does not exist yet: the store has not initialized
// it, so there are no ydoc_* rows to read (creating it here would be a write).
function openReadOnlyDatabase(rootDir: string): SqliteDb | null {
  const path = canonicalEngineDbPath(rootDir);
  if (!existsSync(path)) return null;
  const { DatabaseSync } = nodeSqlite();
  let db: SqliteDb;
  try {
    db = trackEngineDbHandleForTest(new DatabaseSync(path, { readOnly: true }));
  } catch (error) {
    throw corruptStore(error);
  }
  try {
    // busy_timeout is a connection setting (safe on a read-only handle); we do
    // NOT set journal_mode (a WAL switch is a write) or run schema DDL here.
    db.exec(`PRAGMA busy_timeout = ${ENGINE_SQLITE_BUSY_TIMEOUT_MS}`);
    // Read-only validation only: assert the store already created a valid engine
    // schema and quick_check for corruption. Both are pure reads — no DDL, no
    // write lock. The ydoc_* tables are lazy-additive, so the store's open
    // (which always runs ENGINE_YDOC_DDL) must precede any driver read.
    assertRequiredEngineTables(db, corruptStore);
    assertEngineSqliteIntegrity(db, corruptStore);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {}
    if (error instanceof YDocEngineDriverError) throw error;
    throw corruptStore(error);
  }
}

// ---- content-addressed blob helpers ----------------------------------------

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Both blob helpers take the minimal EngineWriteLaneConnection surface so they
// serve either the driver's own read connection (SqliteDb, structurally wider)
// or the shared write-lane connection the store hands the task.
function putYDocBlob(db: EngineWriteLaneConnection, bytes: Uint8Array): string {
  const content = Buffer.from(bytes);
  const sha256 = sha256Bytes(content);
  db.prepare(
    "INSERT OR IGNORE INTO binary_blobs (sha256, byte_length, content) VALUES (?, ?, ?)",
  ).run(sha256, content.byteLength, content);
  return sha256;
}

function readYDocBlob(db: EngineWriteLaneConnection, sha256: string): Uint8Array {
  const row = db
    .prepare("SELECT content, byte_length FROM binary_blobs WHERE sha256 = ?")
    .get(sha256);
  const content = row?.content;
  if (!(content instanceof Uint8Array) && !Buffer.isBuffer(content)) throw corruptStore();
  const bytes = new Uint8Array(content as Uint8Array);
  // Blob-integrity posture (matches the relay/blob path): the row is keyed by a
  // sha, but a corrupt/poisoned binary_blobs row could carry bytes that do NOT
  // hash to that sha. Reconstructing CRDT state from unverified bytes would
  // silently diverge the doc, so verify the digest (and byte_length) on read.
  if (bytes.byteLength !== Number(row?.byte_length)) throw corruptStore();
  if (sha256Bytes(bytes) !== sha256) throw corruptStore();
  return bytes;
}

// ---- public shapes ---------------------------------------------------------

export interface YDocDocKey {
  workspaceId: WorkspaceId;
  versionId: VersionId;
  objectId: WorkspaceObjectId;
}

export interface YDocSettleResult {
  momentId: VersionedTextMomentId;
  path: string;
  markdown: string;
  sha256: string;
}

export type YDocExternalEditResult =
  | { kind: "merged"; markdown: string }
  | { kind: "conflict"; conflictPath: string };

export interface YDocSession {
  readonly workspaceId: WorkspaceId;
  readonly versionId: VersionId;
  readonly objectId: WorkspaceObjectId;
  readonly path: string;
  readonly contentKind: YDocContentKind;
  // The live Y.Doc. Canonical while the session is open.
  readonly doc: Y.Doc;
  // Always "ydoc" while live — the file is a projection until close.
  canonicalSource(): "ydoc";
  // Persist one Yjs update (content-addressed into binary_blobs + an
  // ydoc_updates row), advancing the head. Triggers compaction past threshold.
  recordUpdate(
    update: Uint8Array,
    opts?: { actorOriginId?: string },
  ): Promise<{ seq: number }>;
  // Project the current Y.Doc to markdown and write it through the normal
  // engine text path — capture records ONE ordinary moment (WS-G2 rule 2:
  // engine history is settle points, not keystrokes).
  settle(opts?: { summary?: string }): Promise<YDocSettleResult>;
  // Fold an external markdown edit (restore/agent write) into the live doc via
  // three-way merge on the projection; overlap preserves both (`.conflict`).
  applyExternalMarkdownEdit(input: {
    markdown: string;
  }): Promise<YDocExternalEditResult>;
  // True if `sha256` is the content the last settle wrote (self-write
  // suppression: the watcher event for our own projection is recognized).
  isSelfMaterializedSha(sha256: string): boolean;
  // Flip Y.Doc -> file: settle (unless already quiesced) then tear down. Prunes
  // the CRDT log unless persistClosedSessionState is set (markdown-is-artifact).
  close(opts?: { settle?: boolean; summary?: string }): Promise<void>;
}

export interface YDocEngineDriver {
  openSession(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
    contentKind?: YDocContentKind;
  }): Promise<YDocSession>;
  // "file" when no live session (file is canonical); "ydoc" while a session is
  // live for this object (the Y.Doc is canonical, the file is its projection).
  canonicalSourceFor(input: {
    workspaceId: WorkspaceId;
    objectId: WorkspaceObjectId;
  }): "file" | "ydoc";
  // Does this object carry the driver marker (ydoc_docs row)? A file WITHOUT
  // one is an ordinary text file — the engine projects nothing, patches
  // markdown directly, zero behavior change.
  isYDocDriven(input: YDocDocKey): boolean;
  // Reconstruct the persisted Y.Doc from its latest snapshot + trailing update
  // log (the crash-resume / storage-proof path). Null if no marker row.
  loadPersistedDoc(input: YDocDocKey): Y.Doc | null;
  close(): Promise<void>;
}

export interface YDocEngineDriverOptions {
  store: VersionedTextStore;
  rootDir: string;
  nowMs?: () => number;
  createMomentId?: () => VersionedTextMomentId;
  // Fold the append-only update log into a full-state snapshot (and prune the
  // folded updates) once this many updates accumulate past the latest
  // snapshot. The legacy Hocuspocus stack NEVER compacted; the engine driver
  // must (design Risk 3).
  compactionThreshold?: number;
  // MARKDOWN-IS-THE-ARTIFACT default false: a closed session prunes its CRDT
  // bytes. Flip to true for a future persistent-threads layer (no schema
  // change) so suggestion threads / marks survive a close.
  persistClosedSessionState?: boolean;
  // TEST-ONLY seam. Invoked once inside openSession AFTER the global reservation
  // is taken and the persisted state is reset, but BEFORE the live session is
  // installed. Lets a test simulate a mid-open failure in a later step and prove
  // the reservation is released (never stranded "live") on ANY throw. Undefined
  // in production.
  onAfterReserveForTest?: () => void;
}

const DEFAULT_COMPACTION_THRESHOLD = 64;

// PROCESS-GLOBAL single-canonical reservation. The single-canonical invariant
// ("never two live Y.Docs for one object") must hold across EVERY driver
// instance in the process, not just within one createYDocEngineDriver() — two
// drivers on the same engine.db each with their own in-memory map would both be
// free to open the same object (even under different versions) and race
// resets/appends/settles against the same persisted keys. This module-level set
// is keyed by the normalized engine.db path + workspace + object (version is
// deliberately excluded: a version switch of one object must close first), so a
// second openSession for that object from ANY instance throws already-live.
const globalLiveYDocReservations = new Set<string>();

// ---- driver ----------------------------------------------------------------

export function createYDocEngineDriver(
  options: YDocEngineDriverOptions,
): YDocEngineDriver {
  const { store, rootDir } = options;
  // The Y.Doc driver REQUIRES the store's serialized engine write lane so its
  // writes can never open a second concurrent in-process write transaction
  // (see the SINGLE-WRITER SAFETY note above). The real createVersionedTextStore
  // always provides it; fail loud if handed a store that does not.
  const boundWriteLane = store.runInEngineWriteLane?.bind(store);
  if (!boundWriteLane) {
    throw new YDocEngineDriverError(
      "invalid-input",
      "VersionedTextStore does not expose runInEngineWriteLane; the Y.Doc driver requires it for single-writer safety.",
    );
  }
  // Rebind to a non-optional const so nested write helpers (closures) see the
  // narrowed, definitely-present type rather than the optional interface member.
  const runInWriteLane = boundWriteLane;
  // Canonical (symlink/alias-resolved) engine.db identity: two drivers whose
  // rootDirs point at the SAME physical engine.db (via a symlink or case alias)
  // must share ONE reservation namespace, or each would be free to open the same
  // object and race two live Y.Docs. Keying by resolve() alone (lexical) would
  // hand each a private namespace and defeat single-canonical. This MUST match
  // the store's storeWriteChains key so a store and a driver on one physical DB
  // agree on identity.
  const enginePath = canonicalEngineDbPath(rootDir);
  const globalReservationKey = (
    workspaceId: WorkspaceId,
    objectId: WorkspaceObjectId,
  ) => `${enginePath} ${workspaceId} ${objectId}`;
  const nowMs = options.nowMs ?? (() => Date.now());
  const createMomentId =
    options.createMomentId ?? (() => randomUUID() as VersionedTextMomentId);
  const compactionThreshold = Math.max(
    1,
    options.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
  );
  const persistClosedSessionState = options.persistClosedSessionState === true;

  let dbHandle: SqliteDb | null = null;
  // Read-only handle onto the store-owned engine.db. Null when the store has not
  // created the DB yet (fresh workspace) — there are no ydoc_* rows to read and
  // the driver must NOT create the file (that would be a write on a second
  // connection). Callers treat null as "no ydoc state".
  function readDb(): SqliteDb | null {
    if (dbHandle && dbHandle.isOpen !== false) return dbHandle;
    dbHandle = openReadOnlyDatabase(rootDir);
    return dbHandle;
  }

  // Single-canonical registry: one live session per (workspace, object). The
  // key deliberately omits version so a version switch of the SAME object must
  // close the live session first (never two live Y.Docs for two versions).
  const liveSessions = new Map<string, YDocSession>();
  const liveKey = (workspaceId: WorkspaceId, objectId: WorkspaceObjectId) =>
    `${workspaceId} ${objectId}`;

  function projectMarkdown(doc: Y.Doc, contentKind: YDocContentKind): string {
    // plainText docs already store their body as Y.Text; yDocToMarkdown reads
    // the plain-text field when meta.contentKind is plain-text, so a single
    // projection call is correct for both kinds.
    void contentKind;
    return yDocToMarkdown(doc);
  }

  function seedDoc(markdown: string, contentKind: YDocContentKind): Y.Doc {
    return contentKind === "plaintext"
      ? plainTextToYDoc(markdown)
      : markdownToYDoc(markdown);
  }

  function readDocRow(key: YDocDocKey):
    | { contentKind: YDocContentKind; headUpdateSeq: number; headSnapshotSeq: number }
    | null {
    const handle = readDb();
    if (!handle) return null;
    const row = handle
      .prepare(
        `SELECT content_kind, head_update_seq, head_snapshot_seq
           FROM ydoc_docs
          WHERE workspace_id = ? AND version_id = ? AND object_id = ?`,
      )
      .get(key.workspaceId, key.versionId, key.objectId);
    if (!row) return null;
    return {
      contentKind: row.content_kind === "plaintext" ? "plaintext" : "richdoc",
      headUpdateSeq: Number(row.head_update_seq),
      headSnapshotSeq: Number(row.head_snapshot_seq),
    };
  }

  function loadPersistedDoc(key: YDocDocKey): Y.Doc | null {
    const marker = readDocRow(key);
    if (!marker) return null;
    // readDocRow returned a marker, so the store-owned engine.db exists and the
    // read handle is open; capture it once for the snapshot + update reads.
    const handle = readDb();
    if (!handle) return null;
    const doc = new Y.Doc();
    const snapshotRow = handle
      .prepare(
        `SELECT up_to_seq, snapshot_blob_sha256
           FROM ydoc_snapshots
          WHERE workspace_id = ? AND version_id = ? AND object_id = ?
          ORDER BY up_to_seq DESC
          LIMIT 1`,
      )
      .get(key.workspaceId, key.versionId, key.objectId);
    let fromSeq = 0;
    let applied = false;
    if (snapshotRow) {
      Y.applyUpdate(doc, readYDocBlob(handle, String(snapshotRow.snapshot_blob_sha256)));
      fromSeq = Number(snapshotRow.up_to_seq);
      applied = true;
    }
    const updates = handle
      .prepare(
        `SELECT update_blob_sha256
           FROM ydoc_updates
          WHERE workspace_id = ? AND version_id = ? AND object_id = ? AND seq > ?
          ORDER BY seq ASC`,
      )
      .all(key.workspaceId, key.versionId, key.objectId, fromSeq);
    for (const u of updates) {
      Y.applyUpdate(doc, readYDocBlob(handle, String(u.update_blob_sha256)));
      applied = true;
    }
    // MARKER-ONLY (never a blank doc as content): a default close prunes all
    // snapshots/updates but keeps the tiny ydoc_docs marker ("this file is a
    // rich doc; project, don't patch"). With NO persisted CRDT state the doc
    // would be blank — returning it would let isYDocDriven()+loadPersistedDoc()
    // treat empty CRDT as canonical content. Signal "seed from the file"
    // instead: closed => the .md is canonical (markdown-is-the-artifact).
    if (!applied) return null;
    return doc;
  }

  // All engine.db WRITES go through the store's serialized lane on the store's
  // connection so they can never open a second concurrent write transaction
  // (single-writer safety). The task runs INSIDE the store's BEGIN IMMEDIATE —
  // no local BEGIN/COMMIT; a throw rolls the whole lane transaction back. Any
  // throw is surfaced as a corrupt-store error for callers.
  async function writeLane(task: (conn: EngineWriteLaneConnection) => void): Promise<void> {
    try {
      await runInWriteLane(task);
    } catch (error) {
      if (error instanceof YDocEngineDriverError) throw error;
      throw corruptStore(error);
    }
  }

  // Fold the update log into a fresh full-state snapshot and prune everything
  // it covers, keeping loadPersistedDoc byte-identical across the fold.
  async function compact(key: YDocDocKey): Promise<void> {
    const marker = readDocRow(key);
    if (!marker) return;
    if (marker.headUpdateSeq - marker.headSnapshotSeq < compactionThreshold) return;
    const doc = loadPersistedDoc(key);
    if (!doc) return;
    const upToSeq = marker.headUpdateSeq;
    const snapshotBytes = Y.encodeStateAsUpdate(doc);
    const stateVectorBytes = Y.encodeStateVector(doc);
    const now = nowMs();
    await writeLane((conn) => {
      const snapshotSha = putYDocBlob(conn, snapshotBytes);
      const stateVectorSha = putYDocBlob(conn, stateVectorBytes);
      conn
        .prepare(
          `INSERT OR REPLACE INTO ydoc_snapshots
             (workspace_id, version_id, object_id, up_to_seq,
              snapshot_blob_sha256, state_vector_blob_sha256, recorded_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          key.workspaceId,
          key.versionId,
          key.objectId,
          upToSeq,
          snapshotSha,
          stateVectorSha,
          now,
        );
      // Prune folded updates and now-superseded older snapshots.
      conn
        .prepare(
          `DELETE FROM ydoc_updates
            WHERE workspace_id = ? AND version_id = ? AND object_id = ? AND seq <= ?`,
        )
        .run(key.workspaceId, key.versionId, key.objectId, upToSeq);
      conn
        .prepare(
          `DELETE FROM ydoc_snapshots
            WHERE workspace_id = ? AND version_id = ? AND object_id = ? AND up_to_seq < ?`,
        )
        .run(key.workspaceId, key.versionId, key.objectId, upToSeq);
      conn
        .prepare(
          `UPDATE ydoc_docs SET head_snapshot_seq = ?, updated_at_ms = ?
            WHERE workspace_id = ? AND version_id = ? AND object_id = ?`,
        )
        .run(upToSeq, now, key.workspaceId, key.versionId, key.objectId);
    });
  }

  // Reset the persisted log for a key to a single base snapshot of `doc`. Used
  // on open (trust the file: the prior log is dead) and after a merge reseed.
  async function resetPersistedState(
    key: YDocDocKey,
    contentKind: YDocContentKind,
    doc: Y.Doc,
  ): Promise<void> {
    const snapshotBytes = Y.encodeStateAsUpdate(doc);
    const stateVectorBytes = Y.encodeStateVector(doc);
    const now = nowMs();
    await writeLane((conn) => {
      const snapshotSha = putYDocBlob(conn, snapshotBytes);
      const stateVectorSha = putYDocBlob(conn, stateVectorBytes);
      // Upsert the ydoc_docs marker FIRST: ydoc_snapshots/ydoc_updates carry an
      // ON DELETE CASCADE FK to ydoc_docs, so the parent marker row must exist
      // before the base snapshot row references it (immediate FK enforcement).
      conn
        .prepare(
          `INSERT INTO ydoc_docs
             (workspace_id, version_id, object_id, content_kind,
              head_update_seq, head_snapshot_seq, updated_at_ms)
           VALUES (?, ?, ?, ?, 0, 0, ?)
           ON CONFLICT(workspace_id, version_id, object_id) DO UPDATE SET
             content_kind = excluded.content_kind,
             head_update_seq = 0,
             head_snapshot_seq = 0,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(key.workspaceId, key.versionId, key.objectId, contentKind, now);
      conn
        .prepare(
          `DELETE FROM ydoc_updates
            WHERE workspace_id = ? AND version_id = ? AND object_id = ?`,
        )
        .run(key.workspaceId, key.versionId, key.objectId);
      conn
        .prepare(
          `DELETE FROM ydoc_snapshots
            WHERE workspace_id = ? AND version_id = ? AND object_id = ?`,
        )
        .run(key.workspaceId, key.versionId, key.objectId);
      conn
        .prepare(
          `INSERT INTO ydoc_snapshots
             (workspace_id, version_id, object_id, up_to_seq,
              snapshot_blob_sha256, state_vector_blob_sha256, recorded_at_ms)
           VALUES (?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(key.workspaceId, key.versionId, key.objectId, snapshotSha, stateVectorSha, now);
    });
  }

  async function pruneClosedState(key: YDocDocKey): Promise<void> {
    await writeLane((conn) => {
      conn
        .prepare(
          `DELETE FROM ydoc_updates WHERE workspace_id = ? AND version_id = ? AND object_id = ?`,
        )
        .run(key.workspaceId, key.versionId, key.objectId);
      conn
        .prepare(
          `DELETE FROM ydoc_snapshots WHERE workspace_id = ? AND version_id = ? AND object_id = ?`,
        )
        .run(key.workspaceId, key.versionId, key.objectId);
      // Keep the tiny ydoc_docs marker (this file is a rich doc — "project,
      // don't patch") but zero its head pointers: it is metadata, NOT the
      // forbidden persisted CRDT state.
      conn
        .prepare(
          `UPDATE ydoc_docs SET head_update_seq = 0, head_snapshot_seq = 0, updated_at_ms = ?
            WHERE workspace_id = ? AND version_id = ? AND object_id = ?`,
        )
        .run(nowMs(), key.workspaceId, key.versionId, key.objectId);
    });
  }

  const writeMetadata = (
    origin: ActorNeutralWriteMetadata["origin"],
    summary?: string,
  ): ActorNeutralWriteMetadata => ({
    origin,
    ...(summary !== undefined ? { summary } : {}),
  });

  return {
    canonicalSourceFor({ workspaceId, objectId }) {
      // Process-global: an object is canonical-ydoc if ANY driver instance holds
      // a live session for it, matching the reservation that guards openSession.
      return globalLiveYDocReservations.has(globalReservationKey(workspaceId, objectId))
        ? "ydoc"
        : "file";
    },

    isYDocDriven(key) {
      return readDocRow(key) !== null;
    },

    loadPersistedDoc(key) {
      return loadPersistedDoc(key);
    },

    async openSession({ workspaceId, versionId, path, contentKind }) {
      const snapshot = await store.readTextFile({ workspaceId, versionId, path });
      if (!snapshot) {
        throw new YDocEngineDriverError(
          "not-found",
          `Cannot open a Y.Doc session for a file that does not exist: ${path}`,
        );
      }
      const objectId = snapshot.objectId;
      const registryKey = liveKey(workspaceId, objectId);
      const reservationKey = globalReservationKey(workspaceId, objectId);
      // PROCESS-GLOBAL single-canonical guard (re-check + reserve before any
      // open/reset): a live Y.Doc for this object may be owned by THIS driver OR
      // ANOTHER createYDocEngineDriver() instance on the same engine.db, possibly
      // under a different version. Refuse a second — a version switch is a
      // closed-session boundary; never two live Y.Docs for one object.
      if (globalLiveYDocReservations.has(reservationKey)) {
        throw new YDocEngineDriverError(
          "already-live",
          `Object ${objectId} already has a live Y.Doc session; close it before opening another (single-canonical).`,
        );
      }
      const kind: YDocContentKind = contentKind ?? "richdoc";
      const key: YDocDocKey = { workspaceId, versionId, objectId };

      // Flip file -> Y.Doc: seed from the CURRENT file, never a stale cache.
      const doc = seedDoc(snapshot.text, kind);
      // Reserve BEFORE the reset write so a concurrent open for the same object
      // (any instance) loses the race here, not after clobbering the log.
      globalLiveYDocReservations.add(reservationKey);
      // Wrap the ENTIRE post-reservation open path (reset -> project -> build ->
      // register) so ANY failure before the session is fully installed releases
      // the reservation. Releasing only on a resetPersistedState throw would let
      // a throw in a LATER step (e.g. projectMarkdown) strand the object as
      // "live" forever, blocking every future openSession for it.
      let sessionInstalled = false;
      try {
        await resetPersistedState(key, kind, doc);
        // Test seam: simulate a mid-open failure AFTER the reservation is taken
        // but BEFORE the session installs, proving release-on-any-throw covers
        // the whole open path (not just the reset step).
        options.onAfterReserveForTest?.();

      // The markdown the file held at open — the three-way base for external
      // edits, and the "already quiesced" comparison for close.
      let lastSettledMarkdown = projectMarkdown(doc, kind);
      let lastSettledSha: string | null = snapshot.sha256 ?? null;
      let closed = false;

      const assertOpen = () => {
        if (closed) {
          throw new YDocEngineDriverError(
            "session-closed",
            "Y.Doc session is closed; reopen it to edit.",
          );
        }
      };

      async function doSettle(summary?: string): Promise<YDocSettleResult> {
        const markdown = projectMarkdown(doc, kind);
        const result = await store.writeTextFile({
          workspaceId,
          versionId,
          path,
          text: markdown,
          metadata: writeMetadata("local-file", summary),
        });
        lastSettledMarkdown = markdown;
        lastSettledSha = result.snapshot.sha256 ?? sha256Bytes(Buffer.from(markdown, "utf8"));
        return {
          momentId: result.moment.id,
          path,
          markdown,
          sha256: lastSettledSha,
        };
      }

      const session: YDocSession = {
        workspaceId,
        versionId,
        objectId,
        path,
        contentKind: kind,
        doc,

        canonicalSource() {
          return "ydoc";
        },

        async recordUpdate(update, opts) {
          assertOpen();
          if (update.byteLength === 0) {
            throw new YDocEngineDriverError("invalid-input", "Empty Y.Doc update.");
          }
          const now = nowMs();
          let seq = 0;
          // Blob put + head-advance run in the SAME shared write-lane
          // transaction as every store write, so an append can never race a
          // concurrent settle into a two-writer deadlock. Reading the head
          // inside the transaction keeps seq monotonic under interleaved appends.
          await writeLane((conn) => {
            const sha = putYDocBlob(conn, update);
            const head = conn
              .prepare(
                `SELECT head_update_seq FROM ydoc_docs
                  WHERE workspace_id = ? AND version_id = ? AND object_id = ?`,
              )
              .get(workspaceId, versionId, objectId);
            seq = Number(head?.head_update_seq ?? 0) + 1;
            conn
              .prepare(
                `INSERT INTO ydoc_updates
                   (workspace_id, version_id, object_id, seq,
                    update_blob_sha256, actor_origin_id, recorded_at_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                workspaceId,
                versionId,
                objectId,
                seq,
                sha,
                opts?.actorOriginId ?? null,
                now,
              );
            conn
              .prepare(
                `UPDATE ydoc_docs SET head_update_seq = ?, updated_at_ms = ?
                  WHERE workspace_id = ? AND version_id = ? AND object_id = ?`,
              )
              .run(seq, now, workspaceId, versionId, objectId);
          });
          await compact(key);
          return { seq };
        },

        async settle(opts) {
          assertOpen();
          return doSettle(opts?.summary);
        },

        async applyExternalMarkdownEdit({ markdown }) {
          assertOpen();
          const local = projectMarkdown(doc, kind);
          const merge = mergeMarkdown({
            base: lastSettledMarkdown,
            local,
            remote: markdown,
          });
          if (merge.kind === "merged") {
            // Reseed the live doc from the merged projection and reset its log
            // (markdown-is-the-artifact: the projection is the merge surface).
            const merged = seedDoc(merge.content, kind);
            replaceDocContent(doc, merged, kind);
            await resetPersistedState(key, kind, doc);
            lastSettledMarkdown = projectMarkdown(doc, kind);
            return { kind: "merged", markdown: lastSettledMarkdown };
          }
          // Overlap: preserve BOTH. The live doc keeps `local`; the incoming
          // side lands as a sibling `.conflict` projection (P0D preserve-both).
          const conflictPath = `${path}.conflict`;
          await store.writeTextFile({
            workspaceId,
            versionId,
            path: conflictPath,
            text: markdown,
            metadata: writeMetadata("local-file", "external-edit conflict (preserve-both)"),
          });
          return { kind: "conflict", conflictPath };
        },

        isSelfMaterializedSha(sha256) {
          return lastSettledSha !== null && sha256 === lastSettledSha;
        },

        async close(opts) {
          if (closed) return;
          const shouldSettle = opts?.settle !== false;
          if (shouldSettle) {
            const currentMarkdown = projectMarkdown(doc, kind);
            // Only write if the file is not already the final Y.Doc state — the
            // session-close settle trigger; avoids a redundant no-op moment.
            if (currentMarkdown !== lastSettledMarkdown || lastSettledSha === null) {
              await doSettle(opts?.summary ?? "session close");
            }
          }
          closed = true;
          liveSessions.delete(registryKey);
          globalLiveYDocReservations.delete(reservationKey);
          // Flip Y.Doc -> file. markdown-is-the-artifact: prune the CRDT bytes
          // unless a persistent-threads layer opted to keep them.
          if (persistClosedSessionState) {
            await compact(key);
          } else {
            await pruneClosedState(key);
          }
        },
      };

        liveSessions.set(registryKey, session);
        sessionInstalled = true;
        return session;
      } catch (error) {
        // Release the reservation on ANY failure before the session installed.
        // Once installed, close() owns releasing it (never double-release).
        if (!sessionInstalled) globalLiveYDocReservations.delete(reservationKey);
        throw error;
      }
    },

    async close() {
      // Do NOT auto-settle live sessions here: closing the driver handle is a
      // resource release, not a canonical flip. Callers settle/close sessions
      // explicitly. Just release the sqlite handle.
      if (dbHandle) {
        try {
          dbHandle.close();
        } catch {}
        dbHandle = null;
      }
    },
  };
}

// Replace `target`'s canonical content with `source`'s in a single
// transaction so the live doc converges to the merged state. For richdocs we
// swap the body XmlFragment; for plaintext the Y.Text. Frontmatter/meta maps
// are overwritten wholesale.
function replaceDocContent(target: Y.Doc, source: Y.Doc, kind: YDocContentKind): void {
  const merged = Y.encodeStateAsUpdate(source);
  // Clear the target by transacting a delete of its shared types, then apply
  // the source state. Simplest robust approach for substrate: build a fresh
  // doc's state and diff it in. Yjs applyUpdate is additive, so we instead
  // reset via a state reset: clear known fields then re-import.
  target.transact(() => {
    if (kind === "plaintext") {
      const text = target.getText("plainText");
      if (text.length > 0) text.delete(0, text.length);
    } else {
      const frag = target.getXmlFragment("body");
      if (frag.length > 0) frag.delete(0, frag.length);
    }
    const frontmatter = target.getMap("frontmatter");
    for (const k of [...frontmatter.keys()]) frontmatter.delete(k);
  });
  // Re-import source content into the cleared target.
  const sourceDoc = new Y.Doc();
  Y.applyUpdate(sourceDoc, merged);
  target.transact(() => {
    if (kind === "plaintext") {
      target.getText("plainText").insert(0, sourceDoc.getText("plainText").toString());
    } else {
      const targetFrag = target.getXmlFragment("body");
      const sourceFrag = sourceDoc.getXmlFragment("body");
      // The dohc prosemirror body fragment holds only XmlElement / XmlText
      // (no XmlHook nodes), so cloning covers everything the projection emits.
      const insertable = sourceFrag
        .toArray()
        .filter(
          (node): node is Y.XmlElement | Y.XmlText =>
            node instanceof Y.XmlElement || node instanceof Y.XmlText,
        )
        .map((node) => node.clone() as Y.XmlElement | Y.XmlText);
      if (insertable.length > 0) targetFrag.insert(0, insertable);
    }
    const targetFrontmatter = target.getMap("frontmatter");
    const sourceFrontmatter = sourceDoc.getMap("frontmatter");
    for (const [k, v] of sourceFrontmatter.entries()) targetFrontmatter.set(k, v);
    const targetMeta = target.getMap("meta");
    const sourceMeta = sourceDoc.getMap("meta");
    for (const [k, v] of sourceMeta.entries()) targetMeta.set(k, v);
  });
}
