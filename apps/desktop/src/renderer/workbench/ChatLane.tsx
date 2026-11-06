import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ActorPresentation,
  ChatChannelRecord,
  ChatDecisionRecord,
  ChatRunRecord,
  ChatDispatchStateForThreadResult,
  ChatMessageRecord,
} from "../../ipc/bridgeContract";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import type { WorkspaceHeadingRecord } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { withErrorWords } from "../../ipc/errorWords";
import { extractChatFileReferences } from "./chatFileMentions";
import type { ChatMessageListHandle, ChatReactionControls } from "./chatMessages";
import { FailedRunLine, failedRunEnd, type ChatWorking } from "./ChatThreadPanel";
import { ThreadedChat } from "./ThreadedChat";
import { useReactions } from "./reactionStore";
import { MentionComposer, type FileMentionCandidate } from "./MentionComposer";
import { AGENT_OFFER_SPACE, useAgentOffer } from "./AgentOffer";
import { DecisionStatus } from "./ChatPosts";
import { COLLECTION_CHANGE_FILE } from "../collections/collectionChangeFlow";
import { CollectionChangeCard } from "./CollectionChangeCard";
import { ComposerNotice, DispatchAnnouncement, dispatchAnnouncement } from "./ChatsControls";
import { openPollChoices, pollChoicesToSend, type ComposerPollDraft } from "./chatPoll";
import type { AgentSetupSummary } from "./ChatsView";
import { focusMessage, TARGET_FLASH_MS } from "./landOnMessage";

// The change to a Collection's rules a message asks a person to apply.
const changeFileOf = (message: ChatMessageRecord) =>
  message.attachments?.find((attachment) => attachment.pathHint !== undefined && COLLECTION_CHANGE_FILE.test(attachment.pathHint))?.pathHint;

type PaintedLane = {
  threadId: string | null;
  revision: number;
  // An agent DM's earlier posts, by id, last change and size.
  postsKey: string;
  // A run ends without a new message, so its details repaint when the run changes.
  liveRunId: string | null;
  messageCount: number;
  readState: "retry" | "pending" | "done";
};

// An agent DM's posts from before it was one conversation. Each post's first
// message joins the stream, and the rest of the post is its thread.
function postAsThread(messages: readonly ChatMessageRecord[]): ChatMessageRecord[] {
  const first = messages[0];
  if (!first) return [];
  return messages.map((message, at) => (at === 0 || message.parentMessageId ? message : { ...message, parentMessageId: first.id }));
}

