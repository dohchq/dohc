import type {
  SyncReplicationEnvelope,
  SyncReplicationOpKind,
  TextFileSnapshot,
  WorkspaceId,
} from "@dohc/workspace-contracts/engine";
import { VersionedTextStoreError, createVersionedTextStore } from "./versionedTextStore";
import {
  applySyncQueues,
  collectBlobHashesFromOp,
  openEngineDb,
  sha256Hex,
} from "./syncApply";
import type { EngineSqliteDb } from "./engineDbSchema";

export interface SyncRelayConnection {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export interface SyncRelayInput {
  rootDir: string;
  workspaceId: WorkspaceId;
  relay: SyncRelayConnection;
}

export interface RelayMaterializedPath {
  path: string;
  operation: "write" | "delete";
  contentKind: "text" | "binary";
}

export interface PullWorkspaceFromRelayResult {
  fetched: number;
  applied: number;
  skipped: number;
  conflictsOpened: number;
  pendingConflictResolves: number;
  fastForwardedPaths: RelayMaterializedPath[];
  // The relay cursor this pull reached. NOT persisted by the pull itself:
  // the caller must invoke commitFetchCursor() only after fastForwardedPaths
  // has been materialized to disk. A crash or materialization failure before
  // the commit leaves the cursor behind, so the next pass re-fetches and
  // re-reports the owed disk work instead of permanently skipping remote
  // ops (which would let a later disk reconciliation overwrite pulled engine
  // state with stale disk content).
  nextCursor: number;
  commitFetchCursor: () => Promise<void>;
}

export interface PushWorkspaceToRelayResult {
  pushed: number;
  originsPushed: string[];
}

export class RelayUnauthorizedError extends Error {
  constructor(message = "Relay authorization failed.") {
    super(message);
    this.name = "RelayUnauthorizedError";
  }
}

export class RelayWorkspaceUnavailableError extends Error {
  constructor(message = "Relay workspace is unavailable.") {
    super(message);
    this.name = "RelayWorkspaceUnavailableError";
  }
}

export class RelayConflictError extends Error {
  constructor(message = "Relay rejected the operation batch.") {
    super(message);
    this.name = "RelayConflictError";
  }
}

// The relay log for THIS origin disagrees with the local journal (the relay
// is ahead of local reality, or holds the same origin seq with different
// content). That means the local engine.db was restored/cloned from an older
// snapshot — pushing must fail closed rather than silently drop local ops.
// Recovering via an origin reset is 0P-C follow-up work.
export class RelayOriginDivergedError extends Error {
  constructor(message = "Relay log for this origin diverged from the local journal.") {
    super(message);
    this.name = "RelayOriginDivergedError";
  }
}

// The relay served the workspace but is missing a blob the log references —
// distinct from the fixed absent-workspace 404 so sync can degrade honestly
// instead of reporting the whole workspace unavailable.
export class RelayBlobMissingError extends Error {
  constructor(message = "Relay is missing a referenced blob.") {
    super(message);
    this.name = "RelayBlobMissingError";
  }
}

interface RelayLogPostResult {
  ok: boolean;
  accepted: number;
  inserted: number;
  skipped: number;
  currentMaxOriginSeq: number;
}

interface RelayLogPage {
  ok: boolean;
  ops: Array<{
    relaySeq: number;
    workspaceId: string;
    originId: string;
    originSeq: number;
    opKind: SyncReplicationOpKind;
    payload: unknown;
    recordedAtMs: number;
  }>;
  nextCursor: number;
  hasMore: boolean;
}

function relayFetch(relay: SyncRelayConnection): typeof fetch {
  return relay.fetch ?? fetch;
}

function relayUrl(relay: SyncRelayConnection, path: string): string {
  return `${relay.baseUrl.replace(/\/+$/u, "")}${path}`;
}

async function requestRelay(
  relay: SyncRelayConnection,
  path: string,
  init: RequestInit = {},
  options: { mapNotFound?: (response: Response) => Promise<Error> } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${relay.token}`);
  const response = await relayFetch(relay)(relayUrl(relay, path), { ...init, headers });
  if (response.status === 401) throw new RelayUnauthorizedError();
  if (response.status === 404) {
    throw options.mapNotFound ? await options.mapNotFound(response) : new RelayWorkspaceUnavailableError();
  }
  return response;
}

async function jsonRelay<T>(
  relay: SyncRelayConnection,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await requestRelay(relay, path, init);
  if (response.status === 409) throw new RelayConflictError();
  if (!response.ok) throw new Error(`Relay request failed (${response.status})`);
  return (await response.json()) as T;
}

function rowToOp(row: Record<string, unknown>): SyncReplicationEnvelope {
  return {
    workspaceId: String(row.workspace_id),
    originId: String(row.origin_id),
    originSeq: Number(row.origin_seq),
    opKind: String(row.op_kind) as SyncReplicationOpKind,
    payload: JSON.parse(String(row.payload_json)) as never,
    recordedAtMs: Number(row.recorded_at_ms),
  } as SyncReplicationEnvelope;
}

function readPushedSeq(db: EngineSqliteDb, workspaceId: WorkspaceId, originId: string): number {
  const row = db
    .prepare(
      "SELECT pushed_seq FROM sync_relay_push_state WHERE workspace_id = ? AND origin_id = ?",
    )
    .get(workspaceId, originId);
  return Number(row?.pushed_seq ?? -1);
}

function writePushedSeq(
  db: EngineSqliteDb,
  workspaceId: WorkspaceId,
  originId: string,
  pushedSeq: number,
): void {
  db.prepare(
    `INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id, origin_id) DO UPDATE SET
       pushed_seq = excluded.pushed_seq`,
  ).run(workspaceId, originId, pushedSeq);
}

function readFetchCursor(db: EngineSqliteDb, workspaceId: WorkspaceId): number {
  const row = db
    .prepare("SELECT relay_fetch_cursor FROM sync_relay_cursors WHERE workspace_id = ?")
    .get(workspaceId);
  return Number(row?.relay_fetch_cursor ?? 0);
}

function writeFetchCursor(db: EngineSqliteDb, workspaceId: WorkspaceId, cursor: number): void {
  db.prepare(
    `INSERT INTO sync_relay_cursors (workspace_id, relay_fetch_cursor)
     VALUES (?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       relay_fetch_cursor = excluded.relay_fetch_cursor`,
  ).run(workspaceId, cursor);
}

function collectBlobHashes(ops: readonly SyncReplicationEnvelope[]): {
  text: Set<string>;
  binary: Set<string>;
} {
  const text = new Set<string>();
  const binary = new Set<string>();
  for (const op of ops) {
    const refs = collectBlobHashesFromOp(op);
    for (const sha of refs.text) text.add(sha);
    for (const sha of refs.binary) binary.add(sha);
  }
  return { text, binary };
}

function readBlobBytes(db: EngineSqliteDb, sha: string, kind: "text" | "binary"): Uint8Array {
  if (kind === "text") {
    const row = db.prepare("SELECT text FROM blobs WHERE sha256 = ?").get(sha);
    if (typeof row?.text !== "string") {
      throw new VersionedTextStoreError("state-corrupt", `Missing blob ${sha} for relay push.`);
    }
    const bytes = Buffer.from(row.text, "utf8");
    if (sha256Hex(row.text) !== sha) {
      throw new VersionedTextStoreError("state-corrupt", `Blob ${sha} does not match its hash.`);
    }
    return bytes;
  }
  const row = db.prepare("SELECT content FROM binary_blobs WHERE sha256 = ?").get(sha);
  const content = row?.content;
  const bytes = Buffer.isBuffer(content)
    ? content
    : content instanceof Uint8Array
      ? Buffer.from(content)
      : null;
  if (!bytes) {
    throw new VersionedTextStoreError("state-corrupt", `Missing binary blob ${sha} for relay push.`);
  }
  if (sha256Hex(bytes) !== sha) {
    throw new VersionedTextStoreError("state-corrupt", `Binary blob ${sha} does not match its hash.`);
  }
  return bytes;
}

async function uploadMissingBlobs(
  db: EngineSqliteDb,
  relay: SyncRelayConnection,
  workspaceId: WorkspaceId,
  ops: readonly SyncReplicationEnvelope[],
): Promise<void> {
  const refs = collectBlobHashes(ops);
  const all = [...new Set([...refs.text, ...refs.binary])];
  for (let offset = 0; offset < all.length; offset += 2000) {
    const sha256s = all.slice(offset, offset + 2000);
    if (sha256s.length === 0) continue;
    const have = await jsonRelay<{ ok: boolean; missing: string[] }>(
      relay,
      `/sync/${encodeURIComponent(workspaceId)}/blobs/have`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sha256s }),
      },
    );
    for (const sha of have.missing) {
      const kind = refs.binary.has(sha) ? "binary" : "text";
      const bytes = readBlobBytes(db, sha, kind);
      const response = await requestRelay(
        relay,
        `/sync/${encodeURIComponent(workspaceId)}/blobs/${sha}`,
        {
          method: "PUT",
          body: Buffer.from(bytes),
        },
      );
      if (!response.ok) throw new Error(`Relay blob upload failed (${response.status})`);
    }
  }
}

async function appendOriginOps(
  relay: SyncRelayConnection,
  workspaceId: WorkspaceId,
  originId: string,
  ops: readonly SyncReplicationEnvelope[],
): Promise<RelayLogPostResult> {
  return jsonRelay<RelayLogPostResult>(relay, `/sync/${encodeURIComponent(workspaceId)}/log`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      originId,
      ops: ops.map(({ originSeq, opKind, payload, recordedAtMs }) => ({
        originSeq,
        opKind,
        payload,
        recordedAtMs,
      })),
    }),
  });
}

async function probeOrigin(
  relay: SyncRelayConnection,
  workspaceId: WorkspaceId,
  originId: string,
): Promise<number> {
  const result = await appendOriginOps(relay, workspaceId, originId, []);
  return result.currentMaxOriginSeq;
}

function readOpsAboveCursor(
  db: EngineSqliteDb,
  workspaceId: WorkspaceId,
  originId: string,
  pushedSeq: number,
): SyncReplicationEnvelope[] {
  return db
    .prepare(
      `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms
       FROM replication_log
       WHERE workspace_id = ? AND origin_id = ? AND origin_seq > ?
       ORDER BY origin_seq`,
    )
    .all(workspaceId, originId, pushedSeq)
    .map(rowToOp);
}

function readLocalMaxOriginSeq(
  db: EngineSqliteDb,
  workspaceId: WorkspaceId,
  originId: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(origin_seq), -1) AS max_seq
       FROM replication_log
       WHERE workspace_id = ? AND origin_id = ?`,
    )
    .get(workspaceId, originId);
  return Number(row?.max_seq ?? -1);
}

