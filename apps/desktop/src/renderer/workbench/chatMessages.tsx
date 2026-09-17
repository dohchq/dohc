import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { formatChatDay, formatChatTime, formatClock, sameChatDay } from "../time";
import { ChatAvatar } from "./ChatAvatar";
import { basenameOf } from "../path";
import { ipcErrorMessage } from "../ipcError";
import { FileText, SmilePlus, Send } from "lucide-react";
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
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  ChatAttachmentRecord,
  ChatMessageRecord,
  ChatReactionRecord,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import {
  findMentions,
  type MentionCandidate,
} from "@dohc/workspace-contracts/chat-mentions";
import { extractChatFileReferenceTokens } from "./chatFileMentions";
import type { ChatFileReferenceToken } from "./chatFileMentions";

// Shared Chats rendering (PR 13, WS-E): the file-rail LinkedChats panel and
// the workspace Chats view render messages and composers through these same
// pieces so authorship display and send affordances can never drift. Test
// ids are prefixed per surface ("linked-chat-*" vs "chats-*") because both
// panels can be mounted at once.

// Authorship display rule (plan non-negotiable): agent-authored messages
// render as "<User Name>'s agent"; human messages show the author's name.
export function chatAuthorLabel(
  author: Pick<ChatMessageRecord, "authorKind" | "authorDisplayName">,
): string {
  if (author.authorKind !== "agent") return author.authorDisplayName;
  return `${author.authorDisplayName}'s agent`;
}

// Reaction toggle (WS-MU-C2), shared by both chat surfaces (the file-rail
// LinkedChats panel and the Chats view) so their optimistic behavior can never
// drift. Optimistically flips the viewer's own reaction on the target cell,
// then reconciles to the canonical server list. Two guarantees the naive
// version lacked:
//   1. ROLLBACK — a failed setChatReaction reverts the optimistic cell, so the
//      UI never keeps a reaction the server rejected.
//   2. PER-CELL ORDERING — overlapping toggles on the same (message, emoji) can
//      resolve out of order; a per-cell sequence guard drops every response but
//      the latest toggle's, so two rapid clicks converge to the correct final
//      state instead of racing to whichever server round-trip lands last.
// Both are additionally gated by the caller's existing liveness token, so a
// thread switch still discards stale repaints.
export interface ReactionToggleContext {
  workspaceId: string;
  threadId: string;
  viewerAuthorId: string;
  liveToken: MutableRefObject<number>;
  // Per-(message, emoji) monotonic sequence; the latest toggle for a cell wins.
  reactionSeq: MutableRefObject<Map<string, number>>;
  setReactions: Dispatch<SetStateAction<ChatReactionRecord[]>>;
  setViewerAuthorId: Dispatch<SetStateAction<string>>;
  onError: (message: string) => void;
}

export function runReactionToggle(
  ctx: ReactionToggleContext,
  input: { messageId: string; emoji: string; nextState: "added" | "removed" },
): void {
  const { workspaceId, threadId, viewerAuthorId } = ctx;
  if (viewerAuthorId === "") return;
  const token = ctx.liveToken.current;
  // NUL-joined so a message id that ends with the emoji (or vice versa) can't
  // alias another cell's key.
  const cellKey = `${input.messageId}\u0000${input.emoji}`;
  const seq = (ctx.reactionSeq.current.get(cellKey) ?? 0) + 1;
  ctx.reactionSeq.current.set(cellKey, seq);

  // Apply the viewer's own presence on this one cell, leaving every other
  // reaction (and every other reactor) untouched.
  const setCell = (current: ChatReactionRecord[], present: boolean): ChatReactionRecord[] => {
    const without = current.filter(
      (reaction) =>
        !(
          reaction.messageId === input.messageId &&
          reaction.emoji === input.emoji &&
          reaction.authorId === viewerAuthorId
        ),
    );
    if (!present) return without;
    return [
      ...without,
      {
        reactionId: `optimistic:${input.messageId}:${input.emoji}:${viewerAuthorId}`,
        messageId: input.messageId,
        threadId,
        emoji: input.emoji,
        authorId: viewerAuthorId,
        authorKind: "human",
        authorDisplayName: viewerAuthorId,
      },
    ];
  };

  const present = input.nextState === "added";
  ctx.setReactions((current) => setCell(current, present));

  // A response may touch UI state only if the thread is still live and this is
  // still the latest toggle for this cell (a newer toggle supersedes it).
  const isCurrent = (): boolean =>
    token === ctx.liveToken.current && ctx.reactionSeq.current.get(cellKey) === seq;

  void bridge()
    .setChatReaction({
      workspaceId,
      threadId,
      messageId: input.messageId,
      emoji: input.emoji,
      state: input.nextState,
    })
    .then(() => bridge().listChatReactions({ workspaceId, threadId }))
    .then((result) => {
      if (!isCurrent()) return;
      ctx.setReactions(result.reactions);
      ctx.setViewerAuthorId(result.viewerAuthorId);
    })
    .catch((error) => {
      // Roll this cell back to its pre-toggle presence (the inverse of what we
      // optimistically set) — but only if this is still the live, latest toggle
      // so a superseded failure never clobbers a newer toggle's state.
      if (isCurrent()) ctx.setReactions((current) => setCell(current, !present));
      if (token === ctx.liveToken.current) {
        ctx.onError(ipcErrorMessage(error, "Could not update that reaction."));
      }
    });
}