// A conversation: a group's chat lane or an agent DM. The lane is the
// group's oldest chat-lane thread; the first message starts it. Any message
// can start a thread, which opens beside the conversation. Every response is
// guarded by the mount token so a slow answer for a group the user left
// never repaints the one they opened.
export function ChatLane(props: {
  workspaceId: string;
  channel: ChatChannelRecord;
  locked: boolean;
  mentionCandidates: readonly MentionCandidate[];
  fileCandidates?: readonly FileMentionCandidate[];
  loadFileHeadings?: (path: string) => Promise<readonly WorkspaceHeadingRecord[]>;
  onOpenPath?: (path: string, headingAnchor?: string) => void;
  onError: (message: string, cause?: unknown, retry?: () => void) => void;
  onThreadRead?: () => void;
  // Bumped by the host when a thread starts.
  revision: number;
  // What a picked agent's offer says. Only an agent DM's lane reads its
  // dispatch, to show and stop the agent's run.
  agentSetup?: AgentSetupSummary | null;
  // An agent DM's agent, by the name and colors its row shows.
  agentName?: string;
  agentPresentation?: ActorPresentation;
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
  // Over the conversation: its header and any banners. A thread opened beside
  // it runs the full height next to them.
  header?: ReactNode;
  // One line over the composer when something stops the agent answering,
  // with the action that fixes it.
  notice?: ReactNode;
  // A message to land on once it loads, such as the reply a notice named.
  // One the lane does not hold leaves it at its end.
  focusMessageId?: string;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [postThreadIds, setPostThreadIds] = useState<readonly string[]>([]);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [decisions, setDecisions] = useState<ChatDecisionRecord[]>([]);
  const [runs, setRuns] = useState<Readonly<Record<string, ChatRunRecord>>>({});
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
  const token = useRef(0);
  const loadSequence = useRef(0);
  const onThreadRead = useRef(props.onThreadRead);
  onThreadRead.current = props.onThreadRead;
  const listRef = useRef<ChatMessageListHandle | null>(null);
  const paintedRevision = useRef<PaintedLane | null>(null);
  const { workspaceId, onError, focusMessageId } = props;
  const channelId = props.channel.id;
  // Lands once per message asked for: scrolls to it, washes it and moves
  // focus to it.
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null);
  const landed = useRef<string | null>(null);
  const flashTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  const agentDm = props.channel.kind === "agent";
  const agentOffer = useAgentOffer({
    workspaceId, scope: `${workspaceId}:lane:${channelId}`, setup: props.agentSetup, dispatch: null, reach: props.workspacePath,
  });

  const markRead = useCallback((painted: PaintedLane) => {
    const laneId = painted.threadId;
    if (painted.readState !== "retry" || laneId === null) return;
    const current = token.current;
    const isCurrent = () => current === token.current && paintedRevision.current === painted;
    painted.readState = "pending";
    void bridge().markChatThreadRead({
      workspaceId, threadId: laneId, upToSequence: painted.messageCount,
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
      const [listed, listedPosts] = await Promise.all([
        bridge().listChannelThreads({ workspaceId, channelId, lane: "chat" }),
        agentDm ? bridge().listChannelThreads({ workspaceId, channelId, lane: "posts" }) : null,
      ]);
      if (!isCurrent()) return;
      const lane = [...listed.threads].sort((left, right) =>
        left.createdAtMs - right.createdAtMs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      )[0];
      const posts = listedPosts?.threads ?? [];
      const postsKey = posts.map((post) => `${post.id}:${post.updatedAtMs}:${post.messageCount}`).join("|");
      if (!lane && posts.length === 0) {
        paintedRevision.current = null;
        setThreadId(null);
        setMessages([]);
        setDecisions([]);
        setRuns({});
        setDispatch(null);
        setLoading(false);
        return;
      }
      // Read the watermark before content so a concurrent write cannot be
      // remembered as painted until its content has actually been loaded.
      // A run can start or end without a new message, so the dispatch is
      // read on every pass. Without it the lane shows no Stop, not no chat.
      const laneId = lane?.id ?? null;
      const [revision, nextDispatch] = await Promise.all([
        laneId ? bridge().getChatThreadRevision({ workspaceId, threadId: laneId }).then((read) => read.revision) : 0,
        agentDm && laneId ? bridge().chatDispatchStateForThread({ workspaceId, threadId: laneId }).catch(() => null) : null,
      ]);
      if (!isCurrent()) return;
      setDispatch(nextDispatch);
      const nextRunId = nextDispatch?.liveRunId ?? null;
      const painted = paintedRevision.current;
      if (!force && painted?.threadId === laneId && painted.revision === revision && painted.postsKey === postsKey && painted.liveRunId === nextRunId) {
        markRead(painted);
        return;
      }
      const ticket = reactions.ticket();
      const readThread = async (id: string) => {
        const [page, reacted, polled, ran] = await Promise.all([
          bridge().listChatMessages({ workspaceId, threadId: id }),
          bridge().listChatReactions({ workspaceId, threadId: id }),
          bridge().listChatThreadDecisions({ workspaceId, threadId: id }),
          // Only an agent's replies have runs. Without them the chat still shows.
          agentDm ? bridge().chatRunRecordsForThread({ workspaceId, threadId: id }).catch(() => null) : null,
        ]);
        return { id, messages: page.messages, reacted, decisions: polled.decisions, runs: ran?.runs ?? {} };
      };
      const [laneRead, ...postReads] = await Promise.all([
        laneId ? readThread(laneId) : null,
        ...posts.map((post) => readThread(post.id)),
      ]);
      const reads = laneRead ? [laneRead, ...postReads] : postReads;
      reactions.ingest(reads.map((read) => ({ threadId: read.id, ...read.reacted, ticket })));
      if (!isCurrent()) return;
      const laneMessages = laneRead?.messages ?? [];
      if (lane && paintedRevision.current?.threadId !== lane.id) {
        // Sequences are 1-based, so the read cursor indexes the first unread.
        const firstUnread = lane.unreadCount > 0 ? laneMessages[lane.lastReadSequence] : undefined;
        setFirstUnreadMessageId(firstUnread?.id ?? null);
      }
      const next: PaintedLane = { threadId: laneId, revision, postsKey, liveRunId: nextRunId, messageCount: laneMessages.length, readState: "retry" };
      paintedRevision.current = next;
      setThreadId(laneId);
      setPostThreadIds(posts.map((post) => post.id));
      setMessages([...postReads.flatMap((read) => postAsThread(read.messages)), ...laneMessages]
        .sort((left, right) => left.createdAtMs - right.createdAtMs));
      setDecisions(reads.flatMap((read) => read.decisions));
      setRuns(Object.assign({}, ...reads.map((read) => read.runs)));
      setLoading(false);
      markRead(next);
      // A post shown here is read: there's nowhere else to open it.
      posts.forEach((post, at) => {
        const read = postReads[at];
        if (post.unreadCount === 0 || !read) return;
        void bridge().markChatThreadRead({ workspaceId, threadId: post.id, upToSequence: read.messages.length })
          .then(() => { if (isCurrent()) onThreadRead.current?.(); }, () => {});
      });
    } catch (error) {
      if (!isCurrent()) return;
      setLoading(false);
      onError(ipcErrorMessage(error, "Could not load the chat."), error);
    }
  }, [agentDm, channelId, markRead, onError, reactions, workspaceId]);

  useEffect(() => {
    setThreadId(null);
    setPostThreadIds([]);
    setMessages([]);
    setDecisions([]);
    setRuns({});
    setOwnComposer("");
    setOwnPoll(null);
    setSending(false);
    setDispatch(null);
    setStopping(false);
    setRetrying(false);
    setFirstUnreadMessageId(null);
    paintedRevision.current = null;
    setLoading(true);
    return () => { token.current += 1; };
  }, [channelId, workspaceId]);

  useEffect(() => {
    void load();
    return () => { loadSequence.current += 1; };
  }, [load, props.revision]);

  useEffect(() => {
    if (focusMessageId === undefined || loading || !messages.some((message) => message.id === focusMessageId)) return;
    const key = `${channelId}:${focusMessageId}`;
    if (landed.current === key) return;
    const frame = requestAnimationFrame(() => {
      if (landed.current === key || !listRef.current?.scrollToMessage(focusMessageId)) return;
      landed.current = key;
      setFlashMessageId(focusMessageId);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlashMessageId(null), TARGET_FLASH_MS);
    });
    return () => cancelAnimationFrame(frame);
  }, [channelId, focusMessageId, loading, messages]);
  // A row the list mounts for the scroll paints a frame later.
  useEffect(() => {
    if (flashMessageId === null) return;
    const frame = requestAnimationFrame(() => focusMessage(document, flashMessageId));
    return () => cancelAnimationFrame(frame);
  }, [flashMessageId]);

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

  // A reply goes under the message the thread hangs from. A reply to an
  // earlier post goes on in that post. A reply after Answer answers its question.
  const sendReply = useCallback(async (rootId: string, body: string, answers?: string) => {
    const post = messages.find((message) => message.id === rootId && message.threadId !== threadId)?.threadId;
    const target = post ?? threadId;
    if (!target || props.locked) return false;
    const current = token.current;
    try {
      const references = extractChatFileReferences(body);
      const result = await bridge().sendChatMessage({
        workspaceId,
        threadId: target,
        body,
        ...(post ? {} : { parentMessageId: rootId }),
        ...(references.length > 0 ? { fileReferences: references } : {}),
        ...(answers ? { resolves: { messageId: answers } } : {}),
      });
      if (current !== token.current) return false;
      if (result.waitsForTrust) props.onAgentWaitsForTrust?.(workspaceId);
      loadSequence.current += 1;
      const reply = post ? { ...result.message, parentMessageId: rootId } : result.message;
      setMessages((existing) => existing.some(message => message.id === reply.id) ? existing : [...existing, reply]);
      const resolved = result.resolved;
      if (resolved) setDecisions(existing => existing.map(entry => entry.messageId === resolved.messageId ? resolved : entry));
      if (result.resolveFailure) onError("Sent your reply. dohc could not mark the question answered.", result.resolveFailure);
      void load(true);
      return true;
    } catch (error) {
      if (current === token.current) onError(ipcErrorMessage(error, "Could not send that reply."), error);
      return false;
    }
  }, [load, messages, onError, props.locked, props.onAgentWaitsForTrust, threadId, workspaceId]);

  const chooseOption = useCallback(async (decision: ChatDecisionRecord, option: string) => {
    // The answer goes where the poll is: its thread, or its earlier post.
    const asked = messages.find((message) => message.id === decision.messageId);
    const post = asked && asked.threadId !== threadId ? asked.threadId : undefined;
    const target = post ?? threadId;
    if (!target || sending || loading || props.locked) return;
    const parentMessageId = post ? undefined : asked?.parentMessageId;
    const current = token.current;
    const input = {
      workspaceId, threadId: target, body: option,
      ...(parentMessageId ? { parentMessageId } : {}),
      resolves: { messageId: decision.messageId, chosenOption: option },
    };
    const stayedOpen = (failure: unknown) => onError("Sent your choice. dohc could not mark the question answered.", failure);
    setSending(true);
    try {
      const result = await bridge().sendChatMessage(input);
      if (current !== token.current) return;
      if (result.waitsForTrust) props.onAgentWaitsForTrust?.(workspaceId);
      loadSequence.current += 1;
      listRef.current?.scrollToEnd();
      setMessages(existing => existing.some(message => message.id === result.message.id) ? existing : [...existing, result.message]);
      const resolved = result.resolved;
      if (resolved) setDecisions(existing => existing.map(entry => entry.messageId === decision.messageId ? resolved : entry));
      if (result.resolveFailure) stayedOpen(result.resolveFailure);
    } catch (error) {
      if (current !== token.current) return;
      // A send can fail after main saved the choice, so sending it again could
      // post it twice, and the conversation reloads instead. A question that
      // now shows this choice answered needs no message.
      const now = await bridge().listChatThreadDecisions({ workspaceId, threadId: decision.threadId }).catch(() => null);
      if (current !== token.current) return;
      const landed = now?.decisions.some(entry =>
        entry.messageId === decision.messageId && entry.state === "resolved" && entry.chosenOption === option);
      if (!landed) onError("dohc could not tell whether your choice was sent.", error);
    } finally {
      if (current === token.current) {
        setSending(false);
        void load(true);
      }
    }
  }, [threadId, sending, loading, props.locked, props.onAgentWaitsForTrust, workspaceId, onError, load, messages]);

  // Applying or undoing a change answers in the change's own place, as the person who clicked.
  // Apply answers the message's question, attaching the change a review applied instead. Undo attaches the change file again.
  const replyToChange = useCallback(async (asked: ChatMessageRecord, path: string, input: { body: string; resolves: boolean; attach?: string }) => {
    const post = asked.threadId !== threadId ? asked.threadId : undefined;
    const target = post ?? threadId;
    if (!target) throw new Error("dohc couldn't find this chat.");
    const parentMessageId = post ? undefined : asked.parentMessageId;
    const current = token.current;
    const result = await bridge().sendChatMessage({
      workspaceId, threadId: target, body: input.body,
      ...(parentMessageId ? { parentMessageId } : {}),
      ...(input.resolves ? { resolves: { messageId: asked.id } } : {}),
      ...(input.attach || !input.resolves ? { fileReferences: [{ path: input.attach ?? path }] } : {}),
    });
    if (current !== token.current) return;
    loadSequence.current += 1;
    setMessages(existing => existing.some(message => message.id === result.message.id) ? existing : [...existing, result.message]);
    const resolved = result.resolved;
    if (resolved) setDecisions(existing => existing.map(entry => entry.messageId === asked.id ? resolved : entry));
    if (result.resolveFailure) onError(ipcErrorMessage(result.resolveFailure, "dohc couldn't mark this message answered."), result.resolveFailure);
    void load(true);
  }, [load, onError, threadId, workspaceId]);

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

  // Try again on a run a quit or restart stopped puts its request back in
  // line. The failure's own Try again only asks again: the run's update
  // refreshes the conversation.
  const failedRun = dispatch?.failedRun ?? null;
  const [retrying, setRetrying] = useState(false);
  const retryRun = useCallback(async () => {
    if (!failedRun?.retryable || retrying || threadId === null) return;
    const current = token.current;
    const input = { workspaceId, threadId, runId: failedRun.runId };
    const failed = (error: unknown) => withErrorWords(`dohc could not start ${props.agentName ?? "your agent"}'s run again.`, error);
    setRetrying(true);
    try {
      await bridge().retryStoppedRun(input);
      if (current === token.current) void load();
    } catch (error) {
      if (current !== token.current) return;
      const again = () => void bridge().retryStoppedRun(input)
        .catch((retryError: unknown) => onError(failed(retryError), retryError, again));
      onError(failed(error), error, again);
    } finally {
      if (current === token.current) setRetrying(false);
    }
  }, [failedRun, load, onError, props.agentName, retrying, threadId, workspaceId]);

  // The agent at work. Its answer lands in the thread it was asked in, or at
  // the end of the conversation.
  const working = useMemo<ChatWorking | null>(() => liveRunId === null ? null : {
    agentName: props.agentName ?? "Your agent",
    presentation: props.agentPresentation ?? { group: "", hue: null, self: false },
    stopping,
    ...(props.locked ? {} : { onStop: () => void stopRun() }),
  }, [liveRunId, props.agentName, props.agentPresentation, props.locked, stopping, stopRun]);
  // Reactions live with each message's own thread: the conversation's, or an
  // earlier post's.
  const reactionThreads = useMemo(() => (threadId ? [threadId, ...postThreadIds] : postThreadIds), [postThreadIds, threadId]);
  const reactionViews = reactionThreads.map((id) => reactions.view(id));
  const viewerAuthorId = reactionViews.find((view) => view.viewerAuthorId)?.viewerAuthorId ?? "";
  const reactionControls: ChatReactionControls | undefined = reactionViews.length > 0
    ? {
        // One thread keeps its list as it is, so rows only redraw on a change.
        reactions: reactionViews.length === 1 ? reactionViews[0]!.reactions : reactionViews.flatMap((view) => view.reactions),
        viewerAuthorId,
        readOnly: props.locked,
        onToggle: (input) => {
          const target = messages.find((message) => message.id === input.messageId)?.threadId;
          if (!viewerAuthorId || !target) return;
          const current = token.current;
          reactions.toggle({
            ...input,
            threadId: target,
            viewerAuthorId,
            onError: (message, cause) => {
              if (current === token.current) onError(message, cause);
            },
          });
        },
      }
    : undefined;

  const decisionsByMessage = useMemo(() => new Map(decisions.map(decision => [decision.messageId, decision])), [decisions]);
  const failedEnd = useMemo(() => failedRun ? failedRunEnd(failedRun, runs, messages) : null, [failedRun, messages, runs]);
  // Under a message: its question, and why the agent didn't answer it. A
  // choice answers at once. Answer starts a reply in the question's thread.
  const renderFooter = useCallback((message: ChatMessageRecord, answer: () => void) => {
    const decision = decisionsByMessage.get(message.id);
    const asked = decision ? changeFileOf(message) : undefined;
    const appliedBy = decision?.state === "resolved" ? messages.find((reply) => reply.id === decision.resolvedByMessageId) : undefined;
    // The change a review applied, when it wasn't the one asked.
    const changeFile = asked === undefined ? undefined : (appliedBy && changeFileOf(appliedBy)) ?? asked;
    const undoneBy = changeFile === undefined ? undefined : messages.filter((reply) => reply.id !== appliedBy?.id &&
      reply.createdAtMs > message.createdAtMs && reply.authorKind === "human" && changeFileOf(reply) === changeFile).at(-1);
    const resolve = props.locked ? undefined
      : !decision?.options?.length ? answer
        : sending ? undefined
          : (option?: string) => { if (option) void chooseOption(decision, option); };
    return <>
      {changeFile !== undefined ? <CollectionChangeCard
        key={`${workspaceId}:${message.id}:${asked}`}
        workspaceId={workspaceId}
        message={message}
        path={changeFile}
        appliedBy={appliedBy}
        undoneBy={undoneBy}
        locked={props.locked}
        onOpenPath={props.onOpenPath}
        onReply={(input) => replyToChange(message, changeFile, input)}
        onError={onError}
        testIdPrefix="chats-lane"
      /> : decision ? <DecisionStatus
        decision={decision}
        testIdPrefix="chats-lane"
        {...(resolve ? { onResolve: resolve } : {})}
      /> : null}
      {failedRun && message.id === failedEnd ? <FailedRunLine
        testIdPrefix="chats-lane"
        failed={failedRun}
        busy={retrying}
        className="mt-1"
        {...(failedRun.retryable && !props.locked ? { onRetry: () => void retryRun() } : {})}
      /> : null}
    </>;
  }, [decisionsByMessage, messages, workspaceId, props.locked, props.onOpenPath, onError, replyToChange, sending, chooseOption, failedRun, failedEnd, retrying, retryRun]);
  const place = agentDm ? props.agentName ?? "Your agent" : `# ${props.channel.name}`;

  return (
    <ThreadedChat
      key={`${workspaceId}:${channelId}`}
      testIdPrefix="chats-lane"
      chatId={threadId}
      messages={messages}
      runs={runs}
      loading={loading}
      emptyLabel={agentDm ? "No messages yet." : `No messages in #${props.channel.name} yet.`}
      place={place}
      header={(
        <>
          {props.header}
          <DispatchAnnouncement
            testId="chats-lane-dispatch-announcement"
            text={dispatch && liveRunId !== null ? dispatchAnnouncement(true, dispatch.pendingCount) : ""}
          />
        </>
      )}
      notice={props.notice}
      composer={(inset) => props.locked ? (
        <ComposerNotice testId="chats-lane-readonly">
          This group is read-only for you.
        </ComposerNotice>
      ) : (
        <MentionComposer
          pinned
          testIdPrefix="chats-lane"
          composerId="chats-lane-composer"
          value={composer}
          sending={sending}
          disabled={loading}
          placeholder={agentDm ? `Message ${props.agentName ?? "your agent"}` : `Message #${props.channel.name}`}
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
          inset={inset}
        />
      )}
      replyNotice={props.locked ? (
        <ComposerNotice testId="chats-lane-thread-readonly">
          This group is read-only for you.
        </ComposerNotice>
      ) : undefined}
      onSendReply={sendReply}
      mentionCandidates={props.mentionCandidates}
      fileCandidates={props.fileCandidates}
      loadFileHeadings={props.loadFileHeadings}
      onOpenPath={props.onOpenPath}
      reactionControls={reactionControls}
      renderMessageFooter={renderFooter}
      working={working}
      workingMessageId={dispatch?.liveTriggerMessageId ?? null}
      listRef={listRef}
      firstUnreadMessageId={firstUnreadMessageId}
      flashMessageId={flashMessageId}
      bottomSpace={AGENT_OFFER_SPACE}
    />
  );
}
