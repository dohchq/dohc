import { ArrowDown, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatChannelRecord,
  ChatDecisionRecord,
  ChatDispatchStateForThreadResult,
  ChatMessageRecord,
} from "../../ipc/bridgeContract";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import type { WorkspaceHeadingRecord } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { extractChatFileReferences } from "./chatFileMentions";
import { ChatMessageList, type ChatMessageListHandle, type ChatReactionControls } from "./chatMessages";
import { useReactions } from "./reactionStore";
import { MentionComposer, type FileMentionCandidate } from "./MentionComposer";
import { AGENT_OFFER_SPACE, useAgentOffer } from "./AgentOffer";
import { DecisionStatus } from "./ChatPosts";
import { ComposerNotice, DispatchAnnouncement, dispatchAnnouncement } from "./ChatsControls";
import { openPollChoices, pollChoicesToSend, type ComposerPollDraft } from "./chatPoll";
import type { AgentSetupSummary } from "./ChatsView";

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
  // What a picked agent's offer says. Only an agent DM's lane reads its
  // dispatch, to stop the agent's run.
  agentSetup?: AgentSetupSummary | null;
  // An agent DM's agent, by the name its row shows.
  agentName?: string;
  // A sent message asks an agent that Restricted Mode holds. The shell opens
  // main's trust dialog for the workspace named.
  onAgentWaitsForTrust?: (workspaceId: string) => void;
  workspacePath?: string;
  // An agent DM's unsent message and poll, kept with the tab's other drafts.
  draft?: {
    value: string;
    onChange: (value: string) => void;
    poll: ComposerPollDraft | null;
    onPollChange: (poll: ComposerPollDraft | null) => void;
  };
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [decisions, setDecisions] = useState<ChatDecisionRecord[]>([]);
  const reactions = useReactions();
  const [loading, setLoading] = useState(true);
  const [ownComposer, setOwnComposer] = useState("");
  const composer = props.draft?.value ?? ownComposer;
  const setComposer = props.draft?.onChange ?? setOwnComposer;
  const [ownPoll, setOwnPoll] = useState<ComposerPollDraft | null>(null);
  const poll = props.draft ? props.draft.poll : ownPoll;
  const setPoll = props.draft?.onPollChange ?? setOwnPoll;
  const [sending, setSending] = useState(false);
  const [dispatch, setDispatch] = useState<ChatDispatchStateForThreadResult | null>(null);
  const [stopping, setStopping] = useState(false);
  // The first message the reader had not seen when the lane opened.
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState<string | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  // Messages the reader had seen when last at the end.
  const seenCount = useRef(0);
  const token = useRef(0);
  const loadSequence = useRef(0);
  const onThreadRead = useRef(props.onThreadRead);
  onThreadRead.current = props.onThreadRead;
  const listRef = useRef<ChatMessageListHandle | null>(null);
  const paintedRevision = useRef<PaintedLane | null>(null);
  const { workspaceId, onError } = props;
  const channelId = props.channel.id;
  const agentDm = props.channel.kind === "agent";
  const agentOffer = useAgentOffer({
    workspaceId, scope: `${workspaceId}:lane:${channelId}`, setup: props.agentSetup, dispatch: null, reach: props.workspacePath,
  });

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
        setDecisions([]);
        setDispatch(null);
        setLoading(false);
        return;
      }
      // Read the watermark before content so a concurrent write cannot be
      // remembered as painted until its content has actually been loaded.
      // A run can start or end without a new message, so the dispatch is
      // read on every pass. Without it the lane shows no Stop, not no chat.
      const [{ revision }, nextDispatch] = await Promise.all([
        bridge().getChatThreadRevision({ workspaceId, threadId: lane.id }),
        agentDm ? bridge().chatDispatchStateForThread({ workspaceId, threadId: lane.id }).catch(() => null) : null,
      ]);
      if (!isCurrent()) return;
      setDispatch(nextDispatch);
      if (!force && paintedRevision.current?.threadId === lane.id && paintedRevision.current.revision === revision) {
        markRead(paintedRevision.current);
        return;
      }
      const ticket = reactions.ticket();
      const [page, reacted, polled] = await Promise.all([
        bridge().listChatMessages({ workspaceId, threadId: lane.id }),
        bridge().listChatReactions({ workspaceId, threadId: lane.id }),
        bridge().listChatThreadDecisions({ workspaceId, threadId: lane.id }),
      ]);
      reactions.ingest([{ threadId: lane.id, ...reacted, ticket }]);
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
      setDecisions(polled.decisions);
      setLoading(false);
      markRead(painted);
    } catch (error) {
      if (!isCurrent()) return;
      setLoading(false);
      onError(ipcErrorMessage(error, "Could not load the chat."), error);
    }
  }, [agentDm, channelId, markRead, onError, reactions, workspaceId]);

  useEffect(() => {
    setThreadId(null);
    setMessages([]);
    setDecisions([]);
    setOwnComposer("");
    setOwnPoll(null);
    setSending(false);
    setDispatch(null);
    setStopping(false);
    setFirstUnreadMessageId(null);
    setAtEnd(true);
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
    const asked = openPollChoices(poll);
    const options = asked ? pollChoicesToSend(asked) : null;
    if (asked && !options) return;
    const asks = options ? { needsDecision: true, options } : {};
    const current = token.current;
    setSending(true);
    try {
      const references = extractChatFileReferences(body);
      if (threadId) {
        const result = await bridge().sendChatMessage({
          workspaceId,
          threadId,
          body,
          ...asks,
          ...(references.length > 0 ? { fileReferences: references } : {}),
        });
        if (current !== token.current) return;
        if (result.waitsForTrust) props.onAgentWaitsForTrust?.(workspaceId);
        loadSequence.current += 1;
        listRef.current?.scrollToEnd();
        setMessages((existing) => existing.some(message => message.id === result.message.id) ? existing : [...existing, result.message]);
      } else {
        const ticket = reactions.ticket();
        const result = await bridge().startChannelThread({
          workspaceId,
          channelId,
          body,
          ...asks,
          lane: "chat",
          ...(references.length > 0 ? { fileReferences: references } : {}),
        });
        // The new message has no reactions yet; the start names the viewer.
        reactions.ingest([{
          threadId: result.thread.id,
          messageIds: [result.message.id],
          reactions: [],
          viewerAuthorId: result.viewerAuthorId,
          ticket,
        }]);
        if (current !== token.current) return;
        if (result.waitsForTrust) props.onAgentWaitsForTrust?.(workspaceId);
        loadSequence.current += 1;
        listRef.current?.scrollToEnd();
        setThreadId(result.thread.id);
        setMessages([result.message]);
      }
      setComposer("");
      setPoll(null);
      void load(true);
    } catch (error) {
      if (current !== token.current) return;
      onError(ipcErrorMessage(error, "Could not send that message."), error);
    } finally {
      if (current === token.current) setSending(false);
    }
  }, [channelId, composer, load, loading, onError, poll, props.locked, props.onAgentWaitsForTrust, reactions, sending, threadId, workspaceId]);

  const chooseOption = useCallback(async (decision: ChatDecisionRecord, option: string) => {
    if (!threadId || sending || loading || props.locked) return;
    const current = token.current;
    setSending(true);
    try {
      const result = await bridge().sendChatMessage({
        workspaceId, threadId, body: option,
        resolves: { messageId: decision.messageId, chosenOption: option },
      });
      if (current !== token.current) return;
      if (result.waitsForTrust) props.onAgentWaitsForTrust?.(workspaceId);
      loadSequence.current += 1;
      listRef.current?.scrollToEnd();
      setMessages(existing => existing.some(message => message.id === result.message.id) ? existing : [...existing, result.message]);
      const resolved = result.resolved;
      if (resolved) setDecisions(existing => existing.map(entry => entry.messageId === decision.messageId ? resolved : entry));
      if (result.resolveFailure) onError(ipcErrorMessage(result.resolveFailure, "Could not answer that poll."), result.resolveFailure);
    } catch (error) {
      if (current !== token.current) return;
      onError(ipcErrorMessage(error, "Could not answer that poll."), error);
    } finally {
      if (current === token.current) {
        setSending(false);
        void load(true);
      }
    }
  }, [threadId, sending, loading, props.locked, props.onAgentWaitsForTrust, workspaceId, onError, load]);

  const liveRunId = dispatch?.liveRunId ?? null;
  const stopRun = useCallback(async () => {
    if (liveRunId === null || stopping) return;
    const current = token.current;
    setStopping(true);
    try {
      await bridge().stopAgentRun({ workspaceId, runId: liveRunId });
      if (current === token.current) void load();
    } catch (error) {
      if (current === token.current) onError(ipcErrorMessage(error, "Could not stop this agent run."), error);
    } finally {
      if (current === token.current) setStopping(false);
    }
  }, [liveRunId, load, onError, stopping, workspaceId]);

  const threadReactions = threadId ? reactions.view(threadId) : null;
  const reactionControls = useMemo<ChatReactionControls | undefined>(() => threadId && threadReactions
    ? {
        reactions: threadReactions.reactions,
        viewerAuthorId: threadReactions.viewerAuthorId,
        readOnly: props.locked,
        onToggle: (input) => {
          if (!threadReactions.viewerAuthorId) return;
          const current = token.current;
          reactions.toggle({
            ...input,
            threadId,
            viewerAuthorId: threadReactions.viewerAuthorId,
            onError: (message, cause) => {
              if (current === token.current) onError(message, cause);
            },
          });
        },
      }
    : undefined, [threadId, threadReactions, props.locked, reactions, onError]);

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
      {dispatch && liveRunId !== null ? (
        <div
          data-testid="chats-lane-dispatch-status"
          className="flex h-7 shrink-0 items-center justify-center gap-2 border-b border-line bg-panel-2/35 px-3 text-[10px] tabular-nums text-subtle"
        >
          <span>agent working{dispatch.pendingCount > 0 ? ` · ${dispatch.pendingCount} queued` : ""}</span>
          {!props.locked ? (
            <button
              type="button"
              data-testid="chats-lane-stop-agent-run"
              aria-label="Stop agent run"
              title="Stop agent run"
              disabled={stopping}
              onClick={() => void stopRun()}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-line px-1.5 text-[10px] text-muted hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-50"
            >
              <Square size={8} fill="currentColor" aria-hidden />
              Stop
            </button>
          ) : null}
        </div>
      ) : null}
      <DispatchAnnouncement
        testId="chats-lane-dispatch-announcement"
        text={dispatch && liveRunId !== null ? dispatchAnnouncement(true, dispatch.pendingCount) : ""}
      />
      <ChatMessageList
        testIdPrefix="chats-lane"
        messages={messages}
        loading={loading}
        emptyLabel={props.channel.kind === "agent" ? "No messages yet." : `No messages in #${props.channel.name} yet.`}
        key={`${workspaceId}:${channelId}`}
        listRef={listRef}
        mentionCandidates={props.mentionCandidates}
        onOpenPath={props.onOpenPath}
        reactionControls={reactionControls}
        renderMessageFooter={renderMessageFooter}
        firstUnreadMessageId={firstUnreadMessageId}
        bottomSpace={AGENT_OFFER_SPACE}
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
            className="dohc-pop-in absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full border border-line bg-panel px-2.5 py-1 text-[11px] font-medium text-ink shadow-sm transition-colors hover:bg-line"
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
          sending={sending}
          disabled={loading}
          placeholder={props.channel.kind !== "agent" ? `Message #${props.channel.name}`
            // The input cuts a long name.
            : props.agentName ? `Message ${props.agentName}…` : "Message your agent…"}
          sendLabel="Send message"
          candidates={props.mentionCandidates}
          fileCandidates={props.fileCandidates}
          loadFileHeadings={props.loadFileHeadings}
          onChange={setComposer}
          poll={poll}
          onPollChange={setPoll}
          onSend={() => void send()}
          onRosterPick={agentOffer.onRosterPick}
          rosterScope={agentOffer.scope}
          agentOffer={agentOffer.offer}
        />
      )}
    </div>
  );
}
