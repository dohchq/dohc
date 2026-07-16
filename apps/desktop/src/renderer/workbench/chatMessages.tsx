import { FileText, SmilePlus, Send } from "lucide-react";
import {
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
import type { ChatMessageRecord, ChatReactionRecord } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import {
  findMentions,
  type MentionCandidate,
} from "@dohc/workspace-contracts/chat-mentions";
import { extractChatFileReferenceTokens } from "./chatFileMentions";

// Shared Chats rendering (PR 13, WS-E): the file-rail LinkedChats panel and
// the workspace Chats view render messages and composers through these SAME
// pieces so authorship display and send affordances can never drift. Test
// ids are prefixed per surface ("linked-chat-*" vs "chats-*") because both
// panels can be mounted at once.

// Authorship display rule (plan non-negotiable): agent-authored messages
// render as "<User Name>'s agent"; human messages show the author's name.
export function chatAuthorLabel(
  author: Pick<ChatMessageRecord, "authorKind" | "authorDisplayName">,
): string {
  if (author.authorKind !== "agent") return author.authorDisplayName;
  // Backward compatibility for rows written before agent authors stored the
  // raw owner name; never turn "Ice's agent" into "Ice's agent's agent".
  return /['’]s agent$/i.test(author.authorDisplayName)
    ? author.authorDisplayName
    : `${author.authorDisplayName}'s agent`;
}

export function ipcErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : "";
  const message = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  return message.trim().length > 0 ? message.trim() : fallback;
}

// Reaction toggle (WS-MU-C2), shared by BOTH chat surfaces (the file-rail
// LinkedChats panel and the Chats view) so their optimistic behavior can never
// drift. Optimistically flips the viewer's own reaction on the target cell,
// then reconciles to the canonical server list. Two guarantees the naive
// version lacked:
//   1. ROLLBACK — a failed setChatReaction reverts the optimistic cell, so the
//      UI never keeps a reaction the server rejected.
//   2. PER-CELL ORDERING — overlapping toggles on the SAME (message, emoji) can
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

  // Apply the viewer's OWN presence on this one cell, leaving every other
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

  // A response may touch UI state only if the thread is still live AND this is
  // still the latest toggle for THIS cell (a newer toggle supersedes it).
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

export function formatChatTime(createdAtMs: number): { label: string; iso: string } {
  const createdAt = new Date(createdAtMs);
  return {
    label: createdAt.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
    iso: createdAt.toISOString(),
  };
}

// Renders a message body with @-mention chips. A mention that resolves to a
// known candidate gets a calm inline chip; everything else is plain text, so
// the message reads exactly as written. Whitespace/newlines are preserved by
// the parent's `whitespace-pre-wrap`.
export function MentionText(props: {
  body: string;
  candidates: readonly MentionCandidate[];
  testId?: string;
  onOpenPath?: (path: string, headingAnchor?: string) => void;
}) {
  // Classify code ranges once, against the complete message. File chips split
  // the rendered output into pieces, but must not reset Markdown fence state
  // and accidentally turn a handle inside an unmatched/multiline fence into a
  // mention.
  const fileTokens = extractChatFileReferenceTokens(props.body);
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
          {fileToken.path.split("/").at(-1)}
          {fileToken.headingAnchor ? `#${fileToken.headingAnchor}` : ""}
        </>
      );
      const className = "inline-flex items-center gap-1 rounded bg-line/50 px-1 text-muted";
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
          onClick={() => props.onOpenPath?.(fileToken.path, fileToken.headingAnchor)}
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
export const DEFAULT_REACTION_EMOJIS = ["👍", "❤️", "🎉", "🙌", "😄", "👀", "✅", "🚀"] as const;

export interface ChatReactionControls {
  // Every ACTIVE reaction in the open thread (all messages).
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
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pickerId = useId();
  const choices = props.controls.emojiChoices ?? DEFAULT_REACTION_EMOJIS;

  // Dismiss the picker on an outside pointer press (calm, no modal scrim).
  useEffect(() => {
    if (!pickerOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pickerOpen]);

  // Dismiss on Escape at the DOCUMENT level (not just on the popup): a keyboard
  // user who opened via Enter/Space keeps focus on the trigger, so an onKeyDown
  // scoped to the popup would never fire. Return focus to the trigger on close
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
      className={`relative flex flex-wrap items-center gap-1 ${props.flush ? "" : "mt-1"}`}
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
        // A lightweight quick-pick, NOT an APG menu: role="group" with plain
        // toggle <button>s (each Tab-stoppable, aria-pressed reflecting the
        // viewer's state). We deliberately don't claim role="menu"/menuitem*,
        // which would promise arrow-key roving semantics we don't implement.
        // Escape (document-level) closes and returns focus to the trigger.
        <div
          id={pickerId}
          role="group"
          data-testid={`${props.testIdPrefix}-reaction-picker`}
          aria-label="Choose a reaction"
          className="dohc-popover dohc-pop-in absolute bottom-full left-0 z-10 mb-1 flex gap-0.5 rounded-lg border border-line bg-panel p-1"
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

export function ChatMessageList(props: {
  testIdPrefix: string;
  messages: ChatMessageRecord[];
  loading: boolean;
  emptyLabel: string;
  endRef: RefObject<HTMLDivElement | null>;
  // When provided, message bodies render @-mention chips for these handles.
  mentionCandidates?: readonly MentionCandidate[];
  // File-reference tokens become navigation buttons when the host can open
  // workspace paths; embedded/read-only hosts keep the same non-interactive chip.
  onOpenPath?: (path: string, headingAnchor?: string) => void;
  // When provided, each message gets a reaction row (pills + quick-pick).
  reactionControls?: ChatReactionControls;
  flashMessageId?: string | null;
  onMessageElement?: (messageId: string, element: HTMLLIElement | null) => void;
}) {
  const candidates = props.mentionCandidates ?? [];
  // Group active reactions by message once per render.
  const reactionsByMessage = new Map<string, ChatReactionRecord[]>();
  if (props.reactionControls) {
    for (const reaction of props.reactionControls.reactions) {
      const list = reactionsByMessage.get(reaction.messageId);
      if (list) list.push(reaction);
      else reactionsByMessage.set(reaction.messageId, [reaction]);
    }
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {props.loading ? (
        <p className="m-0 text-center text-[11px] text-subtle">Loading...</p>
      ) : props.messages.length === 0 ? (
        <p className="m-0 pt-4 text-center text-[11px] text-subtle">
          {props.emptyLabel}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {props.messages.map((message) => {
            const time = formatChatTime(message.createdAtMs);
            return (
              <li
                key={message.id}
                ref={(element) => props.onMessageElement?.(message.id, element)}
                data-testid={`${props.testIdPrefix}-message`}
                data-message-id={message.id}
                className={`group transition-shadow ${
                  props.flashMessageId === message.id
                    ? "rounded-xl ring-2 ring-agent/30 ring-offset-2 ring-offset-bg"
                    : ""
                }`}
              >
                <span className="flex items-baseline gap-1.5">
                  <span
                    data-testid={`${props.testIdPrefix}-message-author`}
                    data-author-kind={message.authorKind}
                    className="shrink-0 text-[11px] font-semibold text-ink"
                  >
                    {chatAuthorLabel(message)}
                  </span>
                  <time
                    dateTime={time.iso}
                    title={time.iso}
                    className="shrink-0 text-[10px] text-subtle"
                  >
                    {time.label}
                  </time>
                </span>
                <p
                  data-testid={`${props.testIdPrefix}-message-body`}
                  className="mb-0 mt-0.5 select-text cursor-text whitespace-pre-wrap break-words text-[12px] leading-5 text-muted"
                >
                  <MentionText
                    body={message.body}
                    candidates={candidates}
                    testId={`${props.testIdPrefix}-message-body`}
                    onOpenPath={props.onOpenPath}
                  />
                </p>
                {props.reactionControls ? (
                  <MessageReactions
                    testIdPrefix={props.testIdPrefix}
                    messageId={message.id}
                    records={reactionsByMessage.get(message.id) ?? []}
                    controls={props.reactionControls}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div ref={props.endRef} />
    </div>
  );
}

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
        className="min-w-0 flex-1 resize-none rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] leading-6 text-ink placeholder:text-subtle focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
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
