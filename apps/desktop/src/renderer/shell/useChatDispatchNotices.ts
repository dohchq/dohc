import { useEffect, useRef } from "react";
import { bridge } from "../bridge";
import type { ChatDispatchNotice, ChatDispatchNoticesEvent } from "../../ipc/bridgeContract";
import type { ChatsNav } from "../workbench/ChatsView";
import type { ShellErrorKind, useShellError } from "./useShellError";

const kinds = {
  "no-runner": "chat-no-runner",
  "budget-paused": "chat-budget-paused",
  restricted: "chat-restricted",
} as const satisfies Record<ChatDispatchNotice["reason"], ShellErrorKind>;

export function useChatDispatchNotices(
  workspaceId: string,
  ready: boolean,
  report: ReturnType<typeof useShellError>["reportShellFailure"],
  clear: ReturnType<typeof useShellError>["clearKind"],
  // Opens main's trust dialog, for a request Restricted Mode holds.
  trustWorkspace: () => void,
  openChat: (nav: Extract<ChatsNav, { level: "thread" }>) => void,
) {
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  const trustRef = useRef(trustWorkspace);
  trustRef.current = trustWorkspace;
  const openChatRef = useRef(openChat);
  openChatRef.current = openChat;
  useEffect(() => {
    if (!ready) return;
    let active = true;
    let revision = -1;
    const shown = new Map<ChatDispatchNotice["reason"], string>();
    const isCurrent = () => active && currentWorkspace.current === workspaceId;
    const findThread = async (channelId: string, threadId: string, lane: "posts" | "chat") =>
      (await bridge().listChannelThreads({ workspaceId, channelId, lane })).threads.find((entry) => entry.id === threadId);
    // Opens the paused thread itself, where Resume is: a post, or a group's
    // conversation as a thread.
    const openPaused = async (channelId: string, threadId: string) => {
      try {
        const { channels } = await bridge().listChatChannels({ workspaceId });
        const channel = channels.find((entry) => entry.id === channelId);
        const thread = channel
          ? await findThread(channelId, threadId, "posts") ?? await findThread(channelId, threadId, "chat")
          : undefined;
        if (!isCurrent()) return;
        if (!channel || !thread) throw new Error("The paused thread is gone.");
        openChatRef.current({ level: "thread", channel, thread });
      } catch (cause) {
        if (isCurrent()) report({ message: "dohc could not open the paused thread. Find it in Chats.", cause });
      }
    };
    const receive = (event: ChatDispatchNoticesEvent) => {
      if (!isCurrent() || event.workspaceId !== workspaceId || event.revision <= revision) return;
      revision = event.revision;
      for (const reason of Object.keys(kinds) as Array<ChatDispatchNotice["reason"]>) {
        const notice = event.notices.find((item) => item.reason === reason);
        if (!notice) { clear(kinds[reason]); shown.delete(reason); continue; }
        if (shown.get(reason) === notice.id) continue;
        shown.set(reason, notice.id);
        const pausedIn = notice.channelId;
        report({
          message: notice.message, kind: kinds[reason],
          // Nothing failed: the request waits for the person.
          ...(reason === "restricted" ? {
            tone: "warning" as const,
            action: { label: "Trust workspace", run: () => { if (isCurrent()) trustRef.current(); } },
          } : {}),
          ...(reason === "no-runner" ? { title: "No agent could take this request" } : {}),
          ...(reason === "budget-paused" ? {
            tone: "warning" as const, title: "Agent replies paused",
            ...(pausedIn ? {
              action: { label: "Open", run: () => { if (isCurrent()) void openPaused(pausedIn, notice.threadId); } },
            } : {}),
          } : {}),
          details: [
            ["Thread", notice.threadId],
            ...(notice.runId ? [["Run", notice.runId] as const] : []),
            ...(notice.logPath ? [["Log", notice.logPath] as const] : []),
          ],
          onDismiss: () => {
            if (!isCurrent()) return;
            void bridge().dismissChatDispatchNotice({ workspaceId, id: notice.id }).catch((cause: unknown) => {
              if (!isCurrent()) return;
              shown.delete(reason);
              report({ message: "dohc could not dismiss this notice. Open this workspace again to try again.", cause });
            });
          },
        });
      }
    };
    const unsubscribe = bridge().onChatDispatchNotices(receive);
    void bridge().registerChatDispatchNotices({ workspaceId }).then(receive).catch((cause: unknown) => {
      if (isCurrent()) report({ message: "dohc could not load dispatch notices. Open this workspace again to try again.", cause });
    });
    return () => { active = false; unsubscribe(); };
  }, [workspaceId, ready, report, clear]);
}
