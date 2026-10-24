import { AgentBadge } from "./AgentBadge";
import { AutomationBadge } from "./AutomationBadge";
import { Bookmark, CircleHelp, FileText, MessageSquare } from "lucide-react";
import type { ChannelThreadRecord, ChatBookmarkRecord, ChatReactionRecord } from "../../ipc/bridgeContract";
import { formatChatTime, formatShortTime } from "../time";
import { AgentName, ChatAvatar, LinkHolderMark } from "./ChatAvatar";
import { neutralPresentation } from "./actorPresentation";
import { chatAuthorLabel, MessageReactions, RowToolbar, TOOLBAR_BUTTON, type ChatReactionControls } from "./chatMessages";
import { UnreadPill } from "./ChatsControls";

// A post in a group's feed, drawn as a row: who and when on one line, the
// title or the text, then a meta line with reactions, an open poll, and the
// comment count when there are any. Add reaction, Comment, and Save as file
// sit in a toolbar shown on hover and focus. The whole row opens the post.
// Controls inside stop the click so a reaction never also opens it.
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

// A feed row: a hairline under each row but the last, and on hover the
// hover fill with the hairline gone. PostFeedList marks the last row.
export const FEED_ROW =
  "group relative border-b border-line px-2 py-3 transition-colors duration-75 hover:rounded-lg hover:border-transparent hover:bg-hover in-data-[feed-last]:border-transparent";
// Where a feed row's toolbar floats: level with the name line and clear of
// the unread count. The list paints each row in its own box, so the
// toolbar stays inside the row rather than over its top edge.
export const FEED_TOOLBAR = "top-1 right-9";
// Home's rows have no unread count, so their toolbar sits at the row's edge.
export const HOME_TOOLBAR = "top-1 right-2";
// A feed row's meta line: reactions and counts in the mono voice.
export const FEED_META = "mt-1.5 flex flex-wrap items-center gap-3 font-mono text-[11px] text-subtle";

// One icon button in a row's toolbar.
export function ActionButton(props: {
  testId?: string;
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      title={props.label}
      aria-label={props.label}
      className={`${TOOLBAR_BUTTON} ${props.active ? "text-accent" : "text-muted"}`}
    >
      {props.icon}
      <span className="sr-only">{props.label}</span>
    </button>
  );
}