export async function pushWorkspaceToRelay(
  input: SyncRelayInput,
): Promise<PushWorkspaceToRelayResult> {
  const db = openEngineDb(input.rootDir);
  try {
    const originIds = db
      .prepare(
        `SELECT DISTINCT origin_id
         FROM replication_log
         WHERE workspace_id = ?
         ORDER BY origin_id`,
      )
      .all(input.workspaceId)
      .map((row) => String(row.origin_id));
    let pushed = 0;
    const originsPushed: string[] = [];
    for (const originId of originIds) {
      // pushed_seq must NEVER advance past the local journal's max for this
      // origin: a relay that is ahead of local reality (or that holds a
      // local seq with different content) means the local engine.db was
      // restored/cloned from an older snapshot. Advancing the cursor anyway
      // would silently mark local ops as pushed forever — fail closed
      // instead (origin reset recovery is 0P-C follow-up).
      const localMax = readLocalMaxOriginSeq(db, input.workspaceId, originId);
      const divergedError = (relayMax: number): RelayOriginDivergedError =>
        new RelayOriginDivergedError(
          `Relay log for origin ${originId} diverged from the local journal ` +
            `(relay max seq ${relayMax}, local max seq ${localMax}). The local ` +
            "engine.db looks restored or cloned from an older snapshot; refusing " +
            "to push. Recovering requires an origin reset (0P-C).",
        );
      let cursor = readPushedSeq(db, input.workspaceId, originId);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const ops = readOpsAboveCursor(db, input.workspaceId, originId, cursor);
        if (ops.length === 0) break;
        await uploadMissingBlobs(db, input.relay, input.workspaceId, ops);
        try {
          const result = await appendOriginOps(input.relay, input.workspaceId, originId, ops);
          if (result.currentMaxOriginSeq > localMax) throw divergedError(result.currentMaxOriginSeq);
          writePushedSeq(db, input.workspaceId, originId, result.currentMaxOriginSeq);
          pushed += result.inserted;
          originsPushed.push(originId);
          break;
        } catch (error) {
          if (!(error instanceof RelayConflictError) || attempt > 0) throw error;
          const probed = await probeOrigin(input.relay, input.workspaceId, originId);
          // A 409 is only recoverable when the relay is BEHIND our cursor
          // (relay-side data loss): rewind and re-send. A 409 with the relay
          // at/above our cursor means it already holds these seqs with
          // DIFFERENT content — same-origin divergence, fail closed.
          if (probed > localMax || probed >= cursor) throw divergedError(probed);
          cursor = probed;
          writePushedSeq(db, input.workspaceId, originId, cursor);
        }
      }
    }
    return { pushed, originsPushed };
  } finally {
    db.close();
  }
}

