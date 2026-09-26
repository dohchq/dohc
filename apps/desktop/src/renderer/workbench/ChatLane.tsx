import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatChannelRecord,
  ChatDecisionRecord,
  ChatMessageRecord,
  ChatReactionRecord,
} from "../../ipc/bridgeContract";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import type { WorkspaceHeadingRecord } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { extractChatFileReferences } from "./chatFileMentions";
import { ChatMessageList, runReactionToggle, type ChatMessageListHandle, type ChatReactionControls } from "./chatMessages";
import { MentionComposer, type FileMentionCandidate } from "./MentionComposer";
import { DecisionStatus } from "./ChatPosts";
import { ComposerNotice } from "./ChatsControls";

type PaintedLane = {
  threadId: string;
  revision: number;
  messageCount: number;
  readState: "retry" | "pending" | "done";
};

// Within this distance of the end the reader is following the conversation.
// Matches the list's own maintain-at-end threshold.
const FOLLOW_THRESHOLD_PX = 40;

// A group's chat lane: one running conversation, kept out of the feed. The
// lane is the group's oldest chat-lane thread; the first message starts it.
// Every response is guarded by the mount token so a slow answer for a group
// the user left never repaints the one they opened.
export function ChatLane(props: {
  workspaceId: string;
  channel: ChatChannelRecord;
  locked: boolean;
  mentionCandidates: readonly MentionCandidate[];
  fileCandidates?: readonly FileMentionCandidate[];
  loadFileHeadings?: (path: string) => Promise<readonly WorkspaceHeadingRecord[]>;
  onOpenPath?: (path: string, headingAnchor?: string) => void;
  onError: (message: string, cause?: unknown) => void;
  onThreadRead?: () => void;
  // Bumped by the host when a thread starts.
  revision: number;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [reactions, setReactions] = useState<ChatReactionRecord[]>([]);
  const [decisions, setDecisions] = useState<ChatDecisionRecord[]>([]);
  const [viewerAuthorId, setViewerAuthorId] = useState("");
  const [loading, setLoading] = useState(true);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  // The first message the reader had not seen when the lane opened.
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState<string | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  // Messages the reader had seen when last at the end.
  const seenCount = useRef(0);
  const token = useRef(0);
  const loadSequence = useRef(0);
  const onThreadRead = useRef(props.onThreadRead);
  onThreadRead.current = props.onThreadRead;
  const reactionSeq = useRef(new Map<string, number>());
  const listRef = useRef<ChatMessageListHandle | null>(null);
  const paintedRevision = useRef<PaintedLane | null>(null);
  const { workspaceId, onError } = props;
  const channelId = props.channel.id;

  const markRead = useCallback((painted: PaintedLane) => {
    if (painted.readState !== "retry") return;
    const current = token.current;
    const isCurrent = () => current === token.current && paintedRevision.current === painted;
    painted.readState = "pending";
    void bridge().markChatThreadRead({
      workspaceId, threadId: painted.threadId, upToSequence: painted.messageCount,
    }).then(() => {
      if (!isCurrent()) return;
      painted.readState = "done";
      onThreadRead.current?.();
    }, () => {
      if (isCurrent()) painted.readState = "retry";
    });
  }, [workspaceId]);

  const load = useCallback(async (force = false) => {
    const current = token.current;
    const sequence = ++loadSequence.current;
    const isCurrent = () => current === token.current && sequence === loadSequence.current;
    try {
      const listed = await bridge().listChannelThreads({
        workspaceId,
        channelId,
        lane: "chat",
      });
      if (!isCurrent()) return;
      const lane = [...listed.threads].sort((left, right) =>
        left.createdAtMs - right.createdAtMs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      )[0];
      if (!lane) {
        paintedRevision.current = null;
        setThreadId(null);
        setMessages([]);
        setReactions([]);
        setDecisions([]);
        setLoading(false);
        return;
      }
      // Read the watermark before content so a concurrent write cannot be
      // remembered as painted until its content has actually been loaded.
      const { revision } = await bridge().getChatThreadRevision({ workspaceId, threadId: lane.id });
      if (!isCurrent()) return;
      if (!force && paintedRevision.current?.threadId === lane.id && paintedRevision.current.revision === revision) {
        markRead(paintedRevision.current);
        return;
      }
      const [page, reacted, polled] = await Promise.all([
        bridge().listChatMessages({ workspaceId, threadId: lane.id }),
        bridge().listChatReactions({ workspaceId, threadId: lane.id }),
        bridge().listChatThreadDecisions({ workspaceId, threadId: lane.id }),
      ]);
      if (!isCurrent()) return;
      if (paintedRevision.current?.threadId !== lane.id) {
        // Sequences are 1-based, so the read cursor indexes the first unread.
        const firstUnread = lane.unreadCount > 0 ? page.messages[lane.lastReadSequence] : undefined;
        setFirstUnreadMessageId(firstUnread?.id ?? null);
      }
      const painted: PaintedLane = { threadId: lane.id, revision, messageCount: page.messages.length, readState: "retry" };
      paintedRevision.current = painted;
      setThreadId(lane.id);
      setMessages(page.messages);
      setReactions(reacted.reactions);
      setDecisions(polled.decisions);
      setViewerAuthorId(reacted.viewerAuthorId);
      setLoading(false);
      markRead(painted);
    } catch (error) {
      if (!isCurrent()) return;
      setLoading(false);
      onError(ipcErrorMessage(error, "Could not load the chat."), error);
    }
  }, [channelId, markRead, onError, workspaceId]);

  useEffect(() => {
    setThreadId(null);
    setMessages([]);
    setReactions([]);
    setDecisions([]);
    setComposer("");
    setSending(false);
    setViewerAuthorId("");
    setFirstUnreadMessageId(null);
    setAtEnd(true);
    reactionSeq.current.clear();
    paintedRevision.current = null;
    setLoading(true);
    return () => { token.current += 1; };
  }, [channelId, workspaceId]);

  // Follow the reader's position so arrivals while reading history are
  // counted instead of pulling the view to the end.
  const hasList = !loading && messages.length > 0;
  useEffect(() => {
    const node = hasList ? listRef.current?.getScrollableNode() : null;
    if (!node) return;
    const onScroll = () => {
      setAtEnd(node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_THRESHOLD_PX);
    };
    onScroll();
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [hasList, channelId, workspaceId]);
  useEffect(() => {
    if (atEnd) seenCount.current = messages.length;
  }, [atEnd, messages.length]);
  const newCount = atEnd ? 0 : Math.max(0, messages.length - seenCount.current);

  useEffect(() => {
    void load();
    return () => { loadSequence.current += 1; };
  }, [load, props.revision]);

  useEffect(() => {
    let queued = false;
    let active = true;
    const unsubscribe = bridge().onWorkspaceActivity((event) => {
      if ((event.workspaceId !== undefined && event.workspaceId !== workspaceId) || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (active) void load();
      });
    });
    return () => { active = false; unsubscribe(); };
  }, [load, workspaceId]);

  const send = useCallback(async () => {
    const body = composer.trim();
    if (body.length === 0 || sending || loading || props.locked) return;
    const current = token.current;
    setSending(true);
    try {
      const references = extractChatFileReferences(body);
      if (threadId) {
        const result = await bridge().sendChatMessage({
          workspaceId,
          threadId,
          body,
          ...(references.length > 0 ? { fileReferences: references } : {}),
        });
        if (current !== token.current) return;
        loadSequence.current += 1;
        listRef.current?.scrollToEnd();
        setMessages((existing) => existing.some(message => message.id === result.message.id) ? existing : [...existing, result.message]);
      } else {
        const result = await bridge().startChannelThread({
          workspaceId,
          channelId,
          body,
          lane: "chat",
          ...(references.length > 0 ? { fileReferences: references } : {}),
        });
        if (current !== token.current) return;
        loadSequence.current += 1;
        listRef.current?.scrollToEnd();
        setThreadId(result.thread.id);
        setMessages([result.message]);
        setViewerAuthorId(result.viewerAuthorId);
      }
      setComposer("");
      void load(true);
    } catch (error) {
      if (current !== token.current) return;
      onError(ipcErrorMessage(error, "Could not send that message."), error);
    } finally {
      if (current === token.current) setSending(false);
    }
  }, [channelId, composer, load, loading, onError, props.locked, sending, threadId, workspaceId]);

  const chooseOption = useCallback(async (decision: ChatDecisionRecord, option: string) => {
    if (!threadId || sending || loading || props.locked) return;
    const current = token.current;
    setSending(true);
    try {
      const result = await bridge().sendChatMessage({ workspaceId, threadId, body: option });
      if (current !== token.current) return;
      loadSequence.current += 1;
      listRef.current?.scrollToEnd();
      setMessages(existing => existing.some(message => message.id === result.message.id) ? existing : [...existing, result.message]);
      const resolved = await bridge().resolveChatDecision({
        workspaceId, threadId, messageId: decision.messageId,
        resolvedByMessageId: result.message.id, chosenOption: option,
      });
      if (current !== token.current) return;
      loadSequence.current += 1;
      setDecisions(existing => existing.map(entry => entry.messageId === decision.messageId ? resolved.decision : entry));
    } catch (error) {
      if (current !== token.current) return;
      onError(ipcErrorMessage(error, "Could not answer that poll."), error);
    } finally {
      if (current === token.current) {
        setSending(false);
        void load(true);
      }
    }
  }, [threadId, sending, loading, props.locked, workspaceId, onError, load]);

  const reactionControls = useMemo<ChatReactionControls | undefined>(() => threadId
    ? {
        reactions,
        viewerAuthorId,
        readOnly: props.locked,
        onToggle: (input) =>
          runReactionToggle(
            {
              workspaceId,
              threadId,
              viewerAuthorId,
              liveToken: token,
              reactionSeq,
              setReactions,
              setViewerAuthorId,
              onError,
            },
            input,
          ),
      }
    : undefined, [threadId, reactions, viewerAuthorId, props.locked, workspaceId, onError]);

  const decisionsByMessage = useMemo(() => new Map(decisions.map(decision => [decision.messageId, decision])), [decisions]);
  const renderMessageFooter = useCallback((message: ChatMessageRecord) => {
    const decision = decisionsByMessage.get(message.id);
    return decision ? <DecisionStatus
      decision={decision}
      testIdPrefix="chats-lane"
      {...(!props.locked && !sending && decision.options?.length ? {
        onResolve: (option?: string) => { if (option) void chooseOption(decision, option); },
      } : {})}
    /> : null;
  }, [decisionsByMessage, props.locked, sending, chooseOption]);

  return (
    <div data-testid="chats-lane" className="flex min-h-0 flex-1 flex-col">
      <ChatMessageList
        testIdPrefix="chats-lane"
        messages={messages}
        loading={loading}
        emptyLabel={`No messages in #${props.channel.name} yet.`}
        key={`${workspaceId}:${channelId}`}
        listRef={listRef}
        mentionCandidates={props.mentionCandidates}
        onOpenPath={props.onOpenPath}
        reactionControls={reactionControls}
        renderMessageFooter={renderMessageFooter}
        firstUnreadMessageId={firstUnreadMessageId}
      />
      <span role="status" aria-live="polite" className="sr-only">
        {newCount > 0 ? `${newCount} ${newCount === 1 ? "new message" : "new messages"}` : ""}
      </span>
      {newCount > 0 ? (
        <div className="relative h-0">
          <button
            type="button"
            data-testid="chats-lane-new-messages"
            onClick={() => listRef.current?.scrollToEnd()}
            className="dohc-pop-in absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full border border-line bg-panel px-2.5 py-1 text-[11px] font-medium text-ink shadow-sm transition-colors hover:bg-panel-2 dohc-focus-visible"
          >
            <ArrowDown size={11} aria-hidden />
            <span className="tabular-nums">{newCount}</span>
            {newCount === 1 ? "new message" : "new messages"}
          </button>
        </div>
      ) : null}
      {props.locked ? (
        <ComposerNotice testId="chats-lane-readonly">
          This group is read-only for you.
        </ComposerNotice>
      ) : (
        <MentionComposer
          testIdPrefix="chats-lane"
          composerId="chats-lane-composer"
          value={composer}
          sending={sending || loading}
          placeholder={`Message #${props.channel.name}`}
          sendLabel="Send message"
          candidates={props.mentionCandidates}
          fileCandidates={props.fileCandidates}
          loadFileHeadings={props.loadFileHeadings}
          onChange={setComposer}
          onSend={() => void send()}
        />
      )}
    </div>
  );
}
