import { randomUUID } from "node:crypto";
import type {
  SyncReplicationEnvelope,
  SyncReplicationOpKind,
  TextFileSnapshot,
  WorkspaceId,
} from "@dohc/workspace-contracts/engine";
import {
  RelayBlobMissingError,
  RelayConflictError,
  RelayKeyEnvelopeMissingError,
  RelayOriginDivergedError,
  RelayUnauthorizedError,
  RelayWorkspaceUnavailableError,
  type ProbeRelayWorkspaceResult,
  type PullWorkspaceFromRelayResult,
  type PushWorkspaceToRelayResult,
  type RecoverRelayOriginResult,
  type RelayMaterializedPath,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { VersionedTextStoreError, createVersionedTextStore } from "./versionedTextStore";
import { journalReplicationOp } from "./syncReplication";
import {
  applySyncQueues,
  collectBlobHashesFromOp,
  openEngineDb,
  sha256Hex,
} from "./syncApply";
import type { EngineSqliteDb } from "./engineDbSchema";

export interface SyncRelayInput {
  rootDir: string;
  workspaceId: WorkspaceId;
  relay: SyncRelayConnection;
  // Injectable id seam (oracle/tests) used by recoverRelayOrigin when minting a
  // fresh origin id on orphan-op reconciliation. Omitted ⇒ a real random origin
  // id, identical to today's behavior.
  createId?: () => string;
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

// The relay rejects log appends above its per-request op cap (server
// MAX_OPS_PER_REQUEST = 500). The push chunks to the same bound so a large
// first sync — e.g. joining pushes back, or enabling sync on a workspace
// with a long history — lands as several contiguous batches instead of one
// oversized request that would fail every retry forever.
const MAX_PUSH_OPS_PER_BATCH = 500;

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

// Key-order-independent JSON form for byte-comparing op payloads: the journal
// serializes with plain JSON.stringify (writer key order) while the relay
// stores a sorted-key canonical form, so equality must be decided on content,
// not on the accidental serialization. Mirrors the relay's stableJsonStringify.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
      let originPushedAnything = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const ops = readOpsAboveCursor(db, input.workspaceId, originId, cursor);
        if (ops.length === 0) break;
        await uploadMissingBlobs(db, input.relay, input.workspaceId, ops);
        try {
          // Contiguous chunks within the relay's per-request cap; the pushed
          // cursor commits after EVERY accepted chunk so an interruption
          // resumes where it stopped instead of replaying the whole backlog.
          for (let offset = 0; offset < ops.length; offset += MAX_PUSH_OPS_PER_BATCH) {
            const batch = ops.slice(offset, offset + MAX_PUSH_OPS_PER_BATCH);
            const result = await appendOriginOps(input.relay, input.workspaceId, originId, batch);
            if (result.currentMaxOriginSeq > localMax) {
              throw divergedError(result.currentMaxOriginSeq);
            }
            writePushedSeq(db, input.workspaceId, originId, result.currentMaxOriginSeq);
            cursor = result.currentMaxOriginSeq;
            pushed += result.inserted;
            originPushedAnything = true;
          }
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
      if (originPushedAnything) originsPushed.push(originId);
    }
    return { pushed, originsPushed };
  } finally {
    db.close();
  }
}

