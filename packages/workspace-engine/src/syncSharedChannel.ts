import type { SyncReplicationEnvelope, WorkspaceId } from "@dohc/workspace-contracts/engine";
import { createLinkedChatStore } from "./linkedChatStore";
import { openEngineDb } from "./syncApply";
import { RelayUnauthorizedError, type SyncRelayConnection } from "./syncRelay";
import { ShareUnavailableError } from "./syncShareView";

// MU-C4 — the MEMBER side of a shared channel (the bidirectional chat-channel
// grant). Two passes, both share-scoped and idempotent:
//
//   PULL: fetch the share's server-filtered op log and replay the channel's
//   chat ops into this workspace's OWN chat store. A filtered log has
//   per-source-origin sequence gaps by construction, so each source origin is
//   renumbered DENSELY (in relay order — identical for every member) under a
//   share-scoped origin id before applyReplicationOp; the engine's wire-id /
//   thread-id / message-id convergence then makes every member's copy of the
//   channel identical. Durable per-share state (cursor, per-origin dense
//   counters) lives in engine.db (SHARED_CHANNEL_SYNC_DDL).
//
//   PUSH: scan this workspace's LOCAL origin journal for chat ops that belong
//   to the shared channel (channel-create for the wire id, threads bound to
//   it, messages/reactions in those threads) and append them to the share's
//   member route under this machine's own origin id, renumbered densely so
//   the relay's per-origin contiguity holds. The relay re-validates
//   everything server-side (membership, read-write access, authorship,
//   channel scope) — this client-side scoping exists to send only what
//   belongs, not to be trusted.
//
// Revocation: every relay denial (revoked, not yours, never existed) is the
// same generic 404 and surfaces as ShareUnavailableError — the caller closes
// the view; the locally replayed copy stays readable and simply stops
// updating (PR-18's honest end-of-share).

export class SharedChannelReadOnlyError extends Error {
  constructor(message = "This shared channel is read-only for you.") {
    super(message);
    this.name = "SharedChannelReadOnlyError";
  }
}

export class SharedChannelAppendRejectedError extends Error {
  constructor(message = "The relay refused an op for this shared channel.") {
    super(message);
    this.name = "SharedChannelAppendRejectedError";
  }
}

export interface SharedChannelInfo {
  shareId: string;
  granterUserId: string;
  granterEmail: string | null;
  channelWireId: string;
  access: "read-write" | "read-only";
  createdAtMs: number;
}

export interface PullSharedChannelResult {
  fetched: number;
  applied: number;
  skipped: number;
  nextCursor: number;
}

export interface PushSharedChannelResult {
  pushed: number;
}

const SHARE_PAGE_LIMIT = 500;
const CHAT_OP_KINDS = new Set([
  "chat.channel.create",
  "chat.thread.create",
  "chat.message.append",
  "chat.reaction.set",
]);

function shareUrl(relay: SyncRelayConnection, path: string): string {
  return `${relay.baseUrl.replace(/\/+$/u, "")}${path}`;
}

