import { bridge } from "../bridge";
import type { ChatsNav } from "../workbench/ChatsView";
import type { NoticeTarget } from "./noticeTarget";

/**
 * Where a chat target opens in this workspace, or null when no Group or
 * agent conversation here holds its thread. An agent's DM is one
 * conversation, so its threads open inside it. The message to land on is
 * the one named, or a run's last message; with neither, the conversation
 * opens at its end. A failed read throws.
 */
export async function findNoticeChat(
  workspaceId: string,
  target: Extract<NoticeTarget, { to: "chat" }>,
): Promise<ChatsNav | null> {
  const { channels } = await bridge().listChatChannels({ workspaceId });
  const places = await Promise.all(channels.filter((channel) => channel.kind !== "dm").map(async (channel) =>
    ({ channel, threads: (await bridge().listChannelThreads({ workspaceId, channelId: channel.id })).threads })));
  for (const { channel, threads } of places) {
    const thread = threads.find((candidate) => candidate.id === target.thread);
    if (!thread) continue;
    const focus = target.message ?? (target.run === undefined ? undefined : await lastMessageOfRun(workspaceId, target.thread, target.run));
    const at = focus === undefined ? {} : { focusMessageId: focus };
    return channel.kind === "agent" ? { level: "channel", channel, ...at } : { level: "thread", channel, thread, ...at };
  }
  return null;
}

// A run's messages are the ones its records name. Without one, as when the
// run stopped before it answered, there is nothing to land on.
async function lastMessageOfRun(workspaceId: string, threadId: string, runId: string): Promise<string | undefined> {
  const [{ runs }, { messages }] = await Promise.all([
    bridge().chatRunRecordsForThread({ workspaceId, threadId }),
    bridge().listChatMessages({ workspaceId, threadId }),
  ]);
  const ofRun = new Set(Object.entries(runs).filter(([, run]) => run.runId === runId).map(([messageId]) => messageId));
  return messages.findLast((message) => ofRun.has(message.id))?.id;
}
