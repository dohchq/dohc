import { Send } from "lucide-react";
import { Fragment, type RefObject } from "react";
import type { ChatMessageRecord } from "../../ipc/bridgeContract";
import { toMentionSegments, type MentionCandidate } from "./mentions";

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
  return author.authorKind === "agent"
    ? `${author.authorDisplayName}'s agent`
    : author.authorDisplayName;
}

export function ipcErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : "";
  const message = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  return message.trim().length > 0 ? message.trim() : fallback;
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
}) {
  // Chips are code-aware too: an @handle inside inline code / a fenced block
  // reads as code text, not a mention chip.
  const segments = toMentionSegments(props.body, props.candidates, { ignoreCode: true });
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "mention" ? (
          <span
            // Segments are positional; index is a stable key within one body.
            key={`m${index}`}
            data-testid={props.testId ? `${props.testId}-mention` : undefined}
            data-mention-kind={segment.candidate.kind}
            className="rounded bg-accent/15 px-1 font-medium text-accent"
          >
            {segment.text}
          </span>
        ) : (
          <Fragment key={`t${index}`}>{segment.text}</Fragment>
        ),
      )}
    </>
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
}) {
  const candidates = props.mentionCandidates ?? [];
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
              <li key={message.id} data-testid={`${props.testIdPrefix}-message`}>
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
                  className="mb-0 mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-5 text-muted"
                >
                  {candidates.length > 0 ? (
                    <MentionText
                      body={message.body}
                      candidates={candidates}
                      testId={`${props.testIdPrefix}-message-body`}
                    />
                  ) : (
                    message.body
                  )}
                </p>
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
        className="min-w-0 flex-1 resize-none rounded border border-line bg-bg px-2 py-1.5 text-[12px] leading-5 text-ink placeholder:text-subtle focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
      />
      <button
        type="submit"
        data-testid={`${props.testIdPrefix}-send`}
        aria-label={props.sendLabel}
        title={props.sendLabel}
        disabled={props.sending || props.value.trim().length === 0}
        className="grid size-8 shrink-0 cursor-pointer place-items-center rounded bg-ink text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Send size={13} aria-hidden />
      </button>
    </form>
  );
}
