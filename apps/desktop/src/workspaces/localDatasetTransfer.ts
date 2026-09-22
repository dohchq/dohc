import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DatasetCursor, DatasetJournal } from "@dohc/app-backend-runtime/journal";
import { assertDatasetAttemptsCommitted, initializeDatasetAttempts } from "@dohc/app-backend-runtime/dataset-attempts";
import { encodeRecoveryManifest, recoveryManifestSha256, writeDatasetRecovery, type DatasetRecoveryManifest, type RecoveryEntry, type RecoveryLimits } from "@dohc/app-backend-runtime/recovery";

export interface DatasetTransferReceipt {
  transferId: string;
  manifestSha256: string;
  sourceCursor: DatasetCursor;
  targetCursor: DatasetCursor;
}
export interface DatasetTransferStatus {
  transferId: string;
  workspaceId: string;
  datasetId: string;
  targetOrigin: string;
  state: "ready" | "imported";
  sourceCursor: DatasetCursor;
  manifestSha256: string | null;
  receipt: DatasetTransferReceipt | null;
}
export interface DatasetTransferTarget {
  /** An owner-authenticated, origin-bound client. Same transferId and manifest must return the same durable receipt. */
  importRecovery(input: { transferId: string; sourceCursor: DatasetCursor; manifestSha256: string; manifest: DatasetRecoveryManifest;
    stream: AsyncIterable<Uint8Array>; signal?: AbortSignal }): Promise<DatasetTransferReceipt>;
}
interface StoredTransfer extends DatasetTransferStatus { archive: { directory: string; manifest: DatasetRecoveryManifest } | null }
type PreparedExport = { directory: string; manifest: DatasetRecoveryManifest; assertUnchanged(): void; dispose(): Promise<void> };
const sameCursor = (a: DatasetCursor, b: DatasetCursor) => a.workspaceId === b.workspaceId && a.datasetId === b.datasetId && a.hostEpoch === b.hostEpoch && a.approvedRevisionHash === b.approvedRevisionHash && a.revision === b.revision && a.digest === b.digest;
function canonicalOrigin(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw Error("Choose a configured sharing server.");
  return url.origin;
}
function checkReceipt(value: DatasetTransferReceipt, marker: StoredTransfer): DatasetTransferReceipt {
  if (!value || value.transferId !== marker.transferId || value.manifestSha256 !== marker.manifestSha256 || !value.sourceCursor || !sameCursor(value.sourceCursor, marker.sourceCursor)) throw Error("The sharing server returned another transfer. Retry this transfer.");
  const next = value.targetCursor, before = marker.sourceCursor;
  if (!next || next.workspaceId !== before.workspaceId || next.datasetId !== before.datasetId || next.approvedRevisionHash !== before.approvedRevisionHash ||
      typeof next.hostEpoch !== "string" || !next.hostEpoch || next.hostEpoch === before.hostEpoch || next.revision !== before.revision + 1 || !/^[a-f0-9]{64}$/.test(next.digest)) throw Error("The sharing server did not confirm this Collection. Retry this transfer.");
  return structuredClone(value);
}

