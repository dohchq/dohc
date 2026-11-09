import { agentIdForChannelWireId } from "@dohc/security-contract/chat-wire-ids";
import { sha256Hex } from "@dohc/workspace-core/hash";
import { personalAgentOrigin, PERSONAL_MESSAGE_ID_PREFIX, PERSONAL_THREAD_ID_PREFIX } from "../relayLogInputs";
import type { AgentAccessCheck } from "./agentConnections";
import type { StorageContext } from "./context";
import { validLinkDiscussionIdempotencyKey } from "./discussion";
import { linkChatBody, linkPostOps, replayedLinkPost } from "./linkChat";
import { appendLogBatchInTransaction, fetchChatMessage } from "./log";
import { findChannelCreateKind, findThreadCreateChannelWireId } from "./objectIndex";
import {
  ownedPersonalReach,
  personalReachIn,
  readPersonalAuthority,
  type PersonalConnectionRow,
  type PersonalReach,
} from "./personalAgents";
import { rowToLogRow } from "./rows";
import type { SyncRelayLogRow } from "./types";
import { workspaceUsageBytes } from "./workspaces";

// A personal agent's chat: its posts, written by the relay from the agent's
// own origin, and the reads its wait needs. Every function here checks the
// agent's authority again, at the fence epoch its request read.

/** The request's credential and the fence epoch its authentication read. */
export interface PersonalCredential {
  check: AgentAccessCheck;
  connectionId: string;
  fenceEpoch: number;
}

export interface PersonalScope {
  connection: PersonalConnectionRow;
  /** The agent's current name, which its posts show and people mention. */
  name: string;
  /** Each workspace in reach that the account still owns, with its log head. */
  reach: (PersonalReach & { headSeq: number })[];
}

/** The agent's authority, name, and owned reach, read together; null once any check fails. */
export function readPersonalScope(storage: StorageContext, credential: PersonalCredential, nowMs: number): PersonalScope | null {
  return storage.readTx(() => {
    const connection = readPersonalAuthority(storage, credential.check, credential.fenceEpoch, nowMs);
    if (!connection || connection.connectionId !== credential.connectionId) return null;
    const agent = storage.db.prepare("SELECT name FROM sync_relay_personal_agents WHERE agent_id = ?").get(connection.agentId);
    const head = storage.db.prepare("SELECT COALESCE(MAX(relay_seq), 0) AS head FROM sync_relay_log WHERE workspace_id = ?");
    return {
      connection,
      name: String(agent?.name),
      reach: ownedPersonalReach(storage, connection).map(entry => ({
        ...entry, headSeq: Number(head.get(entry.workspaceId)?.head ?? 0),
      })),
    };
  });
}

/** The agent's reach in one workspace its account still owns, read with its authority; null once any check fails. */
export function readPersonalReach(storage: StorageContext, credential: PersonalCredential, workspaceId: string, nowMs: number): PersonalReach | null {
  return storage.readTx(() => {
    const connection = readPersonalAuthority(storage, credential.check, credential.fenceEpoch, nowMs);
    return connection && connection.connectionId === credential.connectionId ? personalReachIn(storage, connection, workspaceId) : null;
  });
}

export type PersonalChatTarget = { channelWireId: string } | { threadId: string };

export type AppendPersonalChatPostResult =
  | { ok: true; replayed: boolean; channelWireId: string; row: SyncRelayLogRow }
  | {
    ok: false;
    reason: "invalid-input" | "not-authorized" | "out-of-reach" | "not-found" | "read-only" | "idempotency-conflict" | "workspace-quota";
  };

/**
 * Posts one message as a personal agent, in a workspace its account owns and
 * its reach holds at Comment. The relay writes the operations from the
 * agent's own origin, naming the account, the agent, its current name, and
 * the connection the access token names. The caller names only the
 * workspace, a channel for a new thread or a thread to reply in, the body,
 * and a retry key. The connection, the account's fence, the reach, and
 * ownership are read again inside the transaction that writes the post, with
 * the clock read there too. A thread resolves only through its create in the
 * workspace's log. The post lands only in a Group or the agent's own DM, never
 * in a person's DM or another agent's.
 */
