import type {
  ChatFileMentionRecord,
  ChatThreadRecord,
  WorkspaceGraphResult,
} from "../../ipc/bridgeContract";
import type { ChatsNav } from "../workbench/ChatsView";

export interface DmChatLocator {
  channelId?: string;
  channelWireId?: string;
  threadId: string;
  focusMessageId?: string;
}

type ChatOpenTarget =
  | { surface: "channel"; nav: Extract<ChatsNav, { level: "thread" }> }
  | ({ surface: "dm" } & DmChatLocator)
  | {
      surface: "file";
      thread: Pick<ChatThreadRecord, "id" | "title" | "createdAtMs" | "updatedAtMs">;
      focusMessageId?: string;
    }
  | { surface: "overview" };

export function chatMentionOpenTarget(mention: ChatFileMentionRecord): ChatOpenTarget {
  if (mention.channelKind === "dm") {
    return {
      surface: "dm",
      channelId: mention.channelId,
      channelWireId: mention.channelWireId,
      threadId: mention.thread.id,
      focusMessageId: mention.message.id,
    };
  }
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

export function graphChatOpenTarget(
  node: WorkspaceGraphResult["nodes"][number],
): ChatOpenTarget {
  if (node.kind !== "chat-thread" || !node.threadId) return { surface: "overview" };
  const thread = {
    id: node.threadId,
    title: node.title,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
  if (node.channelKind === "dm") {
    return {
      surface: "dm",
      channelId: node.channelId,
      channelWireId: node.channelWireId,
      threadId: node.threadId,
    };
  }
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
