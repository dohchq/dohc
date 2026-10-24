import {useEffect, useRef, useState} from "react";
import {accountUser, namedRequest} from "./namedRecipient";
import {NamedSignIn, signInErrorMessage} from "./NamedSignIn";
import {chatBodyTooLong, followNamedChat, normalizeChatBody, openNamedChannel, postNamedChatMessage, readNamedChatHistory, type NamedChatChannel} from "./namedChat";
import {ChannelView, ended, type ChatChannelClient, type Ended} from "./ChatChannel";
import "./namedRecipient.css";
import "./namedChat.css";

type Account = {id: string; name: string};
type Pending = "account" | "sign-in" | "sign-out" | null;
const CHECK_FAILED = "dohc could not open this channel. Check your connection, then try again.";
const SIGN_OUT_FAILED = "dohc could not sign you out. Retry sign-out.";
const ENDED: Record<Ended, string> = {
  "signed-out": "Your session ended. Sign in again to keep reading.",
  removed: "The owner removed your access.",
  unavailable: "dohc could not open this channel with this account. Ask the owner to share it with you.",
};

function namedClient(channel: NamedChatChannel): ChatChannelClient {
  return {
    access: channel.access,
    readHistory: (before, signal) => readNamedChatHistory(channel, before, signal),
    follow: (since, holdMs, signal) => followNamedChat(channel, since, holdMs, signal),
    post: (post, signal) => postNamedChatMessage(channel, post, signal),
    normalize: text => normalizeChatBody(text, channel),
    tooLong: text => chatBodyTooLong(text, channel),
  };
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
      (reason: unknown) => finish(controller, signInErrorMessage(reason)));
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
      !account ? <NamedSignIn title="Sign in to chat" busy={busy} error={error} onSignIn={signIn}>
        {error === CHECK_FAILED && <button className="handoff-button secondary" onClick={check}>Try again</button>}
      </NamedSignIn> :
      channel ? <>{error && <p className="chat-notice" role="alert">{error}</p>}
        <ChannelView key={`${grantId}\n${channel.shareId}\n${channel.channelWireId}`} client={namedClient(channel)} name={channel.name} onEnded={end}/></> :
      <main className="download-card">
        {busy && <p role="status">{pending === "sign-out" ? "Signing out…" : "Opening shared channel…"}</p>}{error && <p role="alert">{error}</p>}
        {error && error !== ENDED.removed && <button className="handoff-button secondary" onClick={check}>Try again</button>}
      </main>}
  </div>;
}
