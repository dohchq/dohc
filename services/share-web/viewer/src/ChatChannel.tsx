import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { chatWords } from "@dohc/interface-words/notices";
import { compareMessageOrder } from "@dohc/workspace-contracts/chat-order";
import { renderSafeMarkdown } from "./markdown";
import { readDraft, writeDraft } from "./drafts";
import { CopyWork } from "./CopyWork";
import { Icon } from "./icons";
import {
  CHAT_FOLLOW_HOLD_MS,
  mergeChatMessages,
  NamedChatError,
  type ChatPost,
  type ChatWake,
  type DeletedChatMessage,
  type GroupType,
  type NamedChatAccess,
  type NamedChatMessage,
} from "./namedChat";
import { RETRY_INITIAL_MS, RETRY_MAX_MS } from "./retry";
import {
  MESSAGE_DELETE_FAILED,
  MESSAGE_DELETE_OFFLINE,
  MESSAGE_DELETE_REFUSED,
} from "@dohc/security-contract/workspace-members";
import "./namedChat.css";

// One channel view for the named chat page and the link viewer.
export type Ended = "signed-out" | "removed" | "unavailable";
const POST_UNKNOWN =
  "dohc could not confirm that your message was sent. Try again. It will not post twice.";
const POST_BUSY = "The server is busy. Try again in a moment.";
const POST_REFUSED = "The server did not accept this message. Try again.";
const PINNED_PX = 48;
const READ_ONLY = "You can read this channel but not post. The owner gave you read-only access.";
const EMPTY = "No messages in this channel yet.";
const WAKE_READ_MS = 10_000;

/** A wake's line, in the phone's words, without naming a computer. Held and queued show none, as on the phone. */
function wakeText({ state, agentName }: ChatWake): string | null {
  if (state === "waiting") return chatWords.wakeWaiting(agentName);
  if (state === "claimed") return chatWords.wakeStarting(agentName, null);
  if (state === "unclaimed") return chatWords.wakeNotStarted(agentName);
  if (state === "unconfirmed") return chatWords.wakeUnconfirmed(agentName, null);
  return null;
}

const settled = (wakes: readonly ChatWake[] | undefined) =>
  wakes !== undefined &&
  wakes.every((wake) => wake.state !== "waiting" && wake.state !== "claimed");

type PostWakes = {
  posts: readonly NamedChatMessage[];
  wakes: ReadonlyMap<string, readonly ChatWake[]>;
};
const watched = new Map<string, PostWakes>();

/**
 * Where the agents stand that the reader's own posts from this page woke, for a client that reads them: read after
 * each post, then every 10 seconds while the tab shows and any is waiting or starting. A failed read keeps the last
 * lines, and the next read tries again. The lines last while the page does, kept by conversation.
 */
