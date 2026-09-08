import { type StorageContext } from "./context";
import { type SyncRelayLogRow, type ThreadFileBinding, type ObjectMomentRow } from "./types";
import { SHARED_BLOB_CANDIDATE_LIMIT } from "./limits";
import { rowToLogRow, rowToObjectMomentRow } from "./rows";
import { asRecord } from "@dohc/workspace-core";
import { AGENT_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";

export function listObjectMomentLogRowsByBlob(storage: StorageContext, input: {
    workspaceId: string;
    versionId: string;
    sha256: string;
    semantics: "historical-log" | "current-state";
    selectorPaths?: readonly string[];
  }): SyncRelayLogRow[] {
    if (input.selectorPaths?.length === 0) return [];
    const selectorPathsCte = input.selectorPaths
      ? `selector_paths(path) AS (
           VALUES ${input.selectorPaths.map(() => "(?)").join(", ")}
         ),`
      : "";
    const selectorPathsCondition = input.selectorPaths
      ? `AND EXISTS (
             SELECT 1
             FROM selector_paths selected
             WHERE candidate_moment.path = selected.path
                OR substr(candidate_moment.path, 1, length(selected.path) + 1) = selected.path || '/'
           )`
      : "";
    const candidateCtes =
      input.semantics === "current-state"
        ? `candidate_objects AS MATERIALIZED (
             SELECT DISTINCT matching.object_id
             FROM sync_relay_object_moments matching
             WHERE matching.workspace_id = ? AND matching.version_id = ?
               AND matching.blob_sha256 = ?
           ),
           latest_by_object AS (
             SELECT candidate.object_id,
                    (
                      SELECT latest.relay_seq
                      FROM sync_relay_object_moments latest
                      WHERE latest.workspace_id = ? AND latest.version_id = ?
                        AND latest.object_id = candidate.object_id
                      ORDER BY latest.relay_seq DESC
                      LIMIT 1
                    ) AS relay_seq
             FROM candidate_objects candidate
           ),
           candidates AS (
             SELECT candidate_moment.relay_seq
             FROM latest_by_object latest
             JOIN sync_relay_object_moments candidate_moment
               ON candidate_moment.workspace_id = ?
              AND candidate_moment.object_id = latest.object_id
              AND candidate_moment.relay_seq = latest.relay_seq
             WHERE candidate_moment.blob_sha256 = ?
               ${selectorPathsCondition}
             ORDER BY candidate_moment.relay_seq DESC
             LIMIT ?
           )`
        : `candidates AS (
             SELECT MAX(candidate_moment.relay_seq) AS relay_seq
             FROM sync_relay_object_moments candidate_moment
             WHERE candidate_moment.workspace_id = ?
               AND candidate_moment.version_id = ?
               AND candidate_moment.blob_sha256 = ?
               ${selectorPathsCondition}
             GROUP BY candidate_moment.object_id
             ORDER BY relay_seq DESC
             LIMIT ?
           )`;
    return storage.db
      .prepare(
        `WITH ${selectorPathsCte}
         ${candidateCtes}
         SELECT l.workspace_id, l.origin_id, l.origin_seq, l.op_kind,
                l.payload_json, l.recorded_at_ms, l.relay_seq
         FROM candidates c
         JOIN sync_relay_log l ON l.relay_seq = c.relay_seq
         ORDER BY c.relay_seq DESC`,
      )
      .all(
        ...(input.selectorPaths ?? []),
        input.workspaceId,
        input.versionId,
        input.sha256,
        ...(input.semantics === "current-state"
          ? [input.workspaceId, input.versionId, input.workspaceId, input.sha256]
          : []),
        SHARED_BLOB_CANDIDATE_LIMIT,
      )
      .map(rowToLogRow);
  }

export function listVersionCreateLogRowsByBlob(storage: StorageContext, input: {
    workspaceId: string;
    versionId: string;
    sha256: string;
  }): SyncRelayLogRow[] {
    return storage.db
      .prepare(
        `SELECT l.workspace_id, l.origin_id, l.origin_seq, l.op_kind,
                l.payload_json, l.recorded_at_ms, l.relay_seq
         FROM sync_relay_version_snapshot_blobs candidate
         JOIN sync_relay_log l ON l.relay_seq = candidate.relay_seq
         WHERE candidate.workspace_id = ? AND candidate.version_id = ?
           AND candidate.blob_sha256 = ?
         ORDER BY candidate.relay_seq DESC
         LIMIT ?`,
      )
      .all(
        input.workspaceId,
        input.versionId,
        input.sha256,
        SHARED_BLOB_CANDIDATE_LIMIT,
      )
      .map(rowToLogRow);
  }

export function findThreadCreateChannelWireId(
    storage: StorageContext,
    workspaceId: string,
    threadId: string,
  ): string | null | undefined {
    if (!threadId) return undefined;
    for (const row of threadCreateRows(storage, workspaceId, threadId)) {
      let payload: unknown;
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        continue;
      }
      const record = asRecord(payload);
      if (!record || record.threadId !== threadId) continue;
      // The earliest matching op is authoritative, whatever it says: a string
      // channelWireId with no linked-file owner is the binding; anything else
      // (a file-linked/both-owned thread or a pre-wire-id slug binding) is "no
      // shareable binding" — fail closed.
      return record.linkedObjectId === undefined &&
        typeof record.channelWireId === "string" &&
        record.channelWireId.length > 0
        ? record.channelWireId
        : null;
    }
    return undefined;
  }

