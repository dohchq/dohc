import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  SyncReplicationEnvelope,
  WorkspaceId,
} from "@dohc/workspace-contracts/engine";
import {
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  VersionedTextStoreError,
} from "./versionedTextStore";
import {
  applySyncQueues,
  collectBlobHashesFromOp,
  hydrateBinaryBlob,
  hydrateTextBlob,
  openEngineDb,
  sha256Hex,
} from "./syncApply";

export interface ExportSyncBundleInput {
  rootDir: string;
  workspaceId: WorkspaceId;
  toDir: string;
  sinceCursor?: Record<string, number>;
  nowMs?: () => number;
}

export interface ExportSyncBundleResult {
  originsExported: string[];
  opCount: number;
  blobCount: number;
}

export interface ImportSyncBundleInput {
  rootDir: string;
  workspaceId: WorkspaceId;
  fromDir: string;
}

export interface ImportSyncBundleResult {
  applied: number;
  skipped: number;
  conflictsOpened: number;
  // conflict.resolve ops that matched no local conflict (neither by id nor by
  // mirrored heads); journaled and acked but surfaced, never silently
  // swallowed.
  pendingConflictResolves: number;
}

interface ManifestOrigin {
  originId: string;
  minSeq: number;
  maxSeq: number;
  count: number;
}

interface SyncBundleManifest {
  formatVersion: 1;
  workspaceId: WorkspaceId;
  origins: ManifestOrigin[];
  blobCount: number;
  // Absent in bundles exported before WS-G1 binary support; readers treat
  // absent as zero binary blobs.
  binaryBlobCount?: number;
  exportedAtMs: number;
}

function corruptBundle(message: string): VersionedTextStoreError {
  return new VersionedTextStoreError("state-corrupt", message);
}

function rowToOp(row: Record<string, unknown>): SyncReplicationEnvelope {
  return {
    workspaceId: String(row.workspace_id),
    originId: String(row.origin_id),
    originSeq: Number(row.origin_seq),
    opKind: String(row.op_kind),
    payload: JSON.parse(String(row.payload_json)),
    recordedAtMs: Number(row.recorded_at_ms),
  } as SyncReplicationEnvelope;
}

export async function exportSyncBundle(
  input: ExportSyncBundleInput,
): Promise<ExportSyncBundleResult> {
  const db = openEngineDb(input.rootDir);
  try {
    // A reused export directory must never leak a previous export's files
    // into a later bundle: stale op files would not match the fresh manifest
    // (import fails closed on them) and stale blobs would ride along
    // unreferenced. Clear the bundle-owned directories before writing.
    for (const dir of ["ops", "blobs", "blobs-bin"] as const) {
      await rm(join(input.toDir, dir), { recursive: true, force: true });
      await mkdir(join(input.toDir, dir), { recursive: true });
    }
    const rows = db
      .prepare(
        `SELECT *
         FROM replication_log
         WHERE workspace_id = ?
         ORDER BY origin_id, origin_seq`,
      )
      .all(input.workspaceId)
      .map(rowToOp)
      .filter((op) => op.originSeq > (input.sinceCursor?.[op.originId] ?? -1));
    const byOrigin = new Map<string, SyncReplicationEnvelope[]>();
    const blobHashes = new Set<string>();
    const binaryBlobHashes = new Set<string>();
    for (const op of rows) {
      const bucket = byOrigin.get(op.originId) ?? [];
      bucket.push(op);
      byOrigin.set(op.originId, bucket);
      const refs = collectBlobHashesFromOp(op);
      for (const sha of refs.text) blobHashes.add(sha);
      for (const sha of refs.binary) binaryBlobHashes.add(sha);
    }

    const origins: ManifestOrigin[] = [];
    for (const [originId, ops] of byOrigin) {
      ops.sort((a, b) => a.originSeq - b.originSeq);
      const lines = ops
        .map(({ originId, originSeq, opKind, payload, recordedAtMs }) =>
          JSON.stringify({ originId, originSeq, opKind, payload, recordedAtMs }),
        )
        .join("\n");
      await writeFile(join(input.toDir, "ops", `${originId}.jsonl`), `${lines}\n`, "utf8");
      origins.push({
        originId,
        minSeq: ops[0]?.originSeq ?? 0,
        maxSeq: ops[ops.length - 1]?.originSeq ?? -1,
        count: ops.length,
      });
    }

    let blobCount = 0;
    for (const sha of blobHashes) {
      const row = db.prepare("SELECT text FROM blobs WHERE sha256 = ?").get(sha);
      if (typeof row?.text !== "string") {
        throw new VersionedTextStoreError("state-corrupt", `Missing blob ${sha} for sync export.`);
      }
      await writeFile(join(input.toDir, "blobs", sha), row.text, "utf8");
      blobCount += 1;
    }
    let binaryBlobCount = 0;
    for (const sha of binaryBlobHashes) {
      const row = db.prepare("SELECT content FROM binary_blobs WHERE sha256 = ?").get(sha);
      const content = row?.content;
      const bytes = Buffer.isBuffer(content)
        ? content
        : content instanceof Uint8Array
          ? Buffer.from(content)
          : null;
      if (!bytes) {
        throw new VersionedTextStoreError(
          "state-corrupt",
          `Missing binary blob ${sha} for sync export.`,
        );
      }
      await writeFile(join(input.toDir, "blobs-bin", sha), bytes);
      binaryBlobCount += 1;
    }
    const manifest: SyncBundleManifest = {
      formatVersion: 1,
      workspaceId: input.workspaceId,
      origins,
      blobCount,
      binaryBlobCount,
      exportedAtMs: input.nowMs?.() ?? Date.now(),
    };
    await writeFile(join(input.toDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return {
      originsExported: origins.map((origin) => origin.originId),
      opCount: rows.length,
      blobCount: blobCount + binaryBlobCount,
    };
  } finally {
    db.close();
  }
}

const SAFE_ORIGIN_ID = /^[A-Za-z0-9_-]+$/u;

// Reads ONLY the manifest-listed origin files and verifies each file against
// its manifest entry (origin id per line, count, minSeq, maxSeq). Anything
// else in ops/ is ignored; any mismatch fails closed — a bundle whose ops do
// not match its manifest is corrupt, not partially importable.
async function readOps(
  fromDir: string,
  workspaceId: WorkspaceId,
  manifest: SyncBundleManifest,
): Promise<SyncReplicationEnvelope[][]> {
  const queues: SyncReplicationEnvelope[][] = [];
  const origins = [...manifest.origins].sort((a, b) => a.originId.localeCompare(b.originId));
  for (const origin of origins) {
    if (!SAFE_ORIGIN_ID.test(origin.originId)) {
      throw corruptBundle(`Sync bundle manifest origin id ${JSON.stringify(origin.originId)} is invalid.`);
    }
    const path = join(fromDir, "ops", `${origin.originId}.jsonl`);
    const text = await readFile(path, "utf8").catch(() => {
      throw corruptBundle(`Sync bundle is missing ops for origin ${origin.originId}.`);
    });
    const queue = text
      .split(/\n/u)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return { ...parsed, workspaceId } as SyncReplicationEnvelope;
      })
      .sort((a, b) => a.originSeq - b.originSeq);
    const mismatched =
      queue.length !== origin.count ||
      queue.some((op) => op.originId !== origin.originId) ||
      (queue.length > 0 &&
        ((queue[0]?.originSeq ?? -1) !== origin.minSeq ||
          (queue[queue.length - 1]?.originSeq ?? -1) !== origin.maxSeq));
    if (mismatched) {
      throw corruptBundle(
        `Sync bundle ops for origin ${origin.originId} do not match the manifest entry.`,
      );
    }
    if (queue.length > 0) queues.push(queue);
  }
  return queues;
}

