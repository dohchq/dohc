import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { WorkspaceId } from "@dohc/workspace-contracts/engine";
import {
  ENGINE_SQLITE_BUSY_TIMEOUT_MS,
  assertEngineSqliteIntegrity,
  initializeOrValidateEngineSchema,
  trackEngineDbHandleForTest,
  type EngineSqliteDb,
} from "./engineDbSchema";
import { createLinkedChatStore } from "./linkedChatStore";
import { createSecretFileStore } from "./secretFileStore";
import {
  MAX_VERSIONED_BINARY_FILE_BYTES,
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  VersionedTextStoreError,
  createVersionedTextStore,
} from "./versionedTextStore";
import type { PendingConflictResolve, SyncReplicationEnvelope } from "./syncReplication";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => EngineSqliteDb;
}

const requireModule = createRequire(import.meta.url);

function nodeSqlite(): SqliteModule {
  return requireModule("node:sqlite") as SqliteModule;
}

export interface OpBlobRefs {
  text: string[];
  binary: string[];
}

export interface ApplySyncQueuesInput {
  rootDir: string;
  workspaceId: WorkspaceId;
  queues: SyncReplicationEnvelope[][];
  blobSource: (sha256: string, kind: "text" | "binary") => Promise<string | Uint8Array>;
}

export interface ApplySyncQueuesResult {
  applied: number;
  skipped: number;
  conflictsOpened: number;
  // conflict.resolve ops that matched no local conflict (neither by id nor by
  // mirrored heads); journaled and acked but surfaced, never silently
  // swallowed.
  pendingConflictResolves: number;
  // Identities behind the count (0P-C gate fix): lets the surfacing layer
  // clear its "needs a look" state when the referenced conflict is later
  // resolved instead of accumulating a session-sticky counter.
  pendingResolves: PendingConflictResolve[];
  // Ops whose apply was an idempotent skip (already journaled). The relay
  // pull uses these to re-report disk work owed by a previous pass whose
  // materialization failed before the fetch cursor committed.
  skippedOps: SyncReplicationEnvelope[];
}

export function corruptSyncPayload(message: string): VersionedTextStoreError {
  return new VersionedTextStoreError("state-corrupt", message);
}

export function sha256Hex(content: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof content === "string") hash.update(content, "utf8");
  else hash.update(content);
  return hash.digest("hex");
}

