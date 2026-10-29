import { sha256Hex } from "@dohc/workspace-core/hash";
import { parseLiveAuthorContext, parseLiveAuthorSnapshot, type LiveAuthorContext } from "@dohc/live-session-contract/live-authorship";
import { stableJsonStringify } from "./canonicalJson";
import { accountDisplayName } from "./accountDisplayName";
import { badRequest, relayError } from "./errors";
import { parseString } from "./requestInputs";
import type { SyncRelayLogInput } from "./storage";
import { REFUSED_OP_KIND } from "./storage/relayAdmission";
import { MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";

const MAX_OP_KIND_CHARS = 128;

export const COLLECTION_CREATE_ORIGIN_PREFIX = "relay:collection-create:";
export const COLLECTION_FILE_ORIGIN_PREFIX = "relay:collection-file:";

export const SHARE_MEMBER_ORIGIN_PREFIX = "relay:share-member:";

// Only the service host's own feed accepts writes from these origins, so they
// never collide with an owner device's coordinates.
export const SERVICE_HOST_ORIGIN_PREFIX = "service-host:";
// Only the relay writes a document's first live base, under an origin it derives.
export const FIRST_OPEN_ORIGIN_PREFIX = "service-host:first-open:";

export function namedShareOrigin(shareId: string, userId: string, originId: string): string {
  return `${SHARE_MEMBER_ORIGIN_PREFIX}${sha256Hex(JSON.stringify([shareId, userId, originId]))}`;
}

// A link holder's posts, one origin per link principal. Only the relay writes it.
export const LINK_CHAT_ORIGIN_PREFIX = "relay:share-link:";

export function linkChatOrigin(principalId: string): string {
  return `${LINK_CHAT_ORIGIN_PREFIX}${principalId}`;
}

// A desktop stores a received share's op under `shared:<shareId>:<source>` and
// checks a link post against its source, so no client may write from it.
export const SHARED_REPLAY_ORIGIN_PREFIX = "shared:";

// The IDs of a link post's message and new thread. Only the relay mints them,
// so no client can take one first and drop the link post on every desktop.
export const LINK_CHAT_MESSAGE_ID_PREFIX = "link-message:";
export const LINK_CHAT_THREAD_ID_PREFIX = "link-thread:";

// Clients can publish their agent and automation authors, or an exact
// unattributed coverage marker. The marker claims no identity. The relay
// alone mints human, public, named, and link attribution.
const CLIENT_MOMENT_AUTHOR_KINDS: ReadonlySet<unknown> = new Set(["agent", "automation"]);

export function assertClientLogProvenance(originId: string, rawOps: unknown[],
  {deferMomentRefusal = false, serviceHost = false}: {deferMomentRefusal?: boolean; serviceHost?: boolean} = {}): void {
  assertUnreservedLogOrigin(originId, serviceHost);
  for (const raw of rawOps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const op = raw as Record<string, unknown>;
    if (op.opKind !== "moment.append") continue;
    const payload = op.payload as Record<string, unknown> | null;
    if (deferMomentRefusal && payload && Object.hasOwn(payload, "settlementReference")) continue;
    if (clientMomentAuthorsRefused(payload?.authors) && !deferMomentRefusal) throw relayError("authorship_mismatch");
  }
}

function assertUnreservedLogOrigin(originId: string, serviceHost: boolean): void {
  if (originId.startsWith(SERVICE_HOST_ORIGIN_PREFIX) !== serviceHost) {
    throw badRequest(serviceHost ? "originId must use the service host prefix" : "originId is reserved for service host writes");
  }
  if (originId.startsWith(FIRST_OPEN_ORIGIN_PREFIX)) {
    throw badRequest("originId is reserved for relay first-open bases");
  }
  if (originId.startsWith(SHARE_MEMBER_ORIGIN_PREFIX)) {
    throw badRequest("originId is reserved for named share writes");
  }
  if (originId.startsWith(LINK_CHAT_ORIGIN_PREFIX)) {
    throw badRequest("originId is reserved for link posts");
  }
  if (originId.startsWith(SHARED_REPLAY_ORIGIN_PREFIX)) {
    throw badRequest("originId is reserved for replayed share ops");
  }
  if (originId.startsWith(COLLECTION_CREATE_ORIGIN_PREFIX)) {
    throw badRequest("originId is reserved for relay collection creates");
  }
  if (originId.startsWith(COLLECTION_FILE_ORIGIN_PREFIX)) {
    throw badRequest("originId is reserved for relay collection file writes");
  }
}

export function clientMomentAuthorsRefused(authors:unknown):boolean {
  return authors != null && (!Array.isArray(authors) || authors.length === 0 || authors.some((author: unknown) =>
    !author || typeof author !== "object" || Array.isArray(author) ||
    (!CLIENT_MOMENT_AUTHOR_KINDS.has((author as Record<string, unknown>).kind) &&
      !((author as Record<string, unknown>).kind === "unattributed" && Object.keys(author).length === 1))));
}

export function parseLogOp(value: unknown): SyncRelayLogInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("each op must be a JSON object");
  }
  const op = value as Record<string, unknown>;
  const originSeq = Number(op.originSeq);
  if (!Number.isInteger(originSeq) || originSeq < 0) {
    throw badRequest("originSeq must be a non-negative integer");
  }
  const opKind = parseString(op.opKind, "opKind", MAX_OP_KIND_CHARS);
  if (opKind === REFUSED_OP_KIND) throw badRequest("opKind is reserved for the relay");
  if (!op.payload || typeof op.payload !== "object" || Array.isArray(op.payload)) {
    throw badRequest("payload must be a JSON object");
  }
  const recordedAtMs = op.recordedAtMs;
  if (typeof recordedAtMs !== "number" || !Number.isSafeInteger(recordedAtMs)) {
    throw badRequest("recordedAtMs must be an integer in the safe wire range");
  }
  const payloadJson = stableJsonStringify(op.payload);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_JSON_BYTES) {
    throw badRequest("payload is too large");
  }
  return { originSeq, opKind, payloadJson, recordedAtMs };
}

