import {useEffect, useMemo, useRef, useState, type ReactNode} from "react";
import {normalizeShareDiscussionDisplayName} from "@dohc/security-contract/share-discussion";
import {linkChatClient, openLinkChannel, type LinkChannel} from "./linkChat";
import {ChannelView, ended, type ChatChannelClient} from "./ChatChannel";
import {NamedChatError} from "./namedChat";
import "./namedRecipient.css";
import "./namedChat.css";

const ENDED = "This link no longer opens this channel. Ask the owner for a new link.";

/**
 * A Group share's channel beside its files: read with any link, posted to with
 * a read-write one. The share's answer names the channel, as `channelWireId`;
 * any other link has none, so `fallback` shows.
 */
export function LinkChannelPanel({session, channelWireId, fallback}: {session: string; channelWireId: string | null; fallback: ReactNode}) {
  const [found, setFound] = useState<"checking" | "failed" | LinkChannel>("checking"), [attempt, setAttempt] = useState(0);
  const [closed, setClosed] = useState(false);
  const [name, setName] = useState(""), [committedName, setCommittedName] = useState<string | null>(null);
  const channel = typeof found === "object" ? found : null;
  const claimed = name.trim() === "" ? null : normalizeShareDiscussionDisplayName(name);
  const sentName = useRef<string | null>(null);
  sentName.current = committedName !== null || !claimed?.ok ? null : claimed.value;

  useEffect(() => {
    setFound("checking"); setClosed(false); setName(""); setCommittedName(null);
    if (channelWireId === null) return;
    const controller = new AbortController();
    // A failed check keeps the channel's place. A name set on an earlier visit is not asked for again.
    void openLinkChannel(session, channelWireId, controller.signal).then(opened => {
      if (!controller.signal.aborted) {setFound(opened); setCommittedName(opened.profileName);}
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      if (ended(error)) setClosed(true); else setFound("failed");
    });
    return () => controller.abort();
  }, [session, channelWireId, attempt]);

  const client = useMemo((): ChatChannelClient | null => {
    if (!channel) return null;
    const base = linkChatClient(session, channel, () => sentName.current);
    // The relay keeps the first name a link sends; after that the field is gone.
    return {...base, async post(post, signal) {
      const named = sentName.current !== null;
      try {
        const message = await base.post(post, signal);
        if (named) setCommittedName(message.authorDisplayName);
        return message;
      } catch (error) {
        // Another tab set the name first: the channel answer names it.
        if (error instanceof NamedChatError && error.code === "link_name_already_set") {
          const reread = await openLinkChannel(session, channel.channelWireId, signal).catch(() => null);
          if (reread?.profileName && !signal.aborted) setCommittedName(reread.profileName);
        }
        throw error;
      }
    }};
  }, [session, channel]);

  if (channelWireId === null) return <>{fallback}</>;
  return <aside className="comments-panel link-channel named-recipient" aria-label={channel?.name ?? "Channel"} aria-busy={!closed && found === "checking"}>
    <h2>{channel?.name ?? "Channel"}</h2>
    {closed ? <p className="chat-state" role="alert">{ENDED}</p> :
      found === "checking" ? <p className="chat-state">Loading messages…</p> :
      found === "failed" || !client ? <div className="chat-state"><p>Messages didn't load.</p>
        <button type="button" className="handoff-button secondary" onClick={() => setAttempt(value => value + 1)}>Try again</button></div> :
      <ChannelView key={`${session}\n${found.shareId}\n${found.channelWireId}`} client={client} name={found.name}
        onEnded={() => setClosed(true)} holdSend={claimed !== null && !claimed.ok && committedName === null}
        composerField={committedName !== null ? <div className="link-channel-name"><p>Posting as <strong>{committedName}</strong></p></div> :
          <div className="link-channel-name">
            <label htmlFor="link-channel-name">Name (optional)</label>
            <input id="link-channel-name" name="claimedName" value={name} aria-describedby="link-channel-name-help"
              onChange={event => setName(event.currentTarget.value)}/>
            <p id="link-channel-name-help">{claimed !== null && !claimed.ok
              ? "Use a name of up to 40 characters."
              : "Shown with your messages, marked as a link holder. It can't be changed later."}</p>
          </div>}/>}
  </aside>;
}
