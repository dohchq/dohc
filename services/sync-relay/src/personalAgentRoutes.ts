import type { CliResultByVerb } from "@dohc/cli/protocol";
import { jsonResponse, readBoundedJson, type TokenBucketLimiter } from "@dohc/service-http";
import { agentChannelWireId } from "@dohc/security-contract/chat-wire-ids";
import { runAccountOperation } from "./accountOperations";
import {
  AGENT_CHAT_MAX_WAIT_MS,
  AGENT_CHAT_WAIT_MAX_RESPONSE_BYTES,
  agentHandle,
  agentMention,
  mentions,
  MAX_AGENT_CHAT_WAITS_PER_CONNECTION,
  MAX_AGENT_CHAT_WAITS_PER_LINK,
} from "./agentChatRoutes";
import { DiscussionActivityCapacityError, ownerLogWaitGroup, type DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, relayError, type RelayError } from "./errors";
import type { LinkAuthorityResolver, PersonalAuthority } from "./linkAuthority";
import { linkChatMessage, LINK_CHAT_MAX_POST_BYTES, type LinkChatMessage } from "./linkChatRoutes";
import { guardedByteResponse } from "./linkResponseStreams";
import { messageFromOp, type NamedChatMessage } from "./namedRecipientChat";
import type { PersonalAgents } from "./personalAgents";
import { parseString, parseWorkspaceId } from "./requestInputs";
import type { ServerCopies } from "./serverCopies";
import { MAIN_VERSION_ID, MAX_SHARE_PATH_CHARS } from "./shareFilter";
import type { SyncRelayStorage } from "./storage";
import { CHAT_HISTORY_SCAN_BYTES, CHAT_HISTORY_SCAN_WINDOW } from "./storage/log";
import {
  commentFileOf,
  currentFileAt,
  type AppendPersonalChatPostResult,
  type PersonalChatTarget,
  type PersonalCredential,
  type PersonalScope,
} from "./storage/personalAgentChat";
import { PERSONAL_AGENT_REACH_LIMIT, type PersonalReach } from "./storage/personalAgents";
import type { SyncRelayLogRow } from "./storage/types";
import { MAX_BLOB_BYTES } from "./wireLimits";

// share-web calls these over the relay exchange key for a personal agent's
// tool calls. Every request authenticates the access token at the account's
// fence, then resolves the named workspace: in the agent's reach at the level
// the action needs, owned by the account, and not deleted. Ids resolve only
// inside that workspace. No field in a request can name the author.

export type PersonalAgentToolRoute = {
  route: "personal-agent-tools";
  action: "workspaces" | "groups" | "post" | "wait" | "chat" | "discussion" | "files" | "blob";
};

/** The most messages one wait answers with. */
export const PERSONAL_WAIT_MAX_MESSAGES = 100;
// The link wait's cap, with the account in place of the link. Reach holds only
// the account's own workspaces, so no workspace holds more waits than this.
export const MAX_PERSONAL_WAITS_PER_ACCOUNT = MAX_AGENT_CHAT_WAITS_PER_LINK;
const CHAT_READ_DEFAULT_LIMIT = 50;
const CHAT_READ_MAX_LIMIT = 100;
const CHAT_ID_CHARS = 256;
const SHA256 = /^[0-9a-f]{64}$/u;

/**
 * A message for the agent, with the workspace and the place it is in: a
 * channel, or for a Comment, no channel and the file's path, which for a
 * deleted file is the path it last had. Exactly one of them is null.
 */
export type PersonalWaitMessage = LinkChatMessage & { workspaceId: string; channelWireId: string | null; filePath: string | null };

/** Where the next wait starts: a place in each workspace, and the workspace whose turn is first. */
export interface PersonalWaitCursor {
  v: 1;
  agentId: string;
  seqs: Record<string, number>;
  turn: string | null;
}

function fields(input: Record<string, unknown>, required: readonly string[], optional: readonly string[]): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(input).some(key => !allowed.has(key)) || required.some(key => !(key in input))) throw badRequest("invalid request");
}

function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw badRequest(`${name} is invalid`);
  return value;
}

