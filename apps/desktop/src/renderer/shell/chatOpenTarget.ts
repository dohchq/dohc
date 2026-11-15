import type { GraphNode } from "../workbench/graphData";
import type { ChatFileMentionRecord, ChatThreadRecord } from "../../ipc/bridgeContract";
import type { ChatsNav } from "../workbench/ChatsView";

type ChatOpenTarget =
  | { surface: "channel"; nav: Extract<ChatsNav, { level: "thread" }> }
  | {
      surface: "file";
      thread: Pick<ChatThreadRecord, "id" | "title" | "createdAtMs" | "updatedAtMs">;
      focusMessageId?: string;
    }
  | { surface: "overview" };

export function chatMentionOpenTarget(mention: ChatFileMentionRecord): ChatOpenTarget {
  // A workspace's older person-to-person chats no longer open.
  if (mention.channelKind === "dm") return { surface: "overview" };
  if (!mention.channelId || !mention.channelName) {
    return {
      surface: "file",
      thread: mention.thread,
      focusMessageId: mention.message.id,
    };
  }
  return {
    surface: "channel",
    nav: {
      level: "thread",
      channel: {
        id: mention.channelId,
        wireId: mention.channelWireId,
        name: mention.channelName,
        slug: mention.channelSlug ?? mention.channelName,
        kind: mention.channelKind ?? "channel",
        createdAtMs: 0,
        updatedAtMs: 0,
        threadCount: 0,
        unreadCount: 0,
      },
      thread: {
        ...mention.thread,
        channelId: mention.channelId,
        messageCount: 0,
        lastReadSequence: 0,
        unreadCount: 0,
      },
      focusMessageId: mention.message.id,
    },
  };
}

export function graphChatOpenTarget(node: GraphNode): ChatOpenTarget {
  if (node.kind !== "chat-thread" || !node.threadId) return { surface: "overview" };
  const thread = {
    id: node.threadId,
    title: node.title,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
  if (node.channelKind === "dm") return { surface: "overview" };
  if (!node.channelId || !node.channelName) return { surface: "file", thread };
  return {
    surface: "channel",
    nav: {
      level: "thread",
      channel: {
        id: node.channelId,
        wireId: node.channelWireId,
        name: node.channelName,
        slug: node.channelSlug ?? node.channelName,
        kind: node.channelKind ?? "channel",
        createdAtMs: 0,
        updatedAtMs: 0,
        threadCount: 0,
        unreadCount: 0,
      },
      thread: {
        ...thread,
        channelId: node.channelId,
        messageCount: 0,
        lastReadSequence: 0,
        unreadCount: 0,
      },
    },
  };
}
