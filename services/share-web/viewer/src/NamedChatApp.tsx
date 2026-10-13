import {useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent} from "react";
import {renderSafeMarkdown} from "./markdown";
import {accountUser, namedRequest} from "./namedRecipient";
import {NamedSignIn, SIGN_IN_FAILED} from "./NamedSignIn";
import {CHAT_FOLLOW_HOLD_MS, chatBodyTooLong, followNamedChat, mergeChatMessages, NamedChatError, normalizeChatBody, openNamedChannel,
  postNamedChatMessage, readNamedChatHistory, type NamedChatChannel, type NamedChatMessage} from "./namedChat";
import {RETRY_INITIAL_MS, RETRY_MAX_MS} from "./retry";
import "./namedRecipient.css";
import "./namedChat.css";

type Account = {id: string; name: string};
type Pending = "account" | "sign-in" | "sign-out" | null;
type Ended = "signed-out" | "removed" | "unavailable";
const CHECK_FAILED = "dohc could not open this channel. Check your connection, then try again.";
const SIGN_OUT_FAILED = "dohc could not sign you out. Retry sign-out.";
const ENDED: Record<Ended, string> = {
  "signed-out": "Your session ended. Sign in again to keep reading.",
  removed: "The owner removed your access.",
  unavailable: "dohc could not open this channel with this account. Ask the owner to share it with you.",
};
const POST_UNKNOWN = "dohc could not confirm that your message was sent. Try again. It will not post twice.";
const POST_BUSY = "The server is busy. Try again in a moment.";
const POST_REFUSED = "The server did not accept this message. Try again.";
const PINNED_PX = 48;

