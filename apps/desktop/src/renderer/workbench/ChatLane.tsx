import { useCallback, useEffect, useRef, useState } from "react";
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
import { ChatMessageList, runReactionToggle, type ChatReactionControls } from "./chatMessages";
import { MentionComposer, type FileMentionCandidate } from "./MentionComposer";
import { DecisionStatus } from "./ChatPosts";
import { ComposerNotice } from "./ChatsControls";

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
  onError: (message: string) => void;
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
  const token = useRef(0);
  const loadSequence = useRef(0);
  const onThreadRead = useRef(props.onThreadRead);
  onThreadRead.current = props.onThreadRead;
  const reactionSeq = useRef(new Map<string, number>());
  const endRef = useRef<HTMLDivElement | null>(null);
  const { workspaceId, onError } = props;
  const channelId = props.channel.id;

  const load = useCallback(async () => {
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
        setThreadId(null);
        setMessages([]);
        setReactions([]);
        setDecisions([]);
        setLoading(false);
        return;
      }
      const [page, reacted, polled] = await Promise.all([
        bridge().listChatMessages({ workspaceId, threadId: lane.id }),
        bridge().listChatReactions({ workspaceId, threadId: lane.id }),
        bridge().listChatThreadDecisions({ workspaceId, threadId: lane.id }),
      ]);
      if (!isCurrent()) return;
      setThreadId(lane.id);
      setMessages(page.messages);
      setReactions(reacted.reactions);
      setDecisions(polled.decisions);
      setViewerAuthorId(reacted.viewerAuthorId);
      setLoading(false);
      void bridge().markChatThreadRead({ workspaceId, threadId: lane.id, upToSequence: page.messages.length })
        .then(() => { if (isCurrent()) onThreadRead.current?.(); }, () => undefined);
    } catch (error) {
      if (!isCurrent()) return;
      setLoading(false);
      onError(ipcErrorMessage(error, "Could not load the chat."));
    }
  }, [channelId, onError, workspaceId]);

  useEffect(() => {
    setThreadId(null);
    setMessages([]);
    setReactions([]);
    setDecisions([]);
    setComposer("");
    setSending(false);
    setViewerAuthorId("");
    reactionSeq.current.clear();
    setLoading(true);
    return () => { token.current += 1; };
  }, [channelId, workspaceId]);

  useEffect(() => {
    void load();
    return () => { loadSequence.current += 1; };
  }, [load, props.revision]);

  useEffect(() => {
    let queued = false;
    let active = true;
    const unsubscribe = bridge().onWorkspaceActivity((event) => {
      if (event.workspaceId !== workspaceId || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (active) void load();
      });
    });
    return () => { active = false; unsubscribe(); };
  }, [load, workspaceId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

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
        setThreadId(result.thread.id);
        setMessages([result.message]);
        setViewerAuthorId(result.viewerAuthorId);
      }
      setComposer("");
      void load();
    } catch (error) {
      if (current !== token.current) return;
      onError(ipcErrorMessage(error, "Could not send that message."));
    } finally {
      if (current === token.current) setSending(false);
    }
  }, [channelId, composer, load, loading, onError, props.locked, sending, threadId, workspaceId]);

  const chooseOption = async (decision: ChatDecisionRecord, option: string) => {
    if (!threadId || sending || loading || props.locked) return;
    const current = token.current;
    setSending(true);
    try {
      const result = await bridge().sendChatMessage({ workspaceId, threadId, body: option });
      if (current !== token.current) return;
      loadSequence.current += 1;
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
      onError(ipcErrorMessage(error, "Could not answer that poll."));
    } finally {
      if (current === token.current) {
        setSending(false);
        void load();
      }
    }
  };

  const reactionControls: ChatReactionControls | undefined = threadId
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
    : undefined;

  return (
    <div data-testid="chats-lane" className="flex min-h-0 flex-1 flex-col">
      <ChatMessageList
        testIdPrefix="chats-lane"
        messages={messages}
        loading={loading}
        emptyLabel="No messages yet"
        endRef={endRef}
        mentionCandidates={props.mentionCandidates}
        onOpenPath={props.onOpenPath}
        reactionControls={reactionControls}
        renderMessageFooter={(message) => {
          const decision = decisions.find(entry => entry.messageId === message.id);
          return decision ? <DecisionStatus
            decision={decision}
            testIdPrefix="chats-lane"
            {...(!props.locked && !sending && decision.options?.length ? {
              onResolve: (option?: string) => { if (option) void chooseOption(decision, option); },
            } : {})}
          /> : null;
        }}
      />
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
