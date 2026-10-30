import { ChevronLeft, Square, X } from "lucide-react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { ActorPresentation, ChatMessageRecord } from "../../ipc/bridgeContract";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { formatClock, formatShortTime, sameChatDay } from "../time";
import { ChatAvatar, useAgentInk } from "./ChatAvatar";
import { ChatMarkdown } from "./ChatMarkdown";
import { ChatMessageList, DENSITY, type ChatMessageListHandle, type ChatReactionControls } from "./chatMessages";

export interface ChatThreads {
  // The conversation as the stream shows it: every message that is not a reply.
  top: ChatMessageRecord[];
  // Each thread's replies, oldest first, by the message they hang from.
  replies: ReadonlyMap<string, ChatMessageRecord[]>;
}

// A conversation's messages, split into the stream and its threads. A reply
// to a reply joins its first message's thread. A reply whose parent isn't
// loaded stays in the stream, so nothing is hidden.
export function splitThreads(messages: readonly ChatMessageRecord[]): ChatThreads {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const top: ChatMessageRecord[] = [];
  const replies = new Map<string, ChatMessageRecord[]>();
  for (const message of messages) {
    let root = message;
    for (let depth = 0; root.parentMessageId && depth < messages.length; depth += 1) {
      const parent = byId.get(root.parentMessageId);
      if (!parent) break;
      root = parent;
    }
    if (root === message) {
      top.push(message);
      continue;
    }
    const thread = replies.get(root.id);
    if (thread) thread.push(message);
    else replies.set(root.id, [message]);
  }
  return { top, replies };
}

function repliesLabel(count: number): string {
  return `${count} ${count === 1 ? "reply" : "replies"}`;
}

// Under a message with replies: the agent's answer when it replied last, then
// who replied, how many, and when last. Either opens the thread.
export function ThreadSummary(props: {
  testIdPrefix: string;
  replies: readonly ChatMessageRecord[];
  mentionCandidates: readonly MentionCandidate[];
  onOpen: () => void;
}) {
  const last = props.replies[props.replies.length - 1];
  if (!last) return null;
  return (
    <>
      {last.authorKind === "agent" ? <AgentReplyPeek testIdPrefix={props.testIdPrefix} reply={last} mentionCandidates={props.mentionCandidates} onOpen={props.onOpen} /> : null}
      <RepliesLine {...props} last={last} />
    </>
  );
}

// The agent's latest reply, cut at two lines. A pointer opens the thread from
// it; the replies line under it is the keyboard's way in.
function AgentReplyPeek(props: {
  testIdPrefix: string;
  reply: ChatMessageRecord;
  mentionCandidates: readonly MentionCandidate[];
  onOpen: () => void;
}) {
  const { reply } = props;
  const ink = useAgentInk(reply.presentation);
  return (
    <div
      data-testid={`${props.testIdPrefix}-thread-peek`}
      onClick={props.onOpen}
      className={`mt-1.5 cursor-pointer border-l-2 border-current/55 pl-3 ${ink}`}
    >
      <span className="flex items-center gap-1.5 leading-5">
        <ChatAvatar presentation={reply.presentation} name={reply.authorDisplayName} kind="agent" size="strip" />
        <span className="truncate text-[13px] font-semibold">{reply.authorDisplayName}</span>
        <span className="shrink-0 text-[12px] tabular-nums text-subtle">{formatClock(reply.createdAtMs)}</span>
      </span>
      <div inert className="dohc-chat-peek text-[14px] text-ink">
        <ChatMarkdown body={reply.body} candidates={props.mentionCandidates} attachments={reply.attachments} />
      </div>
    </div>
  );
}

