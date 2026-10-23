import {useEffect, useMemo, useRef, useState, type ReactNode} from "react";
import {normalizeShareDiscussionDisplayName} from "@dohc/security-contract/share-discussion";
import {linkChatClient, openLinkChannel, type LinkChannel} from "./linkChat";
import {ChannelView, type ChatChannelClient} from "./ChatChannel";
import "./namedRecipient.css";
import "./namedChat.css";

const ENDED = "This link no longer opens this channel. Ask the owner for a new link.";

/**
 * A Group share's channel beside its files: read with any link, posted to with
 * a read-write one. Any other link has no channel, so `fallback` shows.
 */
export function LinkChannelPanel({session, fallback}: {session: string; fallback: ReactNode}) {
  const [channel, setChannel] = useState<LinkChannel | null>(null), [ended, setEnded] = useState(false);
  const [name, setName] = useState(""), [nameSet, setNameSet] = useState(false);
  const claimed = name.trim() === "" ? null : normalizeShareDiscussionDisplayName(name);
  const sentName = useRef<string | null>(null);
  sentName.current = nameSet || !claimed?.ok ? null : claimed.value;

  useEffect(() => {
    const controller = new AbortController();
    setChannel(null); setEnded(false); setName(""); setNameSet(false);
    // A failed check leaves the link's other panel in place.
    void openLinkChannel(session, controller.signal).then(found => {if (!controller.signal.aborted) setChannel(found);}, () => {});
    return () => controller.abort();
  }, [session]);

  const client = useMemo((): ChatChannelClient | null => {
    if (!channel) return null;
    const base = linkChatClient(session, channel, () => sentName.current);
    // The relay keeps the first name a link sends; after that the field is gone.
    return {...base, async post(post, signal) {
      const named = sentName.current !== null, message = await base.post(post, signal);
      if (named) setNameSet(true);
      return message;
    }};
  }, [session, channel]);

  if (!channel || !client) return <>{fallback}</>;
  return <aside className="comments-panel link-channel named-recipient" aria-label={channel.name ?? "Channel"}>
    <h2>{channel.name ?? "Channel"}</h2>
    {ended ? <p className="chat-state" role="alert">{ENDED}</p> :
      <ChannelView key={`${session}\n${channel.shareId}\n${channel.channelWireId}`} client={client} name={channel.name}
        onEnded={() => setEnded(true)} holdSend={claimed !== null && !claimed.ok && !nameSet}
        composerField={nameSet ? undefined : <div className="link-channel-name">
          <label htmlFor="link-channel-name">Name (optional)</label>
          <input id="link-channel-name" name="claimedName" value={name} aria-describedby="link-channel-name-help"
            onChange={event => setName(event.currentTarget.value)}/>
          <p id="link-channel-name-help">{claimed !== null && !claimed.ok
            ? "Use a name of up to 40 characters."
            : "Shown with your messages, marked as a link holder. It can't be changed later."}</p>
        </div>}/>}
  </aside>;
}
