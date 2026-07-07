// WS-G2-B — the Y.Doc engine content driver.
//
// A rich doc's canonical state, while a session is LIVE, is a Y.Doc persisted
// in `.dohc/engine/engine.db` beside the versioned text store; the settled .md
// file on disk is its PROJECTION. This module ports the storage + projection
// shapes the legacy Hocuspocus stack proved (sequential update log + periodic
// full-state snapshots, services/hocuspocus/src/persistence.ts) onto engine.db,
// content-addressing every update/snapshot blob into `binary_blobs` exactly
// like every other engine artifact — so the same bytes replicate over the 0P
// relay for free at G2-C.
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
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as Y from "yjs";
import {
  markdownToYDoc,
  plainTextToYDoc,
  yDocToMarkdown,
} from "@dohc/ydoc-projection";
import { mergeMarkdown } from "@dohc/workspace-core/mergeMarkdown";
import type {
  ActorNeutralWriteMetadata,
  VersionedTextStore,
  VersionId,
  VersionedTextMomentId,
  WorkspaceId,
  WorkspaceObjectId,
} from "@dohc/workspace-contracts/engine";
import {
  ENGINE_SQLITE_BUSY_TIMEOUT_MS,
  assertEngineSqliteIntegrity,
  initializeOrValidateEngineSchema,
  trackEngineDbHandleForTest,
} from "./engineDbSchema";
import { VERSIONED_TEXT_STORE_RELATIVE_PATH } from "./versionedTextStore";

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

