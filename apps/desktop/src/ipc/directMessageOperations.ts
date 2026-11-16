import { z } from "zod";
import {
  isDirectId,
  isDirectMessageBody,
  isDirectPersonId,
  parseDirectConversation,
  parseDirectMessagePage,
  parseDirectResolution,
  parseDirectSendResult,
  type DirectConversation,
  type DirectMessagePage,
  type DirectResolution,
  type DirectSendResult,
} from "@dohc/security-contract/direct-messages";
import type { OperationTable } from "./operationTable";

// Direct messages belong to the signed-in account on its server, not to a
// workspace, so most rows are device-scoped. Starting from a member list
// needs the window's workspace, because main names the relay workspace from it.
// Every call but the list names the account the window read; main acts only
// while that account is signed in.

export const DIRECT_INACTIVE_MESSAGE = "This message was not sent because this window changed workspaces.";

// The contract's own checks, so the window and the relay agree on every limit.
const id = z.string().refine(isDirectId, "invalid id");
const viewerId = z.string().refine(isDirectPersonId, "invalid account");
const body = z.string().refine(isDirectMessageBody, "message is empty or too long");
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const memberId = z.string().min(1).max(256);
const contract = <T>(parse: (value: unknown) => T | null, what: string) => z.custom<T>((value) => parse(value) !== null, what);

/** Signed out: nothing to show. */
const DirectListResult = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }).strict(),
  z.object({ available: z.literal(true), viewerId, conversations: z.array(contract<DirectConversation>(parseDirectConversation, "invalid conversation")) }).strict(),
]);

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
    payload: z.object({ viewerId, conversationId: id, before: count.min(1).optional() }).strict(),
    result: contract<DirectMessagePage>(parseDirectMessagePage, "invalid page"),
    guard: "trusted-sender", scope: "device",
  },
  directResolve: {
    capabilityId: "direct.read",
    channel: "desktop:direct-resolve",
    payload: z.object({ viewerId, workspaceId: z.string().min(1).max(256), memberId }).strict(),
    result: contract<DirectResolution>(parseDirectResolution, "invalid person"),
    guard: "active-workspace", scope: "workspace",
    inactiveMessage: DIRECT_INACTIVE_MESSAGE,
  },
  directStart: {
    capabilityId: "direct.send",
    channel: "desktop:direct-start",
    payload: z.object({ viewerId, workspaceId: z.string().min(1).max(256), memberId, messageId: id, body }).strict(),
    result: contract<DirectSendResult>(parseDirectSendResult, "invalid send result"),
    guard: "active-workspace", scope: "workspace",
    inactiveMessage: DIRECT_INACTIVE_MESSAGE,
  },
  directSend: {
    capabilityId: "direct.send",
    channel: "desktop:direct-send",
    payload: z.object({ viewerId, conversationId: id, messageId: id, body }).strict(),
    result: contract<DirectSendResult>(parseDirectSendResult, "invalid send result"),
    guard: "trusted-sender", scope: "device",
  },
  directMarkRead: {
    capabilityId: "direct.read",
    channel: "desktop:direct-read",
    payload: z.object({ viewerId, conversationId: id, seq: count }).strict(),
    guard: "trusted-sender", scope: "device",
  },
  directBlock: {
    capabilityId: "direct.block",
    channel: "desktop:direct-block",
    payload: z.object({ viewerId, conversationId: id, blocked: z.boolean() }).strict(),
    guard: "trusted-sender", scope: "device",
  },
} as const satisfies OperationTable;

/** Main tells every window, on CHANNELS.directChanged, when the account's direct conversations change on the server. */
export const DirectChangedEvent = z.undefined();
