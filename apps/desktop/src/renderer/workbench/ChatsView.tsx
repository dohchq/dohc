import { ArrowLeft, Bot, FileText, Hash, MessagesSquare, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChannelThreadRecord,
  ChatChannelRecord,
  ChatMessageRecord,
  ChatReactionRecord,
  FileChatThreadRecord,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { AgentNotification } from "./agentNotifications";
import { ChatMessageList, formatChatTime, ipcErrorMessage } from "./chatMessages";
import { MentionComposer } from "./MentionComposer";
import { findMentions, type MentionCandidate } from "./mentions";

// The Chats view (PR 13, WS-E): workspace Chats organized in channels, plus
// a read-only "Files" grouping that cross-links to the per-file rail. Built
// to feel like chat, not a forum: the channel composer sends on Enter and a
// new thread NEVER asks for a title — it displays its first-message snippet.
//
// Every async response is gated by a liveness token before it touches state
// (workspace switches and rapid navigation must never repaint stale data).

type OverviewState =
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | {
      status: "ready";
      channels: ChatChannelRecord[];
      fileThreads: FileChatThreadRecord[];
    };

type Nav =
  | { level: "channels" }
  | { level: "channel"; channel: ChatChannelRecord }
  | { level: "thread"; channel: ChatChannelRecord; thread: ChannelThreadRecord };

function UnreadPill(props: { count: number; testId: string }) {
  if (props.count <= 0) return null;
  return (
    <span
      data-testid={props.testId}
      aria-label={`${props.count} unread`}
      className="min-w-4 shrink-0 rounded-full bg-ink px-1 text-center text-[9px] font-semibold leading-4 text-bg"
    >
      {props.count > 99 ? "99+" : props.count}
    </span>
  );
}

function BackHeader(props: {
  label: string;
  testId: string;
  onBack: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2">
      <button
        type="button"
        data-testid={`${props.testId}-back`}
        aria-label="Back"
        title="Back"
        onClick={props.onBack}
        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
      >
        <ArrowLeft size={13} aria-hidden />
      </button>
      {props.icon}
      <span
        data-testid={`${props.testId}-title`}
        className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink"
      >
        {props.label}
      </span>
    </div>
  );
}

// "Addressed to me" inbox: the calm, in-context list of things the agent is
// waiting on the user for (asks + needs-input). It reuses the agent
// notification model rather than a heavy new surface, and stays hidden when
// there's nothing to answer.
function AddressedToMe(props: {
  notifications: readonly AgentNotification[];
  onOpen?: (notification: AgentNotification) => void;
}) {
  const waiting = props.notifications.filter(
    (notification) => notification.kind === "asked" || notification.kind === "needs-input",
  );
  if (waiting.length === 0) return null;
  return (
    <section
      data-testid="chats-addressed-to-me"
      aria-label="Addressed to me"
      className="border-b border-line bg-panel-2/40"
    >
      <p className="mb-0 px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-subtle">
        Addressed to me
      </p>
      <ul className="m-0 list-none p-0">
        {waiting.map((notification) => (
          <li key={notification.id}>
            <button
              type="button"
              data-testid="chats-addressed-item"
              onClick={() => props.onOpen?.(notification)}
              className="flex w-full cursor-pointer items-start gap-1.5 px-3 py-2 text-left transition-colors hover:bg-line/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
            >
              <Bot size={13} aria-hidden className="mt-0.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-ink">
                  {notification.title}
                </span>
                <span className="block truncate text-[11px] text-muted">{notification.body}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ChatsView(props: {
  workspaceId: string;
  // Jump a file-linked Chat to where it lives: the file's side rail.
  onOpenFileChat: (thread: FileChatThreadRecord) => void;
  onError: (message: string) => void;
  // @-mention roster for this workspace (the user + available agents). When
  // provided, the composer offers autocomplete and messages render chips.
  mentionCandidates?: readonly MentionCandidate[];
  // Called after a message that @-mentions an agent is sent, so the shell can
  // pull that agent into the thread (the existing agent-chat reply path).
  onAgentMentioned?: (input: { threadId: string; mentioned: MentionCandidate[]; body: string }) => void;
  // "Addressed to me" inbox: agent asks / requests waiting on the user.
  addressedToMe?: readonly AgentNotification[];
  onOpenAddressed?: (notification: AgentNotification) => void;
}) {
  const { workspaceId } = props;
  const mentionCandidates = props.mentionCandidates ?? [];
  const agentCandidates = mentionCandidates.filter((candidate) => candidate.kind === "agent");
  const [overview, setOverview] = useState<OverviewState>({ status: "loading" });
  const [nav, setNav] = useState<Nav>({ level: "channels" });
  const [channelThreads, setChannelThreads] = useState<ChannelThreadRecord[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [reactions, setReactions] = useState<ChatReactionRecord[]>([]);
  const [viewerAuthorId, setViewerAuthorId] = useState("");
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [newThreadBody, setNewThreadBody] = useState("");
  const [startingThread, setStartingThread] = useState(false);
  const [creatingChannel, setCreatingChannel] = useState<string | null>(null);
  // SYNCHRONOUS in-flight guards. `sending` / `startingThread` are React state
  // and stay false until the next render, so a double-send (two Enters in one
  // tick) can fire TWO IPC sends — and two agent invocations — before the state
  // flips. These refs flip synchronously BEFORE the first await, so the second
  // call is ignored immediately.
  const sendingRef = useRef(false);
  const startingThreadRef = useRef(false);
  const liveToken = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const refreshOverview = useCallback(async () => {
    const token = ++liveToken.current;
    setOverview((current) =>
      current.status === "ready" ? current : { status: "loading" },
    );
    try {
      const result = await bridge().listChatChannels({ workspaceId });
      if (token !== liveToken.current) return;
      setOverview({
        status: "ready",
        channels: result.channels,
        fileThreads: result.fileThreads,
      });
    } catch (error) {
      if (token !== liveToken.current) return;
      setOverview({
        status: "unavailable",
        message: ipcErrorMessage(error, "Could not load Chats."),
      });
    }
  }, [workspaceId]);

  // Workspace switch: drop everything stale and reload from the top.
  useEffect(() => {
    liveToken.current += 1;
    setNav({ level: "channels" });
    setChannelThreads([]);
    setMessages([]);
    setComposer("");
    setNewThreadBody("");
    setCreatingChannel(null);
    setOverview({ status: "loading" });
    void refreshOverview();
    return () => {
      liveToken.current += 1;
    };
  }, [refreshOverview]);

  const openChannel = useCallback(
    async (channel: ChatChannelRecord) => {
      const token = ++liveToken.current;
      setNav({ level: "channel", channel });
      setChannelThreads([]);
      setThreadsLoading(true);
      try {
        const result = await bridge().listChannelThreads({
          workspaceId,
          channelId: channel.id,
        });
        if (token !== liveToken.current) return;
        setChannelThreads(result.threads);
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not load this channel."));
      } finally {
        if (token === liveToken.current) setThreadsLoading(false);
      }
    },
    [props, workspaceId],
  );

  const openThread = useCallback(
    async (channel: ChatChannelRecord, thread: ChannelThreadRecord) => {
      const token = ++liveToken.current;
      setNav({ level: "thread", channel, thread });
      setMessages([]);
      setReactions([]);
      setMessagesLoading(true);
      try {
        const [result, reactionResult] = await Promise.all([
          bridge().listChatMessages({ workspaceId, threadId: thread.id }),
          bridge().listChatReactions({ workspaceId, threadId: thread.id }),
        ]);
        if (token !== liveToken.current) return;
        setMessages(result.messages);
        setReactions(reactionResult.reactions);
        setViewerAuthorId(reactionResult.viewerAuthorId);
        requestAnimationFrame(() =>
          messagesEndRef.current?.scrollIntoView({ block: "end" }),
        );
        // Everything on screen is read: advance the monotonic cursor and
        // clear this thread's badge locally so back-navigation is honest
        // without a refetch round trip.
        const upToSequence = result.messages.length;
        setChannelThreads((current) =>
          current.map((entry) =>
            entry.id === thread.id ? { ...entry, unreadCount: 0 } : entry,
          ),
        );
        void bridge()
          .markChatThreadRead({ workspaceId, threadId: thread.id, upToSequence })
          .catch(() => {
            // Mark-read is best-effort; the badge re-appears on next refresh
            // if the cursor write did not land.
          });
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not load this chat."));
      } finally {
        if (token === liveToken.current) setMessagesLoading(false);
      }
    },
    [props, workspaceId],
  );

  // After a human message is sent, pull any @-mentioned agent into the thread
  // through the shell (which wires the existing agent-chat reply path). Deduped
  // by candidate id so "@agent @agent" invokes once.
  const notifyAgentMention = useCallback(
    (threadId: string, body: string) => {
      if (!props.onAgentMentioned || agentCandidates.length === 0) return;
      // Invoke path is code-aware: an @agent typed inside inline code or a
      // fenced block (e.g. `npm install @agent/pkg`) must NOT invoke the agent.
      const mentioned = findMentions(body, agentCandidates, { ignoreCode: true }).map(
        (match) => match.candidate,
      );
      if (mentioned.length === 0) return;
      const unique = Array.from(new Map(mentioned.map((c) => [c.id, c])).values());
      props.onAgentMentioned({ threadId, mentioned: unique, body });
    },
    [agentCandidates, props],
  );

  // The anti-forum move: typing in the channel composer STARTS the chat.
  // One Enter = thread + first message; no title prompt exists on this path.
  const startThread = useCallback(async () => {
    if (nav.level !== "channel") return;
    const body = newThreadBody.trim();
    if (body.length === 0 || startingThread || startingThreadRef.current) return;
    const channel = nav.channel;
    const token = liveToken.current;
    startingThreadRef.current = true;
    setStartingThread(true);
    try {
      const result = await bridge().startChannelThread({
        workspaceId,
        channelId: channel.id,
        body,
      });
      if (token !== liveToken.current) return;
      setNewThreadBody("");
      setNav({ level: "thread", channel, thread: result.thread });
      setMessages([result.message]);
      setChannelThreads((current) => [result.thread, ...current]);
      notifyAgentMention(result.thread.id, body);
    } catch (error) {
      if (token !== liveToken.current) return;
      props.onError(ipcErrorMessage(error, "Could not start that chat."));
    } finally {
      startingThreadRef.current = false;
      setStartingThread(false);
    }
  }, [nav, newThreadBody, notifyAgentMention, props, startingThread, workspaceId]);

  const sendMessage = useCallback(async () => {
    if (nav.level !== "thread") return;
    const body = composer.trim();
    if (body.length === 0 || sending || sendingRef.current) return;
    const token = liveToken.current;
    sendingRef.current = true;
    setSending(true);
    try {
      const result = await bridge().sendChatMessage({
        workspaceId,
        threadId: nav.thread.id,
        body,
      });
      if (token !== liveToken.current) return;
      setMessages((current) => [...current, result.message]);
      setComposer("");
      messagesEndRef.current?.scrollIntoView({ block: "end" });
      notifyAgentMention(nav.thread.id, body);
    } catch (error) {
      if (token !== liveToken.current) return;
      props.onError(ipcErrorMessage(error, "Could not send that message."));
    } finally {
      // Unconditional reset (LinkedChats precedent): navigation bumps the
      // token without resetting `sending`, and the token guard on the READ
      // above already prevents concurrent sends.
      sendingRef.current = false;
      setSending(false);
    }
  }, [composer, nav, notifyAgentMention, props, sending, workspaceId]);

  // Reactions (WS-MU-C2): optimistic add/remove of the viewer's own reaction,
  // then reconcile to the server's canonical list (which carries the real
  // reactionId and any peer reactions). Guarded by the liveness token so a
  // slow response never repaints a thread the user already left.
  const toggleReaction = useCallback(
    (input: { messageId: string; emoji: string; nextState: "added" | "removed" }) => {
      if (nav.level !== "thread" || viewerAuthorId === "") return;
      const token = liveToken.current;
      setReactions((current) => {
        const withoutMine = current.filter(
          (reaction) =>
            !(
              reaction.messageId === input.messageId &&
              reaction.emoji === input.emoji &&
              reaction.authorId === viewerAuthorId
            ),
        );
        if (input.nextState === "removed") return withoutMine;
        return [
          ...withoutMine,
          {
            reactionId: `optimistic:${input.messageId}:${input.emoji}:${viewerAuthorId}`,
            messageId: input.messageId,
            threadId: nav.thread.id,
            emoji: input.emoji,
            authorId: viewerAuthorId,
            authorKind: "human",
            authorDisplayName: viewerAuthorId,
          },
        ];
      });
      void bridge()
        .setChatReaction({
          workspaceId,
          threadId: nav.thread.id,
          messageId: input.messageId,
          emoji: input.emoji,
          state: input.nextState,
        })
        .then(() => bridge().listChatReactions({ workspaceId, threadId: nav.thread.id }))
        .then((result) => {
          if (token !== liveToken.current) return;
          setReactions(result.reactions);
          setViewerAuthorId(result.viewerAuthorId);
        })
        .catch((error) => {
          if (token !== liveToken.current) return;
          props.onError(ipcErrorMessage(error, "Could not update that reaction."));
        });
    },
    [nav, props, viewerAuthorId, workspaceId],
  );

  const createChannel = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (trimmed.length === 0) return;
      const token = liveToken.current;
      try {
        const result = await bridge().createChatChannel({
          workspaceId,
          name: trimmed,
        });
        if (token !== liveToken.current) return;
        setCreatingChannel(null);
        setOverview((current) =>
          current.status === "ready"
            ? { ...current, channels: [...current.channels, result.channel] }
            : current,
        );
        void openChannel(result.channel);
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not create that channel."));
      }
    },
    [openChannel, props, workspaceId],
  );

  const goBack = useCallback(() => {
    liveToken.current += 1;
    if (nav.level === "thread") {
      // Re-open the channel so thread ordering/badges reflect what happened
      // inside the thread.
      void openChannel(nav.channel);
    } else if (nav.level === "channel") {
      setNav({ level: "channels" });
      setChannelThreads([]);
      void refreshOverview();
    }
  }, [nav, openChannel, refreshOverview]);

  // Escape walks back up one level — but never steals Escape from a composer
  // holding a draft (that Escape reads as "leave my text alone").
  const onKeyDownCapture = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (
        (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) &&
        target.value.trim().length > 0
      ) {
        return;
      }
      if (nav.level === "channels") return;
      event.stopPropagation();
      goBack();
    },
    [goBack, nav.level],
  );

  if (overview.status === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-xs text-subtle">
        Loading Chats...
      </div>
    );
  }

  if (overview.status === "unavailable") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <span className="text-xs text-danger">{overview.message}</span>
        <button
          type="button"
          onClick={() => void refreshOverview()}
          className="h-7 cursor-pointer rounded border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink"
        >
          Try again
        </button>
      </div>
    );
  }

  if (nav.level === "thread") {
    return (
      <div
        data-testid="chats-thread-view"
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onKeyDownCapture}
      >
        <BackHeader
          label={nav.thread.title}
          testId="chats-thread"
          onBack={goBack}
        />
        <ChatMessageList
          testIdPrefix="chats"
          messages={messages}
          loading={messagesLoading}
          emptyLabel="No messages yet."
          endRef={messagesEndRef}
          mentionCandidates={mentionCandidates}
          reactionControls={{
            reactions,
            viewerAuthorId,
            onToggle: toggleReaction,
          }}
        />
        <MentionComposer
          testIdPrefix="chats"
          composerId="chats-composer"
          value={composer}
          sending={sending}
          placeholder="Write a message…  @ to mention"
          sendLabel="Send message"
          candidates={mentionCandidates}
          onChange={setComposer}
          onSend={() => void sendMessage()}
        />
      </div>
    );
  }

  if (nav.level === "channel") {
    return (
      <div
        data-testid="chats-channel-view"
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onKeyDownCapture}
      >
        <BackHeader
          label={nav.channel.name}
          testId="chats-channel"
          onBack={goBack}
          icon={<Hash size={12} aria-hidden className="shrink-0 text-subtle" />}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {threadsLoading ? (
            <p className="m-0 pt-4 text-center text-[11px] text-subtle">Loading...</p>
          ) : channelThreads.length === 0 ? (
            <div
              data-testid="chats-channel-empty"
              className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center"
            >
              <MessagesSquare size={16} aria-hidden className="text-subtle" />
              <span className="text-xs text-muted">Nothing here yet.</span>
              <span className="text-[11px] text-subtle">
                Type below to start a chat.
              </span>
            </div>
          ) : (
            <ul className="m-0 list-none p-0">
              {channelThreads.map((thread) => (
                <li key={thread.id} className="border-b border-line">
                  <button
                    type="button"
                    data-testid="chats-thread"
                    data-thread-id={thread.id}
                    onClick={() => void openThread(nav.channel, thread)}
                    className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-line/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        data-testid="chats-thread-name"
                        className="block truncate text-[12px] font-medium text-ink"
                      >
                        {thread.title}
                      </span>
                      <span className="block text-[10px] text-subtle">
                        {formatChatTime(thread.updatedAtMs).label}
                      </span>
                    </span>
                    <UnreadPill count={thread.unreadCount} testId="chats-thread-unread" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <MentionComposer
          testIdPrefix="chats-new-thread"
          composerId="chats-new-thread-composer"
          value={newThreadBody}
          sending={startingThread}
          placeholder={`Message #${nav.channel.name}…  @ to mention`}
          sendLabel="Start a new chat"
          candidates={mentionCandidates}
          onChange={setNewThreadBody}
          onSend={() => void startThread()}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="chats-view"
      className="flex min-h-0 flex-1 flex-col"
      onKeyDownCapture={onKeyDownCapture}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AddressedToMe
          notifications={props.addressedToMe ?? []}
          onOpen={props.onOpenAddressed}
        />
        <ul className="m-0 list-none p-0">
          {overview.channels.map((channel) => (
            <li key={channel.id} className="border-b border-line">
              <button
                type="button"
                data-testid="chats-channel"
                data-channel-id={channel.id}
                data-channel-slug={channel.slug}
                onClick={() => void openChannel(channel)}
                className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-line/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
              >
                <Hash size={13} aria-hidden className="shrink-0 text-subtle" />
                <span className="min-w-0 flex-1">
                  <span
                    data-testid="chats-channel-name"
                    className="block truncate text-[12px] font-medium text-ink"
                  >
                    {channel.name}
                  </span>
                  <span className="block text-[10px] text-subtle">
                    {channel.threadCount === 1
                      ? "1 chat"
                      : `${channel.threadCount} chats`}
                  </span>
                </span>
                <UnreadPill count={channel.unreadCount} testId="chats-channel-unread" />
              </button>
            </li>
          ))}
        </ul>
        {overview.fileThreads.length > 0 ? (
          <div data-testid="chats-files-section">
            <p className="mb-0 mt-3 px-3 text-[10px] font-semibold uppercase tracking-wide text-subtle">
              Files
            </p>
            <ul className="m-0 list-none p-0">
              {overview.fileThreads.map((thread) => (
                <li key={thread.id} className="border-b border-line">
                  <button
                    type="button"
                    data-testid="chats-file-chat"
                    data-thread-id={thread.id}
                    title={
                      thread.path
                        ? `Open in the file rail (${thread.path})`
                        : "Open in the file rail"
                    }
                    onClick={() => props.onOpenFileChat(thread)}
                    className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-line/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                  >
                    <FileText size={13} aria-hidden className="shrink-0 text-subtle" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-ink">
                        {thread.title}
                      </span>
                      <span className="block truncate text-[10px] text-subtle">
                        {thread.path ?? "File no longer tracked"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <div className="shrink-0 border-t border-line p-2">
        {creatingChannel === null ? (
          <button
            type="button"
            data-testid="chats-new-channel"
            onClick={() => setCreatingChannel("")}
            className="flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-line text-[11px] text-muted hover:bg-line/50 hover:text-ink"
          >
            <Plus size={12} aria-hidden />
            New channel
          </button>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createChannel(creatingChannel);
            }}
          >
            <label className="sr-only" htmlFor="chats-new-channel-name">
              Channel name
            </label>
            <input
              id="chats-new-channel-name"
              data-testid="chats-new-channel-name"
              autoFocus
              value={creatingChannel}
              maxLength={80}
              placeholder="Channel name"
              onChange={(event) => setCreatingChannel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setCreatingChannel(null);
                }
              }}
              className="h-7 w-full rounded border border-line bg-bg px-2 text-[12px] text-ink placeholder:text-subtle focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
            />
            <p className="mb-0 mt-1 px-1 text-[10px] leading-4 text-subtle">
              Press Enter to create the channel.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