/** A 401 or 404 ends the channel for this account; other failures leave it open. */
function ended(error: unknown): Ended | null {
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
const sentAt = (ms: number) => new Date(ms).toDateString() === new Date().toDateString() ? timeOfDay.format(ms) : dayAndTime.format(ms);

function ChatMessage({message}: {message: NamedChatMessage}) {
  // Attachments are out of scope, so no image source is allowed.
  const html = useMemo(() => message.body === null ? null : renderSafeMarkdown(message.body, () => null), [message.body]);
  const agent = message.authorKind !== "human";
  return <li className="chat-message">
    <p className="chat-meta">
      {agent && <span className="chat-agent-mark" role="img" aria-label={message.authorKind === "agent" ? "Agent" : "Automation"}/>}
      <span className="chat-author">{message.authorDisplayName}</span>
      {agent && message.authorOwnerDisplayName && <span className="chat-owner">Owned by {message.authorOwnerDisplayName}</span>}
      <time dateTime={new Date(message.createdAtMs).toISOString()}>{sentAt(message.createdAtMs)}</time>
    </p>
    {html === null ? <p className="chat-body chat-body-omitted">This message is too long to show in the browser.</p> :
      <div className="markdown chat-body" dangerouslySetInnerHTML={{__html: html}}/>}
  </li>;
}

function ChannelView({channel, account, onEnded}: {channel: NamedChatChannel; account: Account; onEnded(reason: Ended): void}) {
  const [messages, setMessages] = useState<NamedChatMessage[] | null>(null), [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0), [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [older, setOlder] = useState<"idle" | "loading" | "failed">("idle");
  const [following, setFollowing] = useState<"live" | "delayed" | "stopped">("live"), [unseen, setUnseen] = useState(0);
  const [access, setAccess] = useState(channel.access), [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false), [postError, setPostError] = useState<string | null>(null);
  const mounted = useRef<AbortController | null>(null), follower = useRef<AbortController | null>(null);
  const messagesRef = useRef<NamedChatMessage[]>([]), cursorRef = useRef<number | null>(null);
  const intent = useRef<{id: string; body: string} | null>(null), postingRef = useRef(false), olderRef = useRef(false);
  const scroller = useRef<HTMLDivElement | null>(null), pinned = useRef(true), stick = useRef(false), anchor = useRef<number | null>(null);
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
          const result = await followNamedChat(channel, cursorRef.current!, hold, signal);
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
    void readNamedChatHistory(channel, null, controller.signal).then(result => {
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
    if (anchor.current !== null) {node.scrollTop = node.scrollHeight - anchor.current; anchor.current = null;}
    else if (stick.current) {node.scrollTop = node.scrollHeight; stick.current = false; pinned.current = true; setUnseen(0);}
  }, [messages]);

  const scrolled = () => {
    const node = scroller.current;
    if (!node) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < PINNED_PX;
    if (pinned.current) setUnseen(0);
  };
  const jump = () => {const node = scroller.current; if (node) node.scrollTop = node.scrollHeight; pinned.current = true; setUnseen(0);};

  const loadOlder = async () => {
    const controller = mounted.current, before = olderCursor;
    if (!controller || before === null || olderRef.current) return;
    olderRef.current = true; setOlder("loading");
    try {
      const result = await readNamedChatHistory(channel, before, controller.signal);
      if (controller.signal.aborted) return;
      const node = scroller.current; if (node) anchor.current = node.scrollHeight - node.scrollTop;
      // Older pages never move the following cursor.
      messagesRef.current = mergeChatMessages(messagesRef.current, result.messages); setMessages(messagesRef.current);
      setOlderCursor(result.olderCursor); setOlder("idle");
    } catch (error) {
      if (controller.signal.aborted) return;
      const reason = ended(error);
      if (reason) onEndedRef.current(reason); else setOlder("failed");
    } finally {if (!controller.signal.aborted) olderRef.current = false;}
  };

  const body = normalizeChatBody(draft), tooLong = chatBodyTooLong(draft);
  const send = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const controller = mounted.current;
    if (!controller || body === null || postingRef.current || access !== "read-write") return;
    // The same text keeps its client ID, so a retry after an unknown outcome cannot post twice.
    const post = intent.current?.body === body ? intent.current : {id: crypto.randomUUID(), body};
    intent.current = post; postingRef.current = true; setPosting(true); setPostError(null);
    try {
      const message = await postNamedChatMessage(channel, {id: post.id, body: post.body, authorDisplayName: account.name}, controller.signal);
      if (controller.signal.aborted) return;
      intent.current = null; setDraft(""); receive([message], true);
    } catch (error) {
      if (controller.signal.aborted) return;
      const reason = ended(error);
      if (reason) {onEndedRef.current(reason); return;}
      const status = error instanceof NamedChatError ? error.status : 0;
      if (status === 403 && error instanceof NamedChatError && error.code === "share_read_only") {intent.current = null; setAccess("read-only"); return;}
      if (status === 409) intent.current = null;
      setPostError(status === 0 || status >= 500 ? POST_UNKNOWN : status === 429 ? POST_BUSY : POST_REFUSED);
    } finally {if (!controller.signal.aborted) {postingRef.current = false; setPosting(false);}}
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends with a keyboard. On a touch screen Enter adds a line and the Send button sends.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || window.matchMedia?.("(pointer: coarse)").matches) return;
    event.preventDefault(); void send();
  };

  const status = posting ? "Sending…" : tooLong ? "This message is too long. Shorten it before sending." : postError ?? "";
  return <section className="chat-channel" aria-label={channel.name ?? "Shared channel"}>
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
            <ol className="chat-list">{messages.map(message => <ChatMessage key={message.messageId} message={message}/>)}</ol>}
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
      <div className="chat-composer-row">
        <textarea name="body" value={draft} readOnly={posting} rows={1} aria-label="Message" aria-describedby="chat-composer-status"
          enterKeyHint="send" onKeyDown={keyDown} onChange={event => {setDraft(event.currentTarget.value); setPostError(null);}}/>
        <button type="submit" className="handoff-button primary" disabled={posting || body === null}>{posting ? "Sending" : "Send"}</button>
      </div>
      <div className="chat-composer-status"><p id="chat-composer-status" role="status" aria-atomic="true">{status}</p>
        {postError && !posting && <button type="button" className="handoff-button secondary" onClick={() => void send()}>Try again</button>}</div>
    </form>}
  </section>;
}

