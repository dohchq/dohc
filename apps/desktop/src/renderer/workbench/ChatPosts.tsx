import { AgentBadge } from "./AgentBadge";
import { AutomationBadge } from "./AutomationBadge";
import { Bookmark, CircleCheck, CircleHelp, FileText, MessageSquare, Reply, Zap } from "lucide-react";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import type {
  ChannelThreadRecord,
  ChatAttachmentRecord,
  ChatBookmarkRecord,
  ChatDecisionRecord,
  ChatMessageRecord,
  ChatReactionRecord,
  ChatRunRecord,
} from "../../ipc/bridgeContract";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { basenameOf } from "../path";
import { Ref } from "../ui/Ref";
import { SkeletonRows } from "../ui/SkeletonRows";
import { formatChatTime, formatClockDigits, formatShortTime } from "../time";
import { CopyButton } from "../ui/CopyButton";
import { AgentName, ChatAvatar, LinkHolderMark } from "./ChatAvatar";
import { AgentColorAvatar, AgentColorName, AgentColorScope } from "./AgentColorPicker";
import {
  MentionText,
  MessageReactions,
  TOOLBAR_BUTTON,
  chatAuthorLabel,
  continuesRun,
  type ChatReactionControls,
} from "./chatMessages";
import { SaveAsFileActions, titleRepeatsFirstLine } from "./PostCard";
import { runnerProgram, type ChatsNav } from "./ChatsView";
import { buildThreadCommentTree, type ThreadCommentNode } from "./threadCommentTree";

// "4s", "1m 20s", "2h 5m".
function formatRunDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// The automation whose message started a run, when one did. A person's
// request names nobody: their message sits right above the reply.
function automationAsking(
  run: ChatRunRecord,
  messagesById: ReadonlyMap<string, ChatMessageRecord>,
): ChatMessageRecord | undefined {
  const trigger = messagesById.get(run.triggerMessageId);
  return trigger?.authorKind === "automation" ? trigger : undefined;
}

