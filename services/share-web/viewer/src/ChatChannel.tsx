import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { renderSafeMarkdown } from "./markdown";
import { readDraft, writeDraft } from "./drafts";
import { CopyWork } from "./CopyWork";
import { Icon } from "./icons";
import {
  CHAT_FOLLOW_HOLD_MS,
  mergeChatMessages,
  NamedChatError,
  type ChatPost,
  type GroupType,
  type NamedChatAccess,
  type NamedChatMessage,
} from "./namedChat";
import { RETRY_INITIAL_MS, RETRY_MAX_MS } from "./retry";
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

/** A post or a chat message with its replies: how many, and how to open them. */
interface Replies {
  count: number;
  open(): void;
}

function ChatMessage({
  message,
  replies,
  canReply,
}: {
  message: NamedChatMessage;
  replies?: Replies;
  canReply: boolean;
}) {
  // Attachments are out of scope, so no image source is allowed.
  const html = useMemo(
    () => (message.body === null ? null : renderSafeMarkdown(message.body, () => null)),
    [message.body],
  );
  // An agent that joined with the link wears the agent mark, then the link mark.
  const agent =
    message.authorKind === "agent" || message.authorKind === "automation" || message.linkAgent;
  // A safe integer can lie outside the Date range; such a message shows without a time.
  const sent = new Date(message.createdAtMs),
    dated = !Number.isNaN(sent.getTime());
  // "Agent" is dohc's word for an agent that gave no name. Such an agent goes by whose it is, as on the desktop.
  const owner = agent ? message.authorOwnerDisplayName : null,
    unnamed = owner !== null && message.authorDisplayName === "Agent";
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
        <span className="chat-author">
          {unnamed ? `${owner}'s agent` : message.authorDisplayName}
        </span>
        {message.authorKind === "link" && <LinkHolderMark />}
        {owner && !unnamed && <span className="chat-owner">{owner}'s agent</span>}
        {dated && <time dateTime={sent.toISOString()}>{sentAt(sent)}</time>}
      </p>
      {html === null ? (
        <p className="chat-body chat-body-omitted">
          This message is too long to show in the browser.
        </p>
      ) : (
        <div className="markdown chat-body" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {/* A person who can't post has nothing to reply with, so only a thread with replies opens. */}
      {replies && (canReply || replies.count > 0) && (
        <button type="button" className="chat-replies" onClick={replies.open}>
          {replies.count === 0
            ? "Reply"
            : replies.count === 1
              ? "1 reply"
              : `${replies.count} replies`}
        </button>
      )}
    </li>
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
      replies.set(post.relaySeq, {
        count: thread.length - 1,
        open: () => onOpen({ threadId, rootId: null }, post.relaySeq),
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
    replies.set(message.relaySeq, {
      count: counts.get(message.messageId) ?? 0,
      open: () =>
        onOpen({ threadId: message.threadId, rootId: message.messageId }, message.relaySeq),
    });
  }
  return { shown, replies };
}

/** How a channel view reads, follows and posts: through a named account, or through a share link. */
export interface ChatChannelClient {
  access: NamedChatAccess;
  readHistory(
    before: number | null,
    signal: AbortSignal,
  ): Promise<{ messages: NamedChatMessage[]; nextCursor: number; olderCursor: number | null }>;
  follow(
    since: number,
    holdMs: number,
    signal: AbortSignal,
  ): Promise<{ messages: NamedChatMessage[]; nextCursor: number; hasMore: boolean }>;
  post(post: ChatPost, signal: AbortSignal): Promise<NamedChatMessage>;
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
  const composerKey =
    draftKey === undefined
      ? null
      : !threads
        ? draftKey
        : open
          ? `${draftKey}\nthread\n${open.threadId}\n${open.rootId ?? ""}`
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
  const [posting, setPosting] = useState(false),
    [postError, setPostError] = useState<{ text: string; retry: boolean } | null>(null);
  const mounted = useRef<AbortController | null>(null),
    follower = useRef<AbortController | null>(null);
  const messagesRef = useRef<NamedChatMessage[]>([]),
    cursorRef = useRef<number | null>(null);
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

  const receive = (incoming: NamedChatMessage[], own: boolean) => {
    const merged = mergeChatMessages(messagesRef.current, incoming),
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
          if (result.messages.length) receive(result.messages, false);
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
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadFailed(false);
    void client.readHistory(null, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        // A message posted while history loaded stays in the list.
        messagesRef.current = mergeChatMessages(result.messages, messagesRef.current);
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
      messagesRef.current = mergeChatMessages(messagesRef.current, result.messages);
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
      ? threadView(messages, lane, open, (thread, seq) => {
          setOpen(thread);
          stick.current = true;
          opener.current = seq;
          focusNext.current = "back";
        })
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
      const refusal = error instanceof NamedChatError ? error.reason : null,
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
          <p>{readOnlyNote}</p>
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
    </section>
  );
}