interface FileMentionNavigationTarget {
  path: string;
  headingAnchor?: string;
}

function fileReferenceKey(reference: {
  path: string;
  headingAnchor?: string;
}): string {
  return `${reference.path}\u0000${reference.headingAnchor ?? ""}`;
}

function sameHeading(
  token: Pick<ChatFileReferenceToken, "headingAnchor">,
  attachment: Pick<ChatAttachmentRecord, "headingAnchor">,
): boolean {
  return (token.headingAnchor ?? "") === (attachment.headingAnchor ?? "");
}

// Body text is immutable display copy, while attachment pathHint is the
// engine's authoritative, permission-checked navigation target. Most tokens
// match it exactly. Hand-typed compatibility forms can have edge spaces that
// main intentionally trims only after exact lookup. Reconcile unique
// references in two passes so exact space-named files always
// win, followed only by the explicit edge-space compatibility form. Never
// bind by heading/order alone: CLI callers can attach an independent file that
// happens to share a heading with a literal token in the message body.
function resolveFileMentionNavigationTargets(
  tokens: readonly ChatFileReferenceToken[],
  attachments: readonly ChatAttachmentRecord[],
): Map<string, FileMentionNavigationTarget> {
  const references = Array.from(
    new Map(tokens.map((token) => [fileReferenceKey(token), token])).values(),
  );
  const available = attachments.filter(
    (attachment): attachment is ChatAttachmentRecord & { pathHint: string } =>
      typeof attachment.pathHint === "string" && attachment.pathHint.length > 0,
  );
  const unused = new Set(available.map((_, index) => index));
  const targets = new Map<string, FileMentionNavigationTarget>();

  const assign = (
    predicate: (
      token: ChatFileReferenceToken,
      attachment: ChatAttachmentRecord & { pathHint: string },
    ) => boolean,
  ) => {
    for (const token of references) {
      const key = fileReferenceKey(token);
      if (targets.has(key)) continue;
      const index = available.findIndex(
        (attachment, at) => unused.has(at) && predicate(token, attachment),
      );
      if (index < 0) continue;
      const attachment = available[index];
      if (!attachment) continue;
      unused.delete(index);
      targets.set(key, {
        path: attachment.pathHint,
        ...(attachment.headingAnchor
          ? { headingAnchor: attachment.headingAnchor }
          : {}),
      });
    }
  };

  assign(
    (token, attachment) =>
      attachment.pathHint === token.path && sameHeading(token, attachment),
  );
  assign(
    (token, attachment) =>
      token.path.trim() !== token.path &&
      attachment.pathHint === token.path.trim() &&
      sameHeading(token, attachment),
  );

  return targets;
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
      const testId = props.testId ? `${props.testId}-file-mention` : undefined;
      const chipContent = (
        <>
          <FileText size={11} aria-hidden />
          {basenameOf(fileToken.path)}
          {fileToken.headingAnchor ? `#${fileToken.headingAnchor}` : ""}
        </>
      );
      const className = "inline-flex items-center gap-1 rounded bg-line/50 px-1 text-muted";
      const navigationTarget = fileTargets.get(fileReferenceKey(fileToken)) ?? fileToken;
      content.push(props.onOpenPath ? (
        <button
          type="button"
          key={`file:${fileToken.start}`}
          data-testid={testId}
          aria-label={`Open ${fileToken.path}${
            fileToken.headingAnchor ? ` at #${fileToken.headingAnchor}` : ""
          }`}
          className={`${className} cursor-pointer hover:bg-line hover:text-ink`}
          title={fileToken.text}
          onClick={() =>
            props.onOpenPath?.(
              navigationTarget.path,
              navigationTarget.headingAnchor,
            )
          }
        >
          {chipContent}
        </button>
      ) : (
        <span
          key={`file:${fileToken.start}`}
          data-testid={testId}
          className={className}
          title={fileToken.text}
        >
          {chipContent}
        </span>
      ));
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

// Reactions (WS-MU-C2). A small, calm quick-pick — obvious, not a full emoji
// keyboard. Reacting to an agent's message is a first-class move, so this set
// leans toward acknowledging work.
const DEFAULT_REACTION_EMOJIS = ["👍", "❤️", "🎉", "🙌", "😄", "👀", "✅", "🚀"] as const;

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
}

// "Alice, Bob's agent reacted" — agent reactors read as "<name>'s agent".
function reactionerNames(records: readonly ChatReactionRecord[]): string {
  return records.map((record) => chatAuthorLabel(record)).join(", ");
}

// One message's reaction row: existing pills (grouped by emoji) plus an
// add-reaction affordance. Kept obvious — pills show emoji + count, yours are
// highlighted, and the picker is a short quick-pick.
export function MessageReactions(props: {
  testIdPrefix: string;
  messageId: string;
  records: readonly ChatReactionRecord[];
  controls: ChatReactionControls;
  flush?: boolean;
  // In the chat lane an empty row floats over the message's corner, so a
  // run of short lines keeps its rhythm until someone reacts.
  overlayWhenEmpty?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [pickerPosition, setPickerPosition] = useState({ left: 0, top: 0 });
  const pickerId = useId();
  const choices = props.controls.emojiChoices ?? DEFAULT_REACTION_EMOJIS;

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
    const position = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const picker = pickerRef.current?.getBoundingClientRect();
      if (!trigger || !picker) return;
      setPickerPosition({
        left: Math.max(4, Math.min(trigger.right - picker.width, window.innerWidth - picker.width - 4)),
        top: Math.max(4, Math.min(trigger.top >= picker.height + 4 ? trigger.top - picker.height - 4 : trigger.bottom + 4, window.innerHeight - picker.height - 4)),
      });
    };
    pickerRef.current?.showPopover?.();
    position();
    pickerRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
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
    props.controls.onToggle({
      messageId: props.messageId,
      emoji,
      nextState: mine ? "removed" : "added",
    });
  };

  return (
    <div
      ref={containerRef}
      data-testid={`${props.testIdPrefix}-message-reactions`}
      data-chat-escape-local="true"
      // Channel feed cards are themselves clickable. Keep reaction gestures
      // local so a pill or quick-pick never also opens the post underneath it.
      onClick={(event) => event.stopPropagation()}
      className={
        props.overlayWhenEmpty && byEmoji.length === 0
          ? "absolute right-0 top-0 flex items-center"
          : `relative flex flex-wrap items-center gap-1 ${props.flush ? "" : "mt-1"}`
      }
    >
      {byEmoji.map((group) => (
        <button
          key={group.emoji}
          type="button"
          data-testid={`${props.testIdPrefix}-reaction-pill`}
          data-emoji={group.emoji}
          data-mine={group.mine ? "true" : "false"}
          aria-pressed={group.mine}
          disabled={props.controls.readOnly}
          // The emoji glyph is aria-hidden, so without this the button announces
          // as just its count. Expose emoji + count + reactor names, e.g.
          // "👍 3 — Ice, Ice's agent".
          aria-label={`${group.emoji} ${group.records.length} — ${reactionerNames(group.records)}`}
          title={`${reactionerNames(group.records)} reacted with ${group.emoji}`}
          onClick={() => toggle(group.emoji, group.mine)}
          className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none transition-colors disabled:cursor-default ${
            group.mine
              ? "border-accent bg-accent/15 text-accent"
              : "border-line bg-bg text-muted hover:border-accent/60"
          }`}
        >
          <span aria-hidden>{group.emoji}</span>
          <span className="tabular-nums">{group.records.length}</span>
        </button>
      ))}
      {!props.controls.readOnly ? (
        <button
          ref={triggerRef}
          type="button"
          data-testid={`${props.testIdPrefix}-add-reaction`}
          aria-label="Add reaction"
          aria-haspopup="true"
          aria-expanded={pickerOpen}
          aria-controls={pickerOpen ? pickerId : undefined}
          title="Add reaction"
          onClick={() => setPickerOpen((open) => !open)}
          className="grid size-5 place-items-center rounded-full border border-transparent text-subtle opacity-0 transition-opacity hover:border-line hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
        >
          <SmilePlus size={13} aria-hidden />
        </button>
      ) : null}
      {pickerOpen && !props.controls.readOnly ? (
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
          className="dohc-popover dohc-pop-in fixed z-50 flex max-w-[calc(100vw-8px)] flex-wrap gap-0.5 rounded-lg border border-line bg-panel p-1"
        >
          {choices.map((emoji) => {
            const mine = index.has(emoji) ? (byEmoji[index.get(emoji) as number]?.mine ?? false) : false;
            return (
              <button
                key={emoji}
                type="button"
                aria-pressed={mine}
                data-testid={`${props.testIdPrefix}-reaction-choice`}
                data-emoji={emoji}
                title={emoji}
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
        </div>
      ) : null}
    </div>
  );
}

const GROUP_WINDOW_MS = 5 * 60_000;
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
}) {
  const candidates = props.mentionCandidates ?? EMPTY_MENTION_CANDIDATES;
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
  const nearEnd = useRef(true);
  const viewportSize = useRef({ width: 0, height: 0 });
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
  }), [indexes]);

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
  const pinned = useMemo(() => {
    const focusedIndex = focusedMessage ? indexes.get(focusedMessage) : undefined;
    const indices: number[] = [];
    if (focusedIndex !== undefined) {
      indices.push(focusedIndex);
      for (const direction of [-1, 1]) {
        for (let index = focusedIndex + direction; index >= 0 && index < props.messages.length; index += direction) {
          const message = props.messages[index]!;
          const hasReactionButton = props.reactionControls && !props.reactionControls.readOnly;
          const hasFileButton = props.onOpenPath && extractChatFileReferenceTokens(message.body).length > 0;
          if (hasReactionButton || hasFileButton) {
            indices.push(index);
            break;
          }
        }
      }
    }
    return { keys: selectedMessages, indices };
  }, [selectedMessages, focusedMessage, indexes, props.messages, props.reactionControls, props.onOpenPath]);

  const renderMessage = useCallback(({ item: message, index: at }: { item: ChatMessageRecord; index: number }) => {
    const previous = at > 0 ? props.messages[at - 1] : undefined;
    const newDay = !previous || !sameChatDay(previous.createdAtMs, message.createdAtMs);
    const continues =
      !newDay &&
      previous !== undefined &&
      previous.authorKind === message.authorKind &&
      (previous.authorUserId && message.authorUserId
        ? previous.authorUserId === message.authorUserId
        : !previous.authorUserId && !message.authorUserId &&
          previous.authorDisplayName === message.authorDisplayName) &&
      message.createdAtMs - previous.createdAtMs < GROUP_WINDOW_MS;
    const isAgent = message.authorKind === "agent";
    const time = formatChatTime(message.createdAtMs);
    const reactions = reactionsByMessage.get(message.id) ?? [];
    return (
      <li
        key={message.id}
        role="listitem"
        aria-posinset={at + 1}
        aria-setsize={props.messages.length}
        data-testid={`${props.testIdPrefix}-message`}
        data-message-id={message.id}
        data-continues={continues ? "true" : "false"}
        className={`group relative flex flex-col transition-shadow ${
          continues ? "mt-0.5" : "mt-3"
        } ${
          props.flashMessageId === message.id
            ? "rounded-lg ring-2 ring-agent/30 ring-offset-2 ring-offset-bg"
            : ""
        }`}
      >
        {newDay ? (
          <span
            data-testid={`${props.testIdPrefix}-day`}
            className="mb-3 flex items-center gap-2 text-[11px] text-subtle before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line"
          >
            {formatChatDay(message.createdAtMs)}
          </span>
        ) : null}
        <div className="flex gap-2.5">
          <span className="flex h-5 w-9 shrink-0 items-start justify-end">
            {continues ? (
              <time
                dateTime={time.iso}
                title={time.iso}
                className="block w-full whitespace-nowrap text-right font-mono text-[9px] leading-5 text-subtle opacity-0 group-hover:opacity-100"
              >
                {formatClock(message.createdAtMs)}
              </time>
            ) : (
              <ChatAvatar
                name={message.authorDisplayName}
                kind={isAgent ? "agent" : "human"}
                size="comment"
              />
            )}
          </span>
          <div className="relative min-w-0 flex-1 pr-6">
            {!continues ? (
              <span className="flex items-baseline gap-1.5">
                <span
                  data-testid={`${props.testIdPrefix}-message-author`}
                  data-author-kind={message.authorKind}
                  className={`shrink-0 text-[13px] font-semibold ${
                    isAgent ? "text-agent" : "text-ink"
                  }`}
                >
                  {chatAuthorLabel(message)}
                </span>
                <time
                  dateTime={time.iso}
                  title={time.iso}
                  className="shrink-0 text-[11px] text-subtle"
                >
                  {formatClock(message.createdAtMs)}
                </time>
              </span>
            ) : null}
            <p
              data-testid={`${props.testIdPrefix}-message-body`}
              className="mb-0 mt-0 select-text cursor-text whitespace-pre-wrap break-words text-[13px] leading-5 text-ink"
            >
              <MentionText
                body={message.body}
                candidates={candidates}
                attachments={message.attachments}
                testId={`${props.testIdPrefix}-message-body`}
                onOpenPath={props.onOpenPath}
              />
            </p>
            {props.renderMessageFooter?.(message)}
            {props.reactionControls ? (
              <MessageReactions
                testIdPrefix={props.testIdPrefix}
                messageId={message.id}
                records={reactions}
                controls={props.reactionControls}
                overlayWhenEmpty
              />
            ) : null}
          </div>
        </div>
      </li>
    );
  }, [props, candidates, reactionsByMessage]);
  if (props.loading || props.messages.length === 0) {
    return <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      <p className={`m-0 text-center text-[11px] text-subtle ${props.loading ? "" : "pt-4"}`}>
        {props.loading ? "Loading..." : props.emptyLabel}
      </p>
    </div>;
  }
  return <LegendList
    ref={list}
    data={props.messages}
    extraData={props}
    keyExtractor={messageKeyExtractor}
    renderItem={renderMessage}
    estimatedItemSize={80}
    initialScrollAtEnd
    maintainScrollAtEnd={{ animated: false, on: { dataChange: true, itemLayout: true, layout: true } }}
    // DOM scrollHeight rounds fractional row sizes to whole CSS pixels.
    maintainScrollAtEndThreshold={40.5 / Math.max(1, viewportHeight)}
    maintainVisibleContentPosition
    // Keep the pre-resize bottom position until the new viewport is measured.
    onScroll={event => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      if (Math.abs(layoutMeasurement.height - viewportSize.current.height) < 1) {
        nearEnd.current = contentSize.height - contentOffset.y - layoutMeasurement.height <= 40.5;
      }
    }}
    onLayout={event => {
      const next = event.nativeEvent.layout;
      const previous = viewportSize.current;
      viewportSize.current = next;
      setViewportHeight(next.height);
      if (nearEnd.current && previous.height > 0 && (previous.height !== next.height || previous.width !== next.width)) {
        void list.current?.scrollToEnd({ animated: false });
      }
    }}
    recycleItems={false}
    alwaysRender={pinned}
    className="min-h-0 flex-1 overflow-y-auto"
    style={{ paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12 }}
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
  />;
});

// The fast composer: Enter sends (Shift+Enter for a newline), disabled while
// a send is in flight, submit button gated on non-blank input.
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
  return (
    <form
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
          // isComposing: Enter during IME composition (CJK input) confirms
          // the composed characters — it must never submit the message.
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            props.onSend();
          } else if (event.key === "Escape" && props.onEscape) {
            event.stopPropagation();
            props.onEscape();
          }
        }}
        className="min-w-0 flex-1 resize-none rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] leading-6 text-ink placeholder:text-subtle dohc-focus-input"
      />
      <button
        type="submit"
        data-testid={`${props.testIdPrefix}-send`}
        aria-label={props.sendLabel}
        title={props.sendLabel}
        disabled={props.sending || props.value.trim().length === 0}
        className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md bg-accent text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Send size={13} aria-hidden />
      </button>
    </form>
  );
}