function RepliesLine(props: {
  testIdPrefix: string;
  replies: readonly ChatMessageRecord[];
  last: ChatMessageRecord;
  onOpen: () => void;
}) {
  const { last } = props;
  const faces = new Map<string, ChatMessageRecord>();
  for (const reply of props.replies) {
    const key = `${reply.authorKind}:${reply.presentation.group}:${reply.authorDisplayName}`;
    if (!faces.has(key) && faces.size < 3) faces.set(key, reply);
  }
  // Today's time, "Yesterday", or a short date.
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const when = sameChatDay(last.createdAtMs, yesterday.getTime()) ? "Yesterday" : formatShortTime(last.createdAtMs);
  return (
    <button
      type="button"
      data-testid={`${props.testIdPrefix}-thread-summary`}
      onClick={props.onOpen}
      className="-ml-1 mt-1 flex h-7 max-w-full items-center gap-2 rounded-md border border-transparent px-1 text-[13px] hover:border-line hover:bg-bg"
    >
      <span className="flex shrink-0 gap-[3px]">
        {[...faces.values()].map((reply) => (
          <ChatAvatar
            key={`${reply.authorKind}:${reply.presentation.group}:${reply.authorDisplayName}`}
            presentation={reply.presentation}
            name={reply.authorDisplayName}
            kind={reply.authorKind}
            size="strip"
          />
        ))}
      </span>
      <span className="shrink-0 font-semibold text-hue-blue">{repliesLabel(props.replies.length)}</span>
      <span className="truncate text-[12px] text-subtle">Last reply {when}</span>
    </button>
  );
}

function WorkingDots(props: { presentation: ActorPresentation }) {
  const ink = useAgentInk(props.presentation);
  return (
    <span aria-hidden className={`dohc-working-dots ${ink}`}>
      <i />
      <i />
      <i />
    </span>
  );
}

function StopButton(props: { testIdPrefix: string; stopping: boolean; onStop: () => void }) {
  return (
    <button
      type="button"
      data-testid={`${props.testIdPrefix}-stop-agent-run`}
      aria-label="Stop agent run"
      disabled={props.stopping}
      onClick={props.onStop}
      className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[5px] border border-line bg-bg px-2 text-[12px] font-medium text-muted hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-50"
    >
      <Square size={9} strokeWidth={2} aria-hidden />
      Stop
    </button>
  );
}

export interface ChatWorking {
  agentName: string;
  presentation: ActorPresentation;
  stopping: boolean;
  // Absent when the reader can't stop the run.
  onStop?: () => void;
}

// Under the message an agent is answering: its mark, that it's working, and Stop.
export function WorkingLine(props: { testIdPrefix: string; working: ChatWorking }) {
  const { working } = props;
  return (
    <div data-testid={`${props.testIdPrefix}-working`} className="mt-1 flex h-7 items-center gap-2 text-[13px] text-muted">
      <ChatAvatar presentation={working.presentation} name={working.agentName} kind="agent" size="strip" />
      <span className="min-w-0 truncate">{working.agentName} is working</span>
      <WorkingDots presentation={working.presentation} />
      {working.onStop ? <StopButton testIdPrefix={props.testIdPrefix} stopping={working.stopping} onStop={working.onStop} /> : null}
    </div>
  );
}

// At the end of a stream or thread: the agent's row before its reply lands.
// The reply takes its place.
export function WorkingRow(props: { testIdPrefix: string; working: ChatWorking; density: keyof typeof DENSITY }) {
  const { working } = props;
  const sizes = DENSITY[props.density];
  const ink = useAgentInk(working.presentation);
  return (
    <div data-testid={`${props.testIdPrefix}-working`} className={`grid ${sizes.row} pb-2 pt-1.5`}>
      <span className="flex justify-end">
        <ChatAvatar presentation={working.presentation} name={working.agentName} kind="agent" size={sizes.avatar} />
      </span>
      <div className="min-w-0">
        <span className={`block truncate font-semibold leading-5 ${sizes.name} ${ink}`}>{working.agentName}</span>
        <span className="flex h-7 items-center gap-2 text-[14px] text-muted">
          Working
          <WorkingDots presentation={working.presentation} />
          {working.onStop ? <StopButton testIdPrefix={props.testIdPrefix} stopping={working.stopping} onStop={working.onStop} /> : null}
        </span>
      </div>
    </div>
  );
}

