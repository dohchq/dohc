import { AgentBadge } from "./AgentBadge";
import { Bookmark, CircleHelp, FileText, MessageSquare } from "lucide-react";
import type { ChannelThreadRecord, ChatBookmarkRecord, ChatReactionRecord } from "../../ipc/bridgeContract";
import { formatChatTime } from "../time";
import { ChatAvatar } from "./ChatAvatar";
import { chatAuthorLabel, MessageReactions, type ChatReactionControls } from "./chatMessages";
import { UnreadPill } from "./ChatsControls";
import { useId } from "react";

// A post in a group's feed. Drawn like a social card: who, where, when; the
// title or the text; then one row of reactions, Comment, Save as file. The
// whole card opens the post. Controls inside stop the click so a reaction
// never also opens it.
//
// Pinned names from the previous card are kept: chats-post-card,
// chats-thread, chats-post-author, chats-post-agent-badge, chats-post-time,
// chats-post-title, chats-post-excerpt, chats-post-footer,
// chats-post-reaction-pill, chats-post-decision-open,
// chats-post-comment-count, chats-post-bookmark, chats-thread-unread.

export type PostOpeningMessage = Omit<
  NonNullable<ChannelThreadRecord["openingMessage"]>,
  "reactions"
>;

export interface PostData {
  openingMessage: PostOpeningMessage | null;
  reactions: ChatReactionRecord[];
  viewerAuthorId: string;
}

// The engine's chat_thread_display_title (chats.rs): an untitled post's title
// is its first line with whitespace runs collapsed, and a line over 80
// characters becomes its first 79, trimmed, plus "…". Characters are Unicode
// scalar values, and whitespace is Rust's char::is_whitespace.
const DERIVED_TITLE_MAX_CHARS = 80;
const RUST_WHITESPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

function derivedTitle(firstLine: string): string {
  const line = firstLine.split(RUST_WHITESPACE).filter(Boolean).join(" ");
  const chars = [...line];
  if (chars.length <= DERIVED_TITLE_MAX_CHARS) return line;
  // The collapsed line's only whitespace is single spaces.
  return `${chars.slice(0, DERIVED_TITLE_MAX_CHARS - 1).join("").replace(/ $/, "")}…`;
}

// Whether a post's title is the one the engine derives from its first line,
// so it repeats the text. An explicit title that ends in "…" is still a
// title; only one identical to the derived title repeats the text.
export function titleRepeatsFirstLine(title: string, firstLine: string): boolean {
  const derived = derivedTitle(firstLine);
  return derived !== "" && title === derived;
}

// The card shows a post's words once: a derived title gives way to the whole
// first line it came from, and the text continues after that line.
export function postText(title: string, body: string): { heading: string; excerpt: string } {
  const newline = body.indexOf("\n");
  const firstLine = (newline === -1 ? body : body.slice(0, newline)).trim();
  if (!titleRepeatsFirstLine(title, firstLine)) return { heading: title, excerpt: body };
  return { heading: firstLine, excerpt: newline === -1 ? "" : body.slice(newline + 1).trim() };
}



export function ActionButton(props: {
  testId?: string;
  label: string;
  icon: React.ReactNode;
  count?: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  // The pinned label stays the name; the count describes it.
  const countId = useId();
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-pressed={props.active}
      aria-describedby={props.count ? countId : undefined}
      disabled={props.disabled}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      title={props.label}
      aria-label={props.label}
      className={`flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-[13px] font-medium transition-colors duration-75 dohc-focus-visible disabled:cursor-default disabled:opacity-50 ${
        props.active ? "text-accent" : "text-muted hover:bg-panel-2 hover:text-ink"
      }`}
    >
      {props.icon}
      <span className="sr-only">{props.label}</span>
      {props.count ? (
        <span id={countId} className="font-mono text-[11px] font-normal tabular-nums text-subtle">{props.count}</span>
      ) : null}
    </button>
  );
}

// Shared by the post card and Home.
export function SaveAsFileActions(props: {
  testIdPrefix: string;
  bookmark?: ChatBookmarkRecord;
  busy?: boolean;
  onToggle?: (mode: "live" | "snapshot") => void;
  onOpen?: () => void;
}) {
  if (!props.onToggle && !(props.bookmark && props.onOpen)) return null;
  return (
    <>
      {props.onToggle ? (
        <ActionButton
          testId={props.testIdPrefix}
          label={props.bookmark ? "Saved" : "Save as file"}
          icon={<Bookmark size={16} strokeWidth={1.9} fill={props.bookmark ? "currentColor" : "none"} aria-hidden />}
          active={Boolean(props.bookmark)}
          disabled={props.busy}
          onClick={() => props.onToggle?.("live")}
        />
      ) : null}
      {props.bookmark && props.onOpen ? (
        <ActionButton
          testId={`${props.testIdPrefix}-open`}
          label="Open file"
          icon={<FileText size={15} strokeWidth={1.9} aria-hidden />}
          onClick={props.onOpen}
        />
      ) : null}

    </>
  );
}