// What the agent ran, under its reply: the program and how it ended, then
// the chip that opens the details.
function RunLine(props: { run: ChatRunRecord; askedBy?: ChatMessageRecord }) {
  const { endedAtMs, exitCode } = props.run;
  const failed = endedAtMs !== undefined && exitCode !== 0;
  const program = runnerProgram(props.run.command);
  const label = endedAtMs === undefined
    ? `Running ${program}`
    : failed
      ? `Failed ${program}${exitCode === undefined ? "" : ` · exit ${exitCode}`}`
      : `Ran ${program} · ${formatRunDuration(endedAtMs - props.run.startedAtMs)}`;
  return (
    <div
      data-testid="chats-run-line"
      role="status"
      data-state={endedAtMs === undefined ? "running" : failed ? "failed" : "done"}
      className="mt-1 flex items-center gap-2 px-2 text-[11px] text-subtle"
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${
          endedAtMs === undefined ? "animate-pulse bg-agent" : failed ? "bg-warning" : "bg-success"
        }`}
      />
      <span>{label}</span>
      {props.askedBy ? <RunAskedBy message={props.askedBy} /> : null}
      <RunChip run={props.run} />
    </div>
  );
}


// A poll's choices, stacked. Picking one is the answer. An answered poll
// keeps its choices and marks the one taken.
export function PollOptions(props: {
  decision: ChatDecisionRecord;
  onChoose?: (option: string) => void;
  testIdPrefix: string;
}) {
  const options = props.decision.options ?? [];
  if (options.length === 0) return null;
  const chosen = props.decision.chosenOption;
  return (
    <ol
      data-testid={`${props.testIdPrefix}-poll-options`}
      className="m-0 mt-2 flex list-none flex-col gap-1 p-0"
    >
      {options.map((option) => {
        const taken = chosen === option;
        return (
          <li key={option}>
            <button
              type="button"
              data-testid={`${props.testIdPrefix}-poll-option`}
              data-chosen={taken ? "true" : "false"}
              disabled={!props.onChoose}
              aria-pressed={taken}
              onClick={() => props.onChoose?.(option)}
              className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[13px] transition-colors dohc-focus-visible ${
                taken
                  ? "border-success/50 bg-success/10 text-ink"
                  : "border-line text-ink enabled:hover:bg-hover disabled:opacity-70"
              }`}
            >
              <span
                aria-hidden
                className={`grid size-3.5 shrink-0 place-items-center rounded-full border ${
                  taken ? "border-success bg-success text-bg" : "border-line"
                }`}
              >
                {taken ? <CircleCheck size={10} strokeWidth={3} /> : null}
              </span>
              <span className="min-w-0 flex-1 truncate">{option}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function DecisionStatus(props: {
  decision: ChatDecisionRecord;
  onResolve?: (option?: string) => void;
  testIdPrefix: string;
}) {
  const hasOptions = (props.decision.options?.length ?? 0) > 0;
  if (props.decision.state === "resolved") {
    return (
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          data-testid={`${props.testIdPrefix}-decision-resolved`}
          className="inline-flex w-fit items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[11px] text-success"
        >
          <CircleCheck size={11} strokeWidth={2} aria-hidden />
          Answered
        </span>
        <PollOptions decision={props.decision} testIdPrefix={props.testIdPrefix} />
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span
          data-testid={`${props.testIdPrefix}-decision-open`}
          className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] text-warning"
        >
          <CircleHelp size={11} strokeWidth={2} aria-hidden />
          Poll open
        </span>
        {props.onResolve && !hasOptions ? (
          <button
            type="button"
            data-testid={`${props.testIdPrefix}-decision-resolve`}
            onClick={() => props.onResolve?.()}
            className="rounded px-1 py-0.5 text-[11px] font-medium text-muted hover:text-ink dohc-focus-visible"
          >
            Answer
          </button>
        ) : null}
      </span>
      <PollOptions
        decision={props.decision}
        testIdPrefix={props.testIdPrefix}
        {...(props.onResolve ? { onChoose: props.onResolve } : {})}
      />
    </span>
  );
}

function AttachmentChip(props: {
  attachment: ChatAttachmentRecord;
  onOpenPath?: (path: string, headingAnchor?: string) => void;
}) {
  const { pathHint, headingAnchor, headingText } = props.attachment;
  const onOpenPath = props.onOpenPath;
  // A shared view can hold an attachment whose path it may not read: the
  // chip names it only as an attachment and opens nothing.
  if (!pathHint) return <Ref path="" title="attachment" testId="chats-attachment-chip" />;
  return (
    <Ref
      path={pathHint}
      heading={headingText}
      // An attachment is named by what it shows, the file and its heading.
      label={`${basenameOf(pathHint.replace(/\\/g, "/").replace(/\/+$/, "")) || "attachment"}${
        headingText ? `#${headingText}` : ""
      }`}
      testId="chats-attachment-chip"
      onOpen={onOpenPath
        ? () => (headingAnchor ? onOpenPath(pathHint, headingAnchor) : onOpenPath(pathHint))
        : undefined}
    />
  );
}

// The automation that asked for a run, with the automation's mark and the
// person it ran for in its tooltip.
function RunAskedBy(props: { message: ChatMessageRecord }) {
  const person = props.message.authorOwnerDisplayName;
  return (
    <span
      data-testid="chats-run-asked-by"
      title={person ? `for ${person}` : undefined}
      className="inline-flex min-w-0 items-center gap-1 text-[11px] text-subtle"
    >
      <Zap size={12} strokeWidth={1.9} aria-hidden className="shrink-0" />
      <span className="truncate">Asked by {props.message.authorDisplayName}</span>
      {person ? <span className="sr-only"> for {person}</span> : null}
    </span>
  );
}

// A post an agent opened during a run: who asked for the run, then its chip.
function RunOpening(props: { run: ChatRunRecord; askedBy?: ChatMessageRecord }) {
  return (
    <>
      {props.askedBy ? <RunAskedBy message={props.askedBy} /> : null}
      <RunChip run={props.run} />
    </>
  );
}

function RunChip(props: { run: ChatRunRecord }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const started = formatChatTime(props.run.startedAtMs);
  return (
    <span
      ref={containerRef}
      data-chat-escape-local="true"
      className="relative inline-flex"
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid="chats-run-chip"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
        className="rounded border border-line px-1.5 font-mono text-[10px] text-subtle hover:text-ink dohc-focus-visible"
      >
        run {props.run.runId.slice(0, 7)}
      </button>
      {open ? (
        <span
          role="dialog"
          aria-label={`Run ${props.run.runId}`}
          data-testid="chats-run-popover"
          className="dohc-popover dohc-pop-in absolute left-0 top-full z-30 mt-1 grid w-72 max-w-[calc(100vw-2rem)] gap-2 rounded-lg border border-line bg-panel p-3 text-left"
        >
          <span className="grid gap-0.5">
            <span className="text-[11px] text-muted">Command</span>
            <code data-testid="chats-run-command" className="wrap-anywhere text-[11px] text-ink">
              {props.run.command}
            </code>
          </span>
          <span className="grid grid-cols-2 gap-2">
            <span className="grid gap-0.5">
              <span className="text-[11px] text-muted">Started</span>
              <time
                data-testid="chats-run-started"
                dateTime={started.iso}
                className="text-[11px] tabular-nums text-ink"
              >
                {started.label}
              </time>
            </span>
            <span className="grid gap-0.5">
              <span className="text-[11px] text-muted">Exit code</span>
              <span data-testid="chats-run-exit-code" className="text-[11px] tabular-nums text-ink">
                {props.run.exitCode ?? "—"}
              </span>
            </span>
          </span>
          <span className="grid gap-0.5">
            <span className="text-[11px] text-muted">Log</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <code data-testid="chats-run-log-path" className="min-w-0 flex-1 break-all text-[11px] text-ink">
                {props.run.logPath ?? "No log path"}
              </code>
              {props.run.logPath ? (
                <CopyButton
                  iconOnly
                  testId="chats-run-copy-log"
                  label="Copy log path"
                  pinName
                  getText={() => props.run.logPath ?? null}
                />
              ) : null}
            </span>
          </span>
        </span>
      ) : null}
    </span>
  );
}

export function BookmarkAction(props: {
  active: boolean;
  busy?: boolean;
  destinationPath?: string;
  onToggle?: (mode: "live" | "snapshot") => void;
  onOpen?: () => void;
  testId: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      {props.active && props.onOpen ? (
        <button
          type="button"
          data-testid={`${props.testId}-open`}
          aria-label="Open bookmarked chat file"
          title={props.destinationPath ?? "Open bookmarked chat file"}
          onClick={(event) => {
            event.stopPropagation();
            props.onOpen?.();
          }}
          className="grid size-6 place-items-center rounded text-subtle hover:bg-hover hover:text-ink dohc-focus-visible"
        >
          <FileText size={12} aria-hidden />
        </button>
      ) : null}
      {props.onToggle ? (
        <>
          <button
            type="button"
            data-testid={props.testId}
            aria-pressed={props.active}
            aria-label={props.active ? "Remove chat bookmark" : "Bookmark chat as live file"}
            title={
              props.active
                ? "Remove bookmark (the Markdown file moves to Archived)"
                : "Bookmark as a live Markdown file"
            }
            disabled={props.busy}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggle?.("live");
            }}
            className={`grid size-6 place-items-center rounded dohc-focus-visible disabled:opacity-50 ${
              props.active
                ? "text-accent hover:bg-hover"
                : "text-subtle hover:bg-hover hover:text-ink"
            }`}
          >
            <Bookmark size={12} fill={props.active ? "currentColor" : "none"} aria-hidden />
          </button>

        </>
      ) : null}
    </span>
  );
}

// The thread transcript: opening post plus the recursive comment tree.
// Memoized because ChatsView keeps composer drafts as its own state, so
// without this boundary every keystroke re-rendered — and re-ran the
// mention/file-token scans for — every message in the conversation. ChatsView
// keeps each prop referentially stable across draft and typing renders; the
// transcript re-renders only when the conversation data itself changes.
export const ThreadMessages = memo(function ThreadMessages(props: {
  nav: Extract<ChatsNav, { level: "thread" }>;
  messages: ChatMessageRecord[];
  messagesLoading: boolean;
  threadLocked: boolean;
  flashMessageId: string | null;
  runRecords: Record<string, ChatRunRecord>;
  reactionsByMessage: Map<string, ChatReactionRecord[]>;
  decisionsByMessage: Map<string, ChatDecisionRecord>;
  attachmentsByMessage: Map<string, ChatAttachmentRecord[]>;
  reactionControls: ChatReactionControls;
  mentionCandidates: readonly MentionCandidate[];
  bookmarkFor: (
    targetKind: "message" | "thread",
    targetId: string,
  ) => ChatBookmarkRecord | undefined;
  bookmarkBusy: Set<string>;
  toggleBookmark: (input: {
    target:
      | { kind: "thread"; threadId: string }
      | { kind: "message"; threadId: string; messageId: string };
    mode: "live" | "snapshot";
  }) => Promise<void>;
  beginReply: (message: ChatMessageRecord) => void;
  beginResolve: (message: ChatMessageRecord, option?: string) => void;
  scrollToMessage: (messageId: string) => void;
  onOpenPath?: (path: string, headingAnchor?: string) => void;
  onNavCommand?: (nav: ChatsNav) => void;
  setMessageNode: (messageId: string, element: HTMLElement | null) => void;
}) {
  const {
    nav,
    messages,
    messagesLoading,
    threadLocked,
    flashMessageId,
    runRecords,
    reactionsByMessage,
    decisionsByMessage,
    attachmentsByMessage,
    reactionControls,
    mentionCandidates,
    bookmarkFor,
    bookmarkBusy,
    toggleBookmark,
    beginReply,
    beginResolve,
    scrollToMessage,
    setMessageNode,
  } = props;
  if (messagesLoading) {
    return <SkeletonRows label="Loading..." className="pt-4" />;
  }
  const openingMessage = messages[0] ?? null;
  if (openingMessage === null) {
    return (
      <p className="m-0 pt-4 text-center text-[11px] text-subtle">
        No messages yet.
      </p>
    );
  }
  const commentTree = buildThreadCommentTree(openingMessage.id, messages.slice(1));
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const openingTime = formatChatTime(openingMessage.createdAtMs);
  const openingAttachments = attachmentsByMessage.get(openingMessage.id) ?? [];
  const openingDecision = decisionsByMessage.get(openingMessage.id);
  const openingBookmark = bookmarkFor("message", openingMessage.id);
  const openingIsAgent = openingMessage.authorKind === "agent";
  const hasExplicitTitle = !titleRepeatsFirstLine(nav.thread.title, openingMessage.body.split("\n", 1)[0] ?? "");
  const commentCount = messages.length - 1;

  // A comment: a row that holds the avatar, the name and body, and a hover
  // toolbar, then any replies as a nested list. Comments from one author
  // within five minutes read as one run: the avatar and name once, then bare
  // lines whose time shows in the avatar's place on hover. The DOM shape is
  // what the e2e helpers walk: the row (chats-comment-bubble) is the item's
  // direct child and holds the body and every action; replies are a sibling ol.
  const renderThreadComment = (
    node: ThreadCommentNode,
    depth: number,
    parent: ChatMessageRecord | null,
    previous: ThreadCommentNode | undefined,
  ): ReactNode => {
    const comment = node.message;
    const commentTime = formatChatTime(comment.createdAtMs);
    const commentDecision = decisionsByMessage.get(comment.id);
    const commentAttachments = attachmentsByMessage.get(comment.id) ?? [];
    const isAgent = comment.authorKind === "agent";
    const continues = previous !== undefined && previous.replies.length === 0 &&
      continuesRun(previous.message, comment);
    const replyCount = node.replies.length;
    const commentBookmark = bookmarkFor("message", comment.id);
    const commentBookmarkKey = `message:${comment.id}`;
    return (
      <li
        key={comment.id}
        ref={(element) => setMessageNode(comment.id, element)}
        data-testid="chats-message"
        data-message-id={comment.id}
        data-parent-message-id={comment.parentMessageId}
        data-thread-depth={depth}
        data-author-kind={comment.authorKind}
        data-continues={continues ? "true" : "false"}
        className={`relative flex min-w-0 flex-col pl-[38px] transition-shadow ${
          continues ? "" : "mt-4 first:mt-0"
        } ${
          flashMessageId === comment.id
            ? "rounded-lg ring-2 ring-agent/30 ring-offset-2 ring-offset-bg"
            : ""
        }`}
      >
        {parent && !continues ? (
          <button
            type="button"
            data-testid="chats-reply-context"
            // The jump writes no navigation, so nothing else here cancels
            // the pending cross-surface DM lookup — and a jump is still the
            // user commanding this conversation. Report it as one, before
            // the scroll, or the DM answers late and replaces the message
            // they just jumped to.
            onClick={() => {
              props.onNavCommand?.(nav);
              scrollToMessage(parent.id);
            }}
            className="mb-1 w-fit rounded px-1 text-left text-[11px] text-subtle hover:text-ink dohc-focus-visible"
          >
            ↳ replying to {chatAuthorLabel(parent)}
          </button>
        ) : null}
        <AgentColorScope name={chatAuthorLabel(comment)} kind={comment.authorKind} presentation={comment.presentation}>
        <div
          data-testid="chats-comment-bubble"
          className="group relative -ml-[46px] -mr-2 rounded-lg py-1 pl-[46px] pr-2 transition-colors duration-75 hover:bg-hover"
        >
          {/* A continued comment's slot runs from the row's edge to the
              avatar's right edge, so "12:45" fits at every hour. The full
              time is its tooltip, and the sr-only name line reads it. */}
          <span
            data-testid={continues ? "chats-comment-run-time" : undefined}
            className={`absolute top-1 flex ${continues ? "left-0 w-9 justify-end" : "left-2 w-7 justify-center"}`}
          >
            {continues ? (
              <time
                aria-hidden
                dateTime={commentTime.iso}
                title={commentTime.label}
                className="whitespace-nowrap text-[10px] tabular-nums leading-[22px] text-subtle opacity-0 group-hover:opacity-100"
              >
                {formatClockDigits(comment.createdAtMs)}
              </time>
            ) : (
              <AgentColorAvatar>
                <ChatAvatar presentation={comment.presentation}
                  name={comment.authorDisplayName}
                  kind={comment.authorKind}
                  size="comment"
                />
              </AgentColorAvatar>
            )}
          </span>
          {/* A continued comment keeps its author and time for screen
              readers; the run already shows them. */}
          <div className={continues ? "sr-only" : "flex flex-wrap items-baseline gap-1.5 leading-[18px]"}>
            <span
              data-testid="chats-message-author"
              data-author-kind={comment.authorKind}
              className="text-[13px] font-semibold text-ink"
            >
              <AgentName kind={comment.authorKind} presentation={comment.presentation}>
                <AgentColorName>{chatAuthorLabel(comment)}</AgentColorName>
              </AgentName>
            </span>
            {isAgent && !continues ? <AgentBadge testIdPrefix="chats-comment" author={comment} viewerAuthorId={reactionControls.viewerAuthorId} presentation={comment.presentation} /> : null}
            {comment.authorKind === "link" ? <LinkHolderMark testId="chats-comment-link-holder" /> : null}
            {comment.authorKind === "automation" && !continues ? (
              <AutomationBadge
                testIdPrefix="chats-comment"
                author={comment}
                viewerAuthorId={reactionControls.viewerAuthorId}
                onOpenPath={props.onOpenPath}
              />
            ) : null}
            <time
              data-testid="chats-message-time"
              dateTime={commentTime.iso}
              title={commentTime.label}
              className="text-[11px] tabular-nums text-subtle"
            >
              {formatShortTime(comment.createdAtMs)}
            </time>
          </div>
          <p
            data-testid="chats-message-body"
            className="mb-0 mt-px select-text cursor-text whitespace-pre-wrap break-words text-[14px] leading-[22px] text-ink"
          >
            <MentionText
              body={comment.body}
              candidates={mentionCandidates}
              attachments={commentAttachments}
              testId="chats-message-body"
              onOpenPath={props.onOpenPath}
            />
          </p>
          {commentAttachments.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {commentAttachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.attachmentId}
                  attachment={attachment}
                  onOpenPath={props.onOpenPath}
                />
              ))}
            </div>
          ) : null}
          {commentDecision ? (
            <div className="mt-2">
              <DecisionStatus
                decision={commentDecision}
                onResolve={
                  !threadLocked && commentDecision.state === "open"
                    ? (option) => beginResolve(comment, option)
                    : undefined
                }
                testIdPrefix="chats-comment"
              />
            </div>
          ) : null}
          {replyCount > 0 ? (
            <span data-testid="chats-reply-count" className="mt-1 block text-[11px] tabular-nums text-subtle">
              {replyCount} {replyCount === 1 ? "reply" : "replies"}
            </span>
          ) : null}
          <MessageReactions
            testIdPrefix="chats"
            messageId={comment.id}
            records={reactionsByMessage.get(comment.id) ?? []}
            controls={reactionControls}
            hoverToolbar
            toolbarActions={
              <>
                {!threadLocked ? (
                  <button
                    type="button"
                    data-testid="chats-comment-reply"
                    aria-label="Reply"
                    title="Reply"
                    onClick={() => beginReply(comment)}
                    className={TOOLBAR_BUTTON}
                  >
                    <Reply size={14} strokeWidth={1.9} aria-hidden />
                  </button>
                ) : null}
                <BookmarkAction
                  active={Boolean(commentBookmark)}
                  busy={bookmarkBusy.has(commentBookmarkKey)}
                  destinationPath={commentBookmark?.destinationPath}
                  onToggle={
                    threadLocked
                      ? undefined
                      : (mode) =>
                          void toggleBookmark({
                            target: {
                              kind: "message",
                              threadId: nav.thread.id,
                              messageId: comment.id,
                            },
                            mode,
                          })
                  }
                  onOpen={
                    commentBookmark && props.onOpenPath
                      ? () => props.onOpenPath?.(commentBookmark.destinationPath)
                      : undefined
                  }
                  testId="chats-message-bookmark"
                />
              </>
            }
          />
        </div>
        </AgentColorScope>
        {runRecords[comment.id] ? (
          <RunLine
            run={runRecords[comment.id]}
            askedBy={automationAsking(runRecords[comment.id], messagesById)}
          />
        ) : null}
        {replyCount > 0 ? (
          <ol
            data-testid="chats-replies"
            aria-label={`Replies to ${chatAuthorLabel(comment)}`}
            className={`relative mt-3 list-none p-0 ${
              depth < 3 ? "" : "-ml-[38px]"
            }`}
          >
            {node.replies.map((reply, index) =>
              renderThreadComment(reply, depth + 1, comment, node.replies[index - 1]),
            )}
          </ol>
        ) : null}
      </li>
    );
  };
  return (
    <>
      <AgentColorScope name={chatAuthorLabel(openingMessage)} kind={openingMessage.authorKind} presentation={openingMessage.presentation}>
      <article
        ref={(node) => setMessageNode(openingMessage.id, node)}
        data-testid="chats-message"
        data-message-id={openingMessage.id}
        data-author-kind={openingMessage.authorKind}
        className={`group relative flex gap-2.5 px-2 transition-shadow ${
          flashMessageId === openingMessage.id
            ? "rounded-lg ring-2 ring-agent/30 ring-offset-2 ring-offset-bg"
            : ""
        }`}
      >
        <p
          data-testid="chats-thread-eyebrow"
          className="sr-only"
        >
          {nav.channel.kind === "agent"
            ? "My agent · thread"
            : `#${nav.channel.name} · thread`}
        </p>
        <AgentColorAvatar>
          <ChatAvatar presentation={openingMessage.presentation}
            name={openingMessage.authorDisplayName}
            kind={openingMessage.authorKind}
            size="row"
          />
        </AgentColorAvatar>
        <div className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5 leading-[18px]">
            <span
              data-testid="chats-message-author"
              data-author-kind={openingMessage.authorKind}
              className="truncate text-[13px] font-semibold text-ink"
            >
              <AgentName kind={openingMessage.authorKind} presentation={openingMessage.presentation}>
                <AgentColorName>{chatAuthorLabel(openingMessage)}</AgentColorName>
              </AgentName>
            </span>
            {openingIsAgent ? <AgentBadge testIdPrefix="chats-message" author={openingMessage} viewerAuthorId={reactionControls.viewerAuthorId} presentation={openingMessage.presentation} /> : null}
            {openingMessage.authorKind === "link" ? <LinkHolderMark testId="chats-message-link-holder" /> : null}
            {openingMessage.authorKind === "automation" ? (
              <AutomationBadge
                testIdPrefix="chats-message"
                author={openingMessage}
                viewerAuthorId={reactionControls.viewerAuthorId}
                onOpenPath={props.onOpenPath}
              />
            ) : null}
            <span className="truncate text-[11px] tabular-nums text-subtle">
              {nav.channel.kind === "agent" ? "My agent" : `#${nav.channel.name}`}
            </span>
            <time
              data-testid="chats-message-time"
              dateTime={openingTime.iso}
              title={openingTime.label}
              className="shrink-0 text-[11px] tabular-nums text-subtle"
            >
              {formatShortTime(openingMessage.createdAtMs)}
            </time>
          </span>
          <h1
            data-testid="chats-thread-post-title"
            className={hasExplicitTitle ? "mb-0 mt-1 text-[16px] font-semibold leading-[22px] text-ink" : "sr-only"}
          >
            {nav.thread.title}
          </h1>
          {/* A plain post is its body; the title above repeats it for the
              heading only. */}
          <p
            data-testid="chats-message-body"
            className="mb-0 mt-1 select-text cursor-text whitespace-pre-wrap break-words text-[14px] leading-[22px] text-ink"
          >
            <MentionText
              body={openingMessage.body}
              candidates={mentionCandidates}
              attachments={openingAttachments}
              testId="chats-message-body"
              onOpenPath={props.onOpenPath}
            />
          </p>
          {openingAttachments.length > 0 ? (
            <div
              data-testid="chats-message-attachments"
              className="mt-3 flex flex-wrap items-center gap-1.5"
            >
              {openingAttachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.attachmentId}
                  attachment={attachment}
                  onOpenPath={props.onOpenPath}
                />
              ))}
            </div>
          ) : null}
          {openingDecision || runRecords[openingMessage.id] ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {openingDecision ? (
                <DecisionStatus
                  decision={openingDecision}
                  onResolve={
                    !threadLocked && openingDecision.state === "open"
                      ? (option) => beginResolve(openingMessage, option)
                      : undefined
                  }
                  testIdPrefix="chats-message"
                />
              ) : null}
              {runRecords[openingMessage.id] ? (
                <RunOpening
                  run={runRecords[openingMessage.id]}
                  askedBy={automationAsking(runRecords[openingMessage.id], messagesById)}
                />
              ) : null}
            </div>
          ) : null}
          <MessageReactions
            testIdPrefix="chats"
            messageId={openingMessage.id}
            records={reactionsByMessage.get(openingMessage.id) ?? []}
            controls={reactionControls}
            hoverToolbar
            toolbarActions={
              <SaveAsFileActions
                testIdPrefix="chats-message-bookmark"
                bookmark={openingBookmark}
                busy={bookmarkBusy.has(`message:${openingMessage.id}`)}
                onToggle={
                  threadLocked
                    ? undefined
                    : (mode) =>
                        void toggleBookmark({
                          target: {
                            kind: "message",
                            threadId: nav.thread.id,
                            messageId: openingMessage.id,
                          },
                          mode,
                        })
                }
                onOpen={
                  openingBookmark && props.onOpenPath
                    ? () => props.onOpenPath?.(openingBookmark.destinationPath)
                    : undefined
                }
              />
            }
          />
        </div>
      </article>
      </AgentColorScope>

      <div
        data-testid="chats-comments-divider"
        className="mb-3.5 mt-[18px] flex items-center gap-2 px-2 text-[11px] tabular-nums text-subtle before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line"
      >
        <span className="inline-flex items-center gap-1">
          <MessageSquare size={12} strokeWidth={1.9} aria-hidden />
          <span aria-hidden>{commentCount}</span>
          <span className="sr-only">{`${commentCount} ${commentCount === 1 ? "comment" : "comments"}`}</span>
        </span>
      </div>

      <ol data-testid="chats-comments" className="m-0 list-none px-2 py-0">
        {commentTree.map((node, index) => renderThreadComment(node, 0, null, commentTree[index - 1]))}
      </ol>
    </>
  );
});