// A reaction pill on a feed row: the emoji and its count. Who reacted is
// its tooltip.
export function FeedReactionPill(props: {
  testId: string;
  emoji: string;
  count: number;
  title?: string;
  mine?: boolean;
  disabled?: boolean;
  pending?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      data-emoji={props.emoji}
      data-mine={props.mine}
      aria-label={`${props.emoji} ${props.count}`}
      aria-pressed={props.mine}
      aria-disabled={props.pending || undefined}
      title={props.title}
      disabled={props.disabled}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick(event);
      }}
      className="inline-flex items-center gap-1 rounded-full border border-line bg-bg px-1.5 font-sans text-[11px] leading-5 text-muted hover:border-accent/60 dohc-focus-visible disabled:cursor-default aria-disabled:cursor-default aria-disabled:opacity-50"
    >
      <span aria-hidden>{props.emoji}</span>
      <span className="tabular-nums">{props.count}</span>
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
          icon={<Bookmark size={14} strokeWidth={1.9} fill={props.bookmark ? "currentColor" : "none"} aria-hidden />}
          active={Boolean(props.bookmark)}
          disabled={props.busy}
          onClick={() => props.onToggle?.("live")}
        />
      ) : null}
      {props.bookmark && props.onOpen ? (
        <ActionButton
          testId={`${props.testIdPrefix}-open`}
          label="Open file"
          icon={<FileText size={14} strokeWidth={1.9} aria-hidden />}
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
  onOpenPath?: (path: string) => void;
}) {
  const message = props.data.openingMessage;
  const isAgent = message?.authorKind === "agent";
  const createdAtMs = message?.createdAtMs ?? props.thread.createdAtMs;
  const time = formatChatTime(createdAtMs);
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
  const actions = (
    <>
      <ActionButton
        testId="chats-post-comment"
        label="Comment"
        icon={<MessageSquare size={14} strokeWidth={1.9} aria-hidden />}
        onClick={props.onOpen}
      />
      <SaveAsFileActions
        testIdPrefix="chats-post-bookmark"
        bookmark={props.bookmark}
        busy={props.bookmarkBusy}
        onToggle={props.onToggleBookmark}
        onOpen={props.onOpenBookmark}
      />
    </>
  );

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
      className={`${FEED_ROW} cursor-pointer text-left dohc-focus-visible focus-visible:rounded-lg focus-visible:-outline-offset-2`}
    >
      {/* Compatibility target retained for existing navigation and e2e
          drivers. The row itself is the semantic button. */}
      <div data-testid="chats-thread" data-thread-id={props.thread.id} className="flex items-start gap-3">
        <ChatAvatar presentation={message?.presentation ?? neutralPresentation}
          name={message?.authorDisplayName ?? "?"}
          kind={message?.authorKind ?? "human"}
          size="row"
        />
        <div className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5 leading-[18px]">
            <span
              data-testid="chats-post-author"
              className="truncate text-[13px] font-semibold text-ink"
            >
              {message ? (
                <AgentName kind={message.authorKind} presentation={message.presentation}>{chatAuthorLabel(message)}</AgentName>
              ) : "Unknown author"}
            </span>
            {isAgent ? (
              <AgentBadge testIdPrefix="chats-post" author={message!} viewerAuthorId={props.data.viewerAuthorId} presentation={message!.presentation} />
            ) : null}
            {message?.authorKind === "link" ? <LinkHolderMark testId="chats-post-link-holder" /> : null}
            {message?.authorKind === "automation" ? (
              <AutomationBadge
                testIdPrefix="chats-post"
                author={message}
                viewerAuthorId={props.data.viewerAuthorId}
                onOpenPath={props.onOpenPath}
              />
            ) : null}
            {props.groupLabel ? (
              <span className="truncate font-mono text-[11px] text-subtle">{props.groupLabel}</span>
            ) : null}
            <time
              data-testid="chats-post-time"
              dateTime={time.iso}
              title={time.label}
              className="shrink-0 font-mono text-[11px] text-subtle"
            >
              {formatShortTime(createdAtMs)}
            </time>
          </span>
          <span
            data-testid="chats-post-title"
            className={`mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-ink ${
              plain ? "text-[14px] leading-[21px]" : "text-[14px] font-semibold leading-5"
            }`}
          >
            {heading}
          </span>
          {excerpt ? (
            <span
              data-testid="chats-post-excerpt"
              className="mt-px line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-5 text-muted"
            >
              {excerpt}
            </span>
          ) : null}
          {byEmoji.size > 0 || openDecision || commentCount > 0 ? (
            <div data-testid="chats-post-footer" className={FEED_META}>
              {[...byEmoji.entries()].map(([emoji, records]) => {
                const mine = records.some((r) => r.authorId === props.data.viewerAuthorId);
                return (
                  <FeedReactionPill
                    key={emoji}
                    testId="chats-post-reaction-pill"
                    emoji={emoji}
                    count={records.length}
                    mine={mine}
                    title={records.map((record) => chatAuthorLabel(record)).join(", ")}
                    disabled={readOnly}
                    onClick={() => {
                      if (!message) return;
                      props.reactionControls.onToggle({
                        messageId: message.id,
                        emoji,
                        nextState: mine ? "removed" : "added",
                      });
                    }}
                  />
                );
              })}
              {openDecision ? (
                <span
                  data-testid="chats-post-decision-open"
                  role="img"
                  aria-label="Poll open"
                  title="Poll open"
                  className="inline-flex text-muted"
                >
                  <CircleHelp size={13} strokeWidth={1.9} aria-hidden />
                </span>
              ) : null}
              {commentCount > 0 ? (
                <span
                  data-testid="chats-post-comment-count"
                  role="img"
                  aria-label={`${commentCount} ${commentCount === 1 ? "comment" : "comments"}`}
                  className="inline-flex items-center gap-1 tabular-nums"
                >
                  <MessageSquare size={13} strokeWidth={1.9} aria-hidden />
                  {commentCount}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <UnreadPill count={props.thread.unreadCount} testId="chats-thread-unread" tone="quiet" />
      </div>
      {/* Add reaction, Comment, and Save as file, in that order, so Save as
          file stays the row's last stop before the next row. */}
      {message ? (
        <MessageReactions
          testIdPrefix="chats-post"
          actionTestId="chats-post-like"
          pickerOnly
          hoverToolbar
          toolbarClassName={FEED_TOOLBAR}
          toolbarActions={actions}
          messageId={message.id}
          records={reactions}
          controls={{ ...props.reactionControls, readOnly }}
        />
      ) : (
        <RowToolbar className={FEED_TOOLBAR}>{actions}</RowToolbar>
      )}
    </div>
  );
}