async function shareFetch(
  relay: SyncRelayConnection,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${relay.token}`);
  const response = await (relay.fetch ?? fetch)(shareUrl(relay, path), { ...init, headers });
  if (response.status === 401) throw new RelayUnauthorizedError();
  // The relay's recipient routes answer EVERY denial (revoked, not yours,
  // never existed) with one generic 404 — surface them all as "unavailable".
  if (response.status === 404) throw new ShareUnavailableError();
  return response;
}

export async function fetchSharedChannelInfo(input: {
  relay: SyncRelayConnection;
  shareId: string;
}): Promise<SharedChannelInfo> {
  const response = await shareFetch(
    input.relay,
    `/sync/shares/${encodeURIComponent(input.shareId)}`,
  );
  if (!response.ok) throw new Error(`Share request failed (${response.status})`);
  const body = (await response.json()) as Record<string, unknown>;
  const selector =
    body.selector && typeof body.selector === "object" && !Array.isArray(body.selector)
      ? (body.selector as Record<string, unknown>)
      : {};
  if (
    selector.kind !== "chat-channel" ||
    typeof selector.channelWireId !== "string" ||
    selector.channelWireId.length === 0
  ) {
    // A path/version share is not a channel; opening it as one fails closed
    // with the same "unavailable" the member sees for a revoked share.
    throw new ShareUnavailableError();
  }
  return {
    shareId: String(body.shareId ?? input.shareId),
    granterUserId: String(body.granterUserId ?? ""),
    granterEmail: typeof body.granterEmail === "string" ? body.granterEmail : null,
    channelWireId: selector.channelWireId,
    access: selector.access === "read-only" ? "read-only" : "read-write",
    createdAtMs: Number(body.createdAtMs ?? 0),
  };
}

interface SharedLogPage {
  ok: boolean;
  ops: Array<{
    relaySeq: number;
    originId: string;
    originSeq: number;
    opKind: string;
    payload: unknown;
    recordedAtMs: number;
  }>;
  nextCursor: number;
  hasMore: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// How a threadId resolves against the LOCAL workspace at apply time:
// "absent" (no such thread yet — a served thread.create may bind it),
// "granted" (exists and is bound to the granted channel), or "foreign"
// (exists but belongs to something else — a private/other channel or a
// file-linked thread).
type LocalThreadBinding = "absent" | "granted" | "foreign";

// Client-side scope gate for PULL — the third gate behind grant validation
// and the relay's per-op filter (mirrors syncShareView's pathReplayable): a
// misbehaving or compromised relay must not be able to plant ANOTHER
// channel's ops (or non-chat ops) into the member's local chat store. Thread
// membership is tracked from the ops themselves: a thread belongs to the
// channel iff its thread.create (seen this pull or a previous one — then the
// local chat_threads row already binds it) claims the granted wire id.
//
// Private-thread injection gate (MU-C4 review HIGH): the served stream is
// additionally checked against the LOCAL thread→channel binding. A served
// thread.create reusing a threadId that already exists locally bound
// elsewhere would no-op on apply — but trusting it would route every
// follow-up message/reaction for that threadId into the member's PRIVATE
// (or other-channel / file) thread. So a thread.create is only accepted when
// the local thread is absent or already bound to the granted channel, and
// EVERY message/reaction additionally re-verifies the local binding at apply
// time. Fail closed on anything else.
function opBelongsToChannel(
  opKind: string,
  payload: Record<string, unknown>,
  channelWireId: string,
  channelThreadIds: Set<string>,
  localThreadBinding: (threadId: string) => LocalThreadBinding,
): boolean {
  if (opKind === "chat.channel.create") return payload.wireId === channelWireId;
  if (opKind === "chat.thread.create") {
    if (payload.channelWireId !== channelWireId) return false;
    if (typeof payload.threadId !== "string" || payload.threadId.length === 0) return false;
    if (localThreadBinding(payload.threadId) === "foreign") return false;
    channelThreadIds.add(payload.threadId);
    return true;
  }
  if (opKind === "chat.message.append" || opKind === "chat.reaction.set") {
    if (typeof payload.threadId !== "string" || !channelThreadIds.has(payload.threadId)) {
      return false;
    }
    // The local row the op would land in must be bound to the granted channel
    // RIGHT NOW — a stream-tracked threadId alone is not enough (its accepted
    // thread.create may have no-opped against a pre-existing foreign thread).
    return localThreadBinding(payload.threadId) === "granted";
  }
  return false;
}

export async function pullSharedChannel(input: {
  rootDir: string;
  workspaceId: WorkspaceId;
  relay: SyncRelayConnection;
  shareId: string;
  channelWireId: string;
}): Promise<PullSharedChannelResult> {
  const db = openEngineDb(input.rootDir);
  let since: number;
  let localOriginId: string | null;
  const peers = new Map<string, { applied: number; dense: number }>();
  const channelThreadIds = new Set<string>();
  try {
    const cursorRow = db
      .prepare("SELECT relay_fetch_cursor FROM shared_channel_cursors WHERE share_id = ?")
      .get(input.shareId);
    since = Number(cursorRow?.relay_fetch_cursor ?? 0);
    const identityRow = db
      .prepare("SELECT origin_id FROM sync_identity WHERE workspace_id = ?")
      .get(input.workspaceId);
    localOriginId = typeof identityRow?.origin_id === "string" ? identityRow.origin_id : null;
    for (const row of db
      .prepare(
        "SELECT origin_id, applied_origin_seq, dense_seq FROM shared_channel_peers WHERE share_id = ?",
      )
      .all(input.shareId)) {
      peers.set(String(row.origin_id), {
        applied: Number(row.applied_origin_seq),
        dense: Number(row.dense_seq),
      });
    }
    // Threads ALREADY known (from previous pulls or local sends) to belong to
    // the shared channel: the local truth the scope gate resumes from.
    for (const row of db
      .prepare(
        `SELECT t.thread_id FROM chat_threads t
         JOIN chat_channel_wire_ids w
           ON w.workspace_id = t.workspace_id AND w.channel_id = t.channel_id
         WHERE t.workspace_id = ? AND w.wire_id = ?`,
      )
      .all(input.workspaceId, input.channelWireId)) {
      channelThreadIds.add(String(row.thread_id));
    }
  } finally {
    db.close();
  }

  let cursor = since;
  let fetched = 0;
  const ops: SharedLogPage["ops"] = [];
  for (;;) {
    const response = await shareFetch(
      input.relay,
      `/sync/shares/${encodeURIComponent(input.shareId)}/log?since=${cursor}&limit=${SHARE_PAGE_LIMIT}`,
    );
    if (!response.ok) throw new Error(`Shared channel request failed (${response.status})`);
    const page = (await response.json()) as SharedLogPage;
    ops.push(...page.ops);
    fetched += page.ops.length;
    if (page.hasMore && page.nextCursor <= cursor) {
      throw new Error("Shared channel log pagination did not advance; aborting pull.");
    }
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }

  const chats = createLinkedChatStore(input.rootDir);
  let applied = 0;
  let skipped = 0;
  try {
    const stateDb = openEngineDb(input.rootDir);
    try {
      const upsertPeer = stateDb.prepare(
        `INSERT INTO shared_channel_peers (share_id, origin_id, applied_origin_seq, dense_seq)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(share_id, origin_id) DO UPDATE SET
           applied_origin_seq = excluded.applied_origin_seq,
           dense_seq = excluded.dense_seq`,
      );
      // Live local-binding lookups for the injection gate: reads the SAME
      // engine.db the chat store writes, so a thread.create applied earlier
      // in this loop already resolves as "granted" for its follow-up ops.
      const threadExistsStmt = stateDb.prepare(
        "SELECT 1 AS ok FROM chat_threads WHERE workspace_id = ? AND thread_id = ?",
      );
      const threadBoundStmt = stateDb.prepare(
        `SELECT 1 AS ok FROM chat_threads t
         JOIN chat_channel_wire_ids w
           ON w.workspace_id = t.workspace_id AND w.channel_id = t.channel_id
         WHERE t.workspace_id = ? AND t.thread_id = ? AND w.wire_id = ?`,
      );
      const localThreadBinding = (threadId: string): LocalThreadBinding => {
        if (threadExistsStmt.get(input.workspaceId, threadId) === undefined) return "absent";
        return threadBoundStmt.get(input.workspaceId, threadId, input.channelWireId) !== undefined
          ? "granted"
          : "foreign";
      };
      for (const op of ops) {
        // Own echo: ops this machine pushed through the member route come
        // back under `share:<shareId>:<localOrigin>` — the local store
        // already holds them, so skip without minting a duplicate journal row.
        if (localOriginId !== null && op.originId === `share:${input.shareId}:${localOriginId}`) {
          skipped += 1;
          continue;
        }
        const payload = asRecord(op.payload);
        if (
          !payload ||
          !CHAT_OP_KINDS.has(op.opKind) ||
          !opBelongsToChannel(
            op.opKind,
            payload,
            input.channelWireId,
            channelThreadIds,
            localThreadBinding,
          )
        ) {
          // Fail closed on anything the relay should never have served.
          skipped += 1;
          continue;
        }
        const peer = peers.get(op.originId) ?? { applied: -1, dense: -1 };
        if (op.originSeq <= peer.applied) {
          // Crash-refetch overlap (cursor not yet committed): already applied.
          skipped += 1;
          continue;
        }
        const denseSeq = peer.dense + 1;
        const result = await chats.applyReplicationOp({
          workspaceId: input.workspaceId,
          originId: `shared:${input.shareId}:${op.originId}`,
          originSeq: denseSeq,
          opKind: op.opKind,
          payload: op.payload,
          recordedAtMs: op.recordedAtMs,
        } as SyncReplicationEnvelope);
        if (result.status === "applied") applied += 1;
        else skipped += 1;
        peer.applied = op.originSeq;
        peer.dense = denseSeq;
        peers.set(op.originId, peer);
        upsertPeer.run(input.shareId, op.originId, peer.applied, peer.dense);
      }
      // Chat replay owes no disk materialization, so the cursor commits as
      // soon as the applies land (unlike pullWorkspaceFromRelay's deferred
      // commit). A crash before this line re-fetches; the per-origin
      // applied_origin_seq skip above makes the replay an exact no-op.
      stateDb
        .prepare(
          `INSERT INTO shared_channel_cursors (share_id, relay_fetch_cursor)
           VALUES (?, ?)
           ON CONFLICT(share_id) DO UPDATE SET
             relay_fetch_cursor = excluded.relay_fetch_cursor`,
        )
        .run(input.shareId, cursor);
    } finally {
      stateDb.close();
    }
  } finally {
    await chats.close();
  }
  return { fetched, applied, skipped, nextCursor: cursor };
}

interface LocalJournalRow {
  originSeq: number;
  opKind: string;
  payload: unknown;
  recordedAtMs: number;
}

export async function pushSharedChannel(input: {
  rootDir: string;
  workspaceId: WorkspaceId;
  relay: SyncRelayConnection;
  shareId: string;
  channelWireId: string;
}): Promise<PushSharedChannelResult> {
  const db = openEngineDb(input.rootDir);
  let rows: LocalJournalRow[];
  let scannedLocalSeq: number;
  let pushedShareSeq: number;
  let localOriginId: string | null;
  try {
    const identityRow = db
      .prepare("SELECT origin_id FROM sync_identity WHERE workspace_id = ?")
      .get(input.workspaceId);
    localOriginId = typeof identityRow?.origin_id === "string" ? identityRow.origin_id : null;
    if (localOriginId === null) return { pushed: 0 }; // never journaled anything
    const stateRow = db
      .prepare(
        "SELECT scanned_local_seq, pushed_share_seq FROM shared_channel_push_state WHERE share_id = ?",
      )
      .get(input.shareId);
    scannedLocalSeq = Number(stateRow?.scanned_local_seq ?? -1);
    pushedShareSeq = Number(stateRow?.pushed_share_seq ?? -1);

    // The channel's LOCAL id (wire ids are the cross-machine identity).
    const channelRow = db
      .prepare(
        "SELECT channel_id FROM chat_channel_wire_ids WHERE workspace_id = ? AND wire_id = ?",
      )
      .get(input.workspaceId, input.channelWireId);
    const channelId = typeof channelRow?.channel_id === "string" ? channelRow.channel_id : null;
    const threadInChannel = db.prepare(
      "SELECT 1 AS ok FROM chat_threads WHERE workspace_id = ? AND thread_id = ? AND channel_id = ?",
    );

    // Only ops THIS machine authored (the local origin): imported ops —
    // including other members' ops replayed by pullSharedChannel — live under
    // other origin ids and must never be re-pushed to the share.
    const journalRows = db
      .prepare(
        `SELECT origin_seq, op_kind, payload_json, recorded_at_ms
         FROM replication_log
         WHERE workspace_id = ? AND origin_id = ? AND origin_seq > ?
         ORDER BY origin_seq`,
      )
      .all(input.workspaceId, localOriginId, scannedLocalSeq);
    rows = [];
    for (const row of journalRows) {
      const opKind = String(row.op_kind);
      scannedLocalSeq = Number(row.origin_seq);
      if (!CHAT_OP_KINDS.has(opKind)) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        continue;
      }
      const record = asRecord(payload);
      if (!record) continue;
      const inChannel =
        opKind === "chat.channel.create"
          ? record.wireId === input.channelWireId
          : opKind === "chat.thread.create"
            ? record.channelWireId === input.channelWireId
            : channelId !== null &&
              typeof record.threadId === "string" &&
              threadInChannel.get(input.workspaceId, record.threadId, channelId) !== undefined;
      if (!inChannel) continue;
      rows.push({
        originSeq: Number(row.origin_seq),
        opKind,
        payload,
        recordedAtMs: Number(row.recorded_at_ms),
      });
    }
  } finally {
    db.close();
  }

  if (rows.length === 0) {
    commitPushState(input.rootDir, input.shareId, scannedLocalSeq, pushedShareSeq);
    return { pushed: 0 };
  }

  let pushed = 0;
  for (let offset = 0; offset < rows.length; offset += SHARE_PAGE_LIMIT) {
    const batch = rows.slice(offset, offset + SHARE_PAGE_LIMIT);
    const response = await shareFetch(
      input.relay,
      `/sync/shares/${encodeURIComponent(input.shareId)}/log`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          originId: localOriginId,
          // Dense renumbering: the share-side sequence is its own contiguous
          // space (the local journal interleaves non-channel ops).
          ops: batch.map((row, index) => ({
            originSeq: pushedShareSeq + 1 + index,
            opKind: row.opKind,
            payload: row.payload,
            recordedAtMs: row.recordedAtMs,
          })),
        }),
      },
    );
    if (response.status === 403) {
      const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
      if (body?.code === "share_read_only") throw new SharedChannelReadOnlyError();
      throw new SharedChannelAppendRejectedError();
    }
    if (!response.ok) throw new Error(`Shared channel append failed (${response.status})`);
    pushedShareSeq += batch.length;
    pushed += batch.length;
    // Commit after EVERY accepted batch (mirrors pushWorkspaceToRelay): an
    // interruption resumes with identical seqs, which the relay dedups as
    // idempotent skips.
    commitPushState(
      input.rootDir,
      input.shareId,
      batch[batch.length - 1]!.originSeq,
      pushedShareSeq,
    );
  }
  // Everything scanned (including trailing non-channel rows) is done.
  commitPushState(input.rootDir, input.shareId, scannedLocalSeq, pushedShareSeq);
  return { pushed };
}

function commitPushState(
  rootDir: string,
  shareId: string,
  scannedLocalSeq: number,
  pushedShareSeq: number,
): void {
  const db = openEngineDb(rootDir);
  try {
    db.prepare(
      `INSERT INTO shared_channel_push_state (share_id, scanned_local_seq, pushed_share_seq)
       VALUES (?, ?, ?)
       ON CONFLICT(share_id) DO UPDATE SET
         scanned_local_seq = excluded.scanned_local_seq,
         pushed_share_seq = excluded.pushed_share_seq`,
    ).run(shareId, scannedLocalSeq, pushedShareSeq);
  } finally {
    db.close();
  }
}
