import {useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode} from "react";
import {renderSafeMarkdown} from "./markdown";
import {CHAT_FOLLOW_HOLD_MS, mergeChatMessages, NamedChatError, type NamedChatAccess, type NamedChatMessage} from "./namedChat";
import {RETRY_INITIAL_MS, RETRY_MAX_MS} from "./retry";
import "./namedChat.css";

// One channel view for the named chat page and the link viewer.
export type Ended = "signed-out" | "removed" | "unavailable";
const POST_UNKNOWN = "dohc could not confirm that your message was sent. Try again. It will not post twice.";
const POST_BUSY = "The server is busy. Try again in a moment.";
const POST_REFUSED = "The server did not accept this message. Try again.";
const PINNED_PX = 48;

/** A 401 or 404 ends the channel for this account; other failures leave it open. */
export function ended(error: unknown): Ended | null {
  if (!(error instanceof NamedChatError)) return null;
  if (error.status === 401) return "signed-out";
  if (error.status === 404) return error.code === "share_access_removed" ? "removed" : "unavailable";
  return null;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {clearTimeout(timer); signal.removeEventListener("abort", done); resolve();};
    const timer = setTimeout(done, ms); signal.addEventListener("abort", done, {once: true});
  });
}

const timeOfDay = new Intl.DateTimeFormat(undefined, {hour: "numeric", minute: "2-digit"});
const dayAndTime = new Intl.DateTimeFormat(undefined, {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});
const sentAt = (date: Date) => date.toDateString() === new Date().toDateString() ? timeOfDay.format(date) : dayAndTime.format(date);

// Beside a link holder's chosen name: the share link's mark, as the desktop shows it.
function LinkHolderMark() {
  return <svg className="chat-link-mark" role="img" aria-label="Link holder" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><title>Link holder</title>
    <path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/></svg>;
}

function ChatMessage({message}: {message: NamedChatMessage}) {
  // Attachments are out of scope, so no image source is allowed.
  const html = useMemo(() => message.body === null ? null : renderSafeMarkdown(message.body, () => null), [message.body]);
  const agent = message.authorKind === "agent" || message.authorKind === "automation";
  // A safe integer can lie outside the Date range; such a message shows without a time.
  const sent = new Date(message.createdAtMs), dated = !Number.isNaN(sent.getTime());
  return <li className="chat-message" data-seq={message.relaySeq} data-author-kind={message.authorKind}>
    <p className="chat-meta">
      {agent && <span className="chat-agent-mark" role="img" aria-label={message.authorKind === "agent" ? "Agent" : "Automation"}/>}
      <span className="chat-author">{message.authorDisplayName}</span>
      {message.authorKind === "link" && <LinkHolderMark/>}
      {agent && message.authorOwnerDisplayName && <span className="chat-owner">Owned by {message.authorOwnerDisplayName}</span>}
      {dated && <time dateTime={sent.toISOString()}>{sentAt(sent)}</time>}
    </p>
    {html === null ? <p className="chat-body chat-body-omitted">This message is too long to show in the browser.</p> :
      <div className="markdown chat-body" dangerouslySetInnerHTML={{__html: html}}/>}
  </li>;
}

/** How a channel view reads, follows and posts: through a named account, or through a share link. */
export interface ChatChannelClient {
  access: NamedChatAccess;
  readHistory(before: number | null, signal: AbortSignal): Promise<{messages: NamedChatMessage[]; nextCursor: number; olderCursor: number | null}>;
  follow(since: number, holdMs: number, signal: AbortSignal): Promise<{messages: NamedChatMessage[]; nextCursor: number; hasMore: boolean}>;
  post(post: {id: string; body: string}, signal: AbortSignal): Promise<NamedChatMessage>;
  /** The body the relay stores, or null when it would refuse it. */
  normalize(text: string): string | null;
  tooLong(text: string): boolean;
}

