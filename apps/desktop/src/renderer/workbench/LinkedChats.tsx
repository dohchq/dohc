import { basenameOf } from "../path";
import { ipcErrorMessage } from "../ipcError";
import { ArrowLeft, Info, Lock, Plus } from "lucide-react";
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
  AboutSectionAction,
  type AboutFile,
  type AboutNotices,
  type AboutSectionId,
} from "./About";
import type { AccessContext } from "./accessReason";
import { ChatComposer, ChatMessageList, type ChatMessageListHandle } from "./chatMessages";
import { useReactions, type ReactionView } from "./reactionStore";
import { CopyMessageLink } from "./messageLinks";
import { useMessageDelete } from "./messageDelete";
import { AgentThreadLines } from "./AgentThreadLines";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";

// The composer's replacement when this person cannot comment. The shell
// names the reason main refuses with; this is the same shape the Chats
// view's read-only notice uses, with the lock the Read-only mark shows.
function ReadOnlyNotice({ reason }: { reason: string }) {
  return (
    <p
      data-testid="linked-chat-readonly-note"
      className="m-0 flex shrink-0 items-start gap-1.5 border-t border-line px-3 py-2 text-[11px] text-subtle"
    >
      <Lock size={12} aria-hidden className="mt-px shrink-0" />
      <span>{reason}</span>
    </p>
  );
}

const NEW_COMMENT_COMPOSER = "linked-chat-new-composer-input";

const NO_REACTIONS: ReactionView = { reactions: [], viewerAuthorId: "" };

// `key` names the workspace and file an answer is for: a state for another
// file reads as loading, so a switch never shows the last file's chats.
// `updating` is the engine still reading the workspace's files in.
type ThreadsState =
  | { status: "loading" }
  | { status: "updating"; key: string }
  | { status: "unavailable"; key: string }
  | { status: "ready"; key: string; fileObjectId: string | null; threads: ChatThreadRecord[] };

const SECTIONS_OPEN: Record<AboutSectionId, boolean> = {
  access: true,
  chats: true,
  history: true,
  links: true,
};

// The engine answers "still updating" only while its first capture of the
// workspace runs, and that capture ends ready or degraded. So the read asks
// again each second, with no deadline of its own.
const THREAD_LOAD_RETRY_MS = 1_000;

