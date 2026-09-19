import { AgentBadge } from "./AgentBadge";
import { CircleHelp, FileText, MessageSquare, Save, SmilePlus } from "lucide-react";
import type { ChannelThreadRecord, ChatBookmarkRecord, ChatReactionRecord } from "../../ipc/bridgeContract";
import { formatChatTime } from "../time";
import { ChatAvatar } from "./ChatAvatar";
import { chatAuthorLabel, type ChatReactionControls } from "./chatMessages";
import { UnreadPill } from "./ChatsControls";

// A post in a group's feed. Drawn like a social card: who, where, when; the
// title or the text; a social line; then Like, Comment, Save as file. The
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

// A derived title repeats the body's first line. The card shows the title
// once, so the text starts after it.
export function postExcerpt(title: string, body: string): string {
  const newline = body.indexOf("\n");
  const firstLine = (newline === -1 ? body : body.slice(0, newline)).trim();
  if (firstLine !== title.trim()) return body;
  return newline === -1 ? "" : body.slice(newline + 1).trim();
}

export const LIKE_EMOJI = "👍";

export function ActionButton(props: {
  testId?: string;
  label: string;
  icon: React.ReactNode;
  count?: number;
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
      className={`flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium transition-colors duration-75 dohc-focus-visible disabled:cursor-default disabled:opacity-50 ${
        props.active ? "text-accent" : "text-muted hover:bg-panel-2 hover:text-ink"
      }`}
    >
      {props.icon}
      <span className="truncate @[360px]:inline hidden">{props.label}</span>
      {props.count ? (
        <span className="font-mono text-[11px] font-normal text-subtle">{props.count}</span>
      ) : null}
    </button>
  );
}

// Save as file, with the snapshot alternative on hover, or Open file once
// saved. Shared by the post card and Home so the two read the same.
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
          icon={<Save size={15} strokeWidth={1.9} aria-hidden />}
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
      {!props.bookmark ? (
        <button
          type="button"
          data-testid={`${props.testIdPrefix}-snapshot`}
          aria-label="Bookmark chat as snapshot"
          title="Save a snapshot instead of a live file"
          disabled={props.busy}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggle?.("snapshot");
          }}
          className="grid h-8 w-7 shrink-0 place-items-center rounded-md font-mono text-[10px] text-subtle opacity-0 transition-opacity hover:bg-panel-2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 dohc-focus-visible disabled:opacity-50"
        >
          snap
        </button>
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
  const excerpt = message ? postExcerpt(props.thread.title, message.bodySnippet) : "";
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
  const liked = reactions.some(
    (reaction) =>
      reaction.emoji === LIKE_EMOJI && reaction.authorId === props.data.viewerAuthorId,
  );
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
      className="group @container cursor-pointer rounded-xl border border-line bg-panel px-4 pb-1 pt-3.5 text-left transition-colors duration-75 hover:border-muted/50 dohc-focus-visible"
    >
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
          className={`mt-2.5 block whitespace-pre-wrap break-words text-ink ${
            plain
              ? "text-[15px] leading-relaxed"
              : "text-[16px] font-semibold leading-snug tracking-[-0.01em]"
          }`}
        >
          {props.thread.title}
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

      {/* Social line: who reacted, how many comments. Empty when nothing has
          happened yet, so a fresh post is just its words. */}
      {byEmoji.size > 0 || commentCount > 0 ? (
        <div
          data-testid="chats-post-footer"
          className="mt-2.5 flex items-center gap-2 py-1.5 text-[12px] text-subtle"
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
          <span className="flex-1" />
          <span data-testid="chats-post-comment-count" className="font-mono text-[11px]">
            {commentCount} {commentCount === 1 ? "comment" : "comments"}
          </span>
        </div>
      ) : (
        <span data-testid="chats-post-footer" className="block h-2.5" />
      )}

      <div className="flex items-stretch border-t border-line">
        <ActionButton
          testId="chats-post-like"
          label="Like"
          icon={<SmilePlus size={15} strokeWidth={1.9} aria-hidden />}
          active={liked}
          disabled={readOnly}
          onClick={() => {
            if (!message) return;
            props.reactionControls.onToggle({
              messageId: message.id,
              emoji: LIKE_EMOJI,
              nextState: liked ? "removed" : "added",
            });
          }}
        />
        <ActionButton
          testId="chats-post-comment"
          label="Comment"
          icon={<MessageSquare size={15} strokeWidth={1.9} aria-hidden />}
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
