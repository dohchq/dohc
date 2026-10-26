import { basenameOf } from "../path";
import { ipcErrorMessage } from "../ipcError";
import { ArrowLeft, Info, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatFileMentionRecord,
  ChatMessageRecord,
  ChatThreadRecord,
  ListFileChatsResponse,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { EmptyState, RetryRow } from "../ui/controls";
import { SkeletonRows } from "../ui/SkeletonRows";
import {
  AboutAccess,
  AboutChatRow,
  AboutHeader,
  AboutHistory,
  AboutLinks,
  AboutNote,
  AboutSection,
  type AboutFile,
  type AboutNotices,
  type AboutSectionId,
} from "./About";
import type { AccessContext } from "./accessReason";
import {
  ChatComposer,
  ChatMessageList,
  type ChatMessageListHandle,
} from "./chatMessages";
import { useReactions, type ReactionView } from "./reactionStore";

// The About rail for a file: its Links, Chats, History and Access. A focused
// chat tab gets AboutConversationPanel instead.
// Per-file Chats (PR 0M-5) are stored in the engine and linked to the file's
// stable object id, so a chat follows its file through renames, and that id
// is what History asks about. Product vocabulary: these are Chats.
// Message rendering + composer are the shared chatMessages pieces
// so this surface and the workspace Chats view can never drift.

// The composer's replacement for every received file share.
// Same words main throws (SharedFileReadOnlyError) and the same shape the
// Chats view's read-only notice uses.
function ReadOnlyNotice() {
  return (
    <p
      data-testid="linked-chat-readonly-note"
      className="m-0 shrink-0 border-t border-line px-3 py-2 text-[11px] text-subtle"
    >
      Chats are read-only in this shared view.
    </p>
  );
}

const NO_REACTIONS: ReactionView = { reactions: [], viewerAuthorId: "" };

// `key` names the workspace and file an answer is for: a state for another
// file reads as loading, so a switch never shows the last file's chats.
type ThreadsState =
  | { status: "loading" }
  | { status: "unavailable"; key: string }
  | { status: "ready"; key: string; fileObjectId: string | null; threads: ChatThreadRecord[] };

const SECTIONS_OPEN: Record<AboutSectionId, boolean> = { links: true, chats: true, history: true, access: false };

const WORKSPACE_UPDATING_MESSAGE = "Workspace is still updating. Try again.";
const THREAD_LOAD_RETRY_MS = 1_000;
// Initial capture has a 120s early-import decision ceiling. Leave one retry
// interval for the Ready/Degraded transition, with a fail-safe if that bound
// is ever violated.
const THREAD_LOAD_RETRY_DEADLINE_MS = 121_000;

function isWorkspaceUpdatingResponse(
  response: ListFileChatsResponse,
): response is Extract<
  ListFileChatsResponse,
  { status: "refused"; code: "workspace-updating" }
> {
  return (
    "status" in response &&
    response.status === "refused" &&
    response.code === "workspace-updating"
  );
}

// The per-file Chats panel: thread list with a calm empty state, inline
// create, and a thread view with a composer. Every async response is gated
// by a liveness token before it touches state (workspace/file switches must
// never repaint stale data).
export function LinkedChatsPanel(props: {
  workspaceId: string;
  filePath: string | null;
  // The focused tab, which About is about.
  tabPath?: string | null;
  // With no file or conversation focused: whether another tab holds a file
  // or a conversation. The empty state then says to switch instead of to open.
  aboutTabOpen?: boolean;
  // A shared view always passes true. Absent means a workspace this machine
  // owns, which is writable by definition.
  //
  // The decision, not the level: this panel only ever asked the level one
  // yes/no question, and a level it might not have — a damaged grant carries
  // none — would answer that question generously.
  shareReadOnly?: boolean;
  initialThread?: ChatThreadRecord | null;
  initialFocusMessageId?: string;
  // Fired once when initialThread is consumed so the parent can clear the
  // state it minted for this open. Without that clear, every remount of this
  // panel (History <-> Chats toggle) resets consumedInitialThread and
  // re-opens the stale thread.
  onInitialThreadConsumed?: () => void;
  // Fired when the thread initialThread opened stops showing here.
  onInitialThreadClosed?: () => void;
  onOpenPath?: (path: string, headingAnchor?: string) => void;
  // Reports a landed read so the Chats navigator can refetch its badges. The
  // file-linked threads it lists are read here, not in the Chats view.
  onThreadRead?: () => void;
  onError: (message: string, cause?: unknown) => void;
  // A sent message asks an agent that Restricted Mode holds. The shell opens
  // main's trust dialog for the workspace named.
  onAgentWaitsForTrust?: (workspaceId: string) => void;
  // The file's History, where this workspace records it. A shared view
  // records none, so it passes nothing and About shows no History.
  history?: {
    revision: number;
    // History stopped recording, so its section says so.
    paused: boolean;
    onOpenMoment: (momentId: string, filePath: string) => void;
  };
  // The links into the file, read again as `revision` changes. Chats that
  // link here are read only where `onOpenChat` can open them.
  links: {
    revision: number;
    onOpenLink: (path: string, line: number) => void;
    onOpenChat?: (mention: ChatFileMentionRecord) => void;
  };
  // Where a section read that failed reports, and what can explain an Access
  // answer that covers nothing. Both stay the same object between renders.
  notices: AboutNotices;
  accessContext: AccessContext;
}) {
  const { workspaceId, filePath } = props;
  const threadsKey = `${workspaceId}\0${filePath ?? ""}`;
  // Which sections are open stays while the person moves between files.
  const [sectionsOpen, setSectionsOpen] = useState(SECTIONS_OPEN);
  const toggleSection = (id: AboutSectionId) => () =>
    setSectionsOpen((current) => ({ ...current, [id]: !current[id] }));
  // Every received file share reads the chat about its files and adds nothing
  // to it. Main refuses every chat write with these words before the store.
  const readOnly = props.shareReadOnly === true;
  const [threadsState, setThreadsState] = useState<ThreadsState>({ status: "loading" });
  const [activeThread, setActiveThread] = useState<ChatThreadRecord | null>(null);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<{
    token: number;
    focusMessageId?: string;
  } | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  // Thread requests and this file's Chats read each own a token, so opening,
  // leaving or retrying one never drops the other's answer. A file or
  // workspace switch bumps both.
  const liveToken = useRef(0);
  const threadsToken = useRef(0);
  const reactions = useReactions();
  const listRef = useRef<ChatMessageListHandle | null>(null);

  const currentThreadsKey = useRef(threadsKey);
  currentThreadsKey.current = threadsKey;
  const { notices } = props;
  const refreshThreads = useCallback(async () => {
    if (!filePath) return;
    const token = ++threadsToken.current;
    const current = () => token === threadsToken.current && currentThreadsKey.current === threadsKey;
    const identity = `about-chats:${filePath}`;
    // The words go to the shell's error hook. The row goes when this file
    // leaves About, so its Try again always reads this file.
    const fail = (message: string, cause?: unknown) => {
      setThreadsState({ status: "unavailable", key: threadsKey });
      notices.report({ identity, message, cause, retry: () => void refreshThreads() });
    };
    setThreadsState({ status: "loading" });
    let updatingStartedAtMs: number | null = null;
    while (current()) {
      try {
        const result = await bridge().listFileChats({ workspaceId, path: filePath });
        if (!current()) return;
        if (isWorkspaceUpdatingResponse(result)) {
          const now = performance.now();
          updatingStartedAtMs ??= now;
          const remainingMs =
            updatingStartedAtMs + THREAD_LOAD_RETRY_DEADLINE_MS - now;
          if (remainingMs <= 0) {
            fail(WORKSPACE_UPDATING_MESSAGE);
            return;
          }
          await new Promise((resolveDelay) =>
            setTimeout(resolveDelay, Math.min(THREAD_LOAD_RETRY_MS, remainingMs)),
          );
          continue;
        }
        notices.clear(identity);
        setThreadsState({
          status: "ready",
          key: threadsKey,
          fileObjectId: result.fileObjectId,
          threads: result.threads,
        });
        return;
      } catch (error) {
        if (!current()) return;
        fail(ipcErrorMessage(error, "Could not load Chats for this file."), error);
        return;
      }
    }
  }, [filePath, notices, threadsKey, workspaceId]);

  // File, tab or workspace switch: drop everything stale and reload. The file
  // that leaves About takes its Notices row with it. A tab switch counts even
  // between two tabs that are not files, so a chat opened under one never
  // stays under the next. A file's tab is the file, so it reads no more often.
  const { tabPath } = props;
  useEffect(() => {
    liveToken.current += 1;
    setActiveThread(null);
    setMessages([]);
    setComposer("");
    setCreating(null);
    if (!filePath) {
      setThreadsState({ status: "loading" });
      return;
    }
    void refreshThreads();
    return () => {
      liveToken.current += 1;
      threadsToken.current += 1;
      notices.clear(`about-chats:${filePath}`);
    };
  }, [filePath, notices, refreshThreads, tabPath]);

  const openThread = useCallback(
    async (thread: ChatThreadRecord, focusMessageId?: string) => {
      const token = ++liveToken.current;
      setActiveThread(thread);
      setMessages([]);
      setMessagesLoading(true);
      try {
        const ticket = reactions.ticket();
        const [result, reactionResult] = await Promise.all([
          bridge().listChatMessages({ workspaceId, threadId: thread.id }),
          bridge().listChatReactions({ workspaceId, threadId: thread.id }),
        ]);
        // What the server holds is news for every surface, still open or not.
        reactions.ingest([{ threadId: thread.id, ...reactionResult, ticket }]);
        if (token !== liveToken.current) return;
        setMessages(result.messages);
        // Everything on screen is read. Reporting waits for the write to
        // land: the navigator refetches on that signal, and refetching earlier
        // would read the same count back.
        void bridge()
          .markChatThreadRead({
            workspaceId,
            threadId: thread.id,
            upToSequence: result.messages.length,
          })
          .then(
            () => props.onThreadRead?.(),
            () => {
              // Best-effort, like the Chats view: the badge stays until the
              // next refresh if the cursor write did not land.
            },
          );
        setScrollTarget({ token, focusMessageId });
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not load this chat."), error);
      } finally {
        if (token === liveToken.current) setMessagesLoading(false);
      }
    },
    [props.onError, props.onThreadRead, reactions, workspaceId],
  );

  // A loaded response is not a React commit. Wait until the message list has
  // mounted before asking it to reveal an offscreen row.
  useEffect(() => {
    if (!scrollTarget || messagesLoading) return;
    const frame = requestAnimationFrame(() => {
      if (scrollTarget.token !== liveToken.current) return;
      if (!scrollTarget.focusMessageId ||
          !listRef.current?.scrollToMessage(scrollTarget.focusMessageId)) {
        listRef.current?.scrollToEnd();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [messagesLoading, scrollTarget]);

  // The thread initialThread opened, while it is the one shown. When it stops
  // showing (Back, a switch, or this panel unmounting), the parent hears so.
  // Declared before the effect that sets it, so its first run sees nothing.
  const shownInitialThread = useRef<string | null>(null);
  const onInitialThreadClosed = useRef(props.onInitialThreadClosed);
  onInitialThreadClosed.current = props.onInitialThreadClosed;
  useEffect(() => {
    if (shownInitialThread.current === null || activeThread?.id === shownInitialThread.current) return;
    shownInitialThread.current = null;
    onInitialThreadClosed.current?.();
  }, [activeThread]);
  useEffect(() => () => {
    if (shownInitialThread.current !== null) onInitialThreadClosed.current?.();
  }, []);

  // Consume each search-result click once. The shell creates a fresh record
  // per click, including when the user reopens the same thread.
  const consumedInitialThread = useRef<ChatThreadRecord | null>(null);
  useEffect(() => {
    if (!props.initialThread) return;
    if (consumedInitialThread.current === props.initialThread) return;
    consumedInitialThread.current = props.initialThread;
    shownInitialThread.current = props.initialThread.id;
    void openThread(props.initialThread, props.initialFocusMessageId);
    props.onInitialThreadConsumed?.();
  }, [
    openThread,
    props.initialFocusMessageId,
    props.initialThread,
    props.onInitialThreadConsumed,
  ]);

  const createChat = useCallback(
    async (title: string) => {
      if (!filePath) return;
      const trimmed = title.trim();
      if (trimmed.length === 0) return;
      const token = ++liveToken.current;
      try {
        const result = await bridge().createFileChat({
          workspaceId,
          path: filePath,
          title: trimmed,
        });
        if (token !== liveToken.current) return;
        setCreating(null);
        setThreadsState((current) =>
          current.status === "ready"
            ? { ...current, threads: [...current.threads, result.thread] }
            : current,
        );
        void openThread(result.thread);
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not start a chat for this file."), error);
      }
    },
    [filePath, openThread, props.onError, workspaceId],
  );

  const sendMessage = useCallback(async () => {
    const thread = activeThread;
    const body = composer.trim();
    if (!thread || body.length === 0 || sending) return;
    const token = liveToken.current;
    setSending(true);
    try {
      const result = await bridge().sendChatMessage({
        workspaceId,
        threadId: thread.id,
        body,
      });
      if (token !== liveToken.current) return;
      if (result.waitsForTrust) props.onAgentWaitsForTrust?.(workspaceId);
      setMessages((current) => [...current, result.message]);
      setComposer("");
      listRef.current?.scrollToEnd();
    } catch (error) {
      if (token !== liveToken.current) return;
      props.onError(ipcErrorMessage(error, "Could not send that message."), error);
    } finally {
      // Reset unconditionally: switching threads/files bumps liveToken
      // without resetting `sending`, so a token-gated reset could leave this
      // panel instance's composer disabled forever. The token guard on the
      // `sending` Read (line above the IPC call) already prevents concurrent
      // sends, so an unconditional reset is race-free.
      setSending(false);
    }
  }, [activeThread, composer, props.onAgentWaitsForTrust, props.onError, sending, workspaceId]);

  // Reactions (WS-MU-C2) go through the workspace's reaction store, shared
  // with every Chats surface: this thread's rows as the store knows them.
  const threadReactions = activeThread ? reactions.view(activeThread.id) : NO_REACTIONS;
  const toggleReaction = useCallback(
    (input: { messageId: string; emoji: string; nextState: "added" | "removed" }) => {
      const thread = activeThread;
      if (!thread || !threadReactions.viewerAuthorId) return;
      const token = liveToken.current;
      reactions.toggle({
        ...input,
        threadId: thread.id,
        viewerAuthorId: threadReactions.viewerAuthorId,
        onError: (message, cause) => {
          if (token === liveToken.current) props.onError(message, cause);
        },
      });
    },
    [activeThread, props.onError, reactions, threadReactions.viewerAuthorId],
  );

  // Stable for ChatMessageList's memo — an inline literal would defeat it on
  // every composer keystroke. A reaction is a write, so a share that refuses
  // writes offers no picker — but the reactions already on a message are part
  // of the conversation and stay readable. `readOnly` is the affordance built
  // for exactly this; omitting the whole prop would have hidden other
  // people's reactions too.
  const reactionControls = useMemo(
    () => ({
      reactions: threadReactions.reactions,
      viewerAuthorId: threadReactions.viewerAuthorId,
      onToggle: toggleReaction,
      readOnly,
    }),
    [threadReactions, toggleReaction, readOnly],
  );

  if (activeThread) {
    return (
      <div
        data-testid="linked-chat-thread"
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2">
          <button
            type="button"
            data-testid="linked-chat-back"
            aria-label="Back to Chats"
            title="Back to Chats"
            onClick={() => {
              liveToken.current += 1;
              setActiveThread(null);
              setMessages([]);
            }}
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-subtle hover:bg-hover hover:text-ink"
          >
            <ArrowLeft size={13} aria-hidden />
          </button>
          <span
            data-testid="linked-chat-title"
            className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink"
          >
            {activeThread.title}
          </span>
        </div>
        <ChatMessageList
          testIdPrefix="linked-chat"
          messages={messages}
          loading={messagesLoading}
          emptyLabel={`No messages yet${filePath ? ` about ${basenameOf(filePath)}` : ""}.`}
          key={`${workspaceId}:${activeThread.id}`}
          listRef={listRef}
          onOpenPath={props.onOpenPath}
          reactionControls={reactionControls}
        />
        {readOnly ? (
          <ReadOnlyNotice />
        ) : (
          <ChatComposer
            testIdPrefix="linked-chat"
            composerId="linked-chat-composer"
            value={composer}
            sending={sending}
            placeholder="Write a message…"
            sendLabel="Send message"
            onChange={setComposer}
            onSend={() => void sendMessage()}
          />
        )}
      </div>
    );
  }

  if (!filePath) {
    // About covers a file or a conversation. A shared view has no
    // conversations, so there it names a file's own chats.
    const subject = readOnly ? "a file" : "a file or a conversation";
    const shows = readOnly ? "its chats and access" : "who has access";
    return (
      <EmptyState
        data-testid="linked-chats-empty"
        icon={Info}
        title={
          props.aboutTabOpen
            ? `Switch to ${readOnly ? "a file's tab" : subject} to see ${shows}.`
            : `Open ${subject} to see ${shows}.`
        }
      />
    );
  }

  const threads = "key" in threadsState && threadsState.key === threadsKey ? threadsState : null;
  // History asks about the file's object id, which this file's chats read
  // answers. History keeps its place while that read runs or fails.
  const file: AboutFile =
    threads === null ? { status: "loading" }
    : threads.status === "unavailable" ? { status: "failed", retry: () => void refreshThreads() }
    : { status: "ready", objectId: threads.fileObjectId };
  return (
    <div data-testid="about-panel" className="flex min-h-0 flex-1 flex-col">
      <AboutHeader subject={{ path: filePath }} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        <AboutLinks
          workspaceId={workspaceId}
          path={filePath}
          revision={props.links.revision}
          expanded={sectionsOpen.links}
          onToggle={toggleSection("links")}
          onOpenLink={props.links.onOpenLink}
          {...(props.links.onOpenChat ? { onOpenChat: props.links.onOpenChat } : {})}
          notices={notices}
        />
        <AboutSection
          id="chats"
          icon={MessageSquare}
          label="Chats"
          count={threads?.status === "ready" ? String(threads.threads.length) : undefined}
          expanded={sectionsOpen.chats}
          onToggle={toggleSection("chats")}
        >
          {threads === null ? (
            <SkeletonRows rows={2} className="px-2 py-1" label="Loading Chats..." />
          ) : threads.status === "unavailable" ? (
            <RetryRow testId="linked-chats-failed" onRetry={() => void refreshThreads()} />
          ) : (
            <div data-testid="linked-chats-panel">
              {threads.threads.length === 0 ? (
                // The next step is the New chat control below, where this
                // file offers one.
                <AboutNote testId="linked-chats-empty">No chats about this file yet.</AboutNote>
              ) : (
                <ul className="m-0 list-none p-0">
                  {threads.threads.map((thread) => (
                    <li key={thread.id}>
                      <AboutChatRow thread={thread} onOpen={() => void openThread(thread)} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </AboutSection>
        {props.history ? (
          <AboutHistory
            workspaceId={workspaceId}
            path={filePath}
            file={file}
            revision={props.history.revision}
            paused={props.history.paused}
            expanded={sectionsOpen.history}
            onToggle={toggleSection("history")}
            onOpenMoment={props.history.onOpenMoment}
            notices={notices}
          />
        ) : null}
        <AboutAccess
          workspaceId={workspaceId}
          subject={{ kind: "path", path: filePath }}
          expanded={sectionsOpen.access}
          onToggle={toggleSection("access")}
          notices={notices}
          context={props.accessContext}
        />
      </div>
      {threads?.status !== "ready" ? null : readOnly ? (
        <ReadOnlyNotice />
      ) : (
        <div className="shrink-0 border-t border-line p-2">
          {threads.fileObjectId === null ? (
            <p className="m-0 px-1 text-[11px] leading-4 text-subtle">
              Chats aren't available for this file yet — only text files dohc
              tracks can have Chats.
            </p>
          ) : creating === null ? (
            <button
              type="button"
              data-testid="linked-chat-new"
              onClick={() => setCreating(basenameOf(filePath))}
              className="flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-line text-[11px] text-muted hover:bg-hover hover:text-ink"
            >
              <MessageSquare size={12} aria-hidden />
              New chat
            </button>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void createChat(creating);
              }}
            >
              <label className="sr-only" htmlFor="linked-chat-new-title">
                Chat title
              </label>
              <input
                spellCheck={false}
                id="linked-chat-new-title"
                data-testid="linked-chat-new-title"
                autoFocus
                value={creating}
                maxLength={200}
                placeholder="Chat title"
                onChange={(event) => setCreating(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setCreating(null);
                  }
                }}
                className="h-7 w-full rounded-md border border-line bg-bg px-2 text-[13px] text-ink placeholder:text-subtle dohc-focus-input"
              />
              <p className="mb-0 mt-1 px-1 text-[10px] leading-4 text-subtle">
                Press Enter to start the chat.
              </p>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