function waitCursor(value: unknown, agentId: string): PersonalWaitCursor | null {
  if (value === undefined) return null;
  const record = value as Record<string, unknown> | null;
  const seqs = record?.seqs as Record<string, unknown> | null | undefined;
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).sort().join() !== "agentId,seqs,turn,v" ||
      record.v !== 1 || record.agentId !== agentId || (record.turn !== null && typeof record.turn !== "string") ||
      !seqs || typeof seqs !== "object" || Array.isArray(seqs) || Object.keys(seqs).length > PERSONAL_AGENT_REACH_LIMIT ||
      Object.values(seqs).some(seq => typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0)) {
    throw badRequest("cursor is invalid");
  }
  return { v: 1, agentId, seqs: seqs as Record<string, number>, turn: record.turn as string | null };
}

function postRefusal(reason: Extract<AppendPersonalChatPostResult, { ok: false }>["reason"]): RelayError {
  switch (reason) {
    case "not-authorized":
    case "not-found": return notFound();
    case "out-of-reach": return relayError("personal_agent_out_of_reach");
    case "read-only": return relayError("personal_agent_view_only");
    case "idempotency-conflict": return relayError("conflict", "idempotency key was already used for a different message");
    case "workspace-quota": return relayError("quota_exceeded");
    case "invalid-input": return badRequest("chat message is invalid");
  }
}

function chatMessage(row: SyncRelayLogRow): { message: NamedChatMessage; payload: Record<string, unknown> } | null {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch {
    return null;
  }
  const message = messageFromOp({ relaySeq: row.relaySeq, opKind: row.opKind, payload }, row.originId);
  return message ? { message, payload: payload as Record<string, unknown> } : null;
}

// The message with its bytes in the answer, when they fit in `room`. The
// first message of an answer always goes in, without its body if need be.
function fitted<Message extends LinkChatMessage>(message: Message, room: number, first: boolean): { message: Message; bytes: number } | null {
  const bytes = Buffer.byteLength(JSON.stringify(message)) + 1;
  if (bytes <= room) return { message, bytes };
  if (!first) return null;
  const trimmed = { ...message, body: null, bodyTooLarge: true };
  return { message: trimmed, bytes: Buffer.byteLength(JSON.stringify(trimmed)) + 1 };
}