export function appendPersonalChatPost(storage: StorageContext, input: PersonalCredential & {
  /** The relay's clock, read inside the write. */
  now: () => number;
  workspaceId: string;
  target: PersonalChatTarget;
  body: string;
  idempotencyKey: string;
}): AppendPersonalChatPostResult {
  const body = linkChatBody(input.body);
  const replyTo = "threadId" in input.target ? input.target.threadId : null;
  const named = replyTo ?? ("channelWireId" in input.target ? input.target.channelWireId : "");
  if (body === null || !validLinkDiscussionIdempotencyKey(input.idempotencyKey) || !named || !named.isWellFormed()) {
    return { ok: false, reason: "invalid-input" };
  }
  const { workspaceId } = input;
  return storage.tx((): AppendPersonalChatPostResult => {
    const createdAtMs = Math.trunc(input.now());
    const connection = readPersonalAuthority(storage, input.check, input.fenceEpoch, createdAtMs);
    if (!connection || connection.connectionId !== input.connectionId) return { ok: false, reason: "not-authorized" };
    const reach = personalReachIn(storage, connection, workspaceId);
    if (!reach) return { ok: false, reason: "out-of-reach" };
    if (reach.level === "view") return { ok: false, reason: "read-only" };
    const channelWireId = replyTo === null ? named : findThreadCreateChannelWireId(storage, workspaceId, replyTo);
    if (typeof channelWireId !== "string") return { ok: false, reason: "not-found" };
    const kind = findChannelCreateKind(storage, workspaceId, channelWireId);
    if (kind !== "channel" && !(kind === "agent" && agentIdForChannelWireId(channelWireId) === connection.agentId)) {
      return { ok: false, reason: "not-found" };
    }

    const key = sha256Hex(JSON.stringify([connection.agentId, input.idempotencyKey]));
    const originId = personalAgentOrigin(connection.agentId);
    const messageId = `${PERSONAL_MESSAGE_ID_PREFIX}${key}`;
    const threadId = replyTo ?? `${PERSONAL_THREAD_ID_PREFIX}${key}`;
    const replay = replayedLinkPost(storage, workspaceId, { originId, messageId, threadId }, body);
    if (replay) {
      // A retry that started a thread names the same channel again.
      return replay === "conflict" || findThreadCreateChannelWireId(storage, workspaceId, threadId) !== channelWireId
        ? { ok: false, reason: "idempotency-conflict" }
        : { ok: true, replayed: true, channelWireId, row: replay };
    }
    const agent = storage.db.prepare("SELECT name FROM sync_relay_personal_agents WHERE agent_id = ?").get(connection.agentId);
    const ops = linkPostOps(storage, {
      workspaceId, originId, messageId, threadId, createThread: replyTo === null, channelWireId, body, createdAtMs,
      author: {
        authorKind: "agent", authorDisplayName: String(agent?.name), authorUserId: connection.ownerUserId,
        authorAgentId: connection.agentId, agentConnectionId: connection.connectionId,
      },
    });
    const addedBytes = ops.reduce((bytes, op) => bytes + Buffer.byteLength(op.payloadJson), 0);
    if (workspaceUsageBytes(storage, workspaceId) + addedBytes > storage.options.workspaceQuotaBytes) {
      return { ok: false, reason: "workspace-quota" };
    }
    appendLogBatchInTransaction(storage, { workspaceId, originId, ops });
    storage.db.prepare(`INSERT OR IGNORE INTO sync_relay_personal_agent_threads (agent_id, workspace_id, thread_id)
      VALUES (?, ?, ?)`).run(connection.agentId, workspaceId, threadId);
    storage.db.prepare(`UPDATE sync_relay_personal_agents SET last_action_at_ms = MAX(COALESCE(last_action_at_ms, 0), ?)
      WHERE agent_id = ?`).run(createdAtMs, connection.agentId);
    const row = fetchChatMessage(storage, { workspaceId, originId, messageId });
    if (!row) throw new Error("appended personal agent post is missing");
    return { ok: true, replayed: false, channelWireId, row };
  });
}

/** Whether the agent posted in this thread of the workspace. */
export function personalAgentPostedIn(storage: StorageContext, input: {
  agentId: string; workspaceId: string; threadId: string;
}): boolean {
  return storage.db.prepare(`SELECT 1 FROM sync_relay_personal_agent_threads
    WHERE agent_id = ? AND workspace_id = ? AND thread_id = ?`).get(input.agentId, input.workspaceId, input.threadId) !== undefined;
}

export interface PersonalWaitWindow {
  /** The chat messages among the rows read, in log order. */
  messages: SyncRelayLogRow[];
  /** The last row read, or `afterSeq` when none was. */
  edgeSeq: number;
  rows: number;
  bytes: number;
}

/**
 * The rows after `afterSeq`, up to `maxRows` and `maxBytes` of payload, as a
 * wait scans them. The first row of a scan is read whatever its size, so a
 * scan always moves; `firstOfScan` says this window starts one. Only the chat
 * messages among the rows are read in full.
 */
export function readPersonalWaitWindow(storage: StorageContext, input: {
  workspaceId: string; afterSeq: number; maxRows: number; maxBytes: number; firstOfScan: boolean;
}): PersonalWaitWindow {
  return storage.readTx(() => {
    let rows = 0;
    let bytes = 0;
    let edgeSeq = input.afterSeq;
    const coordinates = storage.db.prepare(`SELECT relay_seq, octet_length(payload_json) AS payload_bytes FROM sync_relay_log
      WHERE workspace_id = ? AND relay_seq > ? ORDER BY relay_seq LIMIT ?`)
      .iterate(input.workspaceId, input.afterSeq, Math.max(0, input.maxRows));
    for (const row of coordinates) {
      const size = Number(row.payload_bytes);
      if ((rows > 0 || !input.firstOfScan) && bytes + size > input.maxBytes) break;
      rows++;
      bytes += size;
      edgeSeq = Number(row.relay_seq);
    }
    const messages = rows === 0 ? [] : storage.db.prepare(`SELECT * FROM sync_relay_log
      WHERE workspace_id = ? AND relay_seq > ? AND relay_seq <= ? AND op_kind = 'chat.message.append'
      ORDER BY relay_seq`).all(input.workspaceId, input.afterSeq, edgeSeq).map(rowToLogRow);
    return { messages, edgeSeq, rows, bytes };
  });
}