function openDatabase(rootDir: string): SqliteDb {
  const path = join(resolve(rootDir), VERSIONED_TEXT_STORE_RELATIVE_PATH);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = nodeSqlite();
  let db: SqliteDb;
  try {
    db = trackEngineDbHandleForTest(new DatabaseSync(path));
  } catch (error) {
    throw corruptStore(error);
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${ENGINE_SQLITE_BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    // Same engine.db, same single DDL owner (engineDbSchema.ts). Opening the
    // ydoc driver on a brand-new workspace creates the identical schema the
    // text/chat stores would; opening on an existing one gains the lazy-
    // additive ydoc tables and no-ops the rest.
    initializeOrValidateEngineSchema(db, corruptStore);
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

function putYDocBlob(db: SqliteDb, bytes: Uint8Array): string {
  const content = Buffer.from(bytes);
  const sha256 = sha256Bytes(content);
  db.prepare(
    "INSERT OR IGNORE INTO binary_blobs (sha256, byte_length, content) VALUES (?, ?, ?)",
  ).run(sha256, content.byteLength, content);
  return sha256;
}

function readYDocBlob(db: SqliteDb, sha256: string): Uint8Array {
  const row = db.prepare("SELECT content FROM binary_blobs WHERE sha256 = ?").get(sha256);
  const content = row?.content;
  if (!(content instanceof Uint8Array) && !Buffer.isBuffer(content)) throw corruptStore();
  return new Uint8Array(content as Uint8Array);
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
}

const DEFAULT_COMPACTION_THRESHOLD = 64;

// ---- driver ----------------------------------------------------------------

export function createYDocEngineDriver(
  options: YDocEngineDriverOptions,
): YDocEngineDriver {
  const { store, rootDir } = options;
  const nowMs = options.nowMs ?? (() => Date.now());
  const createMomentId =
    options.createMomentId ?? (() => randomUUID() as VersionedTextMomentId);
  const compactionThreshold = Math.max(
    1,
    options.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
  );
  const persistClosedSessionState = options.persistClosedSessionState === true;

  let dbHandle: SqliteDb | null = null;
  function db(): SqliteDb {
    if (!dbHandle || dbHandle.isOpen === false) {
      dbHandle = openDatabase(rootDir);
    }
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
    const row = db()
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
    const doc = new Y.Doc();
    const snapshotRow = db()
      .prepare(
        `SELECT up_to_seq, snapshot_blob_sha256
           FROM ydoc_snapshots
          WHERE workspace_id = ? AND version_id = ? AND object_id = ?
          ORDER BY up_to_seq DESC
          LIMIT 1`,
      )
      .get(key.workspaceId, key.versionId, key.objectId);
    let fromSeq = 0;
    if (snapshotRow) {
      Y.applyUpdate(doc, readYDocBlob(db(), String(snapshotRow.snapshot_blob_sha256)));
      fromSeq = Number(snapshotRow.up_to_seq);
    }
    const updates = db()
      .prepare(
        `SELECT update_blob_sha256
           FROM ydoc_updates
          WHERE workspace_id = ? AND version_id = ? AND object_id = ? AND seq > ?
          ORDER BY seq ASC`,
      )
      .all(key.workspaceId, key.versionId, key.objectId, fromSeq);
    for (const u of updates) {
      Y.applyUpdate(doc, readYDocBlob(db(), String(u.update_blob_sha256)));
    }
    return doc;
  }

  // Fold the update log into a fresh full-state snapshot and prune everything
  // it covers, keeping loadPersistedDoc byte-identical across the fold.
  function compact(key: YDocDocKey): void {
    const marker = readDocRow(key);
    if (!marker) return;
    if (marker.headUpdateSeq - marker.headSnapshotSeq < compactionThreshold) return;
    const doc = loadPersistedDoc(key);
    if (!doc) return;
    const upToSeq = marker.headUpdateSeq;
    const snapshotSha = putYDocBlob(db(), Y.encodeStateAsUpdate(doc));
    const stateVectorSha = putYDocBlob(db(), Y.encodeStateVector(doc));
    const now = nowMs();
    const conn = db();
    conn.exec("BEGIN IMMEDIATE");
    try {
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
      conn.exec("COMMIT");
    } catch (error) {
      try {
        conn.exec("ROLLBACK");
      } catch {}
      throw corruptStore(error);
    }
  }

  // Reset the persisted log for a key to a single base snapshot of `doc`. Used
  // on open (trust the file: the prior log is dead) and after a merge reseed.
  function resetPersistedState(
    key: YDocDocKey,
    contentKind: YDocContentKind,
    doc: Y.Doc,
  ): void {
    const snapshotSha = putYDocBlob(db(), Y.encodeStateAsUpdate(doc));
    const stateVectorSha = putYDocBlob(db(), Y.encodeStateVector(doc));
    const now = nowMs();
    const conn = db();
    conn.exec("BEGIN IMMEDIATE");
    try {
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
      conn.exec("COMMIT");
    } catch (error) {
      try {
        conn.exec("ROLLBACK");
      } catch {}
      throw corruptStore(error);
    }
  }

  function pruneClosedState(key: YDocDocKey): void {
    const conn = db();
    conn.exec("BEGIN IMMEDIATE");
    try {
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
      conn.exec("COMMIT");
    } catch (error) {
      try {
        conn.exec("ROLLBACK");
      } catch {}
      throw corruptStore(error);
    }
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
      return liveSessions.has(liveKey(workspaceId, objectId)) ? "ydoc" : "file";
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
      if (liveSessions.has(registryKey)) {
        // Structural single-canonical guard: another live Y.Doc already owns
        // this object (possibly under a different version). Settle+close it
        // first — a version switch is a closed-session boundary.
        throw new YDocEngineDriverError(
          "already-live",
          `Object ${objectId} already has a live Y.Doc session; close it before opening another (single-canonical).`,
        );
      }
      const kind: YDocContentKind = contentKind ?? "richdoc";
      const key: YDocDocKey = { workspaceId, versionId, objectId };

      // Flip file -> Y.Doc: seed from the CURRENT file, never a stale cache.
      const doc = seedDoc(snapshot.text, kind);
      resetPersistedState(key, kind, doc);

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
          const sha = putYDocBlob(db(), update);
          const now = nowMs();
          const conn = db();
          let seq = 0;
          conn.exec("BEGIN IMMEDIATE");
          try {
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
            conn.exec("COMMIT");
          } catch (error) {
            try {
              conn.exec("ROLLBACK");
            } catch {}
            throw corruptStore(error);
          }
          compact(key);
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
            resetPersistedState(key, kind, doc);
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
          // Flip Y.Doc -> file. markdown-is-the-artifact: prune the CRDT bytes
          // unless a persistent-threads layer opted to keep them.
          if (persistClosedSessionState) {
            compact(key);
          } else {
            pruneClosedState(key);
          }
        },
      };

      liveSessions.set(registryKey, session);
      return session;
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
