import { EMOJI_DATA } from "../editor/emojiData";
import { AgentBadge } from "./AgentBadge";
import { AutomationBadge } from "./AutomationBadge";
import { LegendList, type LegendListRef, type OnViewableItemsChanged } from "@legendapp/list/react";
import { formatChatDay, formatChatTime, formatClock, formatClockDigits, sameChatDay } from "../time";
import { AgentName, ChatAvatar, LinkHolderMark } from "./ChatAvatar";
import { AgentColorAvatar, AgentColorName, AgentColorScope } from "./AgentColorPicker";
import { ComposerSendButton } from "./ComposerSendButton";
import { Ref } from "../ui/Ref";
import { ChatMarkdown } from "./ChatMarkdown";
import { retainChatParser } from "./chatMarkdownWorker";
import { SkeletonRows } from "../ui/SkeletonRows";
import { isComposingKey, isSendKey } from "../ui/keys";
import { SmilePlus } from "lucide-react";
import {
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { useToastsAbove } from "./toastClearance";
import type {
  ChatAttachmentRecord,
  ChatMessageRecord,
  ChatReactionRecord,
} from "../../ipc/bridgeContract";
import {
  findMentions,
  type MentionCandidate,
} from "@dohc/workspace-contracts/chat-mentions";
import {
  extractChatFileReferenceTokens,
  fileReferenceKey,
  resolveFileMentionNavigationTargets,
} from "./chatFileMentions";

// Shared Chats rendering (PR 13, WS-E): the file-rail LinkedChats panel and
// the workspace Chats view render messages and composers through these same
// pieces so authorship display and send affordances can never drift. Test
// ids are prefixed per surface ("linked-chat-*" vs "chats-*") because both
// panels can be mounted at once.

// Names are stored verbatim for both human and agent authors.
export function chatAuthorLabel(
  author: Pick<ChatMessageRecord, "authorKind" | "authorDisplayName">,
): string {
  return author.authorDisplayName;
}

// Renders a message body with @-mention chips. A mention that resolves to a
// known candidate gets a calm inline chip; everything else is plain text, so
// the message reads exactly as written. Whitespace/newlines are preserved by
// the parent's `whitespace-pre-wrap`.
export function MentionText(props: {
  body: string;
  candidates: readonly MentionCandidate[];
  attachments?: readonly ChatAttachmentRecord[];
  testId?: string;
  onOpenPath?: (path: string, headingAnchor?: string) => void;
}) {
  // Classify code ranges once, against the complete message. File chips split
  // the rendered output into pieces, but must not reset Markdown fence state
  // and accidentally turn a handle inside an unmatched/multiline fence into a
  // mention.
  const fileTokens = extractChatFileReferenceTokens(props.body);
  const fileTargets = resolveFileMentionNavigationTargets(
    fileTokens,
    props.attachments ?? [],
  );
  // A file token owns its complete source range. A handle-like substring in a
  // filename is part of the attachment syntax, not a person mention.
  const mentions = findMentions(props.body, props.candidates, { ignoreCode: true }).filter(
    (mention) =>
      !fileTokens.some(
        (token) => mention.start < token.end && mention.end > token.start,
      ),
  );
  const content: ReactNode[] = [];
  let cursor = 0;
  let mentionIndex = 0;
  let fileIndex = 0;
  while (mentionIndex < mentions.length || fileIndex < fileTokens.length) {
    const mention = mentions[mentionIndex];
    const fileToken = fileTokens[fileIndex];
    if (fileToken && (!mention || fileToken.start < mention.start)) {
      if (fileToken.start > cursor) content.push(props.body.slice(cursor, fileToken.start));
      const navigationTarget = fileTargets.get(fileReferenceKey(fileToken)) ?? fileToken;
      const onOpenPath = props.onOpenPath;
      content.push(
        <Ref
          key={`file:${fileToken.start}`}
          path={fileToken.path}
          heading={fileToken.headingAnchor}
          testId={props.testId ? `${props.testId}-file-mention` : undefined}
          onOpen={onOpenPath ? () => onOpenPath(navigationTarget.path, navigationTarget.headingAnchor) : undefined}
        />,
      );
      cursor = fileToken.end;
      fileIndex += 1;
      continue;
    }
    if (!mention) break;
    if (mention.start > cursor) content.push(props.body.slice(cursor, mention.start));
    content.push(
      <span
        key={`mention:${mention.start}`}
        data-testid={props.testId ? `${props.testId}-mention` : undefined}
        data-mention-kind={mention.candidate.kind}
        className="rounded bg-accent/15 px-1 font-medium text-accent"
      >
        {props.body.slice(mention.start, mention.end)}
      </span>,
    );
    cursor = mention.end;
    mentionIndex += 1;
  }
  if (cursor < props.body.length) content.push(props.body.slice(cursor));
  return <>{content}</>;
}

// Common reactions lead the searchable Unicode catalog.
const DEFAULT_REACTION_EMOJIS = ["👍", "❤️", "🎉", "🙌", "😄", "👀", "✅", "🚀"] as const;
// One-click reactions on the row's hover toolbar.
const QUICK_REACTION_EMOJIS = ["👍", "🙌"] as const;
export const TOOLBAR_BUTTON =
  "grid size-7 place-items-center rounded-md transition-colors duration-75 hover:bg-hover hover:text-ink disabled:opacity-50 disabled:cursor-default";

// A row's actions, floating over its top-right corner while the row is
// hovered or holds focus. Only opacity changes, so the row never moves, and
// the buttons stay in the Tab order. An open picker inside keeps it shown.
// Hidden, it takes no pointer, so a click there reaches the row beneath.
const ROW_TOOLBAR =
  "dohc-popover absolute z-10 flex items-center gap-0.5 rounded-md border border-line bg-panel p-0.5 text-muted pointer-events-none opacity-0 transition-opacity duration-75 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-[[popover]]:pointer-events-auto has-[[popover]]:opacity-100";

export function RowToolbar(props: { testId?: string; className?: string; children: ReactNode }) {
  return (
    <div
      data-testid={props.testId}
      className={`${ROW_TOOLBAR} ${props.className ?? "-top-1 right-0"}`}
    >
      {props.children}
    </div>
  );
}

const SINGLE_EMOJI = new RegExp("^(?:\\p{RGI_Emoji}|\\p{Extended_Pictographic})$", "v");

export interface ChatReactionControls {
  // Every active reaction in the open thread (all messages).
  reactions: ChatReactionRecord[];
  // The viewer's own reactor id, so pills can highlight "yours" and toggle.
  viewerAuthorId: string;
  onToggle: (input: {
    messageId: string;
    emoji: string;
    nextState: "added" | "removed";
  }) => void;
  emojiChoices?: readonly string[];
  readOnly?: boolean;
  // A write for this message is in flight. Controls stay focusable and
  // refuse another write until it settles; readOnly is the native refusal.
  pending?: boolean;
}

// Reaction labels use the stored human or agent name.
function reactionerNames(records: readonly ChatReactionRecord[]): string {
  return records.map((record) => chatAuthorLabel(record)).join(", ");
}

// One message's reaction row: existing pills (grouped by emoji) plus an
// add-reaction affordance. Kept obvious — pills show emoji + count, yours are
// highlighted, and the picker searches the Unicode emoji catalog.
export function MessageReactions(props: {
  testIdPrefix: string;
  messageId: string;
  records: readonly ChatReactionRecord[];
  controls: ChatReactionControls;
  flush?: boolean;
  // In a message list the add trigger sits with two quick reactions in a
  // toolbar over the row's top-right corner, shown on hover or focus, so a
  // run of short lines keeps its rhythm. Pills still flow under the body.
  hoverToolbar?: boolean;
  // The row's other actions, after the reaction controls in its toolbar.
  toolbarActions?: ReactNode;
  toolbarClassName?: string;
  actionTestId?: string;
  // Only the add trigger: the host draws its own pills, and its toolbar has
  // no quick reactions.
  pickerOnly?: boolean;
  // The add trigger's element, for a parent whose own pill is about to
  // unmount and needs somewhere in the same message to put focus.
  triggerRef?: (node: HTMLButtonElement | null) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [pickerPosition, setPickerPosition] = useState({ left: 0, top: 0 });
  const pickerId = useId();
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(96);
  const [catalog, setCatalog] = useState<readonly { emoji: string; name: string }[]>([]);
  const emojiNames = useMemo(() => new Map([
    ...catalog.map(({ emoji, name }) => [emoji, name] as const),
    ...EMOJI_DATA.map(({ emoji, shortcode }) => [emoji, shortcode] as const),
  ]), [catalog]);
  useEffect(() => {
    if (!props.controls.readOnly && !props.controls.pending) return;
    // A write began from another control on this message, so the picker's
    // choices would do nothing. It closes; focus moves only if it was inside.
    if (pickerRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    setPickerOpen(false);
  }, [props.controls.pending, props.controls.readOnly]);
  useEffect(() => {
    if (!pickerOpen) return;
    let current = true;
    // Unicode Emoji 16.0, fully-qualified sequences from unicode.org's emoji-test.txt.
    void import("./reactionEmojiData.json").then((data) => { if (current) setCatalog(data.default); });
    return () => { current = false; };
  }, [pickerOpen]);
  const searched = query.trim().toLowerCase().replaceAll(":", "");
  const customEmoji = query.trim();
  const isEmoji = SINGLE_EMOJI.test(customEmoji);
  const choices = pickerOpen ? [...new Set([
    ...(isEmoji ? [customEmoji] : []),
    ...(!searched ? (props.controls.emojiChoices ?? DEFAULT_REACTION_EMOJIS) : []),
    ...EMOJI_DATA.filter((entry) => !searched || entry.shortcode.includes(searched) || entry.keywords.some((word) => word.includes(searched)) || entry.emoji === customEmoji).map((entry) => entry.emoji),
    ...catalog.filter((entry) => !searched || entry.name.toLowerCase().includes(searched) || entry.emoji === customEmoji).map((entry) => entry.emoji),
  ])] : [];

  // Dismiss the picker on an outside pointer press (calm, no modal scrim).
  useEffect(() => {
    if (!pickerOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node) && !pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pickerOpen]);

  // Dismiss on Escape at the DOCUMENT level (not just on the popup): a keyboard
  // user can return to the trigger while the popup is open. Return focus to the trigger on close
  // so the tab order is preserved. Mirrors the outside-pointerdown dismissal.
  useEffect(() => {
    if (!pickerOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPickerOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pickerOpen]);

  useLayoutEffect(() => {
    if (!pickerOpen) return;
    let scrollViewport = triggerRef.current?.parentElement ?? null;
    while (scrollViewport && !/^(auto|scroll)$/.test(getComputedStyle(scrollViewport).overflowY)) {
      scrollViewport = scrollViewport.parentElement;
    }
    const position = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const picker = pickerRef.current?.getBoundingClientRect();
      if (!trigger || !picker) return false;
      const viewport = scrollViewport?.getBoundingClientRect();
      const top = Math.max(0, viewport?.top ?? 0);
      const bottom = Math.min(window.innerHeight, viewport?.bottom ?? window.innerHeight);
      if (trigger.bottom <= top || trigger.top >= bottom) {
        if (pickerRef.current?.contains(document.activeElement)) {
          triggerRef.current?.focus({ preventScroll: true });
        }
        setPickerOpen(false);
        return false;
      }
      setPickerPosition({
        left: Math.max(4, Math.min(trigger.left, window.innerWidth - picker.width - 4)),
        top: Math.max(4, Math.min(trigger.top >= picker.height + 4 ? trigger.top - picker.height - 4 : trigger.bottom + 4, window.innerHeight - picker.height - 4)),
      });
      return true;
    };
    pickerRef.current?.showPopover?.();
    if (!position()) return;
    pickerRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [pickerOpen]);

  // Group this message's reactions by emoji, preserving first-seen order.
  const byEmoji: Array<{ emoji: string; records: ChatReactionRecord[]; mine: boolean }> = [];
  const index = new Map<string, number>();
  for (const record of props.records) {
    let at = index.get(record.emoji);
    if (at === undefined) {
      at = byEmoji.length;
      index.set(record.emoji, at);
      byEmoji.push({ emoji: record.emoji, records: [], mine: false });
    }
    const group = byEmoji[at];
    if (!group) continue;
    group.records.push(record);
    if (record.authorId === props.controls.viewerAuthorId) group.mine = true;
  }

  const toggle = (emoji: string, mine: boolean) => {
    if (props.controls.pending) return;
    props.controls.onToggle({
      messageId: props.messageId,
      emoji,
      nextState: mine ? "removed" : "added",
    });
  };

  const trigger = (
    <button
      ref={(node) => {
        triggerRef.current = node;
        props.triggerRef?.(node);
      }}
      type="button"
      data-testid={props.actionTestId ?? `${props.testIdPrefix}-add-reaction`}
      aria-label="Add reaction"
      disabled={props.controls.readOnly}
      aria-disabled={props.controls.pending || undefined}
      aria-haspopup="true"
      aria-expanded={pickerOpen}
      aria-controls={pickerOpen ? pickerId : undefined}
      title="Add reaction"
      onClick={() => { if (props.controls.pending) return; setQuery(""); setVisibleCount(96); setPickerOpen((open) => !open); }}
      className={`${
        props.hoverToolbar
          ? `${TOOLBAR_BUTTON} text-muted`
          : "grid size-8 place-items-center rounded-md border border-transparent text-muted hover:border-line hover:bg-hover hover:text-ink disabled:opacity-50 disabled:cursor-default"
      } aria-disabled:opacity-50 aria-disabled:cursor-default`}
    >
      <SmilePlus size={16} aria-hidden />
    </button>
  );
  const picker = pickerOpen && !props.controls.readOnly ? (
    // A lightweight quick-pick, not an APG menu: role="group" with plain
    // toggle <button>s (each Tab-stoppable, aria-pressed reflecting the
    // viewer's state). We deliberately don't claim role="menu"/menuitem*,
    // which would promise arrow-key roving semantics we don't implement.
    // Escape (document-level) closes and returns focus to the trigger.
    <div
      ref={pickerRef}
      id={pickerId}
      popover="manual"
      data-chat-escape-local="true"
      style={{ margin: 0, inset: "auto", ...pickerPosition }}
      role="group"
      data-testid={`${props.testIdPrefix}-reaction-picker`}
      aria-label="Choose a reaction"
      className="dohc-popover dohc-pop-in fixed z-50 max-h-[calc(100vh-16px)] w-72 max-w-[calc(100vw-8px)] overflow-y-auto rounded-lg border border-line bg-panel p-2"
    >
      <input aria-label="Search emoji or paste any emoji" placeholder="Search or paste an emoji" value={query}
        onChange={(event) => { setQuery(event.currentTarget.value); setVisibleCount(96); }}
        className="mb-2 w-full rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] text-ink"
        onKeyDown={(event) => { if (event.key === "Enter" && !isComposingKey(event)) { event.preventDefault(); if (choices[0]) { toggle(choices[0], byEmoji.some((group) => group.emoji === choices[0] && group.mine)); setPickerOpen(false); triggerRef.current?.focus(); } } }} />
      <div className="grid h-56 content-start grid-cols-8 gap-0.5 overflow-y-auto">
      {choices.slice(0, visibleCount).map((emoji) => {
        const mine = index.has(emoji) ? (byEmoji[index.get(emoji) as number]?.mine ?? false) : false;
        return (
          <button
            key={emoji}
            type="button"
            aria-pressed={mine}
            data-testid={`${props.testIdPrefix}-reaction-choice`}
            data-emoji={emoji}
            aria-label={emoji}
            title={emojiNames.get(emoji) ?? emoji}
            onClick={() => {
              toggle(emoji, mine);
              setPickerOpen(false);
              triggerRef.current?.focus();
            }}
            className={`grid size-7 place-items-center rounded text-[15px] hover:bg-accent/15 ${
              mine ? "bg-accent/15" : ""
            }`}
          >
            <span aria-hidden>{emoji}</span>
          </button>
        );
      })}
      {choices.length > visibleCount ? <button type="button" className="col-span-8 rounded-md p-2 text-[12px] text-muted hover:bg-hover" onClick={() => setVisibleCount((count) => count + 96)}>More emoji</button> : null}
      </div>
      {choices.length === 0 ? <p className="m-0 p-2 text-[12px] text-muted">No matching emoji. Paste an emoji to use it.</p> : null}
    </div>
  ) : null;

  return (
    <div
      ref={containerRef}
      data-testid={`${props.testIdPrefix}-message-reactions`}
      data-chat-escape-local="true"
      // Channel feed cards are themselves clickable. Keep reaction gestures
      // local so a pill or quick-pick never also opens the post underneath it.
      onClick={(event) => event.stopPropagation()}
      className={
        props.hoverToolbar
          ? props.pickerOnly || byEmoji.length === 0 ? "contents" : "mt-1 flex flex-wrap items-center gap-1"
          : `relative flex flex-wrap items-center gap-1 ${props.flush ? "" : "mt-1"}`
      }
    >
      {!props.pickerOnly && byEmoji.map((group) => (
        <button
          key={group.emoji}
          type="button"
          data-testid={`${props.testIdPrefix}-reaction-pill`}
          data-emoji={group.emoji}
          data-mine={group.mine ? "true" : "false"}
          aria-pressed={group.mine}
          disabled={props.controls.readOnly}
          aria-disabled={props.controls.pending || undefined}
          // The emoji glyph is aria-hidden, so without this the button announces
          // as just its count. Expose emoji + count + reactor names, e.g.
          // "👍 3 — Sam, Nova".
          aria-label={`${group.emoji} ${group.records.length} — ${reactionerNames(group.records)}`}
          title={`${reactionerNames(group.records)} reacted with ${group.emoji}`}
          onClick={() => toggle(group.emoji, group.mine)}
          className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none transition-colors disabled:cursor-default aria-disabled:opacity-50 aria-disabled:cursor-default ${
            group.mine
              ? "border-accent/60 bg-accent/15 text-ink"
              : "border-line bg-bg text-muted hover:border-ink/40 hover:text-ink"
          }`}
        >
          <span aria-hidden>{group.emoji}</span>
          <span className="tabular-nums">{group.records.length}</span>
        </button>
      ))}
      {props.hoverToolbar ? (
        <RowToolbar testId={`${props.testIdPrefix}-message-toolbar`} className={props.toolbarClassName}>
          {(props.pickerOnly ? [] : QUICK_REACTION_EMOJIS).map((emoji) => {
            const mine = byEmoji[index.get(emoji) ?? -1]?.mine ?? false;
            return (
              <button
                key={emoji}
                type="button"
                data-testid={`${props.testIdPrefix}-quick-reaction`}
                data-emoji={emoji}
                aria-pressed={mine}
                aria-label={`React with ${emoji}`}
                title={`React with ${emoji}`}
                disabled={props.controls.readOnly}
                aria-disabled={props.controls.pending || undefined}
                onClick={() => toggle(emoji, mine)}
                className={`${TOOLBAR_BUTTON} text-[13px] leading-none aria-disabled:opacity-50 ${mine ? "bg-accent/15" : ""}`}
              >
                <span aria-hidden>{emoji}</span>
              </button>
            );
          })}
          {trigger}
          {picker}
          {props.toolbarActions}
        </RowToolbar>
      ) : (
        <>
          {trigger}
          {picker}
        </>
      )}
    </div>
  );
}

const GROUP_WINDOW_MS = 5 * 60_000;

export type ChatDensity = "stream" | "thread" | "narrow";

// A row is a face column and the text, at the spacing each place gives it.
// The stream stops text at 720px; a thread's panel is narrower than that.
// A narrow row has no room beside its name, so its hover bar rises above it.
export const DENSITY = {
  stream: {
    row: "grid-cols-[36px_minmax(0,1fr)] gap-x-3 px-5", divider: "mx-5", avatar: "post", name: "text-[14px]", text: "max-w-[720px]", toolbar: "-top-3.5 right-5",
  },
  thread: {
    row: "grid-cols-[36px_minmax(0,1fr)] gap-x-3 px-4", divider: "mx-4", avatar: "post", name: "text-[14px]", text: "", toolbar: "-top-3.5 right-4",
  },
  narrow: {
    row: "grid-cols-[28px_minmax(0,1fr)] gap-x-2.5 px-3", divider: "mx-3", avatar: "comment", name: "text-[13.5px]", text: "", toolbar: "-top-[30px] right-3",
  },
} as const;

// Whether a message continues the run before it: the same author within
// five minutes on the same day.
export function continuesRun(previous: ChatMessageRecord | undefined, message: ChatMessageRecord): boolean {
  return previous !== undefined &&
    sameChatDay(previous.createdAtMs, message.createdAtMs) &&
    previous.authorKind === message.authorKind &&
    previous.presentation.group === message.presentation.group &&
    message.createdAtMs - previous.createdAtMs < GROUP_WINDOW_MS;
}

const EMPTY_MENTION_CANDIDATES: readonly MentionCandidate[] = [];
const messageKeyExtractor = (message: ChatMessageRecord) => message.id;

// The chat lane. Messages from one author within five minutes read as one
// run: the avatar and name once, then bare lines. A divider names each day.
// The time sits in the gutter and shows on hover. Memoized because each body
// re-runs the file-token and mention scans on every render: the hosts keep
// composer drafts in the same component that renders this list, so without
// the boundary every keystroke re-scanned the whole conversation. Callers
// keep every prop referentially stable across unrelated renders (drafts,
// typing indicators) for the memo to hold.
export interface ChatMessageListHandle {
  scrollToEnd: () => void;
  scrollToMessage: (messageId: string) => boolean;
  // The scrolling element while the list is mounted, for hosts that follow
  // the reader's position.
  getScrollableNode: () => HTMLElement | null;
}

export const ChatMessageList = memo(function ChatMessageList(props: {
  testIdPrefix: string;
  messages: ChatMessageRecord[];
  loading: boolean;
  emptyLabel: string;
  listRef?: RefObject<ChatMessageListHandle | null>;
  // When provided, message bodies render @-mention chips for these handles.
  mentionCandidates?: readonly MentionCandidate[];
  // File-reference tokens become navigation buttons when the host can open
  // workspace paths; embedded/read-only hosts keep the same non-interactive chip.
  onOpenPath?: (path: string, headingAnchor?: string) => void;
  // When provided, each message gets a reaction row (pills + quick-pick).
  reactionControls?: ChatReactionControls;
  renderMessageFooter?: (message: ChatMessageRecord) => ReactNode;
  flashMessageId?: string | null;
  // A "New" hairline sits before this message, the first the reader has not seen.
  firstUnreadMessageId?: string | null;
  // Room under the last message, in pixels, that the list always keeps.
  bottomSpace?: number;
  // More buttons on a row's hover bar, after the reactions.
  rowActions?: (message: ChatMessageRecord) => ReactNode;
  // The message whose thread is open beside the list.
  openMessageId?: string | null;
  // A thread's parent comes first; this line divides it from the replies.
  dividerAfterFirst?: string;
  // A row after the last message, such as an agent at work.
  footer?: ReactElement | null;
  // A stream sits at the bottom, above its composer, with a line for each day.
  // A thread reads from the top, without day lines.
  anchor?: "end" | "start";
  // A stream at full width, a thread in its side panel, or a narrow pane.
  density?: ChatDensity;
}) {
  const density = props.density ?? "stream";
  const anchor = props.anchor ?? "end";
  const candidates = props.mentionCandidates ?? EMPTY_MENTION_CANDIDATES;
  // Long messages parse in the chat's worker; start it before they need it.
  useEffect(retainChatParser, []);
  const reactionsByMessage = useMemo(() => {
    const grouped = new Map<string, ChatReactionRecord[]>();
    for (const reaction of props.reactionControls?.reactions ?? []) {
      const records = grouped.get(reaction.messageId);
      if (records) records.push(reaction);
      else grouped.set(reaction.messageId, [reaction]);
    }
    return grouped;
  }, [props.reactionControls?.reactions]);
  const list = useRef<LegendListRef | null>(null);
  const [viewportHeight, setViewportHeight] = useState(700);
  const [focusedMessage, setFocusedMessage] = useState<string | null>(null);
  const [selectedMessages, setSelectedMessages] = useState<string[]>([]);
  const indexes = useMemo(() => new Map(props.messages.map((message, index) => [message.id, index])), [props.messages]);
  useImperativeHandle(props.listRef, () => ({
    scrollToEnd: () => { void list.current?.scrollToEnd({ animated: false }); },
    scrollToMessage(messageId) {
      const index = indexes.get(messageId);
      if (index === undefined) return false;
      void list.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
      return true;
    },
    getScrollableNode: () => list.current?.getScrollableNode() ?? null,
  }), [indexes]);
  // The day of the topmost visible message, pinned over the list while the
  // reader is somewhere in history: neither the first nor the last message is
  // in view. Legend reports viewability once per change of the visible set,
  // and an unchanged label is a no-op update.
  const [topDay, setTopDay] = useState<string | null>(null);
  const messageCount = useRef(props.messages.length);
  messageCount.current = props.messages.length;
  const onViewableItemsChanged = useCallback<NonNullable<OnViewableItemsChanged<ChatMessageRecord>>>((info) => {
    const first = info.viewableItems[0];
    const last = info.viewableItems[info.viewableItems.length - 1];
    const inHistory =
      first !== undefined && first.index > 0 && last !== undefined && last.index < messageCount.current - 1;
    setTopDay(inHistory ? formatChatDay(first.item.createdAtMs) : null);
  }, []);

  const messageKey = useCallback((node: Node | null) => {
    const element = node instanceof Element ? node : node?.parentElement;
    const id = element?.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
    return id && indexes.has(id) ? id : null;
  }, [indexes]);
  useEffect(() => {
    const selectionChanged = () => {
      const selection = document.getSelection();
      const start = messageKey(selection?.anchorNode ?? null);
      const end = messageKey(selection?.focusNode ?? null);
      if (selection?.isCollapsed || !start || !end) {
        setSelectedMessages(current => current.length ? [] : current);
        return;
      }
      const first = indexes.get(start)!;
      const last = indexes.get(end)!;
      const keys = props.messages.slice(Math.min(first, last), Math.max(first, last) + 1).map(message => message.id);
      setSelectedMessages(current => current.length === keys.length && current.every((key, i) => key === keys[i]) ? current : keys);
    };
    document.addEventListener("selectionchange", selectionChanged);
    return () => document.removeEventListener("selectionchange", selectionChanged);
  }, [indexes, props.messages, messageKey]);
  const hasReactionButtons = Boolean(props.reactionControls && !props.reactionControls.readOnly);
  const canOpenPath = props.onOpenPath !== undefined;
  const actionableIndexes = useMemo(() => {
    if (hasReactionButtons || !canOpenPath) return [];
    return props.messages.flatMap((message, index) =>
      extractChatFileReferenceTokens(message.body).length > 0 ? [index] : []);
  }, [props.messages, hasReactionButtons, canOpenPath]);
  const pinned = useMemo(() => {
    const focusedIndex = focusedMessage ? indexes.get(focusedMessage) : undefined;
    const indices: number[] = [];
    if (focusedIndex !== undefined) {
      indices.push(focusedIndex);
      if (hasReactionButtons) {
        if (focusedIndex > 0) indices.push(focusedIndex - 1);
        if (focusedIndex + 1 < props.messages.length) indices.push(focusedIndex + 1);
      } else {
        // Sparse read-only file links can be thousands of messages apart.
        let lower = 0;
        let upper = actionableIndexes.length;
        while (lower < upper) {
          const middle = Math.floor((lower + upper) / 2);
          if (actionableIndexes[middle]! < focusedIndex) lower = middle + 1;
          else upper = middle;
        }
        const previous = actionableIndexes[lower - 1];
        const next = actionableIndexes[lower + (actionableIndexes[lower] === focusedIndex ? 1 : 0)];
        if (previous !== undefined) indices.push(previous);
        if (next !== undefined) indices.push(next);
      }
    }
    return { keys: selectedMessages, indices };
  }, [selectedMessages, focusedMessage, indexes, props.messages.length, hasReactionButtons, actionableIndexes]);

  const renderMessage = useCallback(({ item: message, index: at }: { item: ChatMessageRecord; index: number }) => {
    const previous = at > 0 ? props.messages[at - 1] : undefined;
    const newDay = !previous || !sameChatDay(previous.createdAtMs, message.createdAtMs);
    // The divider under a thread's parent starts a new run.
    const continues = !(props.dividerAfterFirst && at === 1) && continuesRun(previous, message);
    const isAgent = message.authorKind === "agent";
    const time = formatChatTime(message.createdAtMs);
    const reactions = reactionsByMessage.get(message.id) ?? [];
    const open = props.openMessageId === message.id;
    const sizes = DENSITY[density];
    return (
      <li
        key={message.id}
        role="listitem"
        aria-posinset={at + 1}
        aria-setsize={props.messages.length}
        data-testid={`${props.testIdPrefix}-message`}
        data-message-id={message.id}
        data-continues={continues ? "true" : "false"}
        data-open={open ? "true" : undefined}
        className={`relative flex flex-col ${
          props.flashMessageId === message.id ? "ring-2 ring-inset ring-agent/30" : ""
        }`}
      >
        {newDay && anchor === "end" ? (
          <span
            data-testid={`${props.testIdPrefix}-day`}
            className={`${sizes.divider} mb-1.5 mt-2.5 flex items-center gap-3 text-[12px] font-medium text-subtle before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line`}
          >
            {formatChatDay(message.createdAtMs)}
          </span>
        ) : null}
        {props.dividerAfterFirst && at === 1 ? (
          <span
            data-testid={`${props.testIdPrefix}-replies-divider`}
            className={`${sizes.divider} my-2 flex items-center gap-2.5 text-[12px] font-medium text-subtle after:h-px after:flex-1 after:bg-line`}
          >
            {props.dividerAfterFirst}
          </span>
        ) : null}
        {message.id === props.firstUnreadMessageId ? (
          <span
            data-testid={`${props.testIdPrefix}-new-divider`}
            className={`${sizes.divider} my-1.5 flex items-center gap-3 text-[12px] font-medium text-muted before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line`}
          >
            New
          </span>
        ) : null}
        <AgentColorScope name={chatAuthorLabel(message)} kind={message.authorKind} presentation={message.presentation}>
        <div
          className={`group relative grid ${sizes.row} ${continues ? "pt-px" : "pt-1.5"} pb-1 ${
            open ? "bg-hue-blue/10 shadow-[inset_2px_0_0_var(--dohc-hue-blue)]" : "hover:bg-hover keyboard:focus-within:bg-hover"
          }`}
        >
          {/* A continued message's time sits in the face's column, ending at
              its edge, so "12:45" fits at every hour. The full time is its
              tooltip, and a screen reader reads it with AM or PM. */}
          <span className="flex items-start justify-end">
            {continues ? (
              <>
                <time
                  aria-hidden
                  dateTime={time.iso}
                  title={time.label}
                  className="whitespace-nowrap text-[11px] tabular-nums leading-[22px] text-subtle opacity-0 group-hover:opacity-100"
                >
                  {formatClockDigits(message.createdAtMs)}
                </time>
                <span className="sr-only">{formatClock(message.createdAtMs)}</span>
              </>
            ) : (
              <AgentColorAvatar>
                {isAgent ? (
                  // The face marks an agent; hovering it says whose agent.
                  <AgentBadge testIdPrefix={props.testIdPrefix} author={message} presentation={message.presentation}>
                    <ChatAvatar presentation={message.presentation} name={message.authorDisplayName} kind={message.authorKind} size={sizes.avatar} />
                  </AgentBadge>
                ) : (
                  <ChatAvatar presentation={message.presentation}
                    name={message.authorDisplayName}
                    kind={message.authorKind}
                    size={sizes.avatar}
                  />
                )}
              </AgentColorAvatar>
            )}
          </span>
          <div className={`min-w-0 ${sizes.text}`}>
            {!continues ? (
              <span className="flex items-baseline gap-2 leading-5">
                <span
                  data-testid={`${props.testIdPrefix}-message-author`}
                  data-author-kind={message.authorKind}
                  className={`min-w-0 truncate font-semibold text-ink ${sizes.name}`}
                >
                  <AgentName kind={message.authorKind} presentation={message.presentation}>
                    <AgentColorName>{chatAuthorLabel(message)}</AgentColorName>
                  </AgentName>
                </span>
                {message.authorKind === "link" ? <LinkHolderMark testId={`${props.testIdPrefix}-message-link-holder`} /> : null}
                {message.authorKind === "automation" ? (
                  <AutomationBadge
                    testIdPrefix={props.testIdPrefix}
                    author={message}
                    viewerAuthorId={props.reactionControls?.viewerAuthorId}
                    onOpenPath={props.onOpenPath}
                  />
                ) : null}
                <time
                  dateTime={time.iso}
                  title={time.iso}
                  className="shrink-0 text-[12px] tabular-nums text-subtle"
                >
                  {formatClock(message.createdAtMs)}
                </time>
              </span>
            ) : null}
            <ChatMarkdown
              body={message.body}
              candidates={candidates}
              attachments={message.attachments}
              testId={`${props.testIdPrefix}-message-body`}
              onOpenPath={props.onOpenPath}
            />
            {props.renderMessageFooter?.(message)}
            {props.reactionControls ? (
              <MessageReactions
                testIdPrefix={props.testIdPrefix}
                messageId={message.id}
                records={reactions}
                controls={props.reactionControls}
                hoverToolbar
                toolbarClassName={sizes.toolbar}
                toolbarActions={props.rowActions?.(message)}
              />
            ) : null}
          </div>
        </div>
        </AgentColorScope>
      </li>
    );
  }, [props, candidates, reactionsByMessage, density, anchor]);
  if (props.loading || props.messages.length === 0) {
    return <div className={`flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-2 ${anchor === "end" ? "justify-end" : ""}`}>
      {props.loading ? (
        <SkeletonRows label="Loading..." className="pt-1" />
      ) : (
        <p className="m-0 pt-4 text-center text-[13px] text-subtle">{props.emptyLabel}</p>
      )}
    </div>;
  }
  return <div className="relative flex min-h-0 flex-1 flex-col">
    {topDay ? (
      <span
        aria-hidden
        data-testid={`${props.testIdPrefix}-sticky-day`}
        className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full border border-line bg-bg px-2 py-0.5 text-[11px] text-subtle"
      >
        {topDay}
      </span>
    ) : null}
    <LegendList
    ref={list}
    data={props.messages}
    extraData={props}
    keyExtractor={messageKeyExtractor}
    renderItem={renderMessage}
    onViewableItemsChanged={onViewableItemsChanged}
    estimatedItemSize={80}
    initialScrollAtEnd={anchor === "end"}
    alignItemsAtEnd={anchor === "end"}
    ListFooterComponent={props.footer}
    maintainScrollAtEnd={{ animated: false, on: { dataChange: true, itemLayout: true, layout: true } }}
    // DOM scrollHeight rounds fractional row sizes to whole CSS pixels.
    maintainScrollAtEndThreshold={40.5 / Math.max(1, viewportHeight)}
    maintainVisibleContentPosition
    onLayout={event => setViewportHeight(event.nativeEvent.layout.height)}
    recycleItems={false}
    alwaysRender={pinned}
    className="min-h-0 flex-1 overflow-y-auto"
    // A narrow row's hover bar rises above it, so the first row needs the room.
    style={{ paddingTop: density === "narrow" ? 30 : 8, paddingBottom: props.bottomSpace ?? 4 }}
    role="list"
    data-chat-virtualized="true"
    onKeyDown={event => {
      if (event.defaultPrevented || event.shiftKey || event.altKey || event.metaKey || event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      const viewport = list.current?.getScrollableNode();
      if (!viewport || viewport.scrollHeight <= viewport.clientHeight) return;
      // Browser offsets include Legend's measurement compensation. Navigate by item.
      if (event.key === "Home") {
        event.preventDefault();
        void list.current?.scrollToIndex({ index: 0, animated: false });
      } else if (event.key === "End") {
        event.preventDefault();
        void list.current?.scrollToEnd({ animated: false });
      }
    }}
    onFocusCapture={event => setFocusedMessage(messageKey(event.target))}
    onBlurCapture={event => setFocusedMessage(messageKey(event.relatedTarget))}
    />
  </div>;
});

// The fast composer: Enter sends (Shift+Enter for a newline), disabled while
// a send is in flight, submit button gated on non-blank input. A slow send
// shows on the shared send control.
export function ChatComposer(props: {
  testIdPrefix: string;
  composerId: string;
  value: string;
  sending: boolean;
  placeholder: string;
  sendLabel: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onEscape?: () => void;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  useToastsAbove(formRef);
  return (
    <form
      ref={formRef}
      className="flex shrink-0 items-end gap-1.5 border-t border-line p-2"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSend();
      }}
    >
      <label className="sr-only" htmlFor={props.composerId}>
        Message
      </label>
      <textarea
        id={props.composerId}
        data-testid={`${props.testIdPrefix}-composer`}
        value={props.value}
        disabled={props.sending}
        rows={2}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          // During IME composition (CJK input), Enter confirms the composed
          // characters and Escape cancels them; neither sends or backs out.
          if (isComposingKey(event)) return;
          if (isSendKey(event)) {
            event.preventDefault();
            props.onSend();
          } else if (event.key === "Escape" && props.onEscape) {
            event.stopPropagation();
            props.onEscape();
          }
        }}
        className="min-w-0 flex-1 resize-none rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] leading-6 text-ink placeholder:text-subtle dohc-focus-input"
      />
      <ComposerSendButton
        testId={`${props.testIdPrefix}-send`}
        label={props.sendLabel}
        sending={props.sending}
        disabled={props.value.trim().length === 0}
        shape="icon"
      />
    </form>
  );
}