export function findChannelCreateKind(
    storage: StorageContext,
    workspaceId: string,
    channelWireId: string,
  ): "channel" | "dm" | "agent" | null | undefined {
    if (!channelWireId) return undefined;
    // Canonical payload JSON sorts keys, so this exact fragment is a useful
    // pre-filter. Escaping LIKE metacharacters prevents a hostile wire id from
    // widening the scan; parsed exact equality below remains authoritative.
    const needle = `"wireId":${JSON.stringify(channelWireId)}`
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    const rows = storage.db
      .prepare(
        `SELECT payload_json FROM sync_relay_log
         WHERE workspace_id = ? AND op_kind = 'chat.channel.create'
           AND payload_json LIKE ? ESCAPE '\\'
         ORDER BY relay_seq`,
      )
      .all(workspaceId, `%${needle}%`);
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        continue;
      }
      const record = asRecord(payload);
      if (!record || record.wireId !== channelWireId) continue;
      // The earliest exact create is authoritative even when malformed; do not
      // skip forward to a later op that could forge a shareable kind. Require
      // the engine's basic replay shape and reserved agent-wire/kind invariant
      // before trusting a human kind; malformed creates resolve permanently
      // unshareable.
      if (
        typeof record.channelId !== "string" ||
        record.channelId.length === 0 ||
        typeof record.name !== "string" ||
        record.name.length === 0 ||
        typeof record.slug !== "string" ||
        record.slug.length === 0 ||
        (record.kind !== "channel" && record.kind !== "dm" && record.kind !== "agent") ||
        typeof record.createdAtMs !== "number" ||
        !Number.isFinite(record.createdAtMs) ||
        ((record.kind === "agent") !== (record.wireId === AGENT_CHANNEL_WIRE_ID))
      ) {
        return null;
      }
      return record.kind;
    }
    return undefined;
  }

export function findThreadCreateFileBinding(
    storage: StorageContext,
    workspaceId: string,
    threadId: string,
  ): ThreadFileBinding | null | undefined {
    if (!threadId) return undefined;
    for (const row of threadCreateRows(storage, workspaceId, threadId)) {
      let payload: unknown;
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        continue;
      }
      const record = asRecord(payload);
      if (!record || record.threadId !== threadId) continue;
      // The earliest matching op is authoritative, whatever it says. Exactly
      // one binding shape may be present: an op claiming both is malformed,
      // and reading either half of it would let a crafted create bind a
      // thread twice.
      const objectId = record.linkedObjectId;
      const path = record.linkedPath;
      const hasObject = typeof objectId === "string" && objectId.length > 0;
      const hasPath = typeof path === "string" && path.length > 0;
      if (hasObject && hasPath) return null;
      if (hasObject) return { kind: "object", objectId: objectId as string };
      if (hasPath) return { kind: "path", path: path as string };
      return null;
    }
    return undefined;
  }

