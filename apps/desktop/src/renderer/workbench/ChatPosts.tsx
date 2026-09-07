import { Bookmark, Copy, FileText } from "lucide-react";
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
import {
  MentionText,
  MessageReactions,
  chatAuthorLabel,
  type ChatReactionControls,
} from "./chatMessages";
import { UnreadPill } from "./ChatsControls";
import type { ChatsNav } from "./ChatsView";

type FeedOpeningMessage = Omit<
  NonNullable<ChannelThreadRecord["openingMessage"]>,
  "reactions"
>;

export interface FeedPostData {
  openingMessage: FeedOpeningMessage | null;
  reactions: ChatReactionRecord[];
  viewerAuthorId: string;
}

interface ThreadCommentNode {
  message: ChatMessageRecord;
  replies: ThreadCommentNode[];
}

// The store keeps the true parent id for every reply. Turn the chronological
// message stream into a display tree without trusting malformed relationships:
// missing parents, self-links, and cycles stay visible as top-level comments.
function buildThreadCommentTree(
  openingMessageId: string,
  comments: readonly ChatMessageRecord[],
): ThreadCommentNode[] {
  const nodes: ThreadCommentNode[] = comments.map((message) => ({
    message,
    replies: [],
  }));
  const byId = new Map(nodes.map((node) => [node.message.id, node]));
  const roots: ThreadCommentNode[] = [];

  const createsCycle = (messageId: string, parentId: string): boolean => {
    const seen = new Set([messageId]);
    let cursor: string | undefined = parentId;
    while (cursor && cursor !== openingMessageId) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      cursor = byId.get(cursor)?.message.parentMessageId;
    }
    return false;
  };

  for (const node of nodes) {
    const parentId = node.message.parentMessageId;
    const parent =
      parentId && parentId !== openingMessageId ? byId.get(parentId) : undefined;
    if (parent && !createsCycle(node.message.id, parentId!)) {
      parent.replies.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function pathBasename(pathHint: string | undefined): string {
  if (!pathHint) return "attachment";
  return basenameOf(pathHint.replace(/\\/g, "/").replace(/\/+$/, "")) || "attachment";
}

function AgentBadge(props: { testIdPrefix: string }) {
  return (
    <span
      data-testid={`${props.testIdPrefix}-agent-badge`}
      className="rounded border border-agent/40 px-1 font-mono text-[10px] text-agent"
    >
      agent
    </span>
  );
}

function DecisionStatus(props: {
  decision: ChatDecisionRecord;
  onResolve?: () => void;
  testIdPrefix: string;
}) {
  if (props.decision.state === "resolved") {
    return (
      <span
        data-testid={`${props.testIdPrefix}-decision-resolved`}
        className="rounded-md border border-success/40 bg-success/10 px-1.5 py-0.5 font-mono text-[10px] text-success"
      >
        resolved
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span
        data-testid={`${props.testIdPrefix}-decision-open`}
        className="rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning"
      >
        needs decision
      </span>
      {props.onResolve ? (
        <button
          type="button"
          data-testid={`${props.testIdPrefix}-decision-resolve`}
          onClick={props.onResolve}
          className="rounded px-1 py-0.5 font-mono text-[10px] text-subtle hover:text-ink dohc-focus-visible"
        >
          Resolve
        </button>
      ) : null}
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

// A derived title repeats the body's first line; the card already shows it
// in serif, so the excerpt starts after it.
function postExcerpt(title: string, body: string): string {
  const newline = body.indexOf("\n");
  const firstLine = (newline === -1 ? body : body.slice(0, newline)).trim();
  if (firstLine !== title.trim()) return body;
  return newline === -1 ? "" : body.slice(newline + 1).trim();
}

export function PostCard(props: {
  thread: ChannelThreadRecord;
  data: FeedPostData;
  reactionControls: ChatReactionControls;
  onOpen: () => void;
  bookmark?: ChatBookmarkRecord;
  bookmarkBusy?: boolean;
  onToggleBookmark?: (mode: "live" | "snapshot") => void;
  onOpenBookmark?: () => void;
}) {
  const message = props.data.openingMessage;
  const isAgent = message?.authorKind === "agent";
  const time = formatChatTime(message?.createdAtMs ?? props.thread.createdAtMs);
  const commentCount = Math.max(0, props.thread.messageCount - 1);
  const excerpt = message ? postExcerpt(props.thread.title, message.bodySnippet) : "";
  return (
    <li
      data-testid="chats-post-card"
      data-thread-id={props.thread.id}
      data-author-kind={message?.authorKind ?? "unknown"}
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onOpen();
        }
      }}
      style={
        isAgent
          ? { borderLeftColor: "color-mix(in oklab, var(--dohc-agent) 55%, var(--dohc-line))" }
          : undefined
      }
      className={`group cursor-pointer rounded-xl border border-line bg-panel px-4 py-3 text-left transition-[border-color,transform] hover:-translate-y-px hover:border-muted/50 dohc-focus-visible ${
        isAgent ? "border-l-2" : ""
      }`}
    >
      {/* Compatibility target retained for existing navigation/e2e drivers;
          the card itself is the new semantic button. */}
      <div data-testid="chats-thread" data-thread-id={props.thread.id}>
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span
            data-testid="chats-post-author"
            className={`text-[13px] font-medium ${isAgent ? "text-agent" : "text-ink"}`}
          >
            {message ? chatAuthorLabel(message) : "Unknown author"}
          </span>
          {isAgent ? <AgentBadge testIdPrefix="chats-post" /> : null}
          <time
            data-testid="chats-post-time"
            dateTime={time.iso}
            title={time.iso}
            className="font-mono text-[10px] text-subtle"
          >
            {time.label}
          </time>
          <span className="ml-auto">
            <UnreadPill count={props.thread.unreadCount} testId="chats-thread-unread" />
          </span>
        </span>
        <span
          data-testid="chats-post-title"
          className="mt-1.5 block text-balance font-serif text-[17px] font-semibold leading-snug text-ink"
        >
          {props.thread.title}
        </span>
        {excerpt ? (
          <span
            data-testid="chats-post-excerpt"
            className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-[13px] text-muted"
          >
            {excerpt}
          </span>
        ) : null}
      </div>
      <div
        data-testid="chats-post-footer"
        className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-line pt-2.5"
      >
        {message ? (
          <MessageReactions
            testIdPrefix="chats-post"
            messageId={message.id}
            records={props.data.reactions.filter((reaction) => reaction.messageId === message.id)}
            controls={props.reactionControls}
            flush
          />
        ) : null}
        {(props.thread.openDecisionCount ?? 0) > 0 ? (
          <span
            data-testid="chats-post-decision-open"
            className="rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning"
          >
            needs decision
          </span>
        ) : null}
        <span className="min-w-2 flex-1" />
        {props.onToggleBookmark || (props.bookmark && props.onOpenBookmark) ? (
          <BookmarkAction
            active={Boolean(props.bookmark)}
            busy={props.bookmarkBusy}
            destinationPath={props.bookmark?.destinationPath}
            onToggle={props.onToggleBookmark}
            onOpen={props.onOpenBookmark}
            testId="chats-post-bookmark"
          />
        ) : null}
        <span
          data-testid="chats-post-comment-count"
          className="font-mono text-[11px] text-subtle"
        >
          {commentCount} {commentCount === 1 ? "comment" : "comments"}
        </span>
      </div>
    </li>
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
          {!props.active ? (
            <button
              type="button"
              data-testid={`${props.testId}-snapshot`}
              aria-label="Bookmark chat as snapshot"
              title="Bookmark as a static Markdown snapshot"
              disabled={props.busy}
              onClick={(event) => {
                event.stopPropagation();
                props.onToggle?.("snapshot");
              }}
              className="rounded px-1.5 py-1 font-mono text-[9px] text-subtle hover:bg-line/50 hover:text-ink dohc-focus-visible disabled:opacity-50"
            >
              snapshot
            </button>
          ) : null}
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
  beginResolve: (message: ChatMessageRecord) => void;
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
        className={`group flex min-w-0 flex-col transition-shadow ${
          flashMessageId === comment.id
            ? "rounded-xl ring-2 ring-agent/30 ring-offset-2 ring-offset-bg"
            : ""
        }`}
      >
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
            className="mb-1 w-fit rounded px-2 text-left font-mono text-[10px] text-subtle hover:text-ink dohc-focus-visible"
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
          className={`w-fit max-w-[92%] rounded-xl border border-line bg-panel-2 px-3.5 py-2 ${
            isAgent ? "border-l-2" : ""
          }`}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              data-testid="chats-message-author"
              data-author-kind={comment.authorKind}
              className={`text-[13px] font-semibold ${
                isAgent ? "text-agent" : "text-ink"
              }`}
            >
              {chatAuthorLabel(comment)}
            </span>
            {isAgent ? <AgentBadge testIdPrefix="chats-comment" /> : null}
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
                    ? () => beginResolve(comment)
                    : undefined
                }
                testIdPrefix="chats-comment"
              />
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3 px-2 pt-1 font-mono text-[11px] text-subtle">
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
              className="rounded hover:text-ink dohc-focus-visible"
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
          {runRecords[comment.id] ? <RunChip run={runRecords[comment.id]} /> : null}
          <time
            data-testid="chats-message-time"
            dateTime={commentTime.iso}
            title={commentTime.iso}
          >
            {commentTime.label}
          </time>
        </div>
        {replyCount > 0 ? (
          <ol
            data-testid="chats-replies"
            aria-label={`Replies to ${chatAuthorLabel(comment)}`}
            className={`relative mt-3 list-none space-y-3 border-l border-line/80 p-0 pl-3 sm:pl-4 ${
              depth < 3 ? "ml-3 sm:ml-5" : "ml-0"
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
        className={`group pt-5 transition-shadow ${
          flashMessageId === openingMessage.id
            ? "rounded-lg ring-2 ring-agent/30 ring-offset-2 ring-offset-bg"
            : ""
        }`}
      >
        <p
          data-testid="chats-thread-eyebrow"
          className="m-0 font-mono text-[10px] uppercase tracking-wide text-subtle"
        >
          {nav.channel.kind === "agent"
            ? "My agent · thread"
            : `#${nav.channel.name} · thread`}
        </p>
        <h1
          data-testid="chats-thread-post-title"
          className="mb-0 mt-2 text-balance font-serif text-[22px] font-semibold leading-tight text-ink"
        >
          {nav.thread.title}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span
            data-testid="chats-message-author"
            data-author-kind={openingMessage.authorKind}
            className={`text-[13px] font-medium ${
              openingMessage.authorKind === "agent" ? "text-agent" : "text-ink"
            }`}
          >
            {chatAuthorLabel(openingMessage)}
          </span>
          {openingMessage.authorKind === "agent" ? (
            <AgentBadge testIdPrefix="chats-message" />
          ) : null}
          <time
            data-testid="chats-message-time"
            dateTime={openingTime.iso}
            title={openingTime.iso}
            className="font-mono text-[10px] text-subtle"
          >
            {openingTime.label}
          </time>
        </div>
        <p
          data-testid="chats-message-body"
          className="mb-0 mt-3 select-text cursor-text whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink"
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
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
                  ? () => beginResolve(openingMessage)
                  : undefined
              }
              testIdPrefix="chats-message"
            />
          ) : null}
          {runRecords[openingMessage.id] ? (
            <RunChip run={runRecords[openingMessage.id]} />
          ) : null}
          <BookmarkAction
            active={Boolean(openingBookmark)}
            busy={bookmarkBusy.has(`message:${openingMessage.id}`)}
            destinationPath={openingBookmark?.destinationPath}
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
            testId="chats-message-bookmark"
          />
        </div>
      </article>

      <div
        data-testid="chats-comments-divider"
        className="mb-1 mt-5 flex items-center gap-2"
      >
        <span className="font-mono text-[10px] uppercase tracking-wide text-subtle">
          Comments
        </span>
        <span aria-hidden className="h-px flex-1 bg-line" />
      </div>

      <ol data-testid="chats-comments" className="m-0 list-none space-y-3 p-0 pt-2">
        {commentTree.map((node) => renderThreadComment(node, 0, null))}
      </ol>
      <div ref={messagesEndRef} />
    </>
  );
});