export async function importSyncBundle(
  input: ImportSyncBundleInput,
): Promise<ImportSyncBundleResult> {
  await mkdir(dirname(join(resolve(input.rootDir), VERSIONED_TEXT_STORE_RELATIVE_PATH)), {
    recursive: true,
  });
  const manifest = JSON.parse(
    await readFile(join(input.fromDir, "manifest.json"), "utf8"),
  ) as SyncBundleManifest;
  if (manifest.formatVersion !== 1 || manifest.workspaceId !== input.workspaceId) {
    throw new VersionedTextStoreError("invalid-input", "Sync bundle manifest does not match workspace.");
  }
  const queues = await readOps(input.fromDir, input.workspaceId, manifest);
  const db = openEngineDb(input.rootDir);
  try {
    // One transaction for hydration + ref validation: pre-apply staging is
    // atomic and avoids a WAL fsync per blob statement.
    db.exec("BEGIN IMMEDIATE");
    try {
      const blobDir = join(input.fromDir, "blobs");
      for (const file of await readdir(blobDir).catch(() => [] as string[])) {
        try {
          hydrateTextBlob(db, file, await readFile(join(blobDir, file), "utf8"));
        } catch (error) {
          if (error instanceof VersionedTextStoreError) {
            throw corruptBundle(error.message.replace(/^Sync text/u, "Sync bundle"));
          }
          throw error;
        }
      }
      const binaryBlobDir = join(input.fromDir, "blobs-bin");
      for (const file of await readdir(binaryBlobDir).catch(() => [] as string[])) {
        try {
          hydrateBinaryBlob(db, file, await readFile(join(binaryBlobDir, file)));
        } catch (error) {
          if (error instanceof VersionedTextStoreError) {
            throw corruptBundle(error.message.replace(/^Sync binary/u, "Sync bundle binary"));
          }
          throw error;
        }
      }
      for (const queue of queues) {
        for (const op of queue) {
          const refs = collectBlobHashesFromOp(op);
          for (const sha of refs.text) {
            if (!db.prepare("SELECT 1 FROM blobs WHERE sha256 = ?").get(sha)) {
              throw corruptBundle(`Sync bundle is missing blob ${sha}.`);
            }
          }
          for (const sha of refs.binary) {
            if (!db.prepare("SELECT 1 FROM binary_blobs WHERE sha256 = ?").get(sha)) {
              throw corruptBundle(`Sync bundle is missing binary blob ${sha}.`);
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
  return applySyncQueues({
    rootDir: input.rootDir,
    workspaceId: input.workspaceId,
    queues,
    blobSource: async (sha, kind) =>
      kind === "text"
        ? readFile(join(input.fromDir, "blobs", sha), "utf8")
        : readFile(join(input.fromDir, "blobs-bin", sha)),
  });
}