export default function NamedChatApp({grantId}: {grantId: string | null}) {
  const [account, setAccount] = useState<Account | null>(null), [channel, setChannel] = useState<NamedChatChannel | null>(null);
  const [pending, setPending] = useState<Pending>(grantId ? "account" : null), [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null), shell = useRef<HTMLDivElement | null>(null);
  const start = (work: Exclude<Pending, null>) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setPending(work); setError(null); return controller;
  };
  const finish = (controller: AbortController, message: string | null) => {
    if (controller.signal.aborted || request.current !== controller) return;
    setPending(null); if (message) setError(message);
  };
  const load = async (controller: AbortController) => {
    const user = accountUser(await namedRequest("/api/account/session", controller.signal));
    if (controller.signal.aborted || request.current !== controller) return;
    setAccount(user); setChannel(null);
    if (!user || !grantId) return;
    const opened = await openNamedChannel(grantId, controller.signal);
    if (controller.signal.aborted || request.current !== controller) return;
    if (opened.userId !== user.id) throw Error("The channel answered for another account.");
    setChannel(opened);
  };
  const failed = (controller: AbortController) => (cause: unknown) => {
    if (controller.signal.aborted || request.current !== controller) return;
    const reason = ended(cause);
    if (reason === "signed-out") setAccount(null);
    finish(controller, reason ? ENDED[reason] : CHECK_FAILED);
  };
  const check = () => {const controller = start("account"); void load(controller).then(() => finish(controller, null), failed(controller));};
  useEffect(() => {
    setChannel(null);
    if (!grantId) return;
    check();
    return () => request.current?.abort();
  }, [grantId]);
  // Fit the column to the visible viewport, so the composer stays above an on-screen keyboard.
  useEffect(() => {
    const viewport = window.visualViewport, node = shell.current;
    if (!viewport || !node) return;
    const fit = () => {node.style.setProperty("--chat-height", `${viewport.height}px`); node.style.setProperty("--chat-top", `${viewport.offsetTop}px`);};
    fit(); viewport.addEventListener("resize", fit); viewport.addEventListener("scroll", fit);
    return () => {viewport.removeEventListener("resize", fit); viewport.removeEventListener("scroll", fit);};
  }, []);
  const signIn = (credentials: {email: string; password: string}) => {
    const controller = start("sign-in");
    void namedRequest("/api/account/sign-in", controller.signal, credentials).then(
      () => load(controller).then(() => finish(controller, null), failed(controller)),
      () => finish(controller, SIGN_IN_FAILED));
  };
  const signOut = () => {
    const controller = start("sign-out");
    void namedRequest("/api/account/sign-out", controller.signal, {}).then(
      () => {if (!controller.signal.aborted && request.current === controller) {setAccount(null); setChannel(null);} finish(controller, null);},
      () => finish(controller, SIGN_OUT_FAILED));
  };
  const end = (reason: Ended) => {
    request.current?.abort(); request.current = null; setPending(null); setChannel(null); setError(ENDED[reason]);
    if (reason === "signed-out") setAccount(null);
  };
  const busy = pending !== null;
  return <div className="viewer named-recipient named-chat" ref={shell}>
    <header><div><p className="eyebrow">dohc</p><h1>{channel?.name ?? "Shared channel"}</h1></div>
      {account && <div className="header-actions"><span>{account.name}</span><button disabled={pending === "sign-out"} className="handoff-button secondary" onClick={signOut}>Sign out</button></div>}
    </header>
    {!grantId ? <main className="download-card"><p>This invitation is unavailable. Open the invitation the owner shared with you.</p></main> :
      !account ? <NamedSignIn title="Sign in to chat" busy={busy} error={error} onSignIn={signIn}/> :
      channel ? <>{error && <p className="chat-notice" role="alert">{error}</p>}
        <ChannelView key={`${grantId}\n${channel.shareId}\n${channel.channelWireId}`} channel={channel} account={account} onEnded={end}/></> :
      <main className="download-card">
        {busy && <p role="status">{pending === "sign-out" ? "Signing out…" : "Opening shared channel…"}</p>}{error && <p role="alert">{error}</p>}
        {error && error !== ENDED.removed && <button className="handoff-button secondary" onClick={check}>Try again</button>}
      </main>}
  </div>;
}
