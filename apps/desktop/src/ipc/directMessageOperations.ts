import { z } from "zod";
import { DIRECT_MESSAGE_BODY_MAX_BYTES, MAX_DIRECT_PEOPLE } from "@dohc/security-contract/direct-messages";
import type { OperationTable } from "./operationTable";

// Direct messages belong to the signed-in account on its server, not to a
// workspace, so most rows are device-scoped. Starting from a member list
// needs the window's workspace, because main names the relay workspace from it.

export const DIRECT_INACTIVE_MESSAGE = "This message was not sent because this window changed workspaces.";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const personId = z.string().regex(/^[\x21-\x7e]{1,256}$/u);
const name = z.string().min(1).max(200).nullable();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const body = z.string().min(1).refine((value) => new TextEncoder().encode(value).length <= DIRECT_MESSAGE_BODY_MAX_BYTES, "message is too long");
const memberIds = z.array(z.string().min(1).max(256)).min(1).max(MAX_DIRECT_PEOPLE - 1);

export const DirectPersonSchema = z.object({ personId, name, blocked: z.boolean() }).strict();
export const DirectMessageSchema = z.object({
  seq: count.min(1), messageId: id, authorId: personId, authorName: name, body: z.string(), createdAtMs: count,
}).strict();
export const DirectConversationSchema = z.object({
  conversationId: id,
  people: z.array(DirectPersonSchema).min(1).max(MAX_DIRECT_PEOPLE - 1),
  last: DirectMessageSchema.nullable(),
  unread: count,
  blocked: z.boolean(),
}).strict();

/** Signed out: nothing to show. `saved`: the server was unreachable and this is this computer's copy. */
const DirectListResult = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z.object({ available: z.literal(true), viewerId: personId, saved: z.boolean(), conversations: z.array(DirectConversationSchema) }).strict(),
]);
const DirectHistoryResult = z.object({ messages: z.array(DirectMessageSchema), more: z.boolean(), saved: z.boolean() }).strict();
const DirectResolveResult = z.object({ conversationId: id.nullable(), people: z.array(DirectPersonSchema).min(1) }).strict();
const DirectSendResult = z.object({ conversationId: id, seq: count.min(1) }).strict();

export const directMessageOperations = {
  directConversations: {
    capabilityId: "direct.list",
    channel: "desktop:direct-conversations",
    payload: z.object({}).strict(),
    result: DirectListResult,
    guard: "trusted-sender", scope: "device",
  },
  directHistory: {
    capabilityId: "direct.read",
    channel: "desktop:direct-history",
    payload: z.object({ conversationId: id, before: count.min(1).optional() }).strict(),
    result: DirectHistoryResult,
    guard: "trusted-sender", scope: "device",
  },
  directResolve: {
    capabilityId: "direct.read",
    channel: "desktop:direct-resolve",
    payload: z.object({ workspaceId: z.string().min(1).max(256), memberIds }).strict(),
    result: DirectResolveResult,
    guard: "active-workspace", scope: "workspace",
    inactiveMessage: DIRECT_INACTIVE_MESSAGE,
  },
  directStart: {
    capabilityId: "direct.send",
    channel: "desktop:direct-start",
    payload: z.object({ workspaceId: z.string().min(1).max(256), memberIds, messageId: id, body }).strict(),
    result: DirectSendResult,
    guard: "active-workspace", scope: "workspace",
    inactiveMessage: DIRECT_INACTIVE_MESSAGE,
  },
  directSend: {
    capabilityId: "direct.send",
    channel: "desktop:direct-send",
    payload: z.object({ conversationId: id, messageId: id, body }).strict(),
    result: DirectSendResult,
    guard: "trusted-sender", scope: "device",
  },
  directMarkRead: {
    capabilityId: "direct.read",
    channel: "desktop:direct-read",
    payload: z.object({ conversationId: id, seq: count }).strict(),
    guard: "trusted-sender", scope: "device",
  },
  directBlock: {
    capabilityId: "direct.block",
    channel: "desktop:direct-block",
    payload: z.object({ conversationId: id, personId, blocked: z.boolean() }).strict(),
    guard: "trusted-sender", scope: "device",
  },
} as const satisfies OperationTable;

/** Main tells every window, on CHANNELS.directChanged, when the account's direct conversations change on the server. */
export const DirectChangedEvent = z.undefined();