/** `composerField` sits above the message box; while `holdSend` is set, the message waits for that field. */
export function ChannelView({client, name, onEnded, composerField, holdSend = false}: {
  client: ChatChannelClient; name: string | null; onEnded(reason: Ended): void; composerField?: ReactNode; holdSend?: boolean;
}) {
  const [messages, setMessages] = useState<NamedChatMessage[] | null>(null), [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0), [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [older, setOlder] = useState<"idle" | "loading" | "failed">("idle");
  const [following, setFollowing] = useState<"live" | "delayed" | "stopped">("live"), [unseen, setUnseen] = useState(0);
  const [access, setAccess] = useState(client.access), [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false), [postError, setPostError] = useState<{text: string; retry: boolean} | null>(null);
  const mounted = useRef<AbortController | null>(null), follower = useRef<AbortController | null>(null);
  const messagesRef = useRef<NamedChatMessage[]>([]), cursorRef = useRef<number | null>(null);
  const intent = useRef<{id: string; body: string} | null>(null), postingRef = useRef(false), olderRef = useRef(false);
  const scroller = useRef<HTMLDivElement | null>(null), pinned = useRef(true), stick = useRef(false);
  const anchor = useRef<{seq: string; offset: number} | null>(null);
  const onEndedRef = useRef(onEnded); onEndedRef.current = onEnded;

  const receive = (incoming: NamedChatMessage[], own: boolean) => {
    const merged = mergeChatMessages(messagesRef.current, incoming), added = merged.length - messagesRef.current.length;
    messagesRef.current = merged; setMessages(merged);
    if (own || pinned.current) stick.current = true;
    else if (added > 0) setUnseen(count => count + added);
  };

  // Each follower owns its controller; a replaced or aborted one never repaints the channel.
  const follow = () => {
    if (cursorRef.current === null || document.visibilityState !== "visible" || !mounted.current) return;
    follower.current?.abort();
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, mounted.current.signal]);
    follower.current = controller; setFollowing("live");
    const current = () => follower.current === controller && !signal.aborted;
    void (async () => {
      let delay = RETRY_INITIAL_MS, hold = CHAT_FOLLOW_HOLD_MS;
      while (current()) {
        try {
          const result = await client.follow(cursorRef.current!, hold, signal);
          if (!current()) return;
          cursorRef.current = result.nextCursor; hold = result.hasMore ? 0 : CHAT_FOLLOW_HOLD_MS; delay = RETRY_INITIAL_MS;
          setFollowing("live");
          if (result.messages.length) receive(result.messages, false);
        } catch (error) {
          if (!current()) return;
          const reason = ended(error);
          if (reason) {onEndedRef.current(reason); return;}
          if (error instanceof NamedChatError && error.status === 400) {setFollowing("stopped"); return;}
          // 429 means the account or relay holds its maximum of open follows, for example from other tabs. Wait for one to end.
          if (!(error instanceof NamedChatError && error.status === 429)) setFollowing("delayed");
          await wait(delay, signal); delay = Math.min(delay * 2, RETRY_MAX_MS);
        }
      }
    })();
  };

  useEffect(() => {
    const controller = new AbortController(); mounted.current = controller;
    const visibility = () => {
      if (document.visibilityState === "visible") follow();
      else {follower.current?.abort(); follower.current = null;}
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {document.removeEventListener("visibilitychange", visibility); controller.abort(); follower.current?.abort(); follower.current = null;};
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadFailed(false);
    void client.readHistory(null, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      // A message posted while history loaded stays in the list.
      messagesRef.current = mergeChatMessages(result.messages, messagesRef.current); cursorRef.current = result.nextCursor; stick.current = true;
      setMessages(messagesRef.current); setOlderCursor(result.olderCursor); follow();
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      const reason = ended(error);
      if (reason) onEndedRef.current(reason); else setLoadFailed(true);
    });
    return () => controller.abort();
  }, [attempt]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const place = anchor.current; anchor.current = null;
    if (place) {
      const item = node.querySelector(`.chat-message[data-seq="${place.seq}"]`);
      if (item) node.scrollTop += item.getBoundingClientRect().top - node.getBoundingClientRect().top - place.offset;
      stick.current = false;
    } else if (stick.current) {node.scrollTop = node.scrollHeight; stick.current = false; pinned.current = true; setUnseen(0);}
  }, [messages]);

  const scrolled = () => {
    const node = scroller.current;
    if (!node) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < PINNED_PX;
    if (pinned.current) setUnseen(0);
  };
  const jump = () => {const node = scroller.current; if (node) node.scrollTop = node.scrollHeight; pinned.current = true; setUnseen(0);};
  // Keep the first visible message in place, whatever else the same commit adds above or below it.
  const holdPlace = () => {
    const node = scroller.current;
    if (!node) return;
    const top = node.getBoundingClientRect().top;
    const first = [...node.querySelectorAll<HTMLElement>(".chat-message")].find(item => item.getBoundingClientRect().bottom > top);
    if (first?.dataset.seq) anchor.current = {seq: first.dataset.seq, offset: first.getBoundingClientRect().top - top};
    else stick.current = true;
  };

  const loadOlder = async () => {
    const controller = mounted.current, before = olderCursor;
    if (!controller || before === null || olderRef.current) return;
    olderRef.current = true; setOlder("loading");
    try {
      const result = await client.readHistory(before, controller.signal);
      if (controller.signal.aborted) return;
      holdPlace();
      // Older pages never move the following cursor.
      messagesRef.current = mergeChatMessages(messagesRef.current, result.messages); setMessages(messagesRef.current);
      setOlderCursor(result.olderCursor); setOlder("idle");
    } catch (error) {
      if (controller.signal.aborted) return;
      const reason = ended(error);
      if (reason) onEndedRef.current(reason); else setOlder("failed");
    } finally {if (!controller.signal.aborted) olderRef.current = false;}
  };

  const body = client.normalize(draft), tooLong = client.tooLong(draft);
  const send = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const controller = mounted.current;
    if (!controller || body === null || holdSend || postingRef.current || access !== "read-write") return;
    // The same text keeps its client ID, so a retry after an unknown outcome cannot post twice.
    const post = intent.current?.body === body ? intent.current : {id: crypto.randomUUID(), body};
    intent.current = post; postingRef.current = true; setPosting(true); setPostError(null);
    try {
      const message = await client.post(post, controller.signal);
      if (controller.signal.aborted) return;
      intent.current = null; setDraft(""); receive([message], true);
    } catch (error) {
      if (controller.signal.aborted) return;
      const reason = ended(error);
      if (reason) {onEndedRef.current(reason); return;}
      const status = error instanceof NamedChatError ? error.status : 0;
      if (status === 403 && error instanceof NamedChatError && (error.code === "share_read_only" || error.code === "link_view_access")) {
        intent.current = null; setAccess("read-only"); return;
      }
      if (status === 409) intent.current = null;
      const refusal = error instanceof NamedChatError ? error.reason : null, code = error instanceof NamedChatError ? error.code : null;
      // A lost answer, a busy server or a pause can pass. Any other refusal in words says what to do instead of trying again.
      const retry = status === 0 || status >= 500 || status === 429 || refusal === null || code === "link_discussion_paused";
      setPostError({text: status === 0 || status >= 500 ? POST_UNKNOWN : refusal ?? (status === 429 ? POST_BUSY : POST_REFUSED), retry});
    } finally {if (!controller.signal.aborted) {postingRef.current = false; setPosting(false);}}
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends with a keyboard. On a touch screen Enter adds a line and the Send button sends.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || window.matchMedia?.("(pointer: coarse)").matches) return;
    event.preventDefault(); void send();
  };

  const status = posting ? "Sending…" : tooLong ? "This message is too long. Shorten it before sending." : postError?.text ?? "";
  return <section className="chat-channel" aria-label={name ?? "Shared channel"}>
    <div className="chat-messages">
      <div className="chat-scroller" ref={scroller} onScroll={scrolled} role="log" aria-label="Messages" tabIndex={0}>
        <div className="chat-column">
          {messages && olderCursor !== null && <div className="chat-older">
            <button type="button" className="handoff-button secondary" disabled={older === "loading"} onClick={() => void loadOlder()}>Load earlier messages</button>
            {older === "failed" && <p role="status">Earlier messages didn't load. Try again.</p>}
          </div>}
          {loadFailed ? <div className="chat-state"><p>Messages didn't load.</p>
            <button type="button" className="handoff-button secondary" onClick={() => setAttempt(value => value + 1)}>Try again</button></div> :
            !messages ? <p className="chat-state">Loading messages…</p> :
            !messages.length && olderCursor === null ? <p className="chat-state">No messages in this channel yet.</p> :
            <ol className="chat-list">{messages.map(message => <ChatMessage key={message.relaySeq} message={message}/>)}</ol>}
          {following === "delayed" && <p className="chat-follow-status" role="status">New messages are delayed. dohc is trying again.</p>}
          {following === "stopped" && <div className="chat-follow-status"><p role="status">New messages stopped updating.</p>
            <button type="button" className="handoff-button secondary" onClick={follow}>Try again</button></div>}
        </div>
      </div>
      {unseen > 0 && <button type="button" className="handoff-button secondary chat-jump" onClick={jump}>{unseen === 1 ? "1 new message" : `${unseen} new messages`}</button>}
    </div>
    {access === "read-only" ? <div className="chat-read-only">
      <p>You can read this channel but not post. The owner gave you read-only access.</p>
      {draft && <textarea readOnly value={draft} aria-label="Your unsent message"/>}
    </div> : <form className="chat-composer" onSubmit={event => void send(event)}>
      {composerField}
      <div className="chat-composer-row">
        <textarea name="body" value={draft} readOnly={posting} rows={1} aria-label="Message" aria-describedby="chat-composer-status"
          enterKeyHint="send" onKeyDown={keyDown} onChange={event => {setDraft(event.currentTarget.value); setPostError(null);}}/>
        <button type="submit" className="handoff-button primary" disabled={posting || body === null || holdSend}>{posting ? "Sending" : "Send"}</button>
      </div>
      <div className="chat-composer-status"><p id="chat-composer-status" role="status" aria-atomic="true">{status}</p>
        {postError?.retry && !posting && <button type="button" className="handoff-button secondary" onClick={() => void send()}>Try again</button>}</div>
    </form>}
  </section>;
}