export function objectIdAtPath(storage: StorageContext, workspaceId: string, path: string): string | undefined {
    if (!path) return undefined;
    const row = storage.db
      .prepare(
        "SELECT object_id FROM sync_relay_object_paths \
         WHERE workspace_id = ? AND path = ? ORDER BY relay_seq DESC LIMIT 1",
      )
      .get(workspaceId, path);
    return typeof row?.object_id === "string" ? row.object_id : undefined;
  }

export function objectCurrentPath(storage: StorageContext, workspaceId: string, objectId: string): string | null | undefined {
    if (!objectId) return undefined;
    const row = storage.db
      .prepare(
        "SELECT path FROM sync_relay_object_paths WHERE workspace_id = ? AND object_id = ?",
      )
      .get(workspaceId, objectId);
    if (row === undefined) return undefined;
    return typeof row.path === "string" && row.path.length > 0 ? row.path : null;
  }

export function objectIdAtPathInVersion(storage: StorageContext, input: {
    workspaceId: string;
    versionId: string;
    path: string;
  }): string | undefined {
    if (!input.path || !input.versionId) return undefined;
    // The object whose latest moment in this version sits at this path. A
    // moment that moved the object away leaves a newer row naming another
    // path, so that object no longer answers here — which is what makes this
    // "who is at this path now, in this version" rather than "who was ever".
    const row = storage.db
      .prepare(
        `SELECT m.object_id
         FROM sync_relay_object_moments m
         WHERE m.workspace_id = ? AND m.version_id = ? AND m.path = ?
           AND m.relay_seq = (
             SELECT MAX(latest.relay_seq)
             FROM sync_relay_object_moments latest
             WHERE latest.workspace_id = m.workspace_id
               AND latest.object_id = m.object_id
               AND latest.version_id = m.version_id
           )
         ORDER BY m.relay_seq DESC
         LIMIT 1`,
      )
      .get(input.workspaceId, input.versionId, input.path);
    return typeof row?.object_id === "string" ? row.object_id : undefined;
  }

export function objectMoment(storage: StorageContext, input: {
    workspaceId: string;
    objectId: string;
    versionId: string;
    blobSha256?: string;
  }): ObjectMomentRow | null {
    if (!input.objectId || !input.versionId) return null;
    if (input.blobSha256 !== undefined && !input.blobSha256) return null;
    const params: unknown[] = [input.workspaceId, input.objectId, input.versionId];
    if (input.blobSha256 !== undefined) params.push(input.blobSha256);
    const row = storage.db
      .prepare(
        `SELECT moment_id, version_id, path, blob_sha256, content_kind, byte_length, recorded_at_ms
         FROM sync_relay_object_moments
         WHERE workspace_id = ? AND object_id = ? AND version_id = ?
           ${input.blobSha256 === undefined ? "" : "AND blob_sha256 = ?"}
         ORDER BY relay_seq DESC LIMIT 1`,
      )
      .get(...params);
    return row ? rowToObjectMomentRow(row) : null;
  }

// The workspace's chat.thread.create rows that might name this threadId, in
// relay order. LIKE pre-filter on the exact JSON fragment the canonical
// (sorted-key, JSON.stringify-escaped) payload stores, wildcards escaped so
// a hostile threadId cannot widen the match; the caller's JSON.parse
// comparison makes the real decision.
export function threadCreateRows(
    storage: StorageContext,
    workspaceId: string,
    threadId: string,
  ): Array<Record<string, unknown>> {
    const needle = `"threadId":${JSON.stringify(threadId)}`
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    return storage.db
      .prepare(
        `SELECT payload_json FROM sync_relay_log
         WHERE workspace_id = ? AND op_kind = 'chat.thread.create'
           AND payload_json LIKE ? ESCAPE '\\'
         ORDER BY relay_seq`,
      )
      .all(workspaceId, `%${needle}%`);
  }
