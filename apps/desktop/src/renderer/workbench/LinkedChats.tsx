import { ArrowLeft, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatMessageRecord,
  ChatReactionRecord,
  ChatThreadRecord,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import {
  ChatComposer,
  ChatMessageList,
  chatAuthorLabel,
  formatChatTime,
  ipcErrorMessage,
  runReactionToggle,
} from "./chatMessages";

// Linked Chats surface (PR 0M-5, workspace-engine alpha) — the Chats
// panel's "This file" tab. Per-file Chats
// stored in the engine and linked to the file's STABLE object id, so a chat
// follows its file through renames. Product vocabulary: these are Chats.
// Message rendering + composer are the SHARED chatMessages pieces (PR 13)
// so this surface and the workspace Chats view can never drift.

// Re-exported: EngineHistory (and its tests) import the authorship rule from
// here since PR 0N-1.
export { chatAuthorLabel };

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

type ThreadsState =
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | { status: "ready"; fileObjectId: string | null; threads: ChatThreadRecord[] };

// The per-file Chats panel: thread list with a calm empty state, inline
// create, and a thread view with a composer. Every async response is gated
// by a liveness token before it touches state (workspace/file switches must
// never repaint stale data).
export function LinkedChatsPanel(props: {
  workspaceId: string;
  filePath: string | null;
  readOnly?: boolean;
  initialThread?: ChatThreadRecord | null;
  initialFocusMessageId?: string;
  // Fired once when initialThread is consumed so the parent can clear the
  // state it minted for this open. Without that clear, every remount of this
  // panel (History <-> Chats toggle) resets consumedInitialThread and
  // re-opens the stale thread.
  onInitialThreadConsumed?: () => void;
  onOpenPath?: (path: string, headingAnchor?: string) => void;
  onError: (message: string) => void;
}) {
  const { workspaceId, filePath } = props;
  const readOnly = props.readOnly === true;
  const [threadsState, setThreadsState] = useState<ThreadsState>({ status: "loading" });
  const [activeThread, setActiveThread] = useState<ChatThreadRecord | null>(null);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [reactions, setReactions] = useState<ChatReactionRecord[]>([]);
  const [viewerAuthorId, setViewerAuthorId] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const liveToken = useRef(0);
  // Per-(message, emoji) toggle sequence so overlapping reaction toggles resolve
  // in order (see runReactionToggle).
  const reactionSeq = useRef(new Map<string, number>());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const threadViewRef = useRef<HTMLDivElement | null>(null);

  const refreshThreads = useCallback(async () => {
    if (!filePath) return;
    const token = ++liveToken.current;
    setThreadsState({ status: "loading" });
    try {
      const result = await bridge().listFileChats({ workspaceId, path: filePath });
      if (token !== liveToken.current) return;
      setThreadsState({
        status: "ready",
        fileObjectId: result.fileObjectId,
        threads: result.threads,
      });
    } catch (error) {
      if (token !== liveToken.current) return;
      setThreadsState({
        status: "unavailable",
        message: ipcErrorMessage(error, "Could not load Chats for this file."),
      });
    }
  }, [filePath, workspaceId]);

  // File (or workspace) switch: drop everything stale and reload.
  useEffect(() => {
    liveToken.current += 1;
    setActiveThread(null);
    setMessages([]);
    setComposer("");
    setCreating(null);
    if (!filePath) {
      setThreadsState({ status: "ready", fileObjectId: null, threads: [] });
      return;
    }
    void refreshThreads();
    return () => {
      liveToken.current += 1;
    };
  }, [filePath, refreshThreads]);

  const openThread = useCallback(
    async (thread: ChatThreadRecord, focusMessageId?: string) => {
      const token = ++liveToken.current;
      setActiveThread(thread);
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
        requestAnimationFrame(() => {
          // Rendering is deferred one frame so the freshly loaded messages
          // exist in the DOM. Re-check the same request token inside that
          // deferred callback: another thread/file/workspace may have opened
          // after the response committed but before this frame ran.
          if (token !== liveToken.current) return;
          const focusedMessage = focusMessageId
            ? Array.from(
                threadViewRef.current?.querySelectorAll<HTMLElement>("[data-message-id]") ??
                  [],
              ).find((element) => element.dataset.messageId === focusMessageId)
            : undefined;
          // A file mention lands on the exact referenced message. Ordinary
          // thread opens retain the established latest-message landing.
          (focusedMessage ?? messagesEndRef.current)?.scrollIntoView({
            block: focusedMessage ? "center" : "end",
          });
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

  // A search-result chat open is consumed ONCE by object identity: the Shell
  // mints a fresh record per click, so clicking the same result again still
  // re-opens, while re-renders (openThread's identity changes every render
  // because it closes over props) and back-navigation inside the panel never
  // re-trigger it — without the guard this effect would loop setMessages([])
  // on every render and trap the user inside the thread.
  const consumedInitialThread = useRef<ChatThreadRecord | null>(null);
  useEffect(() => {
    if (!props.initialThread) return;
    if (consumedInitialThread.current === props.initialThread) return;
    consumedInitialThread.current = props.initialThread;
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
      if (readOnly) return;
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
        props.onError(ipcErrorMessage(error, "Could not start a chat for this file."));
      }
    },
    [filePath, openThread, props, readOnly, workspaceId],
  );

  const sendMessage = useCallback(async () => {
    if (readOnly) return;
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
      setMessages((current) => [...current, result.message]);
      setComposer("");
      messagesEndRef.current?.scrollIntoView({ block: "end" });
    } catch (error) {
      if (token !== liveToken.current) return;
      props.onError(ipcErrorMessage(error, "Could not send that message."));
    } finally {
      // Reset unconditionally: switching threads/files bumps liveToken
      // without resetting `sending`, so a token-gated reset could leave this
      // panel instance's composer disabled forever. The token guard on the
      // `sending` READ (line above the IPC call) already prevents concurrent
      // sends, so an unconditional reset is race-free.
      setSending(false);
    }
  }, [activeThread, composer, props, readOnly, sending, workspaceId]);

  // Reactions (WS-MU-C2): optimistic toggle of the viewer's own reaction with
  // rollback-on-failure and per-cell ordering, then reconcile to the canonical
  // server list. Shared with the Chats view so behavior can never drift.
  const toggleReaction = useCallback(
    (input: { messageId: string; emoji: string; nextState: "added" | "removed" }) => {
      if (readOnly) return;
      const thread = activeThread;
      if (!thread) return;
      runReactionToggle(
        {
          workspaceId,
          threadId: thread.id,
          viewerAuthorId,
          liveToken,
          reactionSeq,
          setReactions,
          setViewerAuthorId,
          onError: props.onError,
        },
        input,
      );
    },
    [activeThread, props, readOnly, viewerAuthorId, workspaceId],
  );

  if (activeThread) {
    return (
      <div
        ref={threadViewRef}
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
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
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
          emptyLabel={`No messages yet${filePath ? ` about ${basename(filePath)}` : ""}.`}
          endRef={messagesEndRef}
          onOpenPath={props.onOpenPath}
          reactionControls={{
            reactions,
            viewerAuthorId,
            onToggle: toggleReaction,
            readOnly,
          }}
        />
        {readOnly ? (
          <p
            data-testid="linked-chat-readonly-note"
            className="m-0 shrink-0 border-t border-line px-3 py-2 text-[11px] text-subtle"
          >
            This shared workspace is read-only. You can still read this chat.
          </p>
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
    return (
      <div
        data-testid="linked-chats-empty"
        className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center"
      >
        <span className="text-xs text-muted">No file open</span>
        <span className="text-[11px] text-subtle">
          Open a file to see its Chats.
        </span>
      </div>
    );
  }

  if (threadsState.status === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-xs text-subtle">
        Loading Chats...
      </div>
    );
  }

  if (threadsState.status === "unavailable") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <span className="text-xs text-danger">{threadsState.message}</span>
        <button
          type="button"
          onClick={() => void refreshThreads()}
          className="h-7 cursor-pointer rounded-md border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div data-testid="linked-chats-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {threadsState.threads.length === 0 ? (
          <div
            data-testid="linked-chats-empty"
            className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center"
          >
            <MessageSquare size={16} aria-hidden className="text-subtle" />
            <span className="text-xs text-muted">
              No chats about this file yet.
            </span>
            <span className="text-[11px] text-subtle">
              {readOnly ? "This shared workspace is read-only." : "Start one."}
            </span>
          </div>
        ) : (
          <ul className="m-0 list-none p-0">
            {threadsState.threads.map((thread) => (
              <li key={thread.id} className="border-b border-line">
                <button
                  type="button"
                  data-testid="linked-chat-open"
                  data-thread-id={thread.id}
                  onClick={() => void openThread(thread)}
                  className="block w-full cursor-pointer px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                >
                  <span className="block truncate text-[12px] font-medium text-ink">
                    {thread.title}
                  </span>
                  <span className="block text-[10px] text-subtle">
                    {formatChatTime(thread.updatedAtMs).label}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="shrink-0 border-t border-line p-2">
        {readOnly ? (
          <p
            data-testid="linked-chat-readonly-note"
            className="m-0 px-1 text-[11px] leading-4 text-subtle"
          >
            This shared workspace is read-only. You can still read its chats.
          </p>
        ) : threadsState.fileObjectId === null ? (
          <p className="m-0 px-1 text-[11px] leading-4 text-subtle">
            Chats aren't available for this file yet — only text files dohc
            tracks can have Chats.
          </p>
        ) : creating === null ? (
          <button
            type="button"
            data-testid="linked-chat-new"
            onClick={() => setCreating(basename(filePath))}
            className="flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-line text-[11px] text-muted hover:bg-line/50 hover:text-ink"
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
              className="h-7 w-full rounded-md border border-line bg-bg px-2 text-[13px] text-ink placeholder:text-subtle focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
            />
            <p className="mb-0 mt-1 px-1 text-[10px] leading-4 text-subtle">
              Press Enter to start the chat.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