export type LogAuthorNameLookup = (userId: string) => Promise<string | null> | string | null;

async function authenticatedDisplayName(actorUserId: string, lookupUserDisplayName?: LogAuthorNameLookup, fallback = "Unnamed"): Promise<string> {
  const name = await accountDisplayName(lookupUserDisplayName, actorUserId) ?? fallback;
  try {
    parseLiveAuthorSnapshot([{kind: "human", humanId: actorUserId, humanName: name}]);
    return name;
  } catch {
    return fallback;
  }
}

export async function parseNamedShareLogOps(
  values: unknown[],
  actorUserId: string,
  lookupUserDisplayName?: LogAuthorNameLookup,
): Promise<SyncRelayLogInput[]> {
  let lookup: Promise<string | null> | undefined;
  // A failed lookup leaves the post unnamed rather than refusing it.
  const accountName = () => lookup ??= accountDisplayName(lookupUserDisplayName, actorUserId);
  const ops = await parseAuthenticatedLogOps(values, actorUserId, accountName);
  const chatOps = ops.filter(op => op.opKind === "chat.message.append" || op.opKind === "chat.reaction.set");
  if (chatOps.length === 0) return ops;
  // Chat names a person without an account name "Unnamed", as the relay's other chat and discussion routes do.
  const humanName = await authenticatedDisplayName(actorUserId, accountName);
  const snapshot = parseLiveAuthorSnapshot([{kind: "human", humanId: actorUserId, humanName}]);
  for (const op of chatOps) {
    op.admittedAuthorSnapshot = snapshot;
    if (op.opKind === "chat.reaction.set") continue;
    const payload = JSON.parse(op.payloadJson) as Record<string, unknown>;
    if (payload.authorKind !== "human" && payload.authorKind !== "agent" && payload.authorKind !== "automation") {
      throw badRequest("invalid author kind");
    }
    if (payload.authorKind !== "human") {
      const name = payload.authorDisplayName;
      if (typeof name !== "string" || !name.isWellFormed() || !name.trim() || name.trim().length > 200) {
        throw badRequest("invalid display name");
      }
      payload.authorDisplayName = name.trim();
      op.payloadJson = stableJsonStringify(payload);
    }
  }
  return ops;
}

