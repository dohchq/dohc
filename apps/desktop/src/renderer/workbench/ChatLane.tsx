import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatChannelRecord,
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
import { ComposerNotice } from "./ChatsControls";

// A group's chat lane: one running conversation, kept out of the feed. The
// lane is the group's newest chat-lane thread; the first message starts it.
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
  // Bumped by the host on workspace activity so the lane refetches.
  revision: number;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [reactions, setReactions] = useState<ChatReactionRecord[]>([]);
  const [viewerAuthorId, setViewerAuthorId] = useState("");
  const [loading, setLoading] = useState(true);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const token = useRef(0);
  const reactionSeq = useRef(new Map<string, number>());
  const endRef = useRef<HTMLDivElement | null>(null);
  const { workspaceId, onError } = props;
  const channelId = props.channel.id;

  const load = useCallback(async () => {
    const current = ++token.current;
    try {
      const listed = await bridge().listChannelThreads({
        workspaceId,
        channelId,
        lane: "chat",
      });
      if (current !== token.current) return;
      const lane = listed.threads[0];
      if (!lane) {
        setThreadId(null);
        setMessages([]);
        setReactions([]);
        setLoading(false);
        return;
      }
      const [page, reacted] = await Promise.all([
        bridge().listChatMessages({ workspaceId, threadId: lane.id }),
        bridge().listChatReactions({ workspaceId, threadId: lane.id }),
      ]);
      if (current !== token.current) return;
      setThreadId(lane.id);
      setMessages(page.messages);
      setReactions(reacted.reactions);
      setViewerAuthorId(reacted.viewerAuthorId);
      setLoading(false);
    } catch (error) {
      if (current !== token.current) return;
      setLoading(false);
      onError(ipcErrorMessage(error, "Could not load the chat."));
    }
  }, [channelId, onError, workspaceId]);

  useEffect(() => {
    setLoading(true);
    void load();
    return () => {
      token.current += 1;
    };
  }, [load, props.revision]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const send = useCallback(async () => {
    const body = composer.trim();
    if (body.length === 0 || sending) return;
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
        setMessages((existing) => [...existing, result.message]);
      } else {
        const result = await bridge().startChannelThread({
          workspaceId,
          channelId,
          body,
          lane: "chat",
          ...(references.length > 0 ? { fileReferences: references } : {}),
        });
        if (current !== token.current) return;
        setThreadId(result.thread.id);
        setMessages([result.message]);
        setViewerAuthorId(result.viewerAuthorId);
      }
      setComposer("");
    } catch (error) {
      if (current !== token.current) return;
      onError(ipcErrorMessage(error, "Could not send that message."));
    } finally {
      if (current === token.current) setSending(false);
    }
  }, [channelId, composer, onError, sending, threadId, workspaceId]);

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
          sending={sending}
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