function isWorkspaceUpdatingResponse(
  response: ListFileChatsResponse,
): response is Extract<ListFileChatsResponse, { status: "refused"; code: "workspace-updating" }> {
  return (
    "status" in response && response.status === "refused" && response.code === "workspace-updating"
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
  // A shared view, which has no conversations of its own in About.
  shared?: boolean;
  // Why this person cannot comment here, in the words main refuses with.
  // Absent means they can. The shell passes the decision, not the level: a
  // damaged grant carries no level, and reading one would answer generously.
  readOnly?: string;
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
  onError: (message: string, cause?: unknown, retry?: () => void) => void;
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
    onOpenHistory: () => void;
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
  const readOnlyReason = props.readOnly;
  const readOnly = readOnlyReason !== undefined;
  const [threadsState, setThreadsState] = useState<ThreadsState>({ status: "loading" });
  const [activeThread, setActiveThread] = useState<ChatThreadRecord | null>(null);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<{
    token: number;
    focusMessageId?: string;
  } | null>(null);
  const [commenting, setCommenting] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  // Thread requests and this file's Chats read each own a token, so opening,
  // leaving or retrying one never drops the other's answer. A file or
  // workspace switch bumps both.
  const liveToken = useRef(0);
  const threadsToken = useRef(0);
  // The open chat's message reads, numbered as they start. An answer older
  // than the one shown is dropped, so a slow first read can't bring back a
  // message deleted since.
  const messageReads = useRef({ started: 0, shown: 0 });
  // The one read of an open chat's messages, for opening it and for activity.
  const readMessages = useCallback(
    (threadId: string) => bridge().listChatMessages({ workspaceId, threadId }),
    [workspaceId],
  );
  const reactions = useReactions();
  const listRef = useRef<ChatMessageListHandle | null>(null);

  const currentThreadsKey = useRef(threadsKey);
  currentThreadsKey.current = threadsKey;
  const { notices } = props;
  const refreshThreads = useCallback(async () => {
    if (!filePath) return;
    const token = ++threadsToken.current;
    const current = () =>
      token === threadsToken.current && currentThreadsKey.current === threadsKey;
    const identity = `about-chats:${filePath}`;
    // The words go to the shell's error hook. The row goes when this file
    // leaves About, so its Try again always reads this file.
    const fail = (message: string, cause?: unknown) => {
      setThreadsState({ status: "unavailable", key: threadsKey });
      notices.report({ identity, message, cause, retry: () => void refreshThreads() });
    };
    setThreadsState({ status: "loading" });
    while (current()) {
      try {
        const result = await bridge().listFileChats({ workspaceId, path: filePath });
        if (!current()) return;
        if (isWorkspaceUpdatingResponse(result)) {
          setThreadsState((state) =>
            state.status === "updating" && state.key === threadsKey
              ? state
              : { status: "updating", key: threadsKey },
          );
          await new Promise((resolveDelay) => setTimeout(resolveDelay, THREAD_LOAD_RETRY_MS));
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
    setCommenting(null);
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

  // The opening message the open chat's title was read with: unknown until
  // its first read shows, and null for a chat read with no messages.
  const titleReadWith = useRef<{ threadId: string; opening: string | null | undefined } | null>(
    null,
  );
  const openThread = useCallback(
    async (thread: ChatThreadRecord, focusMessageId?: string, readWithoutMessages = false) => {
      const token = ++liveToken.current;
      const read = ++messageReads.current.started;
      titleReadWith.current = {
        threadId: thread.id,
        opening: readWithoutMessages ? null : undefined,
      };
      setActiveThread(thread);
      setMessages([]);
      setMessagesLoading(true);
      try {
        const ticket = reactions.ticket();
        const [result, reactionResult] = await Promise.all([
          readMessages(thread.id),
          bridge().listChatReactions({ workspaceId, threadId: thread.id }),
        ]);
        // What the server holds is news for every surface, still open or not.
        reactions.ingest([{ threadId: thread.id, ...reactionResult, ticket }]);
        if (token !== liveToken.current) return;
        if (read > messageReads.current.shown) {
          messageReads.current.shown = read;
          setMessages(result.messages);
        }
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
    [props.onError, props.onThreadRead, reactions, readMessages, workspaceId],
  );

  // The chat this panel shows, and none once it unmounts.
  const shownThreadId = useRef<string | null>(null);
  useEffect(() => {
    shownThreadId.current = activeThread?.id ?? null;
    return () => {
      shownThreadId.current = null;
    };
  }, [activeThread]);
  // A message that saved while a later step failed. The notice's Try again
  // opens its chat again while About still shows that chat on this
  // workspace's file.
  const reportUnshown = useCallback(
    (words: string, failure: string, thread: ChatThreadRecord) => {
      const key = threadsKey;
      props.onError(words, failure, () => {
        if (currentThreadsKey.current === key && shownThreadId.current === thread.id)
          void openThread(thread);
      });
    },
    [openThread, props.onError, threadsKey],
  );

  // A loaded response is not a React commit. Wait until the message list has
  // mounted before asking it to reveal an offscreen row.
  useEffect(() => {
    if (!scrollTarget || messagesLoading) return;
    const frame = requestAnimationFrame(() => {
      if (scrollTarget.token !== liveToken.current) return;
      if (
        !scrollTarget.focusMessageId ||
        !listRef.current?.scrollToMessage(scrollTarget.focusMessageId)
      ) {
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
    if (shownInitialThread.current === null || activeThread?.id === shownInitialThread.current)
      return;
    shownInitialThread.current = null;
    onInitialThreadClosed.current?.();
  }, [activeThread]);
  useEffect(
    () => () => {
      if (shownInitialThread.current !== null) onInitialThreadClosed.current?.();
    },
    [],
  );

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
  }, [openThread, props.initialFocusMessageId, props.initialThread, props.onInitialThreadConsumed]);

  // A comment on the whole file starts its chat, then posts as its first
  // message. A post that fails leaves the chat open with the words in its
  // composer, so nothing written is lost.
  const commentOnFile = useCallback(
    async (body: string) => {
      if (!filePath) return;
      const trimmed = body.trim();
      if (trimmed.length === 0 || sending) return;
      const token = ++liveToken.current;
      setSending(true);
      try {
        const { thread } = await bridge().createFileChat({ workspaceId, path: filePath });
        if (token !== liveToken.current) return;
        setCommenting(null);
        setThreadsState((current) =>
          current.status === "ready"
            ? { ...current, threads: [...current.threads, thread] }
            : current,
        );
        try {
          const result = await bridge().sendChatMessage({
            workspaceId,
            threadId: thread.id,
            body: trimmed,
          });
          if (token !== liveToken.current) return;
          // The comment saved, so its words stay out of the composer. Opening the chat shows it.
          if ("failure" in result)
            reportUnshown(
              "Posted your comment. dohc could not show it yet.",
              result.failure,
              thread,
            );
          else if (result.waitsForTrust) props.onAgentWaitsForTrust?.(workspaceId);
        } catch (error) {
          if (token !== liveToken.current) return;
          setComposer(trimmed);
          props.onError(ipcErrorMessage(error, "Could not post that comment."), error);
        }
        // The chat was created untitled, so its title came before the comment.
        void openThread(thread, undefined, true);
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not comment on this file."), error);
      } finally {
        setSending(false);
      }
    },
    [
      filePath,
      openThread,
      props.onAgentWaitsForTrust,
      props.onError,
      reportUnshown,
      sending,
      workspaceId,
    ],
  );

  // The composer that opens takes focus, as the + that opened it asked.
  const composing = commenting !== null;
  useEffect(() => {
    if (composing) document.getElementById(NEW_COMMENT_COMPOSER)?.focus();
  }, [composing]);

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
      setComposer("");
      if ("failure" in result) {
        // The message saved, so the chat reloads to show it.
        reportUnshown("Sent your message. dohc could not show it yet.", result.failure, thread);
        void openThread(thread);
        return;
      }
      if (result.waitsForTrust) props.onAgentWaitsForTrust?.(workspaceId);
      // A read after the save may already show it, maybe deleted since.
      setMessages((current) =>
        current.some((message) => message.id === result.message.id)
          ? current
          : [...current, result.message],
      );
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
  }, [
    activeThread,
    composer,
    openThread,
    props.onAgentWaitsForTrust,
    props.onError,
    reportUnshown,
    sending,
    workspaceId,
  ]);

  // Reactions go through the workspace's reaction store, shared
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

  const activeThreadId = activeThread?.id ?? null;
  const activeChatThreadIds = useMemo(() => [activeThreadId], [activeThreadId]);
  // Another copy's delete, a pull or an agent changes the open chat without
  // this panel. Workspace activity reads its messages again, as the Chats view
  // does: one read at a time, and one more after it if activity came meanwhile,
  // so a steady stream of activity still shows each answer. A message sent here
  // while a read ran stays at the end.
  useEffect(() => {
    if (activeThreadId === null) return;
    let active = true;
    let reading = false;
    let again = false;
    const readAgain = async () => {
      reading = true;
      do {
        again = false;
        const read = ++messageReads.current.started;
        try {
          const fresh = (await readMessages(activeThreadId)).messages;
          if (!active || read <= messageReads.current.shown) continue;
          messageReads.current.shown = read;
          const ids = new Set(fresh.map((message) => message.id));
          setMessages((current) => [
            ...fresh,
            ...current.filter((message) => !ids.has(message.id)),
          ]);
        } catch {
          // The open chat keeps what it shows; the next activity reads again.
        }
      } while (again && active);
      reading = false;
    };
    const unsubscribe = bridge().onWorkspaceActivity((event) => {
      if (event.workspaceId !== undefined && event.workspaceId !== workspaceId) return;
      if (reading) again = true;
      else void readAgain();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [activeThreadId, readMessages, workspaceId]);

  // An untitled chat shows its opening message's first line, and "New chat"
  // once that message is deleted. When the opening message the heading was
  // read with changes, the chat's title is read again.
  const shownOpening =
    activeThread === null || messagesLoading
      ? undefined
      : messages[0]?.threadId === activeThread.id
        ? `${messages[0].id}:${messages[0].deletedAtMs !== undefined}`
        : null;
  const freshTitle = useWorkspaceQuery(useWorkspaceSession(), {
    key: `linked-chat-title:${workspaceId}:${filePath}:${activeThreadId}`,
    manual: true,
    load: async () => {
      if (!filePath || activeThreadId === null) return null;
      const result = await bridge().listFileChats({ workspaceId, path: filePath });
      if (isWorkspaceUpdatingResponse(result)) return null;
      return result.threads.find((thread) => thread.id === activeThreadId) ?? null;
    },
  });
  const readTitle = freshTitle.retry;
  useEffect(() => {
    const readWith = titleReadWith.current;
    if (shownOpening === undefined || readWith?.threadId !== activeThreadId) return;
    const before = readWith.opening;
    readWith.opening = shownOpening;
    if (before !== undefined && before !== shownOpening) void readTitle();
  }, [activeThreadId, readTitle, shownOpening]);
  const freshThread = freshTitle.value;
  useEffect(() => {
    if (!freshThread) return;
    const { id, title } = freshThread;
    setActiveThread((current) =>
      current?.id === id && current.title !== title ? { ...current, title } : current,
    );
    setThreadsState((current) =>
      current.status === "ready"
        ? {
            ...current,
            threads: current.threads.map((thread) =>
              thread.id === id ? { ...thread, title } : thread,
            ),
          }
        : current,
    );
  }, [freshThread]);
  const reactionControls = useMemo(
    () => ({
      reactions: threadReactions.reactions,
      viewerAuthorId: threadReactions.viewerAuthorId,
      onToggle: toggleReaction,
      readOnly,
    }),
    [threadReactions, toggleReaction, readOnly],
  );
  const messageDelete = useMessageDelete({
    workspaceId,
    viewerAuthorId: threadReactions.viewerAuthorId,
    enabled: true,
  });
  const deleteAction = messageDelete.action;
  // Stable while typing in the composer, so the list keeps its memo.
  const rowActions = useCallback(
    (message: ChatMessageRecord) => (
      <>
        <CopyMessageLink messageId={message.id} testId="linked-chat-copy-link" />
        {deleteAction(message, "linked-chat-delete")}
      </>
    ),
    [deleteAction],
  );

  if (activeThread) {
    return (
      <div data-testid="linked-chat-thread" className="flex min-h-0 flex-1 flex-col">
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
          surface="panel"
          messages={messages}
          loading={messagesLoading}
          emptyLabel={`No messages yet${filePath ? ` about ${basenameOf(filePath)}` : ""}.`}
          key={`${workspaceId}:${activeThread.id}`}
          listRef={listRef}
          onOpenPath={props.onOpenPath}
          reactionControls={reactionControls}
          rowActions={rowActions}
        />
        {messageDelete.dialog}
        <AgentThreadLines
          workspaceId={workspaceId}
          chatThreadIds={activeChatThreadIds}
          className="shrink-0 px-3 py-1"
        />
        {readOnly ? (
          <ReadOnlyNotice reason={readOnlyReason!} />
        ) : (
          <ChatComposer
            pinned
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
    const shared = props.shared === true;
    const subject = shared ? "a file" : "a file or a conversation";
    const shows = shared ? "its comments and access" : "who has access";
    return (
      <EmptyState
        data-testid="linked-chats-empty"
        icon={Info}
        title={
          props.aboutTabOpen
            ? `Switch to ${shared ? "a file's tab" : subject} to see ${shows}.`
            : `Open ${subject} to see ${shows}.`
        }
      />
    );
  }

  const threads = "key" in threadsState && threadsState.key === threadsKey ? threadsState : null;
  // History asks about the file's object id, which this file's chats read
  // answers. History keeps its place while that read runs, waits or fails.
  const file: AboutFile =
    threads === null
      ? { status: "loading" }
      : threads.status === "updating"
        ? { status: "updating" }
        : threads.status === "unavailable"
          ? { status: "failed", retry: () => void refreshThreads() }
          : { status: "ready", objectId: threads.fileObjectId };
  // A file dohc does not track has no object for a chat to follow, so it
  // takes no comments: the section says why instead of offering one.
  const ready = threads?.status === "ready" ? threads : null;
  const untracked = ready !== null && ready.fileObjectId === null;
  const canComment = ready !== null && !readOnly && !untracked;
  const startComment = () => {
    setSectionsOpen((current) => ({ ...current, chats: true }));
    setCommenting((current) => current ?? "");
  };
  return (
    <div data-testid="about-panel" className="flex min-h-0 flex-1 flex-col">
      <AboutHeader subject={{ path: filePath }} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        <AboutAccess
          workspaceId={workspaceId}
          subject={{ kind: "path", path: filePath }}
          expanded={sectionsOpen.access}
          onToggle={toggleSection("access")}
          notices={notices}
          context={props.accessContext}
        />
        <AboutSection
          id="chats"
          label="Comments"
          count={ready ? String(ready.threads.length) : undefined}
          empty={
            ready !== null &&
            ready.threads.length === 0 &&
            commenting === null &&
            !readOnly &&
            !untracked
          }
          expanded={sectionsOpen.chats}
          onToggle={toggleSection("chats")}
          actions={
            canComment ? (
              <AboutSectionAction
                testId="linked-chat-new"
                label="Comment on this file"
                icon={Plus}
                onClick={startComment}
              />
            ) : null
          }
        >
          {threads === null || threads.status === "updating" ? (
            <SkeletonRows rows={2} className="px-2 py-1" label="Loading comments..." />
          ) : threads.status === "unavailable" ? (
            <RetryRow testId="linked-chats-failed" onRetry={() => void refreshThreads()} />
          ) : (
            <div data-testid="linked-chats-panel">
              {commenting !== null ? (
                <div className="-mx-1">
                  <ChatComposer
                    testIdPrefix="linked-chat-new"
                    composerId={NEW_COMMENT_COMPOSER}
                    value={commenting}
                    sending={sending}
                    placeholder="Comment on this file…"
                    sendLabel="Comment"
                    onChange={setCommenting}
                    onSend={() => void commentOnFile(commenting)}
                    onEscape={() => setCommenting(null)}
                  />
                </div>
              ) : null}
              {readOnlyReason !== undefined ? (
                <AboutNote testId="linked-chat-readonly-note" icon={Lock}>
                  {readOnlyReason}
                </AboutNote>
              ) : untracked ? (
                <AboutNote testId="linked-chats-untracked">
                  dohc does not track this file, so it cannot have comments.
                </AboutNote>
              ) : null}
              {threads.threads.length > 0 ? (
                <ul className="m-0 list-none p-0">
                  {threads.threads.map((thread) => (
                    <li key={thread.id}>
                      <AboutChatRow thread={thread} onOpen={() => void openThread(thread)} />
                    </li>
                  ))}
                </ul>
              ) : null}
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
            onOpenHistory={props.history.onOpenHistory}
            notices={notices}
          />
        ) : null}
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
      </div>
    </div>
  );
}