function ordinaryAuthorContext(payload: unknown, opKind: string): LiveAuthorContext | undefined {
  const fields = payload as Record<string, unknown>;
  if (opKind === "moment.append" && (Object.hasOwn(fields, "settlementReference") ||
    Object.hasOwn(fields, "attributionUnavailable") || fields.authors != null)) return undefined;
  if (!Object.hasOwn(fields, "authorContext")) return undefined;
  try {
    const context = parseLiveAuthorContext(fields.authorContext);
    if (context.agent) parseLiveAuthorSnapshot([{kind: "agent", ...context.agent}]);
    return context;
  } catch {
    throw badRequest(`invalid ${opKind} authorContext`);
  }
}

export async function parseAuthenticatedLogOps(
  values: unknown[],
  actorUserId: string,
  lookupUserDisplayName?: LogAuthorNameLookup,
): Promise<SyncRelayLogInput[]> {
  const ops = values.map(value => parseLogOp(value));
  const contexts = ops.map((op, index) => op.opKind === "ydoc.update" || op.opKind === "moment.append"
    ? ordinaryAuthorContext((values[index] as Record<string, unknown>).payload, op.opKind)
    : undefined);
  // Consume ordinary recording claims even if queued moment authors were
  // repaired. Main's live, declared-agent and settlement contexts stay intact.
  for (const [index, op] of ops.entries()) {
    const payload = (values[index] as {payload: Record<string, unknown>}).payload;
    const context = payload.authorContext as {kind?: unknown; accountId?: unknown; agent?: unknown} | null | undefined;
    if (context?.kind !== "account" || context.agent != null) continue;
    if (op.opKind === "moment.append" && (Object.hasOwn(payload, "settlementReference") ||
      Object.hasOwn(payload, "attributionUnavailable"))) continue;
    const attribution = payload.attribution as {actorKind?: unknown} | null | undefined;
    if (op.opKind !== "moment.append" && !(op.opKind === "ydoc.update" && payload.isBaseState === false &&
      payload.actorOriginId === context.accountId && attribution?.actorKind === "human")) continue;
    const {authorContext: _claim, ...stored} = payload;
    op.payloadJson = stableJsonStringify(stored);
  }
  if (!contexts.some(context => context?.kind === "account" && context.accountId === actorUserId)) return ops;
  const humanName = await authenticatedDisplayName(actorUserId, lookupUserDisplayName);
  for (const [index, context] of contexts.entries()) {
    if (context?.kind !== "account" || context.accountId !== actorUserId) continue;
    ops[index]!.admittedAuthorSnapshot = parseLiveAuthorSnapshot([
      {kind: "human", humanId: actorUserId, humanName},
      ...(context.agent ? [{kind: "agent", ...context.agent, onBehalfOf: actorUserId}] : []),
    ]);
  }
  return ops;
}

// MU-C0 verified authorship. The relay authenticates who is pushing
// (actor.userId, server-derived from the Better Auth session — a client cannot
// assert it). For every chat op that names an author, that author must be the
// pusher, or the whole batch is rejected. This is the one place the relay reads
// into a chat payload — a second narrow, tested relaxation of "payloads are
// opaque", after PR-18's share filter, scoped to the author field, fail-closed.
//
// FAIL-CLOSED COMPLETENESS. The chat.* namespace is exhaustive here: every
// chat op is either an explicitly-enumerated structural (no-author) op or an
// authored op with a known author field. An unknown/unmapped chat.* op (a
// future chat.thread.update, chat.message.edit,...) is rejected, never
// admitted unverified — shipping a new authored chat op without extending this
// policy fails closed, not open. Non-chat ops stay fully opaque and pass
// through untouched.
//
// Author identity is always the OPAQUE relay user id (never a raw email — PII
// must not enter the replicated CRDT):
//  - chat.message.append.authorUserId — REQUIRED. Messages without a verified
//    relay identity stay in the local engine and never enter a relay log.
//  - chat.reaction.set.authorId       — REQUIRED. A reaction is inherently an
//    authored act, so a missing/non-string author id is a malformed op and is
//    rejected (fail-closed), same as a mismatch.
//  - chat.decision.set / chat.attachment.add carry no author field. They are
//    derived from messages whose authorship was already verified, so they are
//    explicitly structural here and receive no separate authorship assertion.
//
// A future authored chat op is verified by adding it to CHAT_OP_POLICY; a
// future no-author chat op by enumerating it as "structural".
type ChatOpPolicy =
  | { kind: "structural" }
  | {
      kind: "authored";
      field: string;
    };
