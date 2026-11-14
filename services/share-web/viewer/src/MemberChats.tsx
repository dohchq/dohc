import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {ChannelView, ended, type Ended} from "./ChatChannel";
import {Icon} from "./icons";
import {commentsClient, createGroupFollow, openMemberGroups, type MemberGroups} from "./memberWorkspace";
import type {NamedChatAccess} from "./namedChat";
import "./namedChat.css";

// The app's sentences for a joined workspace's Groups and a file's Comments.
const READ_ONLY = "Only people who can comment post here.";
const EMPTY = "No messages yet.";
const NO_COMMENTS = "No comments yet.";

export type MemberListing = "loading" | "failed" | MemberGroups;

/**
 * The membership's share and Groups, which Chats and Comments both use, read once `grantId` is set:
 * after the workspace opens, so an account that holds no membership reads as refused, not ended. `retry` reads them again.
 */
export function useMemberListing(grantId: string | null, accountId: string, onEnded: (reason: Ended) => void) {
  const [found, setFound] = useState<MemberListing>("loading"), [attempt, setAttempt] = useState(0);
  const onEndedRef = useRef(onEnded); onEndedRef.current = onEnded;
  useEffect(() => {
    setFound("loading");
    if (grantId === null) return;
    const controller = new AbortController();
    void openMemberGroups(grantId, controller.signal).then(groups => {
      if (controller.signal.aborted) return;
      setFound(groups.userId === accountId ? groups : "failed");
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      const reason = ended(error);
      if (reason) onEndedRef.current(reason); else setFound("failed");
    });
    return () => controller.abort();
  }, [grantId, accountId, attempt]);
  return {found, retry: useCallback(() => setAttempt(value => value + 1), [])};
}

/**
 * The workspace's Groups beside its files. One follow serves every Group; the
 * open one shows its messages, and the others count what arrives. `shown`
 * says whether the person can see the panel, so a phone's hidden tab counts too.
 */
export function MemberChats({found, onRetry, shown, onEnded, onUnread}: {
  found: MemberListing; onRetry(): void; shown: boolean; onEnded(reason: Ended): void; onUnread(count: number): void;
}) {
  const [open, setOpen] = useState<string | null>(null), [unread, setUnread] = useState<ReadonlyMap<string, number>>(new Map());
  const onEndedRef = useRef(onEnded); onEndedRef.current = onEnded;
  const seen = useRef({open, shown}); seen.current = {open, shown};
  const listed = useRef<HTMLButtonElement | null>(null), back = useRef<HTMLButtonElement | null>(null), returning = useRef<string | null>(null);
  const opened = typeof found === "object" ? found : null;
  // The first Group opens once the Groups arrive.
  useEffect(() => {if (opened) setOpen(current => current ?? opened.groups[0]?.channelWireId ?? null);}, [opened]);

  const hub = useMemo(() => opened && createGroupFollow({shareId: opened.shareId, userId: opened.userId,
    onEnded: reason => onEndedRef.current(reason),
    onMessages: counts => setUnread(current => {
      const next = new Map(current);
      for (const [wireId, count] of counts) {
        // The Group in view has nothing unread.
        if (wireId === seen.current.open && seen.current.shown) continue;
        next.set(wireId, (next.get(wireId) ?? 0) + count);
      }
      return next;
    })}), [opened]);
  useEffect(() => () => hub?.close(), [hub]);

  // Opening a Group, or showing the panel, reads what it holds.
  useEffect(() => {
    if (open === null || !shown) return;
    setUnread(current => current.has(open) ? new Map([...current].filter(([wireId]) => wireId !== open)) : current);
  }, [open, shown]);
  const total = [...unread.values()].reduce((sum, count) => sum + count, 0);
  useEffect(() => onUnread(total), [total, onUnread]);
  // Focus follows the person between the list and a Group.
  useEffect(() => {
    if (returning.current === null) return;
    if (open === null) listed.current?.focus(); else back.current?.focus();
    returning.current = null;
  }, [open]);

  const go = (wireId: string | null) => {returning.current = open ?? ""; setOpen(wireId);};
  const group = opened?.groups.find(item => item.channelWireId === open) ?? null;
  const others = total - (group ? unread.get(group.channelWireId) ?? 0 : 0);
  return <section className="comments-panel link-channel member-chats" aria-label="Chats" aria-busy={found === "loading"}>
    {group && opened && hub ? <>
      <div className="chats-head">
        {opened.groups.length > 1 && <button ref={back} className="icon-button" type="button" aria-label="All Groups" title="All Groups" onClick={() => go(null)}>
          <Icon name="chevron-left"/>{others > 0 && <span className="unread-count">{others}</span>}
        </button>}
        <span className="chats-hash"><Icon name="hash" size={14}/></span>
        <h2>{group.name ?? "Group"}</h2>
      </div>
      <ChannelView key={`${opened.shareId}\n${group.channelWireId}`} client={hub.client(group)} name={group.name}
        onEnded={reason => onEndedRef.current(reason)} readOnlyNote={READ_ONLY} empty={EMPTY}/>
    </> : <>
      <div className="chats-head"><h2>Chats</h2></div>
      {found === "loading" ? <p className="chat-state">Loading Groups…</p> :
        found === "failed" ? <div className="chat-state" role="alert"><p>Groups didn't load.</p>
          <button type="button" className="handoff-button secondary" onClick={onRetry}>Try again</button></div> :
        !found.groups.length ? <p className="chat-state">No Groups in this workspace yet.</p> :
        <ul className="group-list">{found.groups.map(item => {
          const count = unread.get(item.channelWireId) ?? 0;
          return <li key={item.channelWireId}>
            <button ref={returning.current === item.channelWireId ? listed : undefined} type="button"
              className={count ? "group-row unread" : "group-row"} onClick={() => go(item.channelWireId)}>
              <Icon name="hash" size={14}/><span className="group-name">{item.name ?? "Group"}</span>
              {count > 0 && <span className="unread-count">{count}<span className="sr-only"> unread</span></span>}
            </button>
          </li>;
        })}</ul>}
    </>}
  </section>;
}

/**
 * A file's Comments beside it: the threads on the file that the owner's dohc and every member read.
 * At View there is nothing to write in, only the note.
 */
export function MemberComments({found, onRetry, path, access, onEnded}: {
  found: MemberListing; onRetry(): void; path: string; access: NamedChatAccess; onEnded(reason: Ended): void;
}) {
  const opened = typeof found === "object" ? found : null;
  const client = useMemo(() => opened && commentsClient({shareId: opened.shareId, userId: opened.userId, path, access,
    maxPostBytes: opened.maxPostBytes, maxBodyBytes: opened.maxBodyBytes}), [opened, path, access]);
  const name = path.split("/").at(-1) ?? path;
  return <section className="comments-panel link-channel member-comments" aria-label="Comments">
    <div className="chats-head"><h2>Comments</h2><span className="comments-file" title={path}>{name}</span></div>
    {client && opened ? <ChannelView key={`${opened.shareId}\n${path}\n${access}`} client={client} name={`Comments on ${name}`}
      onEnded={onEnded} readOnlyNote={READ_ONLY} empty={NO_COMMENTS} messageLabel="Comment"
      placeholder="Comment on this file…"/> :
      found === "failed" ? <div className="chat-state" role="alert"><p>Comments didn't load.</p>
        <button type="button" className="handoff-button secondary" onClick={onRetry}>Try again</button></div> :
      <p className="chat-state">Loading comments…</p>}
  </section>;
}