export function openEngineDb(rootDir: string): EngineSqliteDb {
  const dbPath = join(resolve(rootDir), VERSIONED_TEXT_STORE_RELATIVE_PATH);
  mkdirSync(dirname(dbPath), { recursive: true });
  const { DatabaseSync } = nodeSqlite();
  const db = trackEngineDbHandleForTest(new DatabaseSync(dbPath));
  try {
    db.exec(`PRAGMA busy_timeout = ${ENGINE_SQLITE_BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    initializeOrValidateEngineSchema(db, (cause?: unknown) => {
      const error = new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
      return error;
    });
    assertEngineSqliteIntegrity(db, (cause?: unknown) => {
      const error = new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
      return error;
    });
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
}

// moment.append references content by sha with a per-side kind (absent means
// text, the pre-WS-G1 wire truth). conflict.open ships text states inline in
// payload_json but binary states by sha only — binary bytes never ride JSON.
// version.create ships its fork-point snapshot rows by sha (both kinds).
export function collectBlobHashesFromOp(op: SyncReplicationEnvelope): OpBlobRefs {
  const refs: OpBlobRefs = { text: [], binary: [] };
  const push = (sha: string | null | undefined, kind: "text" | "binary") => {
    if (typeof sha === "string" && sha.length > 0) refs[kind].push(sha);
  };
  if (op.opKind === "moment.append") {
    const payload = op.payload;
    push(
      payload.payloadBeforeBlobSha256,
      (payload.payloadBeforeContentKind ?? "text") === "binary" ? "binary" : "text",
    );
    push(
      payload.payloadAfterBlobSha256,
      (payload.payloadAfterContentKind ?? "text") === "binary" ? "binary" : "text",
    );
    push(
      payload.beforeBlobSha256,
      (payload.beforeContentKind ?? "text") === "binary" ? "binary" : "text",
    );
  } else if (op.opKind === "conflict.open") {
    const conflict = op.payload;
    for (const state of [conflict.base, conflict.current, conflict.incoming]) {
      if (state?.exists && (state.contentKind ?? "text") === "binary") {
        push(state.sha256, "binary");
      }
    }
  } else if (op.opKind === "version.create") {
    for (const snapshot of op.payload.forkSnapshots ?? []) {
      push(
        snapshot.blobSha256,
        (snapshot.contentKind ?? "text") === "binary" ? "binary" : "text",
      );
    }
  } else if (op.opKind === "ydoc.update") {
    // The Yjs update bytes are content-addressed into binary_blobs and ride the
    // binary blob-have/blob-put path (dedup for free). Declaring them here makes
    // the push uploader ship the blob BEFORE the log op (honoring the relay's
    // append-time blob-ref validation) and the apply hydrate it before the txn.
    push(op.payload.updateBlobSha256, "binary");
  } else if (op.opKind === "secret.file.put") {
    push(op.payload.ciphertextSha256, "binary");
  } else if (op.opKind === "secret.version.fork") {
    // Guard like version.create's forkSnapshots above: a malformed remote op
    // without rows must reach the store's fail-closed payload validation, not
    // crash here at the transport edge with a TypeError.
    for (const row of op.payload.rows ?? []) {
      push(row.ciphertextSha256, "binary");
    }
  }
  return refs;
}

export function popNextMergedOp(queues: SyncReplicationEnvelope[][]): SyncReplicationEnvelope | null {
  let bestIndex = -1;
  for (let index = 0; index < queues.length; index += 1) {
    const candidate = queues[index]?.[0];
    if (!candidate) continue;
    const best = bestIndex === -1 ? undefined : queues[bestIndex]?.[0];
    if (
      !best ||
      candidate.recordedAtMs < best.recordedAtMs ||
      (candidate.recordedAtMs === best.recordedAtMs && candidate.originId < best.originId) ||
      (candidate.recordedAtMs === best.recordedAtMs &&
        candidate.originId === best.originId &&
        candidate.originSeq < best.originSeq)
    ) {
      bestIndex = index;
    }
  }
  if (bestIndex === -1) return null;
  return queues[bestIndex]?.shift() ?? null;
}

// True only when the blobs row's TEXT hashes to the ref — the one check that
// distinguishes a real hydrated text blob from a binary blob's compatibility
// anchor row (text = "", written by hydrateBinaryBlob/putBinaryBlob under the
// BINARY content's sha). A text ref satisfied by such an anchor would
// materialize empty text under a mismatched sha, so callers treat "present
// but mismatching" exactly like "absent" and re-verify at apply time.
export function isHydratedTextBlob(db: EngineSqliteDb, sha: string): boolean {
  const row = db.prepare("SELECT text FROM blobs WHERE sha256 = ?").get(sha);
  return typeof row?.text === "string" && sha256Hex(row.text) === sha;
}

// Content-verified blob hydration: every source blob must hash to its name,
// and an INSERT OR IGNORE that skips an existing row must find the existing
// content matching that hash — a tampered transfer or poisoned pre-existing
// row is corruption, never silently adopted state.
export function hydrateTextBlob(db: EngineSqliteDb, sha: string, text: string): void {
  if (sha256Hex(text) !== sha) {
    throw corruptSyncPayload(`Sync text blob ${sha} does not match its content hash.`);
  }
  const inserted = db
    .prepare("INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?, ?, ?)")
    .run(sha, Buffer.byteLength(text, "utf8"), text);
  if (inserted.changes > 0) return;
  const existing = db.prepare("SELECT text FROM blobs WHERE sha256 = ?").get(sha);
  const existingText = typeof existing?.text === "string" ? existing.text : null;
  if (existingText === text) return;
  if (existingText === "" && db.prepare("SELECT 1 FROM binary_blobs WHERE sha256 = ?").get(sha)) {
    db.prepare("UPDATE blobs SET text = ?, byte_length = ? WHERE sha256 = ?").run(
      text,
      Buffer.byteLength(text, "utf8"),
      sha,
    );
    return;
  }
  throw corruptSyncPayload(`Existing blob ${sha} does not match the sync bundle content.`);
}

// The engine refuses to WRITE binaries above MAX_VERSIONED_BINARY_FILE_BYTES
// (5 MiB), so no honest peer can ever ship one. The relay's transport cap
// (MAX_BLOB_BYTES, 10 MB) is deliberately larger — headroom for text blobs —
// which means an authenticated client could push an oversized binary the
// relay would store. Enforce the ENGINE limit here, by referenced kind,
// before any insertion: hydrating such a blob would create local state the
// engine itself forbids. Fails closed as a protocol violation.
export function assertBinaryBlobWithinEngineLimit(sha: string, bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_VERSIONED_BINARY_FILE_BYTES) {
    throw new VersionedTextStoreError(
      "file-too-large",
      `Sync binary blob ${sha} is ${bytes.byteLength} bytes and exceeds the ` +
        `${MAX_VERSIONED_BINARY_FILE_BYTES}-byte engine limit; rejecting the protocol violation.`,
    );
  }
}

export function hydrateBinaryBlob(db: EngineSqliteDb, sha: string, bytes: Uint8Array): void {
  assertBinaryBlobWithinEngineLimit(sha, bytes);
  if (sha256Hex(bytes) !== sha) {
    throw corruptSyncPayload(`Sync binary blob ${sha} does not match its content hash.`);
  }
  const buffer = Buffer.from(bytes);
  const inserted = db
    .prepare("INSERT OR IGNORE INTO binary_blobs (sha256, byte_length, content) VALUES (?, ?, ?)")
    .run(sha, buffer.byteLength, buffer);
  if (inserted.changes === 0) {
    const existing = db.prepare("SELECT content FROM binary_blobs WHERE sha256 = ?").get(sha);
    const content = existing?.content;
    const existingBytes = Buffer.isBuffer(content)
      ? content
      : content instanceof Uint8Array
        ? Buffer.from(content)
        : null;
    if (!existingBytes || sha256Hex(existingBytes) !== sha) {
      throw corruptSyncPayload(`Existing binary blob ${sha} does not match the sync bundle content.`);
    }
  }
  db.prepare("INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?, ?, '')").run(
    sha,
    buffer.byteLength,
  );
}

export async function applySyncQueues(
  input: ApplySyncQueuesInput,
): Promise<ApplySyncQueuesResult> {
  const db = openEngineDb(input.rootDir);
  try {
    const textHashes = new Set<string>();
    const binaryHashes = new Set<string>();
    for (const queue of input.queues) {
      for (const op of queue) {
        const refs = collectBlobHashesFromOp(op);
        for (const sha of refs.text) textHashes.add(sha);
        for (const sha of refs.binary) binaryHashes.add(sha);
      }
    }
    // Materialize missing blob bytes BEFORE taking the write transaction:
    // blobSource may be network-backed (the relay path), and BEGIN IMMEDIATE
    // must never hold the engine write lock across a fetch — that starves
    // concurrent local writers into the 5s busy_timeout. Hydration below is
    // synchronous; INSERT OR IGNORE + content verification inside the
    // transaction keeps a racing writer safe.
    const fetchedText = new Map<string, string>();
    const fetchedBinary = new Map<string, Uint8Array>();
    for (const sha of textHashes) {
      // A text ref is hydrated ONLY by a row whose text hashes to the ref
      // (0P-C gate fix). Presence alone is not enough: binary hydration
      // writes a compatibility ANCHOR row (text = "") under the binary sha,
      // and a kind-confused op must never adopt that as text content.
      if (isHydratedTextBlob(db, sha)) continue;
      const text = await input.blobSource(sha, "text");
      if (typeof text !== "string") {
        throw corruptSyncPayload(`Sync blob ${sha} was not text content.`);
      }
      fetchedText.set(sha, text);
    }
    for (const sha of binaryHashes) {
      if (db.prepare("SELECT 1 FROM binary_blobs WHERE sha256 = ?").get(sha)) continue;
      const bytes = await input.blobSource(sha, "binary");
      if (typeof bytes === "string") {
        throw corruptSyncPayload(`Sync binary blob ${sha} was not binary content.`);
      }
      // Fail closed at the transport edge, before anything is staged.
      assertBinaryBlobWithinEngineLimit(sha, bytes);
      fetchedBinary.set(sha, bytes);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const [sha, text] of fetchedText) hydrateTextBlob(db, sha, text);
      for (const [sha, bytes] of fetchedBinary) hydrateBinaryBlob(db, sha, bytes);
      for (const queue of input.queues) {
        for (const op of queue) {
          const refs = collectBlobHashesFromOp(op);
          for (const sha of refs.text) {
            // Content-verified, not presence-checked: a binary anchor row
            // (text = "") under this sha means the op's TEXT ref is
            // kind-confused — fail closed instead of applying empty text.
            if (!isHydratedTextBlob(db, sha)) {
              throw corruptSyncPayload(`Sync payload is missing text blob ${sha}.`);
            }
          }
          for (const sha of refs.binary) {
            if (!db.prepare("SELECT 1 FROM binary_blobs WHERE sha256 = ?").get(sha)) {
              throw corruptSyncPayload(`Sync payload is missing binary blob ${sha}.`);
            }
          }
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  } finally {
    db.close();
  }

  const versions = createVersionedTextStore(input.rootDir);
  const chats = createLinkedChatStore(input.rootDir);
  const secrets = createSecretFileStore(input.rootDir);
  try {
    let applied = 0;
    let skipped = 0;
    let conflictsOpened = 0;
    const pendingResolves: PendingConflictResolve[] = [];
    const skippedOps: SyncReplicationEnvelope[] = [];
    for (;;) {
      const op = popNextMergedOp(input.queues);
      if (!op) break;
      const result =
        op.opKind === "chat.channel.create" ||
        op.opKind === "chat.thread.create" ||
        op.opKind === "chat.message.append" ||
        op.opKind === "chat.decision.set" ||
        op.opKind === "chat.attachment.add" ||
        op.opKind === "chat.reaction.set" ||
        op.opKind === "chat.follow.set" ||
        op.opKind === "chat.feed.read.set"
          ? await chats.applyReplicationOp(op)
          : op.opKind === "secret.file.put" ||
              op.opKind === "secret.file.delete" ||
              op.opKind === "secret.version.fork"
            ? await secrets.applyReplicationOp(op)
          : await versions.applyReplicationOp(op);
      if (result.status === "skipped") {
        skipped += 1;
        skippedOps.push(op);
      } else {
        applied += 1;
        conflictsOpened += result.conflictsOpened;
        pendingResolves.push(...(result.pendingResolves ?? []));
      }
    }
    return {
      applied,
      skipped,
      conflictsOpened,
      pendingConflictResolves: pendingResolves.length,
      pendingResolves,
      skippedOps,
    };
  } finally {
    // Close every store even if one close() rejects — a sequential
    // `await a.close(); await b.close();` would leak the remaining handles on
    // the first throw.
    const closeResults = await Promise.allSettled([
      secrets.close(),
      chats.close(),
      versions.close(),
    ]);
    for (const result of closeResults) {
      // A failed store close can signal unflushed/corrupted durable state —
      // surface it rather than swallowing it (we still don't rethrow, so one
      // failed close can't mask the applied/skipped results).
      if (result.status === "rejected") {
        console.error("applySyncQueues: store close failed", result.reason);
      }
    }
  }
}
