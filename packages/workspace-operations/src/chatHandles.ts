import type { CliAuthor, CliGroup, CliShowMessage } from "@dohc/cli/protocol";
import { formatMessageHandle } from "@dohc/cli/thread-markdown";
import type {
  ChatChannelSummary,
  ChatMessage,
  ChatStreamItem,
  ChatThread,
} from "@dohc/workspace-contracts/engine";

function shortenedEngineId(id: string, enginePrefix: string, cliPrefix: string): string {
  return id.startsWith(enginePrefix)
    ? `${cliPrefix}${id.slice(enginePrefix.length)}`
    : id;
}

function cliChannelId(id: string): string {
  return shortenedEngineId(id, "channel-", "ch_");
}

export function cliThreadId(id: string): string {
  return shortenedEngineId(id, "thread-", "th_");
}

export function cliMessageId(id: string): string {
  return formatMessageHandle(id);
}

export function engineIdForHandle(id: string, handlePrefix: string, enginePrefix: string): string {
  return id.startsWith(handlePrefix) ? `${enginePrefix}${id.slice(handlePrefix.length)}` : id;
}

// The engine's `channel` kind is a Group everywhere a reader sees it.
export function cliGroupKind(kind: ChatChannelSummary["kind"]): CliGroup["kind"] {
  return kind === "channel" ? "group" : kind;
}

// A thread linked to a file belongs to no engine channel; it lists here.
export const FILES_GROUP: CliGroup = {
  id: "files",
  name: "files",
  slug: "files",
  kind: "group",
};

export function groupForCli(channel: Pick<ChatChannelSummary, "id" | "kind" | "name" | "slug" | "purpose">): CliGroup {
  return {
    id: cliChannelId(channel.id),
    name: channel.kind === "agent" ? channel.slug : channel.name,
    slug: channel.slug,
    kind: cliGroupKind(channel.kind),
    ...(channel.purpose ? { purpose: channel.purpose } : {}),
  };
}

export function authorForCli(message: ChatMessage): CliAuthor {
  return {
    kind: message.author.kind,
    displayName: message.author.displayName,
  };
}

export function rawChatThread(thread: ChatThread) {
  return {
    id: thread.id,
    title: thread.title,
    createdAtMs: thread.createdAtMs,
    updatedAtMs: thread.updatedAtMs,
    ...(thread.linkedFile?.pathHint
      ? { linkedPathHint: thread.linkedFile.pathHint }
      : {}),
  };
}

export function rawChatMessage(
  message: ChatMessage,
  decision: ChatStreamItem["decision"],
) {
  return {
    id: message.id,
    threadId: message.threadId,
    authorKind: message.author.kind,
    authorDisplayName: message.author.displayName,
    ...(message.authorOwnerDisplayName ? { authorOwnerDisplayName: message.authorOwnerDisplayName } : {}),
    body: message.body,
    createdAtMs: message.createdAtMs,
    ...(message.parentMessageId ? { parentMessageId: message.parentMessageId } : {}),
    attachments: message.attachments.map(({ objectId, pathHint }) => ({
      ...(objectId ? { objectId } : {}),
      ...(pathHint ? { pathHint } : {}),
    })),
    needsDecision: decision !== undefined,
    ...(decision ? {
      decisionState: decision.state,
      ...(decision.options ? { options: [...decision.options] } : {}),
      ...(decision.chosenOption ? { chosenOption: decision.chosenOption } : {}),
      ...(decision.resolvedByMessageId ? { resolvedByMessageId: decision.resolvedByMessageId } : {}),
    } : {}),
    ...agentRequestsFor(message),
    ...reportedFor(message),
    ...(message.work ? { work: { ...message.work } } : {}),
  };
}

export function cliShowMessage(message: ChatMessage, decision: ChatStreamItem["decision"]): CliShowMessage {
  return {
    id: cliMessageId(message.id),
    author: authorForCli(message),
    body: message.body,
    createdAtMs: message.createdAtMs,
    ...(message.parentMessageId
      ? { parentMessageId: cliMessageId(message.parentMessageId) }
      : {}),
    ...(decision ? {
      decisionState: decision.state,
      ...(decision.options ? { decisionOptions: [...decision.options] } : {}),
      ...(decision.chosenOption ? { decisionChosenOption: decision.chosenOption } : {}),
    } : {}),
    attachments: message.attachments.map((attachment) => ({
      ...(attachment.objectId ? { objectId: attachment.objectId } : {}),
      ...(attachment.pathHint ? { pathHint: attachment.pathHint } : {}),
    })),
    ...agentRequestsFor(message),
    ...reportedFor(message),
    ...(message.work ? { work: { ...message.work } } : {}),
  };
}

// What an agent's client reported about itself, so an agent reading the
// chat sees what a person sees beside the name.
function reportedFor(message: ChatMessage) {
  return message.authorReported ? { authorReported: { ...message.authorReported } } : {};
}

// The agents still asked to answer a message, as the engine reports them.
function agentRequestsFor(message: ChatMessage) {
  return message.agentRequests?.length
    ? { agentRequests: message.agentRequests.map((request) => ({ ...request })) }
    : {};
}