function take(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function release(counts: Map<string, number>, key: string): void {
  const count = (counts.get(key) ?? 1) - 1;
  if (count === 0) counts.delete(key); else counts.set(key, count);
}

export function createPersonalAgentToolRoutes(input: {
  /** All of it: the Groups list reads through the account executor, which reads the whole storage. */
  storage: SyncRelayStorage;
  linkAuthority: Pick<LinkAuthorityResolver, "personal" | "freshPersonal">;
  personalAgents: Pick<PersonalAgents, "register">;
  nowMs: () => number;
  activity: Pick<DiscussionActivityHub, "wait" | "wakeLog">;
  /** Admits requests per connection. */
  limiter: TokenBucketLimiter;
  /** Admits a blob's bytes in flight per connection; returns their release. */
  admitBlobBytes: (key: string, byteLength: number) => (() => void) | null;
  maxFiles: number;
  maxResponseBytes?: number;
  /** This server's copies of workspaces, which the Groups list reads; undefined while they are off or starting. */
  copies: () => ServerCopies | undefined;
}) {
  const { storage, linkAuthority, nowMs, activity } = input;
  const maxResponseBytes = input.maxResponseBytes ?? AGENT_CHAT_WAIT_MAX_RESPONSE_BYTES;
  const waitsByConnection = new Map<string, number>();
  const waitsByAccount = new Map<string, number>();

  const credential = (authority: PersonalAuthority): PersonalCredential =>
    ({ check: authority.check, connectionId: authority.connectionId, fenceEpoch: authority.fenceEpoch });

  // The workspace is in reach and its account owns it; null reads as out of reach.
  const reachIn = (authority: PersonalAuthority, workspaceId: string): PersonalReach => {
    const reach = storage.readPersonalReach(credential(authority), workspaceId, nowMs());
    if (!reach) throw relayError("personal_agent_out_of_reach");
    return reach;
  };

  const scopeOf = (authority: PersonalAuthority): PersonalScope => {
    const scope = storage.readPersonalScope(credential(authority), nowMs());
    if (!scope) throw notFound();
    return scope;
  };

  async function readBody(request: Request): Promise<Record<string, unknown>> {
    let body: unknown;
    try {
      body = await readBoundedJson(request, LINK_CHAT_MAX_POST_BYTES, request.signal);
    } catch {
      throw badRequest("invalid request");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("invalid request");
    return body as Record<string, unknown>;
  }

  // The agent's current name and handle, and the workspaces it reaches, each
  // with the owner's name for it, the agent's level there, and its DM. Sign-in
  // and widening reach append the DM, so it is there before any computer runs.
  function workspaces(authority: PersonalAuthority, body: Record<string, unknown>): Response {
    fields(body, [], []);
    const reached = storage.readPersonalWorkspaces(credential(authority), nowMs());
    if (!reached) throw notFound();
    const { agentId, name } = reached;
    const dmChannelWireId = agentChannelWireId(agentId);
    return jsonResponse({
      ok: true,
      agent: { agentId, name, handle: agentHandle(name) },
      workspaces: reached.workspaces.map(workspace => ({ ...workspace, dmChannelWireId })),
    });
  }

  // The workspace's Groups, read through this server's copy as the account's
  // phone reads them, under the account executor's capacity and refusals. The
  // agent's DM and people's DMs are never listed, nor a Group without a
  // channel id to read or post by. The visit checks the agent's authority at
  // the account's current fence, and its reach, once the copy opens, once it
  // has synced, and before the answer. A server that keeps no copies says so,
  // after the reach check.
  async function groups(authority: PersonalAuthority, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    fields(body, ["workspaceId"], []);
    const workspaceId = parseWorkspaceId(body.workspaceId);
    reachIn(authority, workspaceId);
    const copies = input.copies();
    if (copies === undefined) throw relayError("server_copies_off");
    const authorize = async () => {
      const fresh = await linkAuthority.freshPersonal(authority);
      if (!storage.readPersonalReach(credential(fresh), workspaceId, nowMs())) throw notFound();
    };
    const { result } = await runAccountOperation({ storage, copies }, {
      owner: authority.ownerUserId, workspaceId, operation: "groups", args: {}, authorize,
      visitor: { reason: "account", caller: `agent:${authority.connectionId}`, signal, phone: false },
    });
    const listed = result as CliResultByVerb["groups"];
    return jsonResponse({
      ok: true,
      workspaceId,
      groups: listed.groups.flatMap(group => group.kind === "group" && typeof group.channelWireId === "string"
        ? [{ channelWireId: group.channelWireId, name: group.name, purpose: group.purpose ?? null }] : []),
    });
  }

  // The relay writes the post from the agent's origin. The storage write reads
  // the agent's authority, reach, and ownership again inside its transaction.
  function post(authority: PersonalAuthority, body: Record<string, unknown>): Response {
    fields(body, ["workspaceId", "body", "idempotencyKey"], ["channelWireId", "threadId", "filePath"]);
    const workspaceId = parseWorkspaceId(body.workspaceId);
    if (["channelWireId", "threadId", "filePath"].filter(key => key in body).length !== 1) {
      throw badRequest("name a channel, a thread, or a file");
    }
    const target: PersonalChatTarget = "threadId" in body ? { threadId: parseString(body.threadId, "threadId", CHAT_ID_CHARS) }
      : "filePath" in body ? { filePath: parseString(body.filePath, "filePath", MAX_SHARE_PATH_CHARS) }
      : { channelWireId: parseString(body.channelWireId, "channelWireId", CHAT_ID_CHARS) };
    if (typeof body.body !== "string" || typeof body.idempotencyKey !== "string") throw badRequest("chat message is invalid");
    const result = storage.appendPersonalChatPost({
      ...credential(authority), now: nowMs, workspaceId, target, body: body.body, idempotencyKey: body.idempotencyKey,
    });
    if (!result.ok) throw postRefusal(result.reason);
    if (!result.replayed) activity.wakeLog(workspaceId);
    const read = chatMessage(result.row)?.message;
    if (!read) throw new Error("stored personal agent post is not a chat message");
    const message: PersonalWaitMessage = {
      ...linkChatMessage(read), workspaceId, channelWireId: result.channelWireId, filePath: result.filePath,
    };
    return jsonResponse({ ok: true, message });
  }

  function pageOf(body: Record<string, unknown>): { cursor: number | null; direction: "older"; limit: number } {
    return {
      cursor: body.before === undefined ? null : boundedInteger(body.before, "before", 0, Number.MAX_SAFE_INTEGER),
      direction: "older",
      limit: body.limit === undefined ? CHAT_READ_DEFAULT_LIMIT : boundedInteger(body.limit, "limit", 1, CHAT_READ_MAX_LIMIT),
    };
  }

  // The messages of a page whose thread `kept` keeps, as many as fit in an
  // answer that also holds `frame`. One check per thread on the page.
  function fittedPage(
    page: ReturnType<SyncRelayStorage["fetchChatMessages"]>, frame: Record<string, string>, kept: (threadId: string) => boolean,
  ): { messages: LinkChatMessage[]; olderCursor: number | null } {
    const messages: LinkChatMessage[] = [];
    let olderCursor = page.hasMore ? page.nextCursor : null;
    let room = maxResponseBytes - Buffer.byteLength(JSON.stringify({
      ok: true, ...frame, messages: [], olderCursor: Number.MAX_SAFE_INTEGER,
    }));
    const keeps = new Map<string, boolean>();
    for (const row of page.rows) {
      const read = chatMessage(row);
      if (!read) continue;
      const { threadId } = read.message;
      if (!keeps.has(threadId)) keeps.set(threadId, kept(threadId));
      if (!keeps.get(threadId)) continue;
      const next = fitted(linkChatMessage(read.message), room, messages.length === 0);
      if (!next) {
        olderCursor = messages[messages.length - 1]!.relaySeq;
        break;
      }
      messages.push(next.message);
      room -= next.bytes;
    }
    return { messages, olderCursor };
  }

  // A page of a channel's messages, newest first, older than `before`.
  function chat(authority: PersonalAuthority, body: Record<string, unknown>): Response {
    fields(body, ["workspaceId", "channelWireId"], ["before", "limit"]);
    const workspaceId = parseWorkspaceId(body.workspaceId);
    const channelWireId = parseString(body.channelWireId, "channelWireId", CHAT_ID_CHARS);
    const request = pageOf(body);
    reachIn(authority, workspaceId);
    if (!storage.findChannelCreateKind(workspaceId, channelWireId)) throw notFound();
    const page = storage.fetchChatMessages({ workspaceId, channelWireId, ...request });
    // A thread is the channel's only when its first create names the channel
    // and no file, as a share link reads it.
    const { messages, olderCursor } = fittedPage(page, { workspaceId, channelWireId },
      threadId => storage.findThreadCreateChannelWireId(workspaceId, threadId) === channelWireId);
    return jsonResponse({ ok: true, workspaceId, channelWireId, messages, olderCursor });
  }

  // A page of the Comment messages on a current file, or in one Comment
  // thread, newest first, older than `before`. A thread answers on a current
  // file or a deleted one, with the path the file has or last had.
  function discussion(authority: PersonalAuthority, body: Record<string, unknown>): Response {
    fields(body, ["workspaceId"], ["filePath", "threadId", "before", "limit"]);
    const workspaceId = parseWorkspaceId(body.workspaceId);
    if (("filePath" in body) === ("threadId" in body)) throw badRequest("name a file or a thread");
    if ("threadId" in body) {
      return threadDiscussion(authority, workspaceId, parseString(body.threadId, "threadId", CHAT_ID_CHARS), pageOf(body));
    }
    const named = parseString(body.filePath, "filePath", MAX_SHARE_PATH_CHARS);
    const request = pageOf(body);
    reachIn(authority, workspaceId);
    const file = currentFileAt(storage, workspaceId, named);
    if (!file) throw notFound();
    const { objectId, filePath } = file;
    const page = storage.fetchCommentMessages({ workspaceId, objectId, path: filePath, ...request });
    // A thread is the file's only when its first create binds this file and no other.
    const { messages, olderCursor } = fittedPage(page, { workspaceId, filePath },
      threadId => commentFileOf(storage, workspaceId, threadId)?.objectId === objectId);
    return jsonResponse({ ok: true, workspaceId, filePath, messages, olderCursor });
  }

  // A thread on no file, or on one whose current or last path is secret or unknown, is not found.
  function threadDiscussion(
    authority: PersonalAuthority, workspaceId: string, threadId: string, request: ReturnType<typeof pageOf>,
  ): Response {
    reachIn(authority, workspaceId);
    const file = commentFileOf(storage, workspaceId, threadId);
    if (!file) throw notFound();
    const { filePath } = file;
    const page = storage.fetchThreadMessages({ workspaceId, threadId, ...request });
    const { messages, olderCursor } = fittedPage(page, { workspaceId, threadId, filePath }, () => true);
    return jsonResponse({ ok: true, workspaceId, threadId, filePath, messages, olderCursor });
  }

  // The workspace's current files on its main version.
  function files(authority: PersonalAuthority, body: Record<string, unknown>): Response {
    fields(body, ["workspaceId"], []);
    const workspaceId = parseWorkspaceId(body.workspaceId);
    reachIn(authority, workspaceId);
    const snapshot = storage.readCurrentFileState({ workspaceId, versionId: MAIN_VERSION_ID, selectorPaths: [], limit: input.maxFiles });
    return jsonResponse({ ok: true, workspaceId, files: snapshot.files, truncated: snapshot.tooMany });
  }

  // A current file's bytes. The download is running work: a revoking commit
  // ends it, and each chunk checks the agent's authority at the account's
  // current fence, and its reach, again.
  function blob(authority: PersonalAuthority, body: Record<string, unknown>, signal: AbortSignal): Response {
    fields(body, ["workspaceId", "sha256"], []);
    const workspaceId = parseWorkspaceId(body.workspaceId);
    if (typeof body.sha256 !== "string" || !SHA256.test(body.sha256)) throw badRequest("sha256 is invalid");
    const sha256 = body.sha256;
    reachIn(authority, workspaceId);
    const byteLength = storage.currentFileBlobByteLength({
      workspaceId, versionId: MAIN_VERSION_ID, selectorPaths: [], sha256, epochLogFloor: storage.getEpochLogFloor(workspaceId),
    });
    if (byteLength === null || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_BLOB_BYTES) throw notFound();
    const releaseBytes = input.admitBlobBytes(authority.callerKey, byteLength);
    if (!releaseBytes) throw relayError("link_read_rate_limited");
    let terminateStream: (() => void) | undefined;
    let unregister: (() => void) | undefined;
    let streamOwnsAdmission = false;
    try {
      unregister = input.personalAgents.register({
        agentId: authority.agentId, ownerUserId: authority.ownerUserId, connectionId: authority.connectionId,
        fenceEpoch: authority.fenceEpoch, workspaceIds: [workspaceId], kind: "stream",
        terminate: () => terminateStream?.(),
      });
      const bytes = storage.getBlob(workspaceId, sha256);
      if (!bytes || bytes.byteLength !== byteLength) throw notFound();
      const response = guardedByteResponse(bytes, {
        "content-length": String(byteLength),
        "content-type": "application/octet-stream",
      }, {
        register: (terminate) => {
          terminateStream = terminate;
          return unregister!;
        },
        release: () => releaseBytes(),
        terminatedMessage: "personal agent access changed during stream",
        guard: async () => {
          const fresh = await linkAuthority.freshPersonal(authority);
          if (!storage.readPersonalReach(credential(fresh), workspaceId, nowMs())) throw notFound();
        },
        signal,
      });
      streamOwnsAdmission = true;
      return response;
    } finally {
      if (!streamOwnsAdmission) {
        unregister?.();
        releaseBytes();
      }
    }
  }

  // Answers with the messages for the agent across its reach: a human post by
  // its account, not from the CLI, in the agent's DM, mentioning its current
  // handle, or in a thread it posted in. Only the first row a scan reads may
  // pass the scan's byte budget. Every workspace shares one scan
  // budget. A scan that finds nothing but is behind answers at once; one that
  // is caught up parks on every workspace in reach until a wake, the
  // deadline, or running work ending. Access is checked before every scan and
  // again before the answer leaves.
  async function wait(authority: PersonalAuthority, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    fields(body, [], ["cursor", "timeoutMs"]);
    const timeoutMs = body.timeoutMs === undefined ? AGENT_CHAT_MAX_WAIT_MS
      : boundedInteger(body.timeoutMs, "timeoutMs", 0, AGENT_CHAT_MAX_WAIT_MS);
    const cursor = waitCursor(body.cursor, authority.agentId);
    const deadline = nowMs() + timeoutMs;
    const { agentId, ownerUserId, connectionId } = authority;
    let current = authority;
    let scope = scopeOf(current);
    if ((waitsByConnection.get(connectionId) ?? 0) >= MAX_AGENT_CHAT_WAITS_PER_CONNECTION ||
        (waitsByAccount.get(ownerUserId) ?? 0) >= MAX_PERSONAL_WAITS_PER_ACCOUNT) {
      throw relayError("link_read_rate_limited");
    }
    take(waitsByConnection, connectionId);
    take(waitsByAccount, ownerUserId);
    // Running work ending: Sign out, a reach change, a reset, or the fence going quiet.
    const ended = new AbortController();
    const held = AbortSignal.any([signal, ended.signal]);
    let unregister: (() => void) | undefined;
    try {
      unregister = input.personalAgents.register({
        agentId, ownerUserId, connectionId, fenceEpoch: authority.fenceEpoch,
        workspaceIds: scope.reach.map(entry => entry.workspaceId), kind: "wait",
        terminate: () => ended.abort(),
      });
      const seqs = new Map(Object.entries(cursor?.seqs ?? {}));
      let turn = cursor?.turn ?? null;

      // A workspace new to reach starts where its reach began; one that left drops out.
      const place = (entry: PersonalScope["reach"][number]) => Math.max(seqs.get(entry.workspaceId) ?? entry.startSeq, entry.startSeq);

      const scan = (within: PersonalScope): { found: PersonalWaitMessage[]; behind: boolean } => {
        const reach = [...within.reach].sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0));
        const placed = new Map(reach.map(entry => [entry.workspaceId, place(entry)]));
        seqs.clear();
        for (const [id, seq] of placed) seqs.set(id, seq);
        const found: PersonalWaitMessage[] = [];
        if (reach.length === 0) return { found, behind: false };
        let start = turn === null ? 0 : reach.findIndex(entry => entry.workspaceId >= turn!);
        if (start < 0) start = 0;
        turn = reach[(start + 1) % reach.length]!.workspaceId;
        const mention = agentMention(within.name);
        const dm = agentChannelWireId(agentId);
        let rows = CHAT_HISTORY_SCAN_WINDOW;
        let bytes = CHAT_HISTORY_SCAN_BYTES;
        let firstOfScan = true;
        let room = maxResponseBytes - Buffer.byteLength(JSON.stringify({
          ok: true, messages: [], more: true,
          cursor: {
            v: 1, agentId, seqs: Object.fromEntries(reach.map(entry => [entry.workspaceId, Number.MAX_SAFE_INTEGER])),
            turn: reach.reduce((longest, entry) => (entry.workspaceId.length > longest.length ? entry.workspaceId : longest), ""),
          },
        }));
        let full = false;
        for (let visited = 0; visited < reach.length && !full && rows > 0 && bytes > 0; visited++) {
          const entry = reach[(start + visited) % reach.length]!;
          const after = seqs.get(entry.workspaceId)!;
          if (after >= entry.headSeq) continue;
          const window = storage.readPersonalWaitWindow({
            workspaceId: entry.workspaceId, afterSeq: after, maxRows: rows, maxBytes: bytes, firstOfScan,
          });
          if (window.rows > 0) firstOfScan = false;
          rows -= window.rows;
          bytes -= window.bytes;
          let reached = window.edgeSeq;
          for (const row of window.messages) {
            const message = forAgent(row, entry.workspaceId, within, mention, dm);
            if (!message) continue;
            const next = fitted(message, room, found.length === 0);
            if (!next) {
              // It comes first next time.
              reached = row.relaySeq - 1;
              full = true;
              break;
            }
            found.push(next.message);
            room -= next.bytes;
            if (found.length === PERSONAL_WAIT_MAX_MESSAGES) {
              reached = row.relaySeq;
              full = true;
              break;
            }
          }
          seqs.set(entry.workspaceId, reached);
        }
        return { found, behind: reach.some(entry => seqs.get(entry.workspaceId)! < entry.headSeq) };
      };

      const caughtUp = (within: PersonalScope | null) =>
        within !== null && within.reach.every(entry => place(entry) >= entry.headSeq);

      // One subscription per workspace in reach, all released together. The
      // last re-reads the heads once every subscription is in place.
      const park = async (within: PersonalScope): Promise<void> => {
        const parked = new AbortController();
        const ids = within.reach.map(entry => entry.workspaceId);
        const holdMs = Math.max(1, deadline - nowMs());
        try {
          await Promise.race(ids.map((workspaceId, index) => activity.wait(
            ownerLogWaitGroup(workspaceId), `personal:${connectionId}:${workspaceId}`, {
              holdMs, signal: AbortSignal.any([held, parked.signal]), personal: true,
              shouldPark: index < ids.length - 1 ? () => true : () => {
                try {
                  return caughtUp(storage.readPersonalScope(credential(current), nowMs()));
                } catch {
                  return false;
                }
              },
            },
          )));
        } catch (error) {
          if (error instanceof DiscussionActivityCapacityError) throw relayError("link_read_rate_limited");
          throw error;
        } finally {
          parked.abort();
        }
      };

      // With nothing left in reach there is nothing to hold on.
      let result = scan(scope);
      while (result.found.length === 0 && !result.behind && scope.reach.length > 0 && !held.aborted && nowMs() < deadline) {
        await park(scope);
        current = await linkAuthority.freshPersonal(current);
        scope = scopeOf(current);
        result = scan(scope);
      }
      if (signal.aborted) throw notFound();
      current = await linkAuthority.freshPersonal(current);
      scope = scopeOf(current);
      const inReach = new Set(scope.reach.map(entry => entry.workspaceId));
      for (const id of [...seqs.keys()]) if (!inReach.has(id)) seqs.delete(id);
      const answer: { ok: true; messages: PersonalWaitMessage[]; cursor: PersonalWaitCursor; more: boolean } = {
        ok: true,
        // A file can move to a secret path while the wait holds, so each Comment's file is placed again.
        messages: result.found.filter(message => inReach.has(message.workspaceId) &&
          (message.channelWireId !== null || commentFileOf(storage, message.workspaceId, message.threadId) !== null)),
        cursor: { v: 1, agentId, seqs: Object.fromEntries(seqs), turn },
        more: result.behind,
      };
      return jsonResponse(answer);
    } finally {
      unregister?.();
      release(waitsByConnection, connectionId);
      release(waitsByAccount, ownerUserId);
    }
  }

  function forAgent(row: SyncRelayLogRow, workspaceId: string, scope: PersonalScope, mention: string, dm: string): PersonalWaitMessage | null {
    const read = chatMessage(row);
    if (!read || read.message.authorKind !== "human" || read.message.authorUserId !== scope.connection.ownerUserId ||
        read.payload.origin === "cli") return null;
    const { threadId } = read.message;
    const channelWireId = storage.findThreadCreateChannelWireId(workspaceId, threadId);
    if (channelWireId === undefined) return null;
    // Outside its own DM, another agent's DM and a thread on a file included,
    // a message counts by a mention or a thread the agent posted in.
    if (channelWireId !== dm && !mentions(read.message.body, mention) &&
        !storage.personalAgentPostedIn({ agentId: scope.connection.agentId, workspaceId, threadId })) return null;
    // A Comment on a deleted file names the path the file last had. One whose
    // file is or was last at a secret path, or that the relay never placed,
    // stays out.
    const filePath = channelWireId === null ? commentFileOf(storage, workspaceId, threadId)?.filePath : null;
    if (filePath === undefined) return null;
    return { ...linkChatMessage(read.message), workspaceId, channelWireId, filePath };
  }

  return async function respondToPersonalAgentTools(request: Request, route: PersonalAgentToolRoute): Promise<Response> {
    if (request.method !== "POST") throw relayError("method_not_allowed");
    const authority = await linkAuthority.personal(request);
    if (!input.limiter.allow(authority.callerKey, nowMs())) throw relayError("link_read_rate_limited");
    const body = await readBody(request);
    switch (route.action) {
      // A post or a read checks the fence again once its body is in, and a
      // post's write reads that epoch. A wait checks before it answers, and a
      // file stream before each chunk.
      case "workspaces": return workspaces(await linkAuthority.freshPersonal(authority), body);
      case "groups": return await groups(await linkAuthority.freshPersonal(authority), body, request.signal);
      case "post": return post(await linkAuthority.freshPersonal(authority), body);
      case "wait": return await wait(authority, body, request.signal);
      case "chat": return chat(await linkAuthority.freshPersonal(authority), body);
      case "discussion": return discussion(await linkAuthority.freshPersonal(authority), body);
      case "files": return files(await linkAuthority.freshPersonal(authority), body);
      case "blob": return blob(authority, body, request.signal);
    }
  };
}