/** A complete archive and its journal fence become durable together. Target failures never restore local write authority. */
export function createLocalDatasetTransfers(options: {
  db: DatabaseSync; journal: DatasetJournal; workspaceId: string; exportDirectory: string; limits: RecoveryLimits;
  transaction<T>(run: () => T): T;
  assertCurrent(): void;
  exportRecovery(datasetId: string, signal?: AbortSignal): Promise<PreparedExport>;
}) {
  const { db, journal, transaction, workspaceId } = options;
  transaction(() => initializeDatasetAttempts(db));
  db.exec(`CREATE TABLE IF NOT EXISTS local_dataset_transfers(
    workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,transfer_id TEXT NOT NULL UNIQUE,target_origin TEXT NOT NULL,
    source_cursor TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('ready','imported')),
    manifest_sha256 TEXT,archive TEXT,receipt TEXT,PRIMARY KEY(workspace_id,dataset_id)) STRICT;`);
  const inFlight = new Map<string, Promise<DatasetTransferStatus>>();
  function authorize(signal?: AbortSignal) { options.assertCurrent(); signal?.throwIfAborted(); }
  function read(datasetId: string): StoredTransfer | null {
    options.assertCurrent(); const row = db.prepare("SELECT * FROM local_dataset_transfers WHERE workspace_id=? AND dataset_id=?").get(workspaceId, datasetId);
    if (!row) return null;
    return { workspaceId, datasetId, transferId: String(row.transfer_id), targetOrigin: String(row.target_origin), state: String(row.state) as StoredTransfer["state"],
      sourceCursor: JSON.parse(String(row.source_cursor)), manifestSha256: row.manifest_sha256 === null ? null : String(row.manifest_sha256),
      archive: row.archive === null ? null : JSON.parse(String(row.archive)), receipt: row.receipt === null ? null : JSON.parse(String(row.receipt)) };
  }
  function status(marker: StoredTransfer): DatasetTransferStatus { const { archive: _, ...value } = marker; return structuredClone(value); }
  function assertFence(marker: StoredTransfer) {
    const head = journal.head({ workspaceId, datasetId: marker.datasetId }, options.assertCurrent);
    if (head.active || !sameCursor(head.cursor, marker.sourceCursor)) throw Error("Local Collection authority changed. Reopen the workspace before retrying.");
  }
  async function checkedArchive(archive: NonNullable<StoredTransfer["archive"]>) {
    const expectedParent = await realpath(options.exportDirectory), actual = await realpath(archive.directory), info = await lstat(archive.directory);
    if (info.isSymbolicLink() || !info.isDirectory() || dirname(actual) !== expectedParent || resolve(actual) !== resolve(archive.directory)) throw Error("The transfer archive is unavailable. Restore its private files before retrying.");
    return actual;
  }
  async function finishImported(marker: StoredTransfer): Promise<DatasetTransferStatus> {
    if (marker.archive) {
      try {
        const archiveDirectory = await checkedArchive(marker.archive);
        await rm(archiveDirectory, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      options.assertCurrent();
      db.prepare("UPDATE local_dataset_transfers SET archive=NULL WHERE workspace_id=? AND dataset_id=? AND transfer_id=? AND state='imported'")
        .run(workspaceId, marker.datasetId, marker.transferId);
    }
    return status(marker);
  }
  async function execute(input: { datasetId: string; targetOrigin: string; target: DatasetTransferTarget; signal?: AbortSignal }): Promise<DatasetTransferStatus> {
    const targetOrigin = canonicalOrigin(input.targetOrigin); authorize(input.signal);
    let marker: StoredTransfer;
    const existing = read(input.datasetId);
    if (existing) {
      if (existing.targetOrigin !== targetOrigin) throw Error("This Collection is transferring to another server. Finish that transfer first.");
      assertFence(existing); marker = existing;
    } else {
      // Build and validate the complete archive while local writes remain active. A malformed,
      // oversized, unreadable, or otherwise unexportable dataset must remain writable.
      const prepared = await options.exportRecovery(input.datasetId, input.signal);
      let retained = false;
      try {
        authorize(input.signal);
        prepared.manifest.sourceState = "fenced";
        const archive = { directory: prepared.directory, manifest: prepared.manifest };
        await checkedArchive(archive);
        const manifestSha256 = recoveryManifestSha256(prepared.manifest, options.limits);
        encodeRecoveryManifest(prepared.manifest, options.limits);
        marker = transaction(() => {
          authorize(input.signal);
          const head = journal.head({ workspaceId, datasetId: input.datasetId }, options.assertCurrent);
          if (!head.active) throw Error("This Collection has no local write authority. Restore its transfer record before continuing.");
          if (!sameCursor(head.cursor, prepared.manifest.cursor)) throw Error("The Collection changed while it was being exported. Retry this transfer.");
          prepared.assertUnchanged();
          assertDatasetAttemptsCommitted(db, { workspaceId, datasetId: input.datasetId });
          journal.fence({ expected: head.cursor, authorize: options.assertCurrent });
          const value: StoredTransfer = { workspaceId, datasetId: input.datasetId, transferId: randomUUID(), targetOrigin,
            sourceCursor: head.cursor, state: "ready", manifestSha256, archive, receipt: null };
          db.prepare("INSERT INTO local_dataset_transfers VALUES(?,?,?,?,?,'ready',?,?,NULL)").run(workspaceId, input.datasetId, value.transferId, targetOrigin,
            JSON.stringify(head.cursor), manifestSha256, JSON.stringify(archive));
          return value;
        });
        retained = true;
      } finally { if (!retained) await prepared.dispose(); }
    }
    if (marker.state === "imported") return finishImported(marker);
    if (!marker.archive || !marker.manifestSha256) throw Error("The transfer archive is missing. Restore it before retrying.");
    const archive = marker.archive, archiveDirectory = await checkedArchive(archive);
    if (recoveryManifestSha256(archive.manifest, options.limits) !== marker.manifestSha256) throw Error("The transfer archive changed. Restore it before retrying.");
    encodeRecoveryManifest(archive.manifest, options.limits);
    const receipt = checkReceipt(await input.target.importRecovery({ transferId: marker.transferId, sourceCursor: marker.sourceCursor,
      manifestSha256: marker.manifestSha256, manifest: archive.manifest, signal: input.signal,
      stream: writeDatasetRecovery({ manifest: archive.manifest, limits: options.limits, signal: input.signal,
        authorize() { authorize(input.signal); assertFence(marker); },
        open(entry: RecoveryEntry) {
          const index = archive.manifest.entries.findIndex((candidate: RecoveryEntry) => candidate.id === entry.id);
          if (index < 0) throw Error("The transfer archive changed.");
          return createReadStream(join(archiveDirectory, `${index}.bin`), { highWaterMark: 1024 * 1024 });
        } }),
    }), marker);
    marker = transaction(() => {
      authorize(input.signal); const current = read(input.datasetId)!; assertFence(current);
      if (current.transferId !== marker.transferId || current.manifestSha256 !== marker.manifestSha256) throw Error("The transfer changed. Reopen the workspace.");
      if (current.receipt && JSON.stringify(current.receipt) !== JSON.stringify(receipt)) throw Error("The sharing server changed its transfer receipt.");
      db.prepare("UPDATE local_dataset_transfers SET state='imported',receipt=? WHERE workspace_id=? AND dataset_id=? AND transfer_id=?")
        .run(JSON.stringify(receipt), workspaceId, input.datasetId, marker.transferId);
      return { ...current, state: "imported" as const, receipt };
    });
    return finishImported(marker);
  }
  return {
    status(datasetId: string) { const value = read(datasetId); return value ? status(value) : null; },
    transfer(input: Parameters<typeof execute>[0]) {
      const pending = inFlight.get(input.datasetId);
      const task = pending ? pending.then(() => execute(input), () => execute(input)) : execute(input);
      inFlight.set(input.datasetId, task);
      return task.finally(() => { if (inFlight.get(input.datasetId) === task) inFlight.delete(input.datasetId); });
    },
  };
}