// Canonical (sorted-key) JSON so a local payload and the relay's stored copy
// compare equal regardless of key order (the real relay canonicalizes on
// append; a raw JSON.stringify would not match).
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// Recovery for RelayOriginDivergedError (0P sync-hardening item 3). When a
// machine's engine.db is restored-from-older or cloned, its local origin's
// sequence space collides with the relay's authoritative record for that
// origin and push fails closed with RelayOriginDivergedError — with no way
// forward. This re-baselines the machine onto a FRESH origin id so it can
// resync WITHOUT losing local-only unpushed work:
//   - the shared history prefix (leading ops the relay also holds
//     byte-identically) stays under the old origin and is marked fully pushed,
//     so the old origin is never pushed again;
//   - genuinely-unpushed / divergent local ops ("orphans") are re-journaled
//     under the fresh origin so they push cleanly and, where they clash with
//     the relay's authoritative lineage, surface as ordinary sync conflicts on
//     the next pull — never silently dropped;
//   - the orphan rows are removed from the OLD origin's journal so the relay's
//     authoritative versions at those sequence numbers apply as REMOTE ops on
//     the next pull (opening the preservation conflict) instead of being
//     idempotently skipped;
//   - the relay fetch cursor resets so the next pull re-ingests the relay's
//     authoritative tail (idempotent for everything already applied).
// Idempotent-safe: if there is no divergence (relay holds every local op), it
// still mints a fresh origin with zero preserved ops and leaves state syncing.
export async function recoverRelayOrigin(
  input: SyncRelayInput,
): Promise<RecoverRelayOriginResult> {
  interface LocalOp {
    originSeq: number;
    opKind: SyncReplicationOpKind;
    payloadJson: string;
    recordedAtMs: number;
  }
  const readDb = openEngineDb(input.rootDir);
  let oldOriginId: string;
  let localOps: LocalOp[];
  try {
    const originRow = readDb
      .prepare("SELECT origin_id FROM sync_identity WHERE workspace_id = ?")
      .get(input.workspaceId);
    if (typeof originRow?.origin_id !== "string") {
      throw new VersionedTextStoreError(
        "invalid-workspace",
        `Cannot recover relay origin: workspace ${input.workspaceId} has no local sync identity.`,
      );
    }
    oldOriginId = originRow.origin_id;
    localOps = readDb
      .prepare(
        `SELECT origin_seq, op_kind, payload_json, recorded_at_ms
         FROM replication_log
         WHERE workspace_id = ? AND origin_id = ?
         ORDER BY origin_seq`,
      )
      .all(input.workspaceId, oldOriginId)
      .map((row) => ({
        originSeq: Number(row.origin_seq),
        opKind: String(row.op_kind) as SyncReplicationOpKind,
        payloadJson: String(row.payload_json),
        recordedAtMs: Number(row.recorded_at_ms),
      }));
  } finally {
    readDb.close();
  }

  // Fetch the relay's authoritative ops for the old origin (canonicalized).
  const relayOpsBySeq = new Map<
    number,
    { opKind: string; payloadJson: string; recordedAtMs: number }
  >();
  let cursor = 0;
  for (;;) {
    const page = await jsonRelay<RelayLogPage>(
      input.relay,
      `/sync/${encodeURIComponent(input.workspaceId)}/log?since=${cursor}&limit=500`,
    );
    for (const row of page.ops) {
      if (row.originId === oldOriginId) {
        relayOpsBySeq.set(row.originSeq, {
          opKind: row.opKind,
          payloadJson: stableStringify(row.payload),
          recordedAtMs: row.recordedAtMs,
        });
      }
    }
    if (page.hasMore && page.nextCursor <= cursor) {
      throw new Error("Relay log pagination did not advance; aborting origin recovery.");
    }
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }

  // Longest leading run of local ops the relay holds byte-identically.
  let sharedPrefixLength = 0;
  for (const op of localOps) {
    if (op.originSeq !== sharedPrefixLength) break; // a gap ends the prefix
    const relayOp = relayOpsBySeq.get(op.originSeq);
    if (
      !relayOp ||
      relayOp.opKind !== op.opKind ||
      relayOp.recordedAtMs !== op.recordedAtMs ||
      relayOp.payloadJson !== stableStringify(JSON.parse(op.payloadJson))
    ) {
      break;
    }
    sharedPrefixLength += 1;
  }
  const orphanOps = localOps.filter((op) => op.originSeq >= sharedPrefixLength);

  const writeDb = openEngineDb(input.rootDir);
  try {
    writeDb.exec("BEGIN IMMEDIATE");
    try {
      const newOriginId = input.createId?.() ?? `origin_${randomUUID()}`;
      // Re-journal orphan ops under the fresh origin with contiguous seqs.
      orphanOps.forEach((op, index) => {
        journalReplicationOp(writeDb, {
          workspaceId: input.workspaceId,
          originId: newOriginId,
          originSeq: index,
          opKind: op.opKind,
          payload: JSON.parse(op.payloadJson),
          recordedAtMs: op.recordedAtMs,
        });
      });
      // Drop orphan rows from the OLD origin so the relay's authoritative
      // versions at those seqs apply as REMOTE ops (opening the preservation
      // conflict) instead of being idempotently skipped on the next pull.
      writeDb
        .prepare(
          `DELETE FROM replication_log
           WHERE workspace_id = ? AND origin_id = ? AND origin_seq >= ?`,
        )
        .run(input.workspaceId, oldOriginId, sharedPrefixLength);
      // Adopt the fresh origin for all future local writes.
      writeDb
        .prepare("UPDATE sync_identity SET origin_id = ? WHERE workspace_id = ?")
        .run(newOriginId, input.workspaceId);
      // The old origin is authoritative on the relay; never push it again.
      writeDb
        .prepare(
          `INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq)
           VALUES (?, ?, ?)
           ON CONFLICT(workspace_id, origin_id) DO UPDATE SET pushed_seq = excluded.pushed_seq`,
        )
        .run(input.workspaceId, oldOriginId, sharedPrefixLength - 1);
      // Clamp the old origin's INBOUND ack down to the shared prefix (0P
      // sync-hardening item 5 gate fix). This machine has already ACKED its own
      // old-origin ops back from the relay, so replication_peers.acked_seq for
      // the old origin can sit at/above the relay's authoritative tail. The
      // pull's fast path (`originSeq <= ackedSeq` -> skip) runs BEFORE the
      // imported-log-exists check, so without this clamp the divergent
      // old-origin relay tail (seqs >= sharedPrefixLength, whose local journal
      // rows we just deleted) would be silently skipped and NEVER materialize
      // as a conflict -- the relay's version of that work would be lost. Only
      // lowers (never raises) an existing ack.
      writeDb
        .prepare(
          `UPDATE replication_peers SET acked_seq = ?
           WHERE workspace_id = ? AND origin_id = ? AND acked_seq > ?`,
        )
        .run(
          sharedPrefixLength - 1,
          input.workspaceId,
          oldOriginId,
          sharedPrefixLength - 1,
        );
      // The fresh origin has pushed nothing yet.
      writeDb
        .prepare(
          "DELETE FROM sync_relay_push_state WHERE workspace_id = ? AND origin_id = ?",
        )
        .run(input.workspaceId, newOriginId);
      // Re-pull the relay's authoritative tail from scratch (idempotent for
      // everything already applied; surfaces the divergent tail as conflicts).
      writeDb
        .prepare(
          `INSERT INTO sync_relay_cursors (workspace_id, relay_fetch_cursor)
           VALUES (?, 0)
           ON CONFLICT(workspace_id) DO UPDATE SET relay_fetch_cursor = 0`,
        )
        .run(input.workspaceId);
      writeDb.exec("COMMIT");
      return {
        oldOriginId,
        newOriginId,
        sharedPrefixLength,
        preservedOps: orphanOps.length,
      };
    } catch (error) {
      try {
        writeDb.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  } finally {
    writeDb.close();
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
    if (op.opKind === "conflict.resolve") {
      // A mirrored resolution can change the active snapshot on THIS machine
      // (the peer kept its own copy and the apply adopts it here) — the
      // conflict's path must ride the before/after materialization diff or
      // the engine would update while the file on disk stays stale.
      const payload = op.payload as { path?: unknown };
      if (typeof payload.path === "string" && payload.path.length > 0) {
        paths.add(payload.path);
      }
      continue;
    }
    if (op.opKind === "ydoc.update") {
      // The apply re-projects the converged Y.Doc into this path's markdown
      // snapshot (a local, non-journaling settle), so the path must ride the
      // materialization diff or the on-disk file would stay stale after a pull.
      if (typeof op.payload.path === "string" && op.payload.path.length > 0) {
        paths.add(op.payload.path);
      }
      continue;
    }
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
      pendingResolves: [],
      fastForwardedPaths: [],
      nextCursor: cursor,
      commitFetchCursor,
    };
  }

  // MU-C4 gate fix: relay-learned FOREIGN-origin ops are by definition
  // already at the relay and must never become re-push candidates.
  // pushWorkspaceToRelay scans EVERY distinct origin in the local journal, so
  // ops that entered it through this pull (e.g. member appends landed in the
  // owner's bucket under share-namespaced origins) would otherwise be offered
  // back — and the relay's MU-C0 authorship gate 403s member-authored chat
  // ops pushed by the owner, wedging the owner's sync permanently. Advance
  // the pushed watermark to exactly the seqs FETCHED FROM THE RELAY (never
  // backwards, never past them): bundle-imported foreign ops the relay never
  // served stay above the watermark and remain pushable.
  //
  // DIVERGENCE GUARD (adversarial-review follow-up): the imported-op apply is
  // idempotent on COORDINATES ONLY (importedReplicationLogExists never
  // byte-compares), so a fetched op colliding with an EXISTING local row must
  // be byte-compared HERE before it may count toward the watermark. Identical
  // row = a true idempotent echo, safe to watermark. Different row = the same
  // same-origin divergence the push path fails closed on (syncRelay push's
  // RelayOriginDivergedError) — watermarking past it would silently retire
  // the local op AND hide the divergence forever, so refuse the whole pass
  // before anything is applied or persisted. Recovery stays an origin reset
  // (0P-C), exactly like push-time divergence.
  const maxPulledByOrigin = new Map<string, number>();
  {
    const db = openEngineDb(input.rootDir);
    try {
      const localRowStmt = db.prepare(
        `SELECT op_kind, payload_json, recorded_at_ms FROM replication_log
         WHERE workspace_id = ? AND origin_id = ? AND origin_seq = ?`,
      );
      for (const op of ops) {
        if (op.originId === localOriginId) continue;
        // Relay-fed coordinates are untrusted (same posture as the
        // shared-channel pull's validSharedLogOp): a malformed originSeq must
        // never reach the divergence lookup or the watermark map. The apply
        // below fail-closes on such an op anyway (envelope validation + gap
        // check reject the whole pass), but the watermark must stay
        // fail-closed on its own, independent of apply semantics.
        if (!Number.isSafeInteger(op.originSeq) || op.originSeq < 0) continue;
        const existing = localRowStmt.get(input.workspaceId, op.originId, op.originSeq);
        if (existing) {
          const identical =
            String(existing.op_kind) === op.opKind &&
            Number(existing.recorded_at_ms) === op.recordedAtMs &&
            canonicalJson(JSON.parse(String(existing.payload_json))) === canonicalJson(op.payload);
          if (!identical) {
            throw new RelayOriginDivergedError(
              `Relay log for origin ${op.originId} diverged from the local journal at ` +
                `seq ${op.originSeq}: the relay serves different content for an op this ` +
                "workspace already holds, and the coordinate-idempotent apply would hide " +
                "it. Refusing to mark the local op as pushed. Recovering requires an " +
                "origin reset (0P-C).",
            );
          }
        }
        const current = maxPulledByOrigin.get(op.originId) ?? -1;
        if (op.originSeq > current) maxPulledByOrigin.set(op.originId, op.originSeq);
      }
    } finally {
      db.close();
    }
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

  // Commit the pushed watermarks computed (and divergence-vetted) above, now
  // that the apply landed.
  if (maxPulledByOrigin.size > 0) {
    const db = openEngineDb(input.rootDir);
    try {
      for (const [originId, maxSeq] of maxPulledByOrigin) {
        if (maxSeq > readPushedSeq(db, input.workspaceId, originId)) {
          writePushedSeq(db, input.workspaceId, originId, maxSeq);
        }
      }
    } finally {
      db.close();
    }
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

// Cheap pre-flight for the desktop join flow: fetch the FIRST log page only
// (no engine store, no disk writes). Distinguishes "no such workspace for
// this account" (the relay's fixed 404 -> RelayWorkspaceUnavailableError)
// from "claimed but nothing synced yet" (an owned workspace with an empty
// log). The join flow refuses both before it creates any local state, so a
// mistyped code can never mint an empty local workspace.
export async function probeRelayWorkspace(input: {
  workspaceId: WorkspaceId;
  relay: SyncRelayConnection;
}): Promise<ProbeRelayWorkspaceResult> {
  const page = await jsonRelay<RelayLogPage>(
    input.relay,
    `/sync/${encodeURIComponent(input.workspaceId)}/log?since=0&limit=1`,
  );
  return { hasContent: page.ops.length > 0 };
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

// The relay's PUT /keys is create-only on first write and compare-and-swap
// (If-Match: sha256 of the current envelope) thereafter, so a stale client can
// never silently clobber a newer wrapped key. This uploader is only reached
// when the local machine HOLDS the workspace data key (the enroll/re-wrap
// path), so replacing an existing envelope with a fresh wrap of that key is a
// deliberate, legitimate write: on conflict it reads the current fingerprint
// and retries the CAS a bounded number of times, then fails loudly. Replaced
// envelopes are retained server-side in an audit history.
export async function uploadKeyEnvelope(input: {
  workspaceId: WorkspaceId;
  relay: SyncRelayConnection;
  envelopeJson: string;
}): Promise<void> {
  const path = `/sync/${encodeURIComponent(input.workspaceId)}/keys`;
  let ifMatch: string | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (ifMatch !== null) headers["if-match"] = `"${ifMatch}"`;
    const response = await requestRelay(input.relay, path, {
      method: "PUT",
      headers,
      body: input.envelopeJson,
    });
    if (response.ok) return;
    if (response.status !== 409) {
      throw new Error(`Relay key envelope upload failed (${response.status})`);
    }
    // Conflict: an envelope already exists (or was replaced under us). Read
    // its current fingerprint and retry as an explicit replacement.
    let current: Response;
    try {
      current = await requestRelay(input.relay, path, {});
    } catch (error) {
      if (error instanceof RelayKeyEnvelopeMissingError || error instanceof RelayWorkspaceUnavailableError) {
        // Envelope vanished between the PUT and the GET; retry create-only.
        ifMatch = null;
        continue;
      }
      throw error;
    }
    if (!current.ok) {
      throw new Error(`Relay key envelope upload failed (${current.status})`);
    }
    await current.arrayBuffer().catch(() => undefined);
    const etag = current.headers.get("etag");
    const fingerprint = etag?.trim().replace(/^"(.*)"$/u, "$1") ?? null;
    if (!fingerprint || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
      throw new RelayConflictError(
        "Relay key envelope already exists but did not expose a fingerprint to replace it.",
      );
    }
    ifMatch = fingerprint;
  }
  throw new RelayConflictError(
    "Relay key envelope kept changing concurrently; upload did not complete.",
  );
}

export async function downloadKeyEnvelope(input: {
  workspaceId: WorkspaceId;
  relay: SyncRelayConnection;
}): Promise<string> {
  const response = await requestRelay(
    input.relay,
    `/sync/${encodeURIComponent(input.workspaceId)}/keys`,
    {},
    {
      mapNotFound: async (notFoundResponse) => {
        const body = (await notFoundResponse.json().catch(() => null)) as {
          code?: unknown;
        } | null;
        if (body?.code === "key_envelope_not_found") {
          return new RelayKeyEnvelopeMissingError();
        }
        return new RelayWorkspaceUnavailableError();
      },
    },
  );
  if (!response.ok) throw new Error(`Relay key envelope download failed (${response.status})`);
  return response.text();
}