export function PostCard(props: {
  thread: ChannelThreadRecord;
  data: PostData;
  reactionControls: ChatReactionControls;
  onOpen: () => void;
  // Where the post lives, shown under the author when the list spans groups.
  groupLabel?: string;
  bookmark?: ChatBookmarkRecord;
  bookmarkBusy?: boolean;
  onToggleBookmark?: (mode: "live" | "snapshot") => void;
  onOpenBookmark?: () => void;
}) {
  const message = props.data.openingMessage;
  const isAgent = message?.authorKind === "agent";
  const time = formatChatTime(message?.createdAtMs ?? props.thread.createdAtMs);
  const commentCount = Math.max(0, props.thread.messageCount - 1);
  const { heading, excerpt } = message
    ? postText(props.thread.title, message.bodySnippet)
    : { heading: props.thread.title, excerpt: "" };
  const plain = message !== null && excerpt === "";
  const openDecision = (props.thread.openDecisionCount ?? 0) > 0;

  const reactions = message
    ? props.data.reactions.filter((reaction) => reaction.messageId === message.id)
    : [];
  const byEmoji = new Map<string, ChatReactionRecord[]>();
  for (const reaction of reactions) {
    const list = byEmoji.get(reaction.emoji);
    if (list) list.push(reaction);
    else byEmoji.set(reaction.emoji, [reaction]);
  }
  const readOnly = props.reactionControls.readOnly === true || message === null;

  return (
    <div
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
      className="group @container relative cursor-pointer rounded-xl border border-line bg-panel px-4 pb-1 pt-3.5 text-left transition-colors duration-75 hover:border-muted/50 dohc-focus-visible"
    >
      {/* Unread: a bar down the left edge, inset past the corner radius. */}
      {props.thread.unreadCount > 0 ? (
        <span aria-hidden className="absolute inset-y-3 left-0 w-0.5 rounded-full bg-ink" />
      ) : null}
      {/* Compatibility target retained for existing navigation and e2e
          drivers. The card itself is the semantic button. */}
      <div data-testid="chats-thread" data-thread-id={props.thread.id}>
        <div className="flex items-center gap-2.5">
          <ChatAvatar
            name={message?.authorDisplayName ?? "?"}
            kind={isAgent ? "agent" : "human"}
          />
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="flex items-center gap-1.5">
              <span
                data-testid="chats-post-author"
                className={`truncate text-[14px] font-semibold ${
                  isAgent ? "text-agent" : "text-ink"
                }`}
              >
                {message ? chatAuthorLabel(message) : "Unknown author"}
              </span>
              {isAgent ? (
                <AgentBadge testIdPrefix="chats-post" author={message!} viewerAuthorId={props.data.viewerAuthorId} />
              ) : null}
            </span>
            <span className="flex items-center gap-1.5 text-[12px] text-subtle">
              {props.groupLabel ? (
                <span className="truncate font-mono text-[11px]">{props.groupLabel}</span>
              ) : null}
              {props.groupLabel ? <span aria-hidden>·</span> : null}
              <time
                data-testid="chats-post-time"
                dateTime={time.iso}
                title={time.iso}
                className="shrink-0"
              >
                {time.label}
              </time>
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-2">
            {openDecision ? (
              <span
                data-testid="chats-post-decision-open"
                className="inline-flex items-center gap-1 text-[11px] text-warning"
              >
                <CircleHelp size={11} strokeWidth={2} aria-hidden />
                Poll open
              </span>
            ) : null}
            <UnreadPill count={props.thread.unreadCount} testId="chats-thread-unread" />
          </span>
        </div>
        <span
          data-testid="chats-post-title"
          className={`mt-2.5 line-clamp-3 whitespace-pre-wrap break-words text-ink ${
            plain
              ? "text-[15px] leading-relaxed"
              : "text-[16px] font-semibold leading-snug tracking-[-0.01em]"
          }`}
        >
          {heading}
        </span>
        {excerpt ? (
          <span
            data-testid="chats-post-excerpt"
            className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-muted"
          >
            {excerpt}
          </span>
        ) : null}
      </div>

      {/* One row: who reacted and the picker on the left; Comment, with its
          count, and Save as file on the right. In a narrow panel the actions
          wrap under the pills instead of crushing them. */}
      <div
        data-testid="chats-post-footer"
        className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line py-1.5"
      >
        {[...byEmoji.entries()].map(([emoji, records]) => (
          <button
            key={emoji}
            type="button"
            data-testid="chats-post-reaction-pill"
            data-emoji={emoji}
            data-mine={records.some((r) => r.authorId === props.data.viewerAuthorId)}
            aria-label={`${emoji} ${records.length}`}
            title={records.map((record) => chatAuthorLabel(record)).join(", ")}
            disabled={readOnly}
            onClick={(event) => {
              event.stopPropagation();
              if (!message) return;
              const mine = records.some((r) => r.authorId === props.data.viewerAuthorId);
              props.reactionControls.onToggle({
                messageId: message.id,
                emoji,
                nextState: mine ? "removed" : "added",
              });
            }}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-bg px-1.5 text-[11px] leading-5 text-muted hover:border-accent/60 dohc-focus-visible disabled:cursor-default"
          >
            <span aria-hidden>{emoji}</span>
            <span className="tabular-nums">{records.length}</span>
          </button>
        ))}
        {message ? <MessageReactions testIdPrefix="chats-post" actionTestId="chats-post-like" pickerOnly
          messageId={message.id} records={reactions} controls={{ ...props.reactionControls, readOnly }} flush /> : null}
        <span className="flex-1" />
        <ActionButton
          testId="chats-post-comment"
          label="Comment"
          icon={<MessageSquare size={15} strokeWidth={1.9} aria-hidden />}
          count={
            commentCount > 0 ? (
              <span data-testid="chats-post-comment-count">
                {commentCount} {commentCount === 1 ? "comment" : "comments"}
              </span>
            ) : undefined
          }
          onClick={props.onOpen}
        />
        <SaveAsFileActions
          testIdPrefix="chats-post-bookmark"
          bookmark={props.bookmark}
          busy={props.bookmarkBusy}
          onToggle={props.onToggleBookmark}
          onOpen={props.onOpenBookmark}
        />
      </div>
    </div>
  );
}
