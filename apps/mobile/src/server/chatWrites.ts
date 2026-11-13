import { MAX_CHAT_MESSAGE_BODY_BYTES } from "@dohc/workspace-contracts/chat-message-body";
import { isFields, okAnswer, segment, text, type Fields } from "./api";
import { ServerError, type ServerClient } from "./client";
import { isCursor } from "./workspaceReads";

// The chat writes the phone sends through its server's copy of a workspace, `POST /sync/<workspace>/ops/<operation>`
// (services/sync-relay/src/accountOperationRoutes.ts), and their answers. Each write carries an operation ID the phone
// mints once. Sent again with the same arguments, it answers the first write's result instead of writing twice. The
// server takes the author from the session, so nothing here names the account. The fields are the route's allowlist
// (packages/cli/src/protocol.ts, `phoneWriteArgsSchemas`), written out.

interface MessageFields {
  readonly body: string;
  readonly needsDecision?: boolean;
  readonly options?: readonly string[];
}

/**
 * A write without its operation ID. A reply's `threadId` is null only while it waits for the outbox post or send it
 * replies to, whose result names the thread.
 */
export type ChatWrite =
  | { readonly operation: "post"; readonly args: MessageFields & { readonly groupId: string; readonly title?: string } }
  | { readonly operation: "send"; readonly args: MessageFields & { readonly streamId: string } }
  | {
    readonly operation: "reply";
    readonly args: MessageFields & {
      readonly threadId: string | null;
      readonly parentMessageId?: string;
      readonly resolves?: { readonly messageId: string; readonly chosenOption?: string };
    };
  }
  | { readonly operation: "react"; readonly args: { readonly messageId: string; readonly emoji: string; readonly state: "added" | "removed" } };

/** The closed list of reasons a refused write gives (services/sync-relay/src/operationPublication.ts). */
export type RefusalReason =
  | "already answered"
  | "The message it replies to wasn't sent"
  | "This workspace changed on your server"
  | "Couldn't send"
  | "too old";
const REASONS: ReadonlySet<string> = new Set<RefusalReason>([
  "already answered", "The message it replies to wasn't sent", "This workspace changed on your server", "Couldn't send", "too old",
]);
export const isRefusalReason = (value: unknown): value is RefusalReason => typeof value === "string" && REASONS.has(value);

/**
 * A write's answer. `pending`: the relay holds the write and is still publishing it, so ask again with the same ID.
 * `refused` doesn't prove nothing published: a refused answer can leave its reply published. `missing`: the target is
 * gone or hidden, worded as reads word it.
 */
export type WriteAnswer =
  | { readonly kind: "saved"; readonly threadId: string | null; readonly messageId: string | null }
  | { readonly kind: "pending"; readonly threadId: string | null; readonly messageId: string | null }
  | { readonly kind: "refused"; readonly reason: RefusalReason; readonly threadId: string | null; readonly winnerMessageId: string | null }
  | { readonly kind: "missing"; readonly reason: string };

/** The relay waits up to 20 s for publication before it answers `pending`. */
const WRITE_TIMEOUT_MS = 30_000;

const id = (value: unknown): value is string => text(value, 256);
/** An optional ID: null when absent, undefined when it isn't one. */
const optionalId = (value: unknown): string | null | undefined => value === undefined ? null : id(value) ? value : undefined;

/** The write's result, from the route's `{ ok, result, cursor }`. The cursor is checked, never used: a write doesn't move the feed. */
export function readWriteAnswer(body: unknown): WriteAnswer | null {
  const answer = okAnswer(body);
  if (!answer || !isCursor(answer.cursor) || !isFields(answer.result)) return null;
  const result = answer.result;
  const threadId = optionalId(result.threadId);
  if (result.ok === true && (result.state === "saved" || result.state === "pending")) {
    const messageId = optionalId(result.messageId);
    return threadId === undefined || messageId === undefined ? null : { kind: result.state, threadId, messageId };
  }
  if (result.ok === false && result.refusal === "refused" && isRefusalReason(result.reason)) {
    const winnerMessageId = optionalId(result.winnerMessageId);
    return threadId === undefined || winnerMessageId === undefined ? null : { kind: "refused", reason: result.reason, threadId, winnerMessageId };
  }
  if (result.ok === false && result.refusal === "missing" && text(result.reason)) return { kind: "missing", reason: result.reason };
  return null;
}

/** Sends the write, or asks again for one sent before, with the same operation ID and arguments. */
export function sendWrite(client: ServerClient, workspaceId: string, operationId: string, write: ChatWrite, signal: AbortSignal): Promise<WriteAnswer> {
  // The outbox sends a reply only once it knows the thread.
  if (write.operation === "reply" && write.args.threadId === null) return Promise.reject(new ServerError("invalid"));
  return client.send("POST", `/sync/${segment(workspaceId)}/ops/${write.operation}`, readWriteAnswer, { operationId, ...write.args },
    { signal, timeoutMs: WRITE_TIMEOUT_MS });
}

// --- checking a write ---------------------------------------------------------------------------------------------

const BODY_MAX = 2 * MAX_CHAT_MESSAGE_BODY_BYTES;
const choice = (value: unknown): value is string => text(value, 200);

/** The message fields, or null. Only the allowlisted fields are copied. */
function messageFields(value: Fields): MessageFields | null {
  if (!text(value.body, BODY_MAX)) return null;
  if (value.needsDecision !== undefined && typeof value.needsDecision !== "boolean") return null;
  if (value.options !== undefined && !(Array.isArray(value.options) && value.options.length <= 12 && value.options.every(choice))) return null;
  return {
    body: value.body,
    ...(value.needsDecision === undefined ? {} : { needsDecision: value.needsDecision }),
    ...(value.options === undefined ? {} : { options: [...value.options] }),
  };
}

/** A write as the route takes it, with only its allowlisted fields, or null when any field is wrong. */
export function readChatWrite(value: unknown): ChatWrite | null {
  if (!isFields(value) || !isFields(value.args)) return null;
  const args = value.args;
  switch (value.operation) {
    case "post": {
      const message = messageFields(args);
      if (!message || !id(args.groupId) || (args.title !== undefined && !choice(args.title))) return null;
      return { operation: "post", args: { ...message, groupId: args.groupId, ...(args.title === undefined ? {} : { title: args.title }) } };
    }
    case "send": {
      const message = messageFields(args);
      return message && id(args.streamId) ? { operation: "send", args: { ...message, streamId: args.streamId } } : null;
    }
    case "reply": {
      const message = messageFields(args);
      const parentMessageId = optionalId(args.parentMessageId);
      if (!message || !(args.threadId === null || id(args.threadId)) || parentMessageId === undefined) return null;
      let resolves: { messageId: string; chosenOption?: string } | undefined;
      if (args.resolves !== undefined) {
        const target = args.resolves;
        if (!isFields(target) || !id(target.messageId) || (target.chosenOption !== undefined && !choice(target.chosenOption))) return null;
        resolves = { messageId: target.messageId, ...(target.chosenOption === undefined ? {} : { chosenOption: target.chosenOption }) };
      }
      return {
        operation: "reply",
        args: {
          ...message, threadId: args.threadId,
          ...(parentMessageId === null ? {} : { parentMessageId }),
          ...(resolves === undefined ? {} : { resolves }),
        },
      };
    }
    case "react":
      return id(args.messageId) && text(args.emoji, 32) && (args.state === "added" || args.state === "removed")
        ? { operation: "react", args: { messageId: args.messageId, emoji: args.emoji, state: args.state } }
        : null;
    default:
      return null;
  }
}