// One thread beside its conversation: the message it hangs from, its
// replies, and a composer. Narrow, it takes the conversation's place and
// leads with a way back. Everything it shows comes in through its props.
export function ChatThreadPanel(props: {
  testIdPrefix: string;
  // Where the thread is: "# general" or the agent's name.
  place: ReactNode;
  parent: ChatMessageRecord | null;
  replies: readonly ChatMessageRecord[];
  loading: boolean;
  narrow: boolean;
  onClose: () => void;
  mentionCandidates?: readonly MentionCandidate[];
  onOpenPath?: (path: string, headingAnchor?: string) => void;
  reactionControls?: ChatReactionControls;
  renderMessageFooter?: (message: ChatMessageRecord) => ReactNode;
  rowActions?: (message: ChatMessageRecord) => ReactNode;
  listRef?: RefObject<ChatMessageListHandle | null>;
  flashMessageId?: string | null;
  working?: ChatWorking | null;
  composer: ReactNode;
}) {
  const root = useRef<HTMLElement | null>(null);
  const parentId = props.parent?.id ?? null;
  // Opening a thread puts the cursor in its composer.
  useEffect(() => {
    root.current?.querySelector<HTMLTextAreaElement>("[data-thread-composer] textarea")?.focus();
  }, [parentId]);
  const messages = props.parent ? [props.parent, ...props.replies] : [];
  const density = props.narrow ? "narrow" : "thread";
  return (
    <aside
      ref={root}
      role="complementary"
      aria-label="Thread"
      data-testid={`${props.testIdPrefix}-thread-panel`}
      data-chat-escape-local="true"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        props.onClose();
      }}
      className={`flex min-h-0 min-w-0 flex-col bg-bg ${props.narrow ? "flex-1" : "w-[400px] shrink-0 border-l border-line"}`}
    >
      <header className={`flex shrink-0 items-center gap-2 border-b border-line ${props.narrow ? "h-11 px-2" : "h-12 pl-4 pr-3"}`}>
        {props.narrow ? (
          <button
            type="button"
            data-testid={`${props.testIdPrefix}-thread-back`}
            aria-label="Back to the conversation"
            onClick={props.onClose}
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-ink"
          >
            <ChevronLeft size={16} aria-hidden />
          </button>
        ) : null}
        <h2 className="m-0 shrink-0 text-[14px] font-semibold text-ink">Thread</h2>
        <span className="min-w-0 truncate text-[12px] text-subtle">{props.place}</span>
        {props.narrow ? null : (
          <button
            type="button"
            data-testid={`${props.testIdPrefix}-thread-close`}
            aria-label="Close thread"
            onClick={props.onClose}
            className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-ink"
          >
            <X size={16} aria-hidden />
          </button>
        )}
      </header>
      <ChatMessageList
        testIdPrefix={`${props.testIdPrefix}-thread`}
        messages={messages}
        loading={props.loading && !props.parent}
        emptyLabel="This message isn't here anymore."
        key={parentId ?? "none"}
        listRef={props.listRef}
        flashMessageId={props.flashMessageId}
        mentionCandidates={props.mentionCandidates}
        onOpenPath={props.onOpenPath}
        reactionControls={props.reactionControls}
        renderMessageFooter={props.renderMessageFooter}
        rowActions={props.rowActions}
        dividerAfterFirst={props.replies.length > 0 ? repliesLabel(props.replies.length) : undefined}
        footer={props.working ? <WorkingRow testIdPrefix={`${props.testIdPrefix}-thread`} working={props.working} density={density} /> : null}
        anchor="start"
        density={density}
      />
      <div data-thread-composer className="contents">{props.composer}</div>
    </aside>
  );
}
