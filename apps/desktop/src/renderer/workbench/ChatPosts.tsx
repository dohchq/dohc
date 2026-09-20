import { AgentBadge } from "./AgentBadge";
import { Bookmark, CircleCheck, CircleHelp, Copy, FileText, TriangleAlert } from "lucide-react";
import { memo, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
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
import { bridge } from "../bridge";
import { formatChatTime } from "../time";
import { ChatAvatar } from "./ChatAvatar";
import {
  MentionText,
  MessageReactions,
  chatAuthorLabel,
  type ChatReactionControls,
} from "./chatMessages";
import { SaveAsFileActions } from "./PostCard";
import type { ChatsNav } from "./ChatsView";
import { buildThreadCommentTree, type ThreadCommentNode } from "./threadCommentTree";

function pathBasename(pathHint: string | undefined): string {
  if (!pathHint) return "attachment";
  return basenameOf(pathHint.replace(/\\/g, "/").replace(/\/+$/, "")) || "attachment";
}

// The dispatcher writes a failure as the agent, so the thread has a record.
// It reads as a notice from dohc, never as something the agent said.
function isRunnerFailure(body: string): boolean {
  return body.startsWith("⚠ Agent run failed");
}

// What the agent ran, under its reply: the chip that opens the details,
// with the outcome in a word.
function RunLine(props: { run: ChatRunRecord }) {
  const running = props.run.endedAtMs === undefined;
  const failed = !running && props.run.exitCode !== 0;
  return (
    <div
      data-testid="chats-run-line"
      data-state={running ? "running" : failed ? "failed" : "done"}
      className="mt-1 flex items-center gap-2 px-2 text-[11px] text-subtle"
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${
          running ? "animate-pulse bg-agent" : failed ? "bg-warning" : "bg-success"
        }`}
      />
      <span>{running ? "Running" : failed ? "Failed" : "Done"}</span>
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
                  : "border-line text-ink enabled:hover:bg-panel-2 disabled:opacity-70"
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
  const label = pathBasename(props.attachment.pathHint);
  const title = `${props.attachment.pathHint ?? label}${
    props.attachment.headingText ? `#${props.attachment.headingText}` : ""
  }`;
  const className =
    "inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 px-2 py-0.5 font-mono text-[10px] text-muted";
  const content = (
    <>
      <FileText size={11} aria-hidden className="shrink-0" />
      <span className="max-w-56 truncate">{label}</span>
      {props.attachment.headingText ? (
        <span className="max-w-48 truncate text-subtle">
          #{props.attachment.headingText}
        </span>
      ) : null}
    </>
  );
  if (props.attachment.pathHint && props.onOpenPath) {
    return (
      <button
        type="button"
        data-testid="chats-attachment-chip"
        title={title}
        onClick={() => {
          const path = props.attachment.pathHint ?? "";
          if (props.attachment.headingAnchor) {
            props.onOpenPath?.(path, props.attachment.headingAnchor);
          } else {
            props.onOpenPath?.(path);
          }
        }}
        className={`${className} cursor-pointer hover:border-muted/50 hover:text-ink dohc-focus-visible`}
      >
        {content}
      </button>
    );
  }
  return (
    <span
      data-testid="chats-attachment-chip"
      className={className}
    >
      {content}
    </span>
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
            <span className="font-mono text-[10px] uppercase tracking-wide text-subtle">Command</span>
            <code data-testid="chats-run-command" className="break-words text-[11px] text-ink">
              {props.run.command}
            </code>
          </span>
          <span className="grid grid-cols-2 gap-2">
            <span className="grid gap-0.5">
              <span className="font-mono text-[10px] uppercase tracking-wide text-subtle">Started</span>
              <time
                data-testid="chats-run-started"
                dateTime={started.iso}
                className="font-mono text-[10px] text-muted"
              >
                {started.label}
              </time>
            </span>
            <span className="grid gap-0.5">
              <span className="font-mono text-[10px] uppercase tracking-wide text-subtle">Exit code</span>
              <span data-testid="chats-run-exit-code" className="font-mono text-[10px] text-muted">
                {props.run.exitCode ?? "—"}
              </span>
            </span>
          </span>
          <span className="grid gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-wide text-subtle">Log</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <code data-testid="chats-run-log-path" className="min-w-0 flex-1 break-all text-[10px] text-muted">
                {props.run.logPath ?? "No log path"}
              </code>
              {props.run.logPath ? (
                <button
                  type="button"
                  data-testid="chats-run-copy-log"
                  aria-label="Copy log path"
                  title="Copy log path"
                  onClick={() => {
                    void bridge()
                      .writeClipboardText({ text: props.run.logPath ?? "" })
                      .catch(() => undefined);
                  }}
                  className="grid size-6 shrink-0 place-items-center rounded border border-line text-subtle hover:text-ink dohc-focus-visible"
                >
                  <Copy size={11} aria-hidden />
                </button>
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
          className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink dohc-focus-visible"
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
                ? "text-accent hover:bg-line/50"
                : "text-subtle hover:bg-line/50 hover:text-ink"
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
  messagesEndRef: RefObject<HTMLDivElement | null>;
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
    messagesEndRef,
  } = props;
  if (messagesLoading) {
    return (
      <p className="m-0 pt-4 text-center text-[11px] text-subtle">Loading...</p>
    );
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
  const openingTime = formatChatTime(openingMessage.createdAtMs);
  const openingAttachments = attachmentsByMessage.get(openingMessage.id) ?? [];
  const openingDecision = decisionsByMessage.get(openingMessage.id);
  const openingBookmark = bookmarkFor("message", openingMessage.id);
  const openingIsAgent = openingMessage.authorKind === "agent";
  const commentCount = messages.length - 1;

  // A comment: avatar column, then a bubble that holds the name and body,
  // then the quiet action row, then any replies as a nested list. The DOM
  // shape is what the e2e helpers walk: the bubble is the item's direct
  // child, the action row is a direct div, replies are a sibling ol.
  const renderThreadComment = (
    node: ThreadCommentNode,
    depth: number,
    parent: ChatMessageRecord | null,
  ): ReactNode => {
    const comment = node.message;
    const commentTime = formatChatTime(comment.createdAtMs);
    const commentDecision = decisionsByMessage.get(comment.id);
    const commentAttachments = attachmentsByMessage.get(comment.id) ?? [];
    const isAgent = comment.authorKind === "agent";
    const isSystem = isAgent && isRunnerFailure(comment.body);
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
        className={`group relative flex min-w-0 flex-col pl-9 transition-shadow ${
          flashMessageId === comment.id
            ? "rounded-xl ring-2 ring-agent/30 ring-offset-2 ring-offset-bg"
            : ""
        }`}
      >
        <span className="absolute left-0 top-0">
          {isSystem ? (
            <span
              role="img"
              aria-label="Run failed"
              className="grid size-7 place-items-center rounded-full border border-warning/40 bg-bg text-warning"
            >
              <TriangleAlert size={12} strokeWidth={1.9} aria-hidden />
            </span>
          ) : (
            <ChatAvatar
              name={comment.authorDisplayName}
              kind={comment.authorKind}
              size="comment"
            />
          )}
        </span>
        {parent ? (
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
        <div
          data-testid="chats-comment-bubble"
          style={
            isAgent
              ? {
                  borderLeftColor:
                    "color-mix(in oklab, var(--dohc-agent) 55%, var(--dohc-line))",
                }
              : undefined
          }
          data-system={isSystem ? "true" : undefined}
          className={`w-fit max-w-[92%] rounded-2xl border px-3.5 py-2 ${
            isSystem
              ? "border-dashed border-warning/40 bg-warning/5"
              : isAgent
                ? "border-l-2 border-line bg-bg"
                : "border-line bg-bg"
          }`}
        >
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span
              data-testid="chats-message-author"
              data-author-kind={isSystem ? "system" : comment.authorKind}
              className={`text-[13px] font-semibold ${
                isAgent && !isSystem ? "text-agent" : "text-ink"
              }`}
            >
              {isSystem ? "dohc" : chatAuthorLabel(comment)}
            </span>
            {isAgent && !isSystem ? <AgentBadge testIdPrefix="chats-comment" author={comment} viewerAuthorId={reactionControls.viewerAuthorId} /> : null}
            <time
              data-testid="chats-message-time"
              dateTime={commentTime.iso}
              title={commentTime.iso}
              className="text-[11px] text-subtle"
            >
              {commentTime.label}
            </time>
          </div>
          <p
            data-testid="chats-message-body"
            className="mb-0 mt-0.5 select-text cursor-text whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink"
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
        </div>
        <div className="flex flex-wrap items-center gap-3 px-2 pt-1 text-[11px] text-subtle">
          <MessageReactions
            testIdPrefix="chats"
            messageId={comment.id}
            records={reactionsByMessage.get(comment.id) ?? []}
            controls={reactionControls}
            flush
          />
          {!threadLocked ? (
            <button
              type="button"
              data-testid="chats-comment-reply"
              onClick={() => beginReply(comment)}
              className="rounded font-medium hover:text-ink dohc-focus-visible"
            >
              Reply
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
          {replyCount > 0 ? (
            <span data-testid="chats-reply-count">
              {replyCount} {replyCount === 1 ? "reply" : "replies"}
            </span>
          ) : null}
        </div>
        {runRecords[comment.id] ? <RunLine run={runRecords[comment.id]} /> : null}
        {replyCount > 0 ? (
          <ol
            data-testid="chats-replies"
            aria-label={`Replies to ${chatAuthorLabel(comment)}`}
            className={`relative mt-3 list-none space-y-3 p-0 ${
              depth < 3 ? "" : "-ml-9"
            }`}
          >
            {node.replies.map((reply) =>
              renderThreadComment(reply, depth + 1, comment),
            )}
          </ol>
        ) : null}
      </li>
    );
  };
  return (
    <>
      <article
        ref={(node) => setMessageNode(openingMessage.id, node)}
        data-testid="chats-message"
        data-message-id={openingMessage.id}
        data-author-kind={openingMessage.authorKind}
        className={`group rounded-xl border border-line bg-panel px-4 pb-1 pt-3.5 transition-shadow ${
          flashMessageId === openingMessage.id
            ? "ring-2 ring-agent/30 ring-offset-2 ring-offset-bg"
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
        <div className="flex items-center gap-2.5">
          <ChatAvatar
            name={openingMessage.authorDisplayName}
            kind={openingMessage.authorKind}
          />
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="flex items-center gap-1.5">
              <span
                data-testid="chats-message-author"
                data-author-kind={openingMessage.authorKind}
                className={`truncate text-[14px] font-semibold ${
                  openingIsAgent ? "text-agent" : "text-ink"
                }`}
              >
                {chatAuthorLabel(openingMessage)}
              </span>
              {openingIsAgent ? <AgentBadge testIdPrefix="chats-message" author={openingMessage} viewerAuthorId={reactionControls.viewerAuthorId} /> : null}
            </span>
            <span className="flex items-center gap-1.5 text-[12px] text-subtle">
              <span className="truncate font-mono text-[11px]">
                {nav.channel.kind === "agent" ? "My agent" : `#${nav.channel.name}`}
              </span>
              <span aria-hidden>·</span>
              <time
                data-testid="chats-message-time"
                dateTime={openingTime.iso}
                title={openingTime.iso}
                className="shrink-0"
              >
                {openingTime.label}
              </time>
            </span>
          </div>
        </div>
        <h1
          data-testid="chats-thread-post-title"
          className="sr-only"
        >
          {nav.thread.title}
        </h1>
        {/* A plain post is its body; the title above repeats it for the
            heading only. */}
        <p
          data-testid="chats-message-body"
          className="mb-0 mt-2 select-text cursor-text whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink"
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
        <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-line py-1.5">
          <MessageReactions
            testIdPrefix="chats"
            messageId={openingMessage.id}
            records={reactionsByMessage.get(openingMessage.id) ?? []}
            controls={reactionControls}
            flush
          />
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
            <RunChip run={runRecords[openingMessage.id]} />
          ) : null}
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
        </div>
      </article>

      <div
        data-testid="chats-comments-divider"
        className="mb-1 mt-5 flex items-center gap-2 border-t border-line pt-3"
      >
        <span className="text-[12px] text-subtle">
          {commentCount === 0
            ? "No comments yet"
            : `${commentCount} ${commentCount === 1 ? "comment" : "comments"}`}
        </span>
      </div>

      <ol data-testid="chats-comments" className="m-0 list-none space-y-4 p-0 pt-2">
        {commentTree.map((node) => renderThreadComment(node, 0, null))}
      </ol>
      <div ref={messagesEndRef} />
    </>
  );
});
