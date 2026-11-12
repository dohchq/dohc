import type { FileChatThreadRecord } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { ChatsNav } from "../workbench/ChatsView";
import type { DmChatLocator } from "./chatOpenTarget";
import type { NoticeTarget } from "../../notices/noticeTarget";

/**
 * Where a chat target opens. A Group's or an agent's conversation opens in
 * Chats. A DM opens through its canonical record, which the shell reads as it
 * opens. A file's conversation opens in About beside its file.
 */
export type NoticeChatPlace =
  | { open: "chats"; nav: ChatsNav }
  | { open: "dm"; locator: DmChatLocator }
  | { open: "file"; thread: FileChatThreadRecord; focusMessageId?: string };

/**
 * Where a chat target opens in this workspace, or null when nothing here
 * holds its thread. A thread in a chat lane, such as an agent's DM, is that
 * conversation, so it opens there; a post opens as its thread. A DM is found
 * only when the target names it. The message to land on is the one named, or
 * a run's last message; with neither, the conversation opens at its end. A
 * failed read throws.
 */
export async function findNoticeChat(
  workspaceId: string,
  target: Extract<NoticeTarget, { to: "chat" }>,
): Promise<NoticeChatPlace | null> {
  const { channels, fileThreads } = await bridge().listChatChannels({ workspaceId });
  const landing = async (): Promise<{ focusMessageId?: string }> => {
    const focus = target.message ?? (target.run === undefined ? undefined : await lastMessageOfRun(workspaceId, target.thread, target.run));
    return focus === undefined ? {} : { focusMessageId: focus };
  };
  const fileThread = fileThreads.find((thread) => thread.id === target.thread);
  if (fileThread) return { open: "file", thread: fileThread, ...(await landing()) };
  const named = target.channel === undefined ? channels : channels.filter((channel) => channel.id === target.channel);
  const dm = target.channel === undefined ? undefined : named.find((channel) => channel.kind === "dm");
  if (dm) return { open: "dm", locator: { channelId: dm.id, threadId: target.thread, ...(await landing()) } };
  const places = await Promise.all(named.filter((channel) => channel.kind !== "dm").flatMap((channel) =>
    (["chat", "posts"] as const).map(async (lane) =>
      ({ channel, lane, threads: (await bridge().listChannelThreads({ workspaceId, channelId: channel.id, lane })).threads }))));
  for (const { channel, lane, threads } of places) {
    const thread = threads.find((candidate) => candidate.id === target.thread);
    if (!thread) continue;
    const at = await landing();
    return { open: "chats", nav: lane === "chat" ? { level: "channel", channel, lane, ...at } : { level: "thread", channel, thread, ...at } };
  }
  return null;
}

/**
 * Where a Group, DM, or agent chat opens as a whole, or null when this
 * workspace has no such chat. A DM opens through its canonical record. A
 * failed read throws.
 */
export async function findNoticeChannel(workspaceId: string, channelId: string): Promise<NoticeChatPlace | null> {
  const { channels } = await bridge().listChatChannels({ workspaceId });
  const channel = channels.find((candidate) => candidate.id === channelId);
  if (!channel) return null;
  if (channel.kind !== "dm") return { open: "chats", nav: { level: "channel", channel } };
  const dm = (await bridge().syncDms({ workspaceId })).dms.find((candidate) => candidate.channelId === channelId);
  return dm ? { open: "chats", nav: { level: "dm", dm } } : null;
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