function queueByOrigin(ops: SyncReplicationEnvelope[]): SyncReplicationEnvelope[][] {
  const byOrigin = new Map<string, SyncReplicationEnvelope[]>();
  for (const op of ops) {
    const bucket = byOrigin.get(op.originId) ?? [];
    bucket.push(op);
    byOrigin.set(op.originId, bucket);
  }
  return [...byOrigin.values()].map((queue) =>
    queue.sort((left, right) => left.originSeq - right.originSeq),
  );
}

async function fetchRelayBlob(
  relay: SyncRelayConnection,
  workspaceId: WorkspaceId,
  sha: string,
  kind: "text" | "binary",
): Promise<string | Uint8Array> {
  const response = await requestRelay(
    relay,
    `/sync/${encodeURIComponent(workspaceId)}/blobs/${sha}`,
    {},
    {
      // The relay distinguishes a missing blob in an owned workspace
      // (code "blob_not_found") from the fixed absent-workspace 404. Map the
      // former to its own error so sync degrades honestly instead of
      // reporting the whole workspace unavailable.
      mapNotFound: async (notFoundResponse) => {
        const body = (await notFoundResponse.json().catch(() => null)) as {
          code?: unknown;
        } | null;
        if (body?.code === "blob_not_found") {
          return new RelayBlobMissingError(
            `Relay is missing blob ${sha} referenced by the workspace log.`,
          );
        }
        return new RelayWorkspaceUnavailableError();
      },
    },
  );
  if (!response.ok) throw new Error(`Relay blob download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256Hex(bytes) !== sha) {
    throw new VersionedTextStoreError("state-corrupt", `Relay blob ${sha} failed hash verification.`);
  }
  return kind === "text" ? Buffer.from(bytes).toString("utf8") : bytes;
}

type SnapshotSummary = { contentKind: "text" | "binary"; text: string; sha256?: string } | null;

async function activeSnapshotMap(
  rootDir: string,
  workspaceId: WorkspaceId,
  paths: Iterable<string>,
): Promise<Map<string, SnapshotSummary>> {
  const store = createVersionedTextStore(rootDir);
  try {
    const active = await store.getActiveVersion({ workspaceId });
    const versionId = active?.id ?? "main";
    const result = new Map<string, SnapshotSummary>();
    for (const path of paths) {
      const snapshot = await store.readTextFile({ workspaceId, versionId, path }).catch(() => null);
      result.set(path, summarizeSnapshot(snapshot));
    }
    return result;
  } finally {
    await store.close();
  }
}

function summarizeSnapshot(snapshot: TextFileSnapshot | null): SnapshotSummary {
  if (!snapshot) return null;
  return {
    contentKind: (snapshot.contentKind ?? "text") === "binary" ? "binary" : "text",
    text: snapshot.text,
    ...(snapshot.sha256 ? { sha256: snapshot.sha256 } : {}),
  };
}

function snapshotChanged(before: SnapshotSummary, after: SnapshotSummary): boolean {
  if (before === null || after === null) return before !== after;
  if (before.contentKind !== after.contentKind) return true;
  return before.contentKind === "binary" ? before.sha256 !== after.sha256 : before.text !== after.text;
}

function candidateMaterializationPaths(ops: readonly SyncReplicationEnvelope[]): Set<string> {
  const paths = new Set<string>();
  for (const op of ops) {
    if (op.opKind !== "moment.append") continue;
    for (const path of [
      op.payload.path,
      op.payload.payloadAfterPath,
      op.payload.payloadBeforePath,
      op.payload.beforePath,
    ]) {
      if (typeof path === "string" && path.length > 0) paths.add(path);
    }
  }
  return paths;
}

export async function pullWorkspaceFromRelay(
  input: SyncRelayInput,
): Promise<PullWorkspaceFromRelayResult> {
  const initialDb = openEngineDb(input.rootDir);
  const since = readFetchCursor(initialDb, input.workspaceId);
  // The LOCAL origin id (null on a pull-only replica that never journaled).
  // Own-origin ops pulled back from the relay never owe disk work; remote
  // ops always might (see the retry note below).
  const localOriginRow = initialDb
    .prepare("SELECT origin_id FROM sync_identity WHERE workspace_id = ?")
    .get(input.workspaceId);
  const localOriginId =
    typeof localOriginRow?.origin_id === "string" ? localOriginRow.origin_id : null;
  initialDb.close();

  let cursor = since;
  let fetched = 0;
  const ops: SyncReplicationEnvelope[] = [];
  for (;;) {
    const page = await jsonRelay<RelayLogPage>(
      input.relay,
      `/sync/${encodeURIComponent(input.workspaceId)}/log?since=${cursor}&limit=500`,
    );
    for (const row of page.ops) {
      ops.push({
        workspaceId: input.workspaceId,
        originId: row.originId,
        originSeq: row.originSeq,
        opKind: row.opKind,
        payload: row.payload,
        recordedAtMs: row.recordedAtMs,
      } as SyncReplicationEnvelope);
    }
    fetched += page.ops.length;
    // Forward-progress guard: a buggy or malicious relay claiming hasMore
    // without advancing the cursor must abort the pass, not spin forever.
    if (page.hasMore && page.nextCursor <= cursor) {
      throw new Error("Relay log pagination did not advance; aborting pull.");
    }
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  const commitFetchCursor = async (): Promise<void> => {
    const db = openEngineDb(input.rootDir);
    try {
      writeFetchCursor(db, input.workspaceId, cursor);
    } finally {
      db.close();
    }
  };
  if (ops.length === 0) {
    return {
      fetched,
      applied: 0,
      skipped: 0,
      conflictsOpened: 0,
      pendingConflictResolves: 0,
      fastForwardedPaths: [],
      nextCursor: cursor,
      commitFetchCursor,
    };
  }

  const paths = candidateMaterializationPaths(ops);
  const before = await activeSnapshotMap(input.rootDir, input.workspaceId, paths);
  const result = await applySyncQueues({
    rootDir: input.rootDir,
    workspaceId: input.workspaceId,
    queues: queueByOrigin(ops),
    blobSource: (sha, kind) => fetchRelayBlob(input.relay, input.workspaceId, sha, kind),
  });
  const after = await activeSnapshotMap(input.rootDir, input.workspaceId, paths);
  const fastForwardedPaths: RelayMaterializedPath[] = [];
  for (const path of paths) {
    const beforeSnapshot = before.get(path) ?? null;
    const afterSnapshot = after.get(path) ?? null;
    if (!snapshotChanged(beforeSnapshot, afterSnapshot)) continue;
    fastForwardedPaths.push(
      afterSnapshot
        ? { path, operation: "write", contentKind: afterSnapshot.contentKind }
        : {
            path,
            operation: "delete",
            contentKind: beforeSnapshot?.contentKind ?? "text",
          },
    );
  }

  // Retry safety for the cursor-commit contract: ops below the un-committed
  // cursor are re-fetched after a failed materialization, but their re-apply
  // is an idempotent SKIP — the before/after diff alone would silently drop
  // the still-owed disk work. Re-report every skipped REMOTE-origin write
  // path whose active snapshot exists; materialization writes the engine's
  // own active content under expected-event suppression, so a redundant
  // write is a harmless no-op. Own-origin echoes stay excluded (disk already
  // led the engine for those). Deletes intentionally ride the diff only:
  // reporting a delete for a path a skipped op merely REFERENCES (e.g. a
  // rename's before path that never existed here) could remove an untracked
  // user file.
  const { skippedOps, ...applyCounts } = result;
  const reported = new Set(fastForwardedPaths.map((entry) => entry.path));
  const skippedRemotePaths = candidateMaterializationPaths(
    skippedOps.filter((op) => op.originId !== localOriginId),
  );
  for (const path of skippedRemotePaths) {
    if (reported.has(path)) continue;
    const snapshot = after.get(path) ?? null;
    if (!snapshot) continue;
    fastForwardedPaths.push({ path, operation: "write", contentKind: snapshot.contentKind });
  }

  return { fetched, ...applyCounts, fastForwardedPaths, nextCursor: cursor, commitFetchCursor };
}

export async function claimRelayWorkspace(input: {
  workspaceId: WorkspaceId;
  relay: SyncRelayConnection;
}): Promise<void> {
  await jsonRelay(input.relay, "/sync/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: input.workspaceId }),
  });
}