function usePostWakes(
  read: ChatChannelClient["wakes"],
  key: string | undefined,
  deleted: (messageId: string) => boolean,
) {
  const kept = key === undefined ? undefined : watched.get(key);
  const [posts, setPosts] = useState(kept?.posts ?? []),
    [wakes, setWakes] = useState(kept?.wakes ?? new Map<string, readonly ChatWake[]>());
  const known = useRef(wakes),
    reader = useRef(read),
    gone = useRef(deleted);
  reader.current = read;
  gone.current = deleted;
  useEffect(() => {
    if (key !== undefined && posts.length > 0) watched.set(key, { posts, wakes });
  }, [key, posts, wakes]);
  useEffect(() => {
    if (posts.length === 0) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined,
      reading = false;
    const tick = async () => {
      timer = undefined;
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      const next = new Map(known.current);
      const watching = () =>
        posts.filter((post) => !gone.current(post.messageId) && !settled(next.get(post.messageId)));
      await Promise.all(
        watching().map((post) =>
          reader.current!(post, controller.signal).then(
            (found) => void next.set(post.messageId, found),
            () => undefined,
          ),
        ),
      );
      reading = false;
      if (controller.signal.aborted) return;
      known.current = next;
      setWakes(next);
      if (watching().length > 0) timer = setTimeout(() => void tick(), WAKE_READ_MS);
    };
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", visible);
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [posts]);
  return {
    wakes,
    watch: (post: NamedChatMessage) => {
      if (read) setPosts((current) => [...current, post]);
    },
  };
}

/** A 401 or 404 ends the channel for this account; other failures leave it open. */
export function ended(error: unknown): Ended | null {
  if (!(error instanceof NamedChatError)) return null;
  if (error.status === 401) return "signed-out";
  if (error.status === 404)
    return error.code === "share_access_removed" ? "removed" : "unavailable";
  return null;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

const timeOfDay = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayAndTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const sentAt = (date: Date) =>
  date.toDateString() === new Date().toDateString()
    ? timeOfDay.format(date)
    : dayAndTime.format(date);

// Beside a link holder's chosen name: the share link's mark, as the desktop shows it.
function LinkHolderMark() {
  return (
    <svg
      className="chat-link-mark"
      role="img"
      aria-label="Link holder"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <title>Link holder</title>
      <path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
      <path d="M8 12h8" />
    </svg>
  );
}

const isAgent = (message: NamedChatMessage) =>
  message.authorKind === "agent" || message.authorKind === "automation" || message.linkAgent;

// "Agent" is dohc's word for an agent that gave no name. Such an agent goes by whose it is, as on the desktop.
function authorName(message: NamedChatMessage): string {
  const owner = isAgent(message) ? message.authorOwnerDisplayName : null;
  return owner !== null && message.authorDisplayName === "Agent"
    ? `${owner}'s agent`
    : message.authorDisplayName;
}

/** A post or a chat message with its replies: how many, and how to open them. */
interface Replies {
  count: number;
  // The tab holds an unsent reply to this thread.
  drafted: boolean;
  open(): void;
}

function ChatMessage({
  message,
  replies,
  canReply,
  readerUserId,
  wakes,
  onDelete,
}: {
  message: NamedChatMessage;
  replies?: Replies;
  canReply: boolean;
  readerUserId: string | undefined;
  wakes?: readonly ChatWake[] | undefined;
  onDelete?: () => void;
}) {
  // Attachments are out of scope, so no image source is allowed.
  const html = useMemo(
    () => (message.body === null ? null : renderSafeMarkdown(message.body, () => null)),
    [message.body],
  );
  // An agent that joined with the link wears the agent mark, then the link mark.
  const agent = isAgent(message);
  // A safe integer can lie outside the Date range; such a message shows without a time.
  const sent = new Date(message.createdAtMs),
    dated = !Number.isNaN(sent.getTime());
  const owner = agent ? message.authorOwnerDisplayName : null,
    unnamed = owner !== null && message.authorDisplayName === "Agent",
    // An agent posts as its person's account, so the reader's own agent shares their id.
    yours = readerUserId !== undefined && message.authorUserId === readerUserId;
  const deleted = message.deletedAtMs !== undefined;
  return (
    <li className="chat-message" data-seq={message.relaySeq} data-author-kind={message.authorKind}>
      <p className="chat-meta">
        {agent && (
          <span
            className="chat-agent-mark"
            role="img"
            aria-label={message.authorKind === "automation" ? "Automation" : "Agent"}
          />
        )}
        <span className="chat-author">{unnamed && yours ? "Your agent" : authorName(message)}</span>
        {message.authorKind === "link" && <LinkHolderMark />}
        {owner && !unnamed && (
          <span className="chat-owner">{yours ? "Your agent" : `${owner}'s agent`}</span>
        )}
        {dated && <time dateTime={sent.toISOString()}>{sentAt(sent)}</time>}
        {onDelete && message.deletedAtMs === undefined && (
          <button
            type="button"
            className="icon-button chat-delete"
            aria-label="Delete message"
            title="Delete message"
            onClick={onDelete}
          >
            <Icon name="trash" size={14} />
          </button>
        )}
      </p>
      {message.deletedAtMs !== undefined ? (
        <p className="chat-deleted">
          <Icon name="ban" size={13} />
          Message deleted
        </p>
      ) : html === null ? (
        <p className="chat-body chat-body-omitted">
          This message is too long to show in the browser.
        </p>
      ) : (
        <div className="markdown chat-body" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {!deleted &&
        wakes?.map((wake) => {
          const text = wakeText(wake);
          return (
            text && (
              <p key={wake.wakeId} className="chat-wake">
                {text}
              </p>
            )
          );
        })}
      {/* A person who can't post has nothing to reply with, and a deleted message nothing to reply to,
          as on the desktop. So only a thread with replies opens, or one holding an unsent reply to copy. */}
      {replies && ((canReply && !deleted) || replies.count > 0 || replies.drafted) && (
        <button type="button" className="chat-replies" onClick={replies.open}>
          {replies.count === 0
            ? canReply && !deleted
              ? "Reply"
              : "Unsent reply"
            : replies.count === 1
              ? "1 reply"
              : `${replies.count} replies`}
        </button>
      )}
    </li>
  );
}

/** A delete the reader asked for: asking, running, or refused with why. */
type Removing = {
  message: NamedChatMessage;
  // The reader's own message keeps "this"; another's names its author.
  own: boolean;
  phase: "asking" | "deleting" | "failed";
  why: string | null;
};

const ARROW_STEP: Partial<Record<string, -1 | 1>> = {
  ArrowLeft: -1,
  ArrowUp: -1,
  ArrowRight: 1,
  ArrowDown: 1,
};

// A deleted message's place: its replies, else the next message's first control, else the composer.
function survivor(scroller: HTMLElement | null, seq: number): HTMLElement | null {
  const item = scroller?.querySelector(`.chat-message[data-seq="${seq}"]`);
  return (
    item?.querySelector<HTMLElement>(".chat-replies") ??
    item?.nextElementSibling?.querySelector<HTMLElement>(".chat-delete, .chat-replies") ??
    scroller?.closest(".chat-channel")?.querySelector<HTMLElement>(".chat-composer textarea") ??
    null
  );
}

// The message stays as it is until the relay answers, so a refusal has nothing to restore.
// The card is the desktop's confirmation: a tile beside one text column, its keys included.
function DeleteMessage({
  removing,
  cancel,
  confirm,
  fallback,
}: {
  removing: Removing;
  cancel(): void;
  confirm(): void;
  // Takes focus when the deleted message leaves no control in its place.
  fallback: RefObject<HTMLElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    confirmButton = useRef<HTMLButtonElement>(null);
  // The control that opened the dialog, read before the dialog takes focus, and the message it asks about.
  const [opener] = useState(() => document.activeElement),
    [seq] = useState(() => removing.message.relaySeq);
  useEffect(() => {
    const current = dialog.current;
    current?.showModal();
    confirmButton.current?.focus();
    return () => {
      current?.close();
      // React removes the dialog before this runs, so the browser can't hand
      // focus back. A deleted message has lost its Delete, so focus stays in its place.
      if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected)
        opener.focus();
      else (survivor(fallback.current, seq) ?? fallback.current)?.focus();
    };
  }, [opener, seq, fallback]);
  const deleting = removing.phase === "deleting",
    failed = removing.phase === "failed";
  // The confirm was disabled while the delete ran; Try again takes focus back.
  useEffect(() => {
    if (failed) confirmButton.current?.focus();
  }, [failed]);
  const quote = removing.message.body?.replace(/\s+/gu, " ").trim();
  return (
    <dialog
      ref={dialog}
      className="download-card chat-delete-dialog"
      aria-labelledby="chat-delete-title"
      aria-describedby="chat-delete-body"
      onCancel={(event) => {
        // While the delete runs, only its answer closes the dialog.
        event.preventDefault();
        if (!deleting) cancel();
      }}
      onKeyDown={(event) => {
        // A held Enter never confirms: it may be the key that opened the dialog, repeating.
        if (event.key === "Enter" && event.repeat) {
          event.preventDefault();
          return;
        }
        // The arrow keys move between the buttons, as in the desktop's dialogs.
        const step = ARROW_STEP[event.key];
        if (!step || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            ".chat-delete-actions button:enabled",
          ),
        ];
        if (buttons.length === 0) return;
        event.preventDefault();
        const from = buttons.indexOf(event.target as HTMLButtonElement);
        buttons[
          from === -1
            ? step === 1
              ? 0
              : buttons.length - 1
            : (from + step + buttons.length) % buttons.length
        ]!.focus();
      }}
    >
      <span className="tile bad">
        <Icon name="trash" size={16} />
      </span>
      <div className="chat-delete-column">
        <div>
          <h2 id="chat-delete-title">
            {removing.own
              ? "Delete this message?"
              : `Delete ${authorName(removing.message)}'s message?`}
          </h2>
          <div id="chat-delete-body" className="chat-delete-body">
            {/* The dialog covers the message, so it shows what it deletes. */}
            {quote ? <p className="chat-delete-quote">{quote}</p> : null}
            <p>
              This removes the message from this conversation for everyone. You can't undo it.
              People who already read it may keep a copy.
            </p>
          </div>
        </div>
        {failed && (
          <p className="chat-delete-error" role="alert">
            <Icon name="alert" size={12} />
            <span>
              {removing.why ? `${MESSAGE_DELETE_FAILED} ${removing.why}` : MESSAGE_DELETE_FAILED}
            </span>
          </p>
        )}
        <div className="chat-delete-actions">
          <button
            type="button"
            className="handoff-button secondary"
            disabled={deleting}
            onClick={cancel}
          >
            Cancel
          </button>
          <button
            ref={confirmButton}
            type="button"
            className="handoff-button danger"
            disabled={deleting}
            onClick={confirm}
          >
            {deleting ? "Deleting…" : failed ? "Try again" : "Delete"}
          </button>
        </div>
      </div>
    </dialog>
  );
}

type Lane = "posts" | "chat";
const LANES = [
  ["posts", "Posts"],
  ["chat", "Chat"],
] as const;
/** An open thread: a post's, or one chat message's replies. */
type OpenThread = { threadId: string; rootId: string | null };

// The desktop's Group: a feed of posts, each a thread, and one running chat whose messages can each hold a thread.
function threadView(
  messages: readonly NamedChatMessage[],
  lane: Lane,
  open: OpenThread | null,
  onOpen: (thread: OpenThread, seq: number) => void,
  drafted: (thread: OpenThread) => boolean,
) {
  if (open)
    return {
      shown: messages.filter(
        (message) =>
          message.threadId === open.threadId &&
          (open.rootId === null ||
            message.messageId === open.rootId ||
            message.parentMessageId === open.rootId),
      ),
      replies: new Map<number, Replies>(),
    };
  const replies = new Map<number, Replies>(),
    shown: NamedChatMessage[] = [];
  if (lane === "posts") {
    const threads = new Map<string, NamedChatMessage[]>();
    for (const message of messages)
      if ((message.lane ?? "posts") === "posts")
        threads.set(message.threadId, [...(threads.get(message.threadId) ?? []), message]);
    // History loads newest first, so once a post's first message has loaded, so have all its replies.
    // Until then the post belongs above Load earlier messages.
    for (const [threadId, thread] of threads) {
      const post = thread.find((message) => message.startsPost);
      if (!post) continue;
      shown.push(post);
      const opens = { threadId, rootId: null };
      replies.set(post.relaySeq, {
        count: thread.length - 1,
        drafted: drafted(opens),
        open: () => onOpen(opens, post.relaySeq),
      });
    }
    shown.sort((left, right) => left.relaySeq - right.relaySeq);
    return { shown, replies };
  }
  const counts = new Map<string, number>();
  for (const message of messages)
    if (message.lane === "chat" && message.parentMessageId)
      counts.set(message.parentMessageId, (counts.get(message.parentMessageId) ?? 0) + 1);
  for (const message of messages) {
    if (message.lane !== "chat" || message.parentMessageId) continue;
    shown.push(message);
    const opens = { threadId: message.threadId, rootId: message.messageId };
    replies.set(message.relaySeq, {
      count: counts.get(message.messageId) ?? 0,
      drafted: drafted(opens),
      open: () => onOpen(opens, message.relaySeq),
    });
  }
  // The relay's order is the order messages reached it, so two sent at once
  // can swap. The desktop's order, by when each was sent, keeps them alike.
  shown.sort((left, right) =>
    compareMessageOrder(
      { createdAtMs: left.createdAtMs, id: left.messageId },
      { createdAtMs: right.createdAtMs, id: right.messageId },
    ),
  );
  return { shown, replies };
}

/** How a channel view reads, follows and posts: through a named account, or through a share link. */
export interface ChatChannelClient {
  /** The signed-in reader, whose own agent's posts read "Your agent". A link holder has none. */
  readerUserId?: string;
  access: NamedChatAccess;
  readHistory(
    before: number | null,
    signal: AbortSignal,
  ): Promise<{ messages: NamedChatMessage[]; nextCursor: number; olderCursor: number | null }>;
  follow(
    since: number,
    holdMs: number,
    signal: AbortSignal,
  ): Promise<{
    messages: NamedChatMessage[];
    deleted?: DeletedChatMessage[];
    nextCursor: number;
    hasMore: boolean;
  }>;
  post(post: ChatPost, signal: AbortSignal): Promise<NamedChatMessage>;
  /** Only the owner's page has it: where the agents a post woke stand. */
  wakes?(message: NamedChatMessage, signal: AbortSignal): Promise<ChatWake[]>;
  /** Where the reader can delete: their own messages, or any for the owner or an admin. The relay decides. */
  remove?: {
    can(message: NamedChatMessage): boolean;
    /** Whether the reader wrote it. */
    own(message: NamedChatMessage): boolean;
    run(message: NamedChatMessage, signal: AbortSignal): Promise<DeletedChatMessage>;
  };
  /** The body the relay stores, or null when it would refuse it. */
  normalize(text: string): string | null;
  tooLong(text: string): boolean;
}

/**
 * `composerField` sits above the message box; while `holdSend` is set, the message waits for that field.
 * `readOnlyNote`, `empty`, `messageLabel` and `placeholder` replace the channel's own words, where the page names its conversations differently.
 * `threads` shows a Group's lanes and threads as the desktop does. `draftKey` keeps unsent text for the tab, per composer.
 */
export function ChannelView({
  client,
  name,
  onEnded,
  composerField,
  holdSend = false,
  readOnlyNote = READ_ONLY,
  empty = EMPTY,
  messageLabel = "Message",
  placeholder: channelPlaceholder = name ? `Message #${name}` : "Write a message…",
  threads,
  draftKey,
}: {
  client: ChatChannelClient;
  name: string | null;
  onEnded(reason: Ended): void;
  composerField?: ReactNode;
  holdSend?: boolean;
  readOnlyNote?: string;
  empty?: string;
  messageLabel?: string;
  placeholder?: string;
  threads?: GroupType;
  draftKey?: string;
}) {
  const [lane, setLane] = useState<Lane>(threads === "chat" ? "chat" : "posts"),
    [open, setOpen] = useState<OpenThread | null>(null);
  // Each composer keeps its own draft: the Group's lane, or the open thread.
  const threadKey = (thread: OpenThread) =>
    `${draftKey}\nthread\n${thread.threadId}\n${thread.rootId ?? ""}`;
  const composerKey =
    draftKey === undefined
      ? null
      : !threads
        ? draftKey
        : open
          ? threadKey(open)
          : `${draftKey}\n${lane}`;
  const [messages, setMessages] = useState<NamedChatMessage[] | null>(null),
    [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0),
    [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [older, setOlder] = useState<"idle" | "loading" | "failed">("idle");
  const [following, setFollowing] = useState<"live" | "delayed" | "stopped">("live"),
    [unseen, setUnseen] = useState(0);
  const [access, setAccess] = useState(client.access),
    [accessFrom, setAccessFrom] = useState(client.access),
    [draft, setDraftText] = useState(() => (composerKey === null ? "" : readDraft(composerKey)));
  const [draftFor, setDraftFor] = useState(composerKey),
    currentKey = useRef(composerKey);
  currentKey.current = composerKey;
  if (draftFor !== composerKey) {
    setDraftFor(composerKey);
    setDraftText(composerKey === null ? "" : readDraft(composerKey));
  }
  // A changed level reaches a mounted channel in place, so its messages and draft stay.
  // A discarded draft the person can no longer post, kept only for its Undo, as the page's kept edits are.
  const [discarded, setDiscarded] = useState<{ key: string | null; text: string } | null>(null);
  if (accessFrom !== client.access) {
    setAccessFrom(client.access);
    setAccess(client.access);
    setDiscarded(null);
  }
  const setDraft = (text: string) => {
    setDraftText(text);
    if (composerKey !== null) writeDraft(composerKey, text);
  };
  const [removing, setRemoving] = useState<Removing | null>(null),
    remove = client.remove;
  const [posting, setPosting] = useState(false),
    [postError, setPostError] = useState<{ text: string; retry: boolean } | null>(null);
  const postWakes = usePostWakes(client.wakes, draftKey, (messageId) =>
    messagesRef.current.some(
      (message) => message.messageId === messageId && message.deletedAtMs !== undefined,
    ),
  );
  const mounted = useRef<AbortController | null>(null),
    follower = useRef<AbortController | null>(null);
  const messagesRef = useRef<NamedChatMessage[]>([]),
    cursorRef = useRef<number | null>(null);
  // Every delete this conversation has heard. A page read before a delete can arrive after it, with the message's text.
  const deletesRef = useRef<DeletedChatMessage[]>([]);
  const intent = useRef<(ChatPost & { key: string | null }) | null>(null),
    postingRef = useRef(false),
    olderRef = useRef(false);
  const scroller = useRef<HTMLDivElement | null>(null),
    pinned = useRef(true),
    stick = useRef(false);
  const anchor = useRef<{ seq: string; offset: number } | null>(null);
  // Opening a thread moves focus to its back control. Going back returns it to the Reply that opened the thread.
  const backControl = useRef<HTMLButtonElement | null>(null),
    opener = useRef<number | null>(null),
    focusNext = useRef<"back" | number | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === "back") backControl.current?.focus();
    else if (target !== null)
      scroller.current
        ?.querySelector<HTMLElement>(`.chat-message[data-seq="${target}"] .chat-replies`)
        ?.focus();
  }, [open]);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  const receive = (
    incoming: NamedChatMessage[],
    own: boolean,
    deleted: readonly DeletedChatMessage[] = [],
  ) => {
    if (deleted.length) deletesRef.current = [...deletesRef.current, ...deleted];
    const merged = mergeChatMessages(messagesRef.current, incoming, deletesRef.current),
      added = merged.length - messagesRef.current.length;
    messagesRef.current = merged;
    setMessages(merged);
    if (own || pinned.current) stick.current = true;
    else if (added > 0) setUnseen((count) => count + added);
  };

  // Each follower owns its controller; a replaced or aborted one never repaints the channel.
  const follow = () => {
    if (cursorRef.current === null || document.visibilityState !== "visible" || !mounted.current)
      return;
    follower.current?.abort();
    const controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, mounted.current.signal]);
    follower.current = controller;
    setFollowing("live");
    const current = () => follower.current === controller && !signal.aborted;
    void (async () => {
      let delay = RETRY_INITIAL_MS,
        hold = CHAT_FOLLOW_HOLD_MS;
      while (current()) {
        try {
          const result = await client.follow(cursorRef.current!, hold, signal);
          if (!current()) return;
          cursorRef.current = result.nextCursor;
          hold = result.hasMore ? 0 : CHAT_FOLLOW_HOLD_MS;
          delay = RETRY_INITIAL_MS;
          setFollowing("live");
          if (result.messages.length || result.deleted?.length)
            receive(result.messages, false, result.deleted);
        } catch (error) {
          if (!current()) return;
          const reason = ended(error);
          if (reason) {
            onEndedRef.current(reason);
            return;
          }
          if (error instanceof NamedChatError && error.status === 400) {
            setFollowing("stopped");
            return;
          }
          // 429 means the account or relay holds its maximum of open follows, for example from other tabs. Wait for one to end.
          if (!(error instanceof NamedChatError && error.status === 429)) setFollowing("delayed");
          await wait(delay, signal);
          delay = Math.min(delay * 2, RETRY_MAX_MS);
        }
      }
    })();
  };

  useEffect(() => {
    const controller = new AbortController();
    mounted.current = controller;
    const visibility = () => {
      if (document.visibilityState === "visible") follow();
      else {
        follower.current?.abort();
        follower.current = null;
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      controller.abort();
      follower.current?.abort();
      follower.current = null;
      deletesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadFailed(false);
    void client.readHistory(null, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        // A message posted while history loaded stays in the list.
        messagesRef.current = mergeChatMessages(
          result.messages,
          messagesRef.current,
          deletesRef.current,
        );
        cursorRef.current = result.nextCursor;
        stick.current = true;
        setMessages(messagesRef.current);
        setOlderCursor(result.olderCursor);
        follow();
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const reason = ended(error);
        if (reason) onEndedRef.current(reason);
        else setLoadFailed(true);
      },
    );
    return () => controller.abort();
  }, [attempt]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const place = anchor.current;
    anchor.current = null;
    if (place) {
      const item = node.querySelector(`.chat-message[data-seq="${place.seq}"]`);
      if (item)
        node.scrollTop +=
          item.getBoundingClientRect().top - node.getBoundingClientRect().top - place.offset;
      stick.current = false;
    } else if (stick.current) {
      node.scrollTop = node.scrollHeight;
      stick.current = false;
      pinned.current = true;
      setUnseen(0);
    }
  }, [messages]);

  const scrolled = () => {
    const node = scroller.current;
    if (!node) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < PINNED_PX;
    if (pinned.current) setUnseen(0);
  };
  const jump = () => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
    pinned.current = true;
    setUnseen(0);
  };
  // Keep the first visible message in place, whatever else the same commit adds above or below it.
  const holdPlace = () => {
    const node = scroller.current;
    if (!node) return;
    const top = node.getBoundingClientRect().top;
    const first = [...node.querySelectorAll<HTMLElement>(".chat-message")].find(
      (item) => item.getBoundingClientRect().bottom > top,
    );
    if (first?.dataset.seq)
      anchor.current = { seq: first.dataset.seq, offset: first.getBoundingClientRect().top - top };
    else stick.current = true;
  };

  const loadOlder = async () => {
    const controller = mounted.current,
      before = olderCursor;
    if (!controller || before === null || olderRef.current) return;
    olderRef.current = true;
    setOlder("loading");
    try {
      const result = await client.readHistory(before, controller.signal);
      if (controller.signal.aborted) return;
      holdPlace();
      // Older pages never move the following cursor.
      messagesRef.current = mergeChatMessages(
        messagesRef.current,
        result.messages,
        deletesRef.current,
      );
      setMessages(messagesRef.current);
      setOlderCursor(result.olderCursor);
      setOlder("idle");
    } catch (error) {
      if (controller.signal.aborted) return;
      const reason = ended(error);
      if (reason) onEndedRef.current(reason);
      else setOlder("failed");
    } finally {
      if (!controller.signal.aborted) olderRef.current = false;
    }
  };

  const body = client.normalize(draft),
    tooLong = client.tooLong(draft);
  const placeholder = !threads
    ? channelPlaceholder
    : open
      ? "Reply…"
      : lane === "posts"
        ? `What's happening in #${name ?? "Group"}?`
        : `Message #${name ?? "Group"}`;
  const target: Omit<ChatPost, "id" | "body"> = !threads
    ? {}
    : open
      ? { threadId: open.threadId, ...(open.rootId ? { parentMessageId: open.rootId } : {}) }
      : { lane };
  const view =
    threads && messages
      ? threadView(
          messages,
          lane,
          open,
          (thread, seq) => {
            setOpen(thread);
            stick.current = true;
            opener.current = seq;
            focusNext.current = "back";
          },
          (thread) => draftKey !== undefined && readDraft(threadKey(thread)) !== "",
        )
      : null;
  const shown = view?.shown ?? messages;
  const showLane = (next: Lane) => {
    setLane(next);
    setOpen(null);
    intent.current = null;
    setPostError(null);
    stick.current = true;
  };
  // The arrow keys, Home and End move between the lanes, as between the workspace's tabs.
  const moveLane = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = LANES.findIndex(([value]) => value === lane),
      count = LANES.length;
    const target =
      event.key === "ArrowRight"
        ? (index + 1) % count
        : event.key === "ArrowLeft"
          ? (index + count - 1) % count
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : -1;
    if (target < 0) return;
    event.preventDefault();
    showLane(LANES[target]![0]);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
  };
  const send = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const controller = mounted.current;
    if (!controller || body === null || holdSend || postingRef.current || access !== "read-write")
      return;
    // The same text keeps its client ID, so a retry after an unknown outcome cannot post twice.
    const post =
      intent.current?.body === body && intent.current.key === composerKey
        ? intent.current
        : { id: crypto.randomUUID(), body, key: composerKey, ...target };
    intent.current = post;
    postingRef.current = true;
    setPosting(true);
    setPostError(null);
    try {
      const { key, ...sent } = post;
      const message = await client.post(sent, controller.signal);
      if (controller.signal.aborted) return;
      // A confirmed send clears its own composer's draft, wherever the person is now.
      intent.current = null;
      if (key !== null) writeDraft(key, "");
      if (currentKey.current === key) setDraftText("");
      receive([message], true);
      postWakes.watch(message);
    } catch (error) {
      if (controller.signal.aborted) return;
      const reason = ended(error);
      if (reason) {
        onEndedRef.current(reason);
        return;
      }
      const status = error instanceof NamedChatError ? error.status : 0;
      if (
        status === 403 &&
        error instanceof NamedChatError &&
        (error.code === "share_read_only" || error.code === "link_view_access")
      ) {
        intent.current = null;
        setAccess("read-only");
        return;
      }
      if (status === 409) intent.current = null;
      const refusal =
          error instanceof NamedChatError
            ? error.code === "too_many_wakes"
              ? chatWords.wakeTooMany
              : error.reason
            : null,
        code = error instanceof NamedChatError ? error.code : null;
      // A lost answer, a busy server or a pause can pass. Any other refusal in words says what to do instead of trying again.
      const retry =
        status === 0 ||
        status >= 500 ||
        status === 429 ||
        refusal === null ||
        code === "link_discussion_paused";
      setPostError({
        text:
          status === 0 || status >= 500
            ? POST_UNKNOWN
            : (refusal ?? (status === 429 ? POST_BUSY : POST_REFUSED)),
        retry,
      });
    } finally {
      if (!controller.signal.aborted) {
        postingRef.current = false;
        setPosting(false);
      }
    }
  };
  // The line changes from the relay's answer. Other open pages hear the delete from their follows.
  const confirmRemove = async () => {
    const controller = mounted.current,
      target = removing;
    if (!controller || !remove || !target || target.phase === "deleting") return;
    setRemoving({ ...target, phase: "deleting", why: null });
    try {
      const deleted = await remove.run(target.message, controller.signal);
      if (controller.signal.aborted) return;
      receive([], false, [deleted]);
      setRemoving(null);
    } catch (error) {
      if (controller.signal.aborted) return;
      const status = error instanceof NamedChatError ? error.status : 0;
      if (status === 401) {
        setRemoving(null);
        onEndedRef.current("signed-out");
        return;
      }
      // Every refusal reads as not-found, so a delete never confirms a hidden message.
      setRemoving({
        ...target,
        phase: "failed",
        why: status === 404 ? MESSAGE_DELETE_REFUSED : status === 0 ? MESSAGE_DELETE_OFFLINE : null,
      });
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends with a keyboard. On a touch screen Enter adds a line and the Send button sends.
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      window.matchMedia?.("(pointer: coarse)").matches
    )
      return;
    event.preventDefault();
    void send();
  };

  const status = posting
    ? "Sending…"
    : tooLong
      ? "This message is too long. Shorten it before sending."
      : (postError?.text ?? "");
  const back = open && (
    <div className="chat-thread-head">
      <button
        type="button"
        className="icon-button"
        ref={backControl}
        aria-label={lane === "posts" ? "Back to posts" : "Back to the conversation"}
        title={lane === "posts" ? "Back to posts" : "Back to the conversation"}
        onClick={() => {
          setOpen(null);
          intent.current = null;
          setPostError(null);
          stick.current = true;
          focusNext.current = opener.current;
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.9}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
      <h3>Thread</h3>
    </div>
  );
  return (
    <section className="chat-channel" aria-label={name ?? "Shared channel"}>
      {threads === "both" && !open && (
        <div className="chat-lanes" role="tablist" aria-label="Group lanes" onKeyDown={moveLane}>
          {LANES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={lane === value}
              tabIndex={lane === value ? 0 : -1}
              onClick={() => showLane(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {back}
      <div className="chat-messages">
        <div
          className="chat-scroller"
          ref={scroller}
          onScroll={scrolled}
          role="log"
          aria-label="Messages"
          tabIndex={0}
        >
          <div className="chat-column">
            {messages && olderCursor !== null && (
              <div className="chat-older">
                <button
                  type="button"
                  className="handoff-button secondary"
                  disabled={older === "loading"}
                  onClick={() => void loadOlder()}
                >
                  Load earlier messages
                </button>
                {older === "failed" && (
                  <p role="status">Earlier messages didn't load. Try again.</p>
                )}
              </div>
            )}
            {loadFailed ? (
              <div className="chat-state">
                <p>Messages didn't load.</p>
                <button
                  type="button"
                  className="handoff-button secondary"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Try again
                </button>
              </div>
            ) : !messages ? (
              <p className="chat-state">Loading messages…</p>
            ) : !shown!.length && olderCursor === null ? (
              <p className="chat-state">{empty}</p>
            ) : (
              <ol className="chat-list">
                {shown!.map((message) => (
                  <ChatMessage
                    key={message.relaySeq}
                    message={message}
                    replies={view?.replies.get(message.relaySeq)}
                    canReply={access === "read-write"}
                    readerUserId={client.readerUserId}
                    wakes={postWakes.wakes.get(message.messageId)}
                    {...(remove?.can(message)
                      ? {
                          onDelete: () =>
                            setRemoving({
                              message,
                              own: remove.own(message),
                              phase: "asking",
                              why: null,
                            }),
                        }
                      : {})}
                  />
                ))}
              </ol>
            )}
            {following === "delayed" && (
              <p className="chat-follow-status" role="status">
                New messages are delayed. dohc is trying again.
              </p>
            )}
            {following === "stopped" && (
              <div className="chat-follow-status">
                <p role="status">New messages stopped updating.</p>
                <button type="button" className="handoff-button secondary" onClick={follow}>
                  Try again
                </button>
              </div>
            )}
          </div>
        </div>
        {unseen > 0 && (
          <button type="button" className="handoff-button secondary chat-jump" onClick={jump}>
            {unseen === 1 ? "1 new message" : `${unseen} new messages`}
          </button>
        )}
      </div>
      {access === "read-only" ? (
        <div className="chat-read-only">
          <p className="chat-read-only-note">
            <Icon name="lock" size={14} />
            <span>{readOnlyNote}</span>
          </p>
          {/* Text the person wrote before they could no longer post stays theirs to copy, until they discard it. */}
          {draft ? (
            <>
              {/* The same pattern as a page's unsent edits: what and where, then where the text lives. */}
              <h3 className="chat-unsent-title">
                <Icon name="triangle-alert" size={14} />
                <span>{name ? `Unsent message to #${name}` : "Unsent message"}</span>
              </h3>
              <p className="chat-unsent-note">Only this tab has it. Copy it before you close it.</p>
              <textarea readOnly value={draft} aria-label="Your unsent message" />
              <div className="chat-unsent-actions">
                <CopyWork
                  text={draft}
                  label="Copy unsent message"
                  failure="dohc could not copy the message. Select it, then copy it."
                />
                <button
                  type="button"
                  className="handoff-button secondary"
                  onClick={() => {
                    setDiscarded({ key: composerKey, text: draft });
                    setDraft("");
                  }}
                >
                  Discard
                </button>
              </div>
            </>
          ) : (
            discarded &&
            discarded.key === composerKey && (
              <div className="chat-unsent-discarded">
                <p>Discarded your unsent message.</p>
                <button
                  type="button"
                  className="handoff-button secondary"
                  onClick={() => {
                    setDraft(discarded.text);
                    setDiscarded(null);
                  }}
                >
                  Undo
                </button>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Dismiss"
                  title="Dismiss"
                  onClick={() => setDiscarded(null)}
                >
                  <Icon name="x" />
                </button>
              </div>
            )
          )}
        </div>
      ) : (
        <form className="chat-composer" onSubmit={(event) => void send(event)}>
          {composerField}
          <div className="chat-composer-row">
            <textarea
              name="body"
              value={draft}
              readOnly={posting}
              rows={1}
              aria-label={messageLabel}
              placeholder={placeholder}
              aria-describedby="chat-composer-status"
              enterKeyHint="send"
              onKeyDown={keyDown}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                setPostError(null);
              }}
            />
            <button
              type="submit"
              className="handoff-button primary"
              disabled={posting || body === null || holdSend}
            >
              {posting ? "Sending" : "Send"}
            </button>
          </div>
          <div className="chat-composer-status">
            <p id="chat-composer-status" role="status" aria-atomic="true">
              {status}
            </p>
            {postError?.retry && !posting && (
              <button
                type="button"
                className="handoff-button secondary"
                onClick={() => void send()}
              >
                Try again
              </button>
            )}
          </div>
        </form>
      )}
      {removing && (
        <DeleteMessage
          removing={removing}
          cancel={() => setRemoving(null)}
          confirm={() => void confirmRemove()}
          fallback={scroller}
        />
      )}
    </section>
  );
}