const CHAT_OP_POLICY: Record<string, ChatOpPolicy> = {
  // No-author structural/derived ops: nothing to verify, pass through.
  "chat.channel.create": { kind: "structural" },
  "chat.thread.create": { kind: "structural" },
  "chat.decision.set": { kind: "structural" },
  "chat.attachment.add": { kind: "structural" },
  // Authored ops: a present author field must equal the authenticated pusher.
  "chat.message.append": {
    kind: "authored",
    field: "authorUserId",
  },
  "chat.reaction.set": { kind: "authored", field: "authorId" },
  // Receiver-private state still rides the owner's ordinary workspace log.
  // It never appears in a channel share, and the authenticated pusher must be
  // the receiver named by the durable record.
  "chat.follow.set": { kind: "authored", field: "ownerUserId" },
  "chat.feed.read.set": { kind: "authored", field: "ownerUserId" },
};

// Verifies chat authorship before parseLogOp freezes the exact payload bytes.
// The ordinary workspace route preserves payload bytes for replica comparison.
// Named share writes separately admit the account's chat display name.
export function assertChatAuthorship(
  rawOps: unknown[],
  actorUserId: string,
): void {
  for (const rawOp of rawOps) {
    if (!rawOp || typeof rawOp !== "object" || Array.isArray(rawOp)) continue;
    const op = rawOp as Record<string, unknown>;
    const opKind = op.opKind;
    if (typeof opKind !== "string") continue;
    // Only chat.* ops are subject to the authorship gate; everything else is an
    // opaque payload and passes through even if it carries an author-shaped field.
    if (!opKind.startsWith("chat.")) continue;
    const policy = CHAT_OP_POLICY[opKind];
    if (!policy) throw relayError("unknown_chat_op"); // fail-closed: an unrecognized chat op.
    // Only the relay names a link post's message and new thread.
    const reserved = op.payload && typeof op.payload === "object" ? op.payload as Record<string, unknown> : {};
    if ((opKind === "chat.message.append" && String(reserved.messageId).startsWith(LINK_CHAT_MESSAGE_ID_PREFIX)) ||
        (opKind === "chat.thread.create" && String(reserved.threadId).startsWith(LINK_CHAT_THREAD_ID_PREFIX))) {
      throw relayError("authorship_mismatch");
    }
    if (policy.kind === "structural") continue;
    const payload = op.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      // An authored op with no object payload cannot be verified — reject
      // (fail-closed). parseLogOp would also reject it, but authorship first.
      throw relayError("authorship_mismatch");
    }
    const bag = payload as Record<string, unknown>;
    // Only the relay writes a link post, from the link holder's own session.
    if (opKind === "chat.message.append" && (bag.authorKind === "link" ||
        Object.hasOwn(bag, "linkGrantId") || Object.hasOwn(bag, "linkPrincipalId"))) {
      throw relayError("authorship_mismatch");
    }
    const claimed = bag[policy.field];
    if (claimed === undefined || claimed === null) {
      throw relayError("authorship_mismatch");
    }
    if (typeof claimed !== "string" || claimed !== actorUserId) {
      throw relayError("authorship_mismatch");
    }
  }
}
