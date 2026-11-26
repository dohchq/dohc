import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ActorPresentation,
  ChatChannelRecord,
  ChatDecisionRecord,
  ChatRunRecord,
  ChatDispatchStateForThreadResult,
  ChatMessageRecord,
} from "../../ipc/bridgeContract";
import {
  extractChatFileReferences,
  type MentionCandidate,
} from "@dohc/workspace-contracts/chat-mentions";
import {
  CHAT_DISPATCH_POST_THREADS_MAX,
  type WorkspaceHeadingRecord,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { withErrorWords } from "../../ipc/errorWords";
import type { ChatMessageListHandle, ChatReactionControls } from "./chatMessages";
import { FailedRunLine, failedRunEnd, WaitingLine, type ChatWorking } from "./ChatThreadPanel";
import { isWorkspaceGroup } from "@dohc/security-contract/chat-wire-ids";
import { ThreadedChat } from "./ThreadedChat";
import { useMessageDelete } from "./messageDelete";
import { useReactions } from "./reactionStore";
import {
  MentionComposer,
  type AddMessageFiles,
  type FileMentionCandidate,
  type MentionComposerHandle,
} from "./MentionComposer";
import { agentMentionId } from "../../settings/userSettings";
import { useAgentOffer } from "./AgentOffer";
import { AgentThreadLines } from "./AgentThreadLines";
import { DecisionStatus } from "./ChatPosts";
import { COLLECTION_CHANGE_FILE } from "../collections/collectionChangeFlow";
import { CollectionChangeCard } from "./CollectionChangeCard";
import { ComposerNotice, DispatchAnnouncement, dispatchAnnouncement } from "./ChatsControls";
import { openPollChoices, pollChoicesToSend, type ComposerPollDraft } from "./chatPoll";
import type { AgentSetupSummary } from "./ChatsView";
import { agentChatIdentity, type SettingsAgent } from "./agentChat";
import { focusMessage, TARGET_FLASH_MS } from "./landOnMessage";
import { WorkStatus } from "./WorkCard";
import { neutralPresentation } from "./actorPresentation";
import { compareMessageOrder } from "@dohc/workspace-contracts/chat-order";

// The change to a Collection's rules a message asks a person to apply.
const changeFileOf = (message: ChatMessageRecord) =>
  message.attachments?.find(
    (attachment) =>
      attachment.pathHint !== undefined && COLLECTION_CHANGE_FILE.test(attachment.pathHint),
  )?.pathHint;

type PaintedLane = {
  // The conversation's threads, oldest first.
  laneIds: string;
  // Each one's revision.
  revisions: string;
  // An agent DM's earlier posts, by id, last change and size.
  postsKey: string;
  // A run ends without a new message, so its details repaint when the run changes.
  liveRunId: string | null;
  // How many messages each conversation thread held when painted, to mark read.
  read: readonly { threadId: string; messageCount: number }[];
  readState: "retry" | "pending" | "done";
};

const byAge = (
  left: { createdAtMs: number; id: string },
  right: { createdAtMs: number; id: string },
) => left.createdAtMs - right.createdAtMs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

function postAsThread(messages: readonly ChatMessageRecord[]): ChatMessageRecord[] {
  const first = messages[0];
  if (!first) return [];
  return messages.map((message, at) =>
    at === 0 || message.parentMessageId ? message : { ...message, parentMessageId: first.id },
  );
}

// A conversation: a group's chat lane or an agent DM. The lane shows every
// chat-lane thread of the group, since two devices can each start one before
// they sync; a new message goes on in the oldest. The first message starts
// it. Any message can start a thread, which opens beside the conversation.
// Every response is guarded by the mount token so a slow answer for a group
// the user left never repaints the one they opened.
export function ChatLane(props: {
  workspaceId: string;
  channel: ChatChannelRecord;
  locked: boolean;
  // Why, in place of the composer, when locked.
  lockedLine?: string;
  mentionCandidates: readonly MentionCandidate[];
  fileCandidates?: readonly FileMentionCandidate[];
  onAddFiles?: AddMessageFiles;
  loadFileHeadings?: (path: string) => Promise<readonly WorkspaceHeadingRecord[]>;
  onOpenPath?: (path: string, headingAnchor?: string) => void;
  onError: (message: string, cause?: unknown, retry?: () => void) => void;
  // What a change card's Apply or Undo did, when it finishes after the chat closed.
  onNotice?: (message: string) => void;
  onThreadRead?: () => void;
  // Opens Settings at Agents, from a failed run whose agent is gone.
  onOpenAgentSettings?: () => void;
  // Bumped by the host when a thread starts.
  revision: number;
  // What a picked agent's offer says.
  agentSetup?: AgentSetupSummary | null;
  // The agents in Settings, to name and color the one at work here.
  agents?: readonly SettingsAgent[];
  // An agent DM's agent, by the name and colors its row shows.
  agentName?: string;
  agentPresentation?: ActorPresentation;
  // Agent replies are paused on this computer, which holds each request
  // instead of the busy agent.
  dispatchPaused?: boolean;
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
  // The conversation's threads, oldest first. A new message goes in the first.
  const [laneIds, setLaneIds] = useState<readonly string[]>([]);
  const threadId = laneIds[0] ?? null;
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
  const composerHandle = useRef<MentionComposerHandle>(null);
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
  const chatAgentId = agentDm ? props.channel.agentId : undefined;
  const agentOffer = useAgentOffer({
    workspaceId,
    scope: `${workspaceId}:lane:${channelId}`,
    setup: props.agentSetup,
    dispatch: null,
    reach: props.workspacePath,
  });

  const markRead = useCallback(
    (painted: PaintedLane) => {
      if (painted.readState !== "retry" || painted.read.length === 0) return;
      const current = token.current;
      const isCurrent = () => current === token.current && paintedRevision.current === painted;
      painted.readState = "pending";
      void Promise.all(
        painted.read.map((read) =>
          bridge().markChatThreadRead({
            workspaceId,
            threadId: read.threadId,
            upToSequence: read.messageCount,
          }),
        ),
      ).then(
        () => {
          if (!isCurrent()) return;
          painted.readState = "done";
          onThreadRead.current?.();
        },
        () => {
          if (isCurrent()) painted.readState = "retry";
        },
      );
    },
    [workspaceId],
  );

  const load = useCallback(
    async (force = false) => {
      const current = token.current;
      const sequence = ++loadSequence.current;
      const isCurrent = () => current === token.current && sequence === loadSequence.current;
      try {
        const [listed, listedPosts] = await Promise.all([
          bridge().listChannelThreads({ workspaceId, channelId, lane: "chat" }),
          agentDm ? bridge().listChannelThreads({ workspaceId, channelId, lane: "posts" }) : null,
        ]);
        if (!isCurrent()) return;
        const lane = [...listed.threads].sort(byAge);
        const nextLaneIds = lane.map((each) => each.id);
        const laneKey = nextLaneIds.join("|");
        const posts = listedPosts?.threads ?? [];
        const postsKey = posts
          .map((post) => `${post.id}:${post.updatedAtMs}:${post.messageCount}`)
          .join("|");
        if (lane.length === 0 && posts.length === 0) {
          paintedRevision.current = null;
          setLaneIds([]);
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
        // A reply to an earlier post can wait for the agent too, so the one
        // read covers the posts.
        const postIds = posts.slice(0, CHAT_DISPATCH_POST_THREADS_MAX).map((post) => post.id);
        const laneRest = nextLaneIds.slice(1, CHAT_DISPATCH_POST_THREADS_MAX + 1);
        const [revisionList, nextDispatch] = await Promise.all([
          Promise.all(
            nextLaneIds.map((id) =>
              bridge()
                .getChatThreadRevision({ workspaceId, threadId: id })
                .then((read) => read.revision),
            ),
          ),
          bridge()
            .chatDispatchStateForThread({
              workspaceId,
              threadId: nextLaneIds[0] ?? null,
              ...(postIds.length > 0 ? { postThreadIds: postIds } : {}),
              ...(laneRest.length > 0 ? { laneThreadIds: laneRest } : {}),
            })
            .catch(() => null),
        ]);
        if (!isCurrent()) return;
        setDispatch(nextDispatch);
        const nextRunId = nextDispatch?.liveRunId ?? null;
        const revisions = revisionList.join("|");
        const painted = paintedRevision.current;
        if (
          !force &&
          painted?.laneIds === laneKey &&
          painted.revisions === revisions &&
          painted.postsKey === postsKey &&
          painted.liveRunId === nextRunId
        ) {
          markRead(painted);
          return;
        }
        const ticket = reactions.ticket();
        const readThread = async (id: string) => {
          const [page, reacted, polled, ran] = await Promise.all([
            bridge().listChatMessages({ workspaceId, threadId: id }),
            bridge().listChatReactions({ workspaceId, threadId: id }),
            bridge().listChatThreadDecisions({ workspaceId, threadId: id }),
            // Without an agent's runs the chat still shows.
            bridge()
              .chatRunRecordsForThread({ workspaceId, threadId: id })
              .catch(() => null),
          ]);
          return {
            id,
            messages: page.messages,
            reacted,
            decisions: polled.decisions,
            runs: ran?.runs ?? {},
          };
        };
        const reads = await Promise.all([
          ...lane.map((each) => readThread(each.id)),
          ...posts.map((post) => readThread(post.id)),
        ]);
        reactions.ingest(reads.map((read) => ({ threadId: read.id, ...read.reacted, ticket })));
        if (!isCurrent()) return;
        const laneReads = reads.slice(0, lane.length);
        const postReads = reads.slice(lane.length);
        if (lane.length > 0 && paintedRevision.current?.laneIds !== laneKey) {
          // The earliest message the reader had not seen, in any of its threads.
          const firstUnread = lane
            .flatMap((each, at) => {
              const unread = laneReads[at]?.messages[each.lastReadSequence];
              return each.unreadCount > 0 && unread ? [unread] : [];
            })
            .sort(compareMessageOrder)[0];
          setFirstUnreadMessageId(firstUnread?.id ?? null);
        }
        const next: PaintedLane = {
          laneIds: laneKey,
          revisions,
          postsKey,
          liveRunId: nextRunId,
          read: laneReads.map((read) => ({
            threadId: read.id,
            messageCount: read.messages.length,
          })),
          readState: "retry",
        };
        paintedRevision.current = next;
        setLaneIds(nextLaneIds);
        setPostThreadIds(posts.map((post) => post.id));
        setMessages(
          [
            ...postReads.flatMap((read) => postAsThread(read.messages)),
            ...laneReads.flatMap((read) => read.messages),
          ].sort(compareMessageOrder),
        );
        setDecisions(reads.flatMap((read) => read.decisions));
        setRuns(Object.assign({}, ...reads.map((read) => read.runs)));
        setLoading(false);
        markRead(next);
        // A post shown here is read: there's nowhere else to open it.
        posts.forEach((post, at) => {
          const read = postReads[at];
          if (post.unreadCount === 0 || !read) return;
          void bridge()
            .markChatThreadRead({
              workspaceId,
              threadId: post.id,
              upToSequence: read.messages.length,
            })
            .then(
              () => {
                if (isCurrent()) onThreadRead.current?.();
              },
              () => {},
            );
        });
      } catch (error) {
        if (!isCurrent()) return;
        setLoading(false);
        onError(ipcErrorMessage(error, "dohc could not load this chat."), error);
      }
    },
    [agentDm, channelId, markRead, onError, reactions, workspaceId],
  );

  // A message that saved while a later step failed. Try again reloads the
  // conversation it saved in, while this lane still shows it.
  const reportUnshown = useCallback(
    (words: string, failure: string) => {
      const current = token.current;
      onError(words, failure, () => {
        if (current === token.current) void load(true);
      });
    },
    [load, onError],
  );

  // An answer whose reply saved while its question stayed open. Try again
  // marks the question answered with that reply, while this lane still shows
  // it, and never posts the reply again. A failed try offers Try again again.
  const reportStillOpen = useCallback(
    (
      words: string,
      failure: unknown,
      answer: {
        threadId: string;
        messageId: string;
        resolvedByMessageId: string;
        chosenOption?: string;
      },
    ) => {
      const current = token.current;
      const report = (cause: unknown) =>
        onError(words, cause, () => {
          if (current !== token.current) return;
          void bridge()
            .resolveChatDecision({ workspaceId, ...answer })
            .then(
              ({ resolved }) => {
                if (current !== token.current) return;
                setDecisions((existing) =>
                  existing.map((entry) =>
                    entry.messageId === resolved.messageId ? resolved : entry,
                  ),
                );
                void load(true);
              },
              (error: unknown) => {
                if (current === token.current) report(error);
              },
            );
        });
      report(failure);
    },
    [load, onError, workspaceId],
  );

  useEffect(() => {
    setLaneIds([]);
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
    return () => {
      token.current += 1;
    };
  }, [channelId, workspaceId]);

  useEffect(() => {
    void load();
    return () => {
      loadSequence.current += 1;
    };
  }, [load, props.revision]);

  useEffect(() => {
    if (
      focusMessageId === undefined ||
      loading ||
      !messages.some((message) => message.id === focusMessageId)
    )
      return;
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

  // A resume puts requests back to waiting on the busy agent, and no
  // activity says so, so the lane reads its dispatch again.
  const dispatchPaused = props.dispatchPaused === true;
  const wasPaused = useRef(dispatchPaused);
  useEffect(() => {
    const resumed = wasPaused.current && !dispatchPaused;
    wasPaused.current = dispatchPaused;
    if (resumed) void load();
  }, [dispatchPaused, load]);

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
    return () => {
      active = false;
      unsubscribe();
    };
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
        // The message saved, so it is not sent again. The reload below shows it.
        if ("failure" in result)
          reportUnshown("Sent your message. dohc could not show it yet.", result.failure);
        else {
          if (result.waitsForTrust) props.onAgentWaitsForTrust?.(workspaceId);
          loadSequence.current += 1;
          listRef.current?.scrollToEnd();
          setMessages((existing) =>
            existing.some((message) => message.id === result.message.id)
              ? existing
              : [...existing, result.message],
          );
        }
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
        if ("failure" in result) {
          if (current !== token.current) return;
          reportUnshown("Sent your message. dohc could not show it yet.", result.failure);
        } else {
          // The new message has no reactions yet; the start names the viewer.
          reactions.ingest([
            {
              threadId: result.thread.id,
              messageIds: [result.message.id],
              reactions: [],
              viewerAuthorId: result.viewerAuthorId,
              ticket,
            },
          ]);
          if (current !== token.current) return;
          if (result.waitsForTrust) props.onAgentWaitsForTrust?.(workspaceId);
          loadSequence.current += 1;
          listRef.current?.scrollToEnd();
          setLaneIds([result.thread.id]);
          setMessages([result.message]);
        }
      }
      setComposer("");
      setPoll(null);
      void load(true);
    } catch (error) {
      if (current !== token.current) return;
      onError(ipcErrorMessage(error, "dohc could not send that message."), error);
    } finally {
      if (current === token.current) setSending(false);
    }
  }, [
    channelId,
    composer,
    load,
    loading,
    onError,
    poll,
    props.locked,
    props.onAgentWaitsForTrust,
    reactions,
    reportUnshown,
    sending,
    threadId,
    workspaceId,
  ]);

  // A reply goes under the message the thread hangs from. A reply to an
  // earlier post goes on in that post. A reply after Answer answers its question.
  const sendReply = useCallback(
    async (rootId: string, body: string, answers?: string) => {
      const root = messages.find((message) => message.id === rootId)?.threadId;
      const post = root !== undefined && postThreadIds.includes(root) ? root : undefined;
      const target = root ?? threadId;
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
        if (!("failure" in result)) {
          if (result.waitsForTrust) props.onAgentWaitsForTrust?.(workspaceId);
          loadSequence.current += 1;
          const reply = post ? { ...result.message, parentMessageId: rootId } : result.message;
          setMessages((existing) =>
            existing.some((message) => message.id === reply.id) ? existing : [...existing, reply],
          );
          const resolved = result.resolved;
          if (resolved)
            setDecisions((existing) =>
              existing.map((entry) => (entry.messageId === resolved.messageId ? resolved : entry)),
            );
        }
        if (answers && result.resolveFailure) {
          reportStillOpen(
            "Sent your reply. dohc could not mark the question answered.",
            result.resolveFailure,
            {
              threadId: target,
              messageId: answers,
              resolvedByMessageId: result.message.id,
            },
          );
        } else if ("failure" in result)
          reportUnshown("Sent your reply. dohc could not show it yet.", result.failure);
        void load(true);
        return true;
      } catch (error) {
        if (current === token.current)
          onError(ipcErrorMessage(error, "dohc could not send that reply."), error);
        return false;
      }
    },
    [
      load,
      messages,
      onError,
      postThreadIds,
      props.locked,
      props.onAgentWaitsForTrust,
      reportStillOpen,
      reportUnshown,
      threadId,
      workspaceId,
    ],
  );

  const chooseOption = useCallback(
    async (decision: ChatDecisionRecord, option: string) => {
      // The answer goes where the poll is: its thread, or its earlier post.
      const asked = messages.find((message) => message.id === decision.messageId);
      const post = asked && postThreadIds.includes(asked.threadId) ? asked.threadId : undefined;
      const target = asked?.threadId ?? threadId;
      if (!target || sending || loading || props.locked) return;
      const parentMessageId = post ? undefined : asked?.parentMessageId;
      const current = token.current;
      const input = {
        workspaceId,
        threadId: target,
        body: option,
        ...(parentMessageId ? { parentMessageId } : {}),
        resolves: { messageId: decision.messageId, chosenOption: option },
      };
      setSending(true);
      try {
        const result = await bridge().sendChatMessage(input);
        if (current !== token.current) return;
        if (!("failure" in result)) {
          if (result.waitsForTrust) props.onAgentWaitsForTrust?.(workspaceId);
          loadSequence.current += 1;
          listRef.current?.scrollToEnd();
          setMessages((existing) =>
            existing.some((message) => message.id === result.message.id)
              ? existing
              : [...existing, result.message],
          );
          const resolved = result.resolved;
          if (resolved)
            setDecisions((existing) =>
              existing.map((entry) => (entry.messageId === decision.messageId ? resolved : entry)),
            );
        }
        if (result.resolveFailure) {
          reportStillOpen(
            "Sent your choice. dohc could not mark the question answered.",
            result.resolveFailure,
            {
              threadId: target,
              messageId: decision.messageId,
              resolvedByMessageId: result.message.id,
              chosenOption: option,
            },
          );
        } else if ("failure" in result)
          reportUnshown("Sent your choice. dohc could not show it yet.", result.failure);
      } catch (error) {
        // A choice that saved answers, so a refused one saved nothing.
        if (current === token.current)
          onError(ipcErrorMessage(error, "dohc could not send that choice."), error);
      } finally {
        if (current === token.current) {
          setSending(false);
          void load(true);
        }
      }
    },
    [
      threadId,
      sending,
      loading,
      props.locked,
      props.onAgentWaitsForTrust,
      workspaceId,
      onError,
      load,
      messages,
      postThreadIds,
      reportStillOpen,
      reportUnshown,
    ],
  );

  // Applying or undoing a change answers in the change's own place, as the person who clicked.
  // Apply answers the message's question, attaching the change a review applied instead. Undo attaches the change file again.
  const replyToChange = useCallback(
    async (
      asked: ChatMessageRecord,
      path: string,
      input: { body: string; resolves: boolean; attach?: string },
    ) => {
      const post = postThreadIds.includes(asked.threadId) ? asked.threadId : undefined;
      const target = asked.threadId;
      const parentMessageId = post ? undefined : asked.parentMessageId;
      const current = token.current;
      const result = await bridge().sendChatMessage({
        workspaceId,
        threadId: target,
        body: input.body,
        ...(parentMessageId ? { parentMessageId } : {}),
        ...(input.resolves ? { resolves: { messageId: asked.id } } : {}),
        ...(input.attach || !input.resolves
          ? { fileReferences: [{ path: input.attach ?? path }] }
          : {}),
      });
      if (current !== token.current) return;
      // A reply that saved is not posted again, so this does not throw for it.
      if (!("failure" in result)) {
        loadSequence.current += 1;
        setMessages((existing) =>
          existing.some((message) => message.id === result.message.id)
            ? existing
            : [...existing, result.message],
        );
        const resolved = result.resolved;
        if (resolved)
          setDecisions((existing) =>
            existing.map((entry) => (entry.messageId === asked.id ? resolved : entry)),
          );
      }
      if (result.resolveFailure)
        onError(
          ipcErrorMessage(result.resolveFailure, "dohc could not mark this message answered."),
          result.resolveFailure,
        );
      else if ("failure" in result)
        reportUnshown("Sent your reply. dohc could not show it yet.", result.failure);
      void load(true);
    },
    [load, onError, postThreadIds, reportUnshown, workspaceId],
  );

  const liveRunId = dispatch?.liveRunId ?? null;
  const stopRun = useCallback(async () => {
    if (liveRunId === null || stopping) return;
    const current = token.current;
    setStopping(true);
    try {
      await bridge().stopAgentRun({ workspaceId, runId: liveRunId });
      if (current !== token.current) return;
      // Stop leaves with the strip, so the reader goes on in the composer.
      composerHandle.current?.focus();
      void load();
    } catch (error) {
      if (current === token.current)
        onError(ipcErrorMessage(error, "dohc could not stop this agent run."), error);
    } finally {
      if (current === token.current) setStopping(false);
    }
  }, [liveRunId, load, onError, stopping, workspaceId]);

  // Try again on an eligible failed run puts its request back in
  // line. The failure's own Try again only asks again: the run's update
  // refreshes the conversation.
  const failedRun = dispatch?.failedRun ?? null;
  const [retrying, setRetrying] = useState(false);
  const retryRun = useCallback(async () => {
    if (!failedRun?.retryable || retrying || threadId === null) return;
    const current = token.current;
    const input = { workspaceId, threadId, runId: failedRun.runId };
    const failed = (error: unknown) =>
      withErrorWords(`dohc could not start ${props.agentName ?? "your agent"}'s run again.`, error);
    setRetrying(true);
    try {
      await bridge().retryStoppedRun(input);
      if (current === token.current) void load();
    } catch (error) {
      if (current !== token.current) return;
      const again = () =>
        void bridge()
          .retryStoppedRun(input)
          .catch((retryError: unknown) => onError(failed(retryError), retryError, again));
      onError(failed(error), error, again);
    } finally {
      if (current === token.current) setRetrying(false);
    }
  }, [failedRun, load, onError, props.agentName, retrying, threadId, workspaceId]);

  // The agent at work on this computer. Its answer lands in the thread it was
  // asked in, or at the end of the conversation. Anyone who can post here can
  // stop it.
  const liveAgentId = dispatch?.liveAgent?.agentId;
  const liveAgentName = dispatch?.liveAgent?.name;
  const working = useMemo<ChatWorking | null>(() => {
    if (liveRunId === null) return null;
    const identity =
      liveAgentId !== undefined && liveAgentName !== undefined && liveAgentId !== chatAgentId
        ? agentChatIdentity({ agentId: liveAgentId, name: liveAgentName }, props.agents ?? [])
        : {
            label: props.agentName ?? "Your agent",
            presentation: props.agentPresentation ?? neutralPresentation,
          };
    return {
      agentName: identity.label,
      presentation: identity.presentation,
      stopping,
      ...(props.locked ? {} : { onStop: () => void stopRun() }),
    };
  }, [
    chatAgentId,
    liveAgentId,
    liveAgentName,
    liveRunId,
    props.agentName,
    props.agentPresentation,
    props.agents,
    props.locked,
    stopping,
    stopRun,
  ]);
  // The messages that wait for the agent to end its run, which none do while
  // a pause holds them. Another agent asked here takes the default agent color.
  const waiting = dispatchPaused ? undefined : dispatch?.waiting;
  const waitingIds = useMemo(() => new Set(waiting?.triggerMessageIds), [waiting]);
  const waitingPresentation =
    (waiting && waiting.agentId === chatAgentId ? props.agentPresentation : undefined) ??
    neutralPresentation;
  // Reactions live with each message's own thread: the conversation's, or an
  // earlier post's.
  const reactionThreads = useMemo(() => [...laneIds, ...postThreadIds], [laneIds, postThreadIds]);
  const reactionViews = reactionThreads.map((id) => reactions.view(id));
  const viewerAuthorId = reactionViews.find((view) => view.viewerAuthorId)?.viewerAuthorId ?? "";
  // Only a Group's messages can be deleted: not General's, an agent's or a DM's.
  const messageDelete = useMessageDelete({
    workspaceId,
    viewerAuthorId,
    enabled: isWorkspaceGroup(props.channel.wireId ?? null, props.channel.kind),
  });
  const reactionControls: ChatReactionControls | undefined =
    reactionViews.length > 0
      ? {
          // One thread keeps its list as it is, so rows only redraw on a change.
          reactions:
            reactionViews.length === 1
              ? reactionViews[0]!.reactions
              : reactionViews.flatMap((view) => view.reactions),
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

  const decisionsByMessage = useMemo(
    () => new Map(decisions.map((decision) => [decision.messageId, decision])),
    [decisions],
  );
  const failedEnd = useMemo(
    () => (failedRun ? failedRunEnd(failedRun, runs, messages) : null),
    [failedRun, messages, runs],
  );
  // Under a message: its question, and why the agent didn't answer it. A
  // choice answers at once. Answer starts a reply in the question's thread.
  // Where a change card's reply posts, as a reply that fails to post names it.
  const replyPlace = agentDm
    ? `your chat with ${props.agentName ?? "your agent"}`
    : `#${props.channel.name}`;
  // A failed run's ask-again readies this composer; it never sends.
  const askAgain = useCallback((agentId: string, mention: boolean) => {
    if (mention) composerHandle.current?.mention(agentMentionId(agentId));
    else composerHandle.current?.focus();
  }, []);
  const renderFooter = useCallback(
    (message: ChatMessageRecord, answer: () => void, place: "stream" | "thread") => {
      const decision = decisionsByMessage.get(message.id);
      const asked = decision ? changeFileOf(message) : undefined;
      const appliedBy =
        decision?.state === "resolved"
          ? messages.find((reply) => reply.id === decision.resolvedByMessageId)
          : undefined;
      // The change a review applied, when it wasn't the one asked.
      const changeFile =
        asked === undefined ? undefined : ((appliedBy && changeFileOf(appliedBy)) ?? asked);
      const undoneBy =
        changeFile === undefined
          ? undefined
          : messages
              .filter(
                (reply) =>
                  reply.id !== appliedBy?.id &&
                  reply.createdAtMs > message.createdAtMs &&
                  reply.authorKind === "human" &&
                  changeFileOf(reply) === changeFile,
              )
              .at(-1);
      const resolve = props.locked
        ? undefined
        : !decision?.options?.length
          ? answer
          : sending
            ? undefined
            : (option?: string) => {
                if (option) void chooseOption(decision, option);
              };
      return (
        <>
          {changeFile !== undefined ? (
            <CollectionChangeCard
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
              onNotice={props.onNotice}
              chatName={replyPlace}
              testIdPrefix="chats-lane"
            />
          ) : decision ? (
            <DecisionStatus
              decision={decision}
              testIdPrefix="chats-lane"
              {...(resolve ? { onResolve: resolve } : {})}
            />
          ) : null}
          {message.work ? <WorkStatus testIdPrefix="chats-lane" work={message.work} /> : null}
          {failedRun && message.id === failedEnd ? (
            <FailedRunLine
              testIdPrefix="chats-lane"
              failed={failedRun}
              busy={retrying}
              className="mt-1"
              {...(failedRun.retryable && !props.locked ? { onRetry: () => void retryRun() } : {})}
              {...(props.onOpenAgentSettings
                ? { onOpenAgentSettings: props.onOpenAgentSettings }
                : {})}
              {...(chatAgentId ? { chatAgentId } : {})}
              {...(!props.locked && !sending && place === "stream" ? { onAskAgain: askAgain } : {})}
            />
          ) : null}
          {waiting && waitingIds.has(message.id) ? (
            <WaitingLine
              testIdPrefix="chats-lane"
              agentName={waiting.name}
              presentation={waitingPresentation}
              className="mt-1"
            />
          ) : null}
        </>
      );
    },
    [
      decisionsByMessage,
      messages,
      workspaceId,
      props.locked,
      props.onOpenPath,
      props.onOpenAgentSettings,
      chatAgentId,
      onError,
      props.onNotice,
      replyPlace,
      replyToChange,
      sending,
      chooseOption,
      failedRun,
      failedEnd,
      retrying,
      retryRun,
      askAgain,
      waiting,
      waitingIds,
      waitingPresentation,
    ],
  );
  const place = agentDm ? (props.agentName ?? "Your agent") : `# ${props.channel.name}`;

  return (
    <>
      <ThreadedChat
        key={`${workspaceId}:${channelId}`}
        deleteAction={messageDelete.action}
        testIdPrefix="chats-lane"
        chatIds={laneIds}
        messages={messages}
        runs={runs}
        loading={loading}
        emptyLabel={agentDm ? "No messages yet." : `No messages in #${props.channel.name} yet.`}
        place={place}
        header={
          <>
            {props.header}
            <DispatchAnnouncement
              testId="chats-lane-dispatch-announcement"
              text={
                dispatch && liveRunId !== null
                  ? dispatchAnnouncement(true, dispatch.pendingCount)
                  : ""
              }
            />
          </>
        }
        belowList={
          <AgentThreadLines
            workspaceId={workspaceId}
            chatThreadIds={reactionThreads}
            className="mx-5 mb-1 mt-2"
          />
        }
        notice={props.notice}
        composer={(inset) =>
          props.locked ? (
            <ComposerNotice testId="chats-lane-readonly" className="px-5 pb-4 pt-1">
              {props.lockedLine ?? "This Group is read-only for you."}
            </ComposerNotice>
          ) : (
            <MentionComposer
              pinned
              testIdPrefix="chats-lane"
              composerId="chats-lane-composer"
              value={composer}
              sending={sending}
              disabled={loading}
              placeholder={
                agentDm
                  ? `Message ${props.agentName ?? "your agent"}`
                  : `Message #${props.channel.name}`
              }
              sendLabel="Send message"
              candidates={props.mentionCandidates}
              fileCandidates={props.fileCandidates}
              loadFileHeadings={props.loadFileHeadings}
              onAddFiles={props.onAddFiles}
              onChange={setComposer}
              poll={poll}
              onPollChange={setPoll}
              onSend={() => void send()}
              onRosterPick={agentOffer.onRosterPick}
              rosterScope={agentOffer.scope}
              agentOffer={agentOffer.offer}
              inset={inset}
              handle={composerHandle}
            />
          )
        }
        replyNotice={
          props.locked ? (
            <ComposerNotice testId="chats-lane-thread-readonly" className="px-4 pb-4 pt-1">
              {props.lockedLine ?? "This Group is read-only for you."}
            </ComposerNotice>
          ) : undefined
        }
        onSendReply={sendReply}
        mentionCandidates={props.mentionCandidates}
        fileCandidates={props.fileCandidates}
        loadFileHeadings={props.loadFileHeadings}
        onAddFiles={props.onAddFiles}
        onOpenPath={props.onOpenPath}
        reactionControls={reactionControls}
        renderMessageFooter={renderFooter}
        working={working}
        workingMessageId={dispatch?.liveTriggerMessageId ?? null}
        listRef={listRef}
        firstUnreadMessageId={firstUnreadMessageId}
        flashMessageId={flashMessageId}
      />
      {messageDelete.dialog}
    </>
  );
}
