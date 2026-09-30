import { sha256Hex } from "@dohc/workspace-core/hash";
import { stableJsonStringify } from "./canonicalJson";
import { badRequest, relayError } from "./errors";
import { parseString } from "./requestInputs";
import type { SyncRelayLogInput } from "./storage";
import { MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";

const MAX_OP_KIND_CHARS = 128;

export const COLLECTION_CREATE_ORIGIN_PREFIX = "relay:collection-create:";
export const COLLECTION_FILE_ORIGIN_PREFIX = "relay:collection-file:";

export const SHARE_MEMBER_ORIGIN_PREFIX = "relay:share-member:";

export function namedShareOrigin(shareId: string, userId: string, originId: string): string {
  return `${SHARE_MEMBER_ORIGIN_PREFIX}${sha256Hex(JSON.stringify([shareId, userId, originId]))}`;
}

// Only the relay mints public and named authors, under these origins.
export function assertClientLogProvenance(originId: string, rawOps: unknown[]): void {
  if (originId.startsWith(SHARE_MEMBER_ORIGIN_PREFIX)) {
    throw badRequest("originId is reserved for named share writes");
  }
  if (originId.startsWith(COLLECTION_CREATE_ORIGIN_PREFIX)) {
    throw badRequest("originId is reserved for relay collection creates");
  }
  if (originId.startsWith(COLLECTION_FILE_ORIGIN_PREFIX)) {
    throw badRequest("originId is reserved for relay collection file writes");
  }
  for (const raw of rawOps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const op = raw as Record<string, unknown>;
    if (op.opKind !== "moment.append") continue;
    const payload = op.payload as Record<string, unknown> | null;
    const authors = payload?.authors;
    if (Array.isArray(authors) && authors.some((author: unknown) => {
      const kind = (author as Record<string, unknown> | null)?.kind;
      return kind === "public" || kind === "named";
    })) throw relayError("authorship_mismatch");
  }
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
// The relay never mutates replicated payloads because the author reads its own
// operations back and compares those bytes with its local replication log.
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
    if (policy.kind === "structural") continue;
    const payload = op.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      // An authored op with no object payload cannot be verified — reject
      // (fail-closed). parseLogOp would also reject it, but authorship first.
      throw relayError("authorship_mismatch");
    }
    const bag = payload as Record<string, unknown>;
    const claimed = bag[policy.field];
    if (claimed === undefined || claimed === null) {
      throw relayError("authorship_mismatch");
    }
    if (typeof claimed !== "string" || claimed !== actorUserId) {
      throw relayError("authorship_mismatch");
    }
  }
}
