import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChannelView, ended, type Ended } from "./ChatChannel";
import { Icon } from "./icons";
import {
  commentsClient,
  createGroupFollow,
  openMemberGroups,
  type MemberGroups,
} from "./memberWorkspace";
import type { NamedChatAccess } from "./namedChat";
import "./namedChat.css";

// The app's sentences for a joined workspace's Groups and a file's Comments.
const READ_ONLY = "Only people who can comment post here.";
const EMPTY = "No messages yet.";
const NO_COMMENTS = "No comments yet.";
/** The membership's Groups and Comments come from one read, so its failure names both. */
export const LISTING_FAILED = "dohc could not load Groups and comments";

export type MemberListing = "loading" | "failed" | MemberGroups;

/**
 * The membership's share and Groups, which Chats and Comments both use, read once `grantId` is set:
 * after the workspace opens, so an account that holds no membership reads as refused, not ended. `retry` reads them again.
 * `refresh` reads them again without showing a load, so a Group added while the workspace is open appears.
 * Given an age, it reads only when the last read is older. A refresh that fails keeps the Groups shown, and the next one tries again.
 * `reads` counts the reads that arrived, including one that brought the same Groups.
 */
export function useMemberListing(
  grantId: string | null,
  accountId: string,
  onEnded: (reason: Ended) => void,
) {
  const [found, setFound] = useState<MemberListing>("loading"),
    [reads, setReads] = useState(0),
    [attempt, setAttempt] = useState(0);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  // When the Groups last arrived, or null before they do.
  const readAt = useRef<number | null>(null),
    request = useRef<((olderThanMs: number) => void) | null>(null);
  useEffect(() => {
    setFound("loading");
    readAt.current = null;
    if (grantId === null) return;
    const controller = new AbortController();
    // A rule can change while a read is out. A refresh asked for then reads once more after it,
    // and only the newest read asked for shows, so an older answer never replaces a newer level.
    let asked = 0,
      pending = false;
    const read = () => {
      const number = asked;
      pending = true;
      void openMemberGroups(grantId, controller.signal)
        .then(
          (groups) => {
            if (controller.signal.aborted || number !== asked) return;
            if (groups.userId !== accountId) {
              if (readAt.current === null) setFound("failed");
              return;
            }
            readAt.current = Date.now();
            setReads((count) => count + 1);
            // The same Groups keep the same object, so nothing open reads them again.
            setFound((current) =>
              typeof current === "object" && JSON.stringify(current) === JSON.stringify(groups)
                ? current
                : groups,
            );
          },
          (error: unknown) => {
            if (controller.signal.aborted) return;
            const reason = ended(error);
            // The page checks whether the membership ended. If it didn't, the Groups keep their Try again.
            // The read it asks for here would only be refused again, so it waits for the next one.
            if (reason) {
              const before = asked;
              onEndedRef.current(reason);
              asked = before;
            }
            if (readAt.current === null && number === asked) setFound("failed");
          },
        )
        .finally(() => {
          pending = false;
          if (!controller.signal.aborted && number !== asked) read();
        });
    };
    request.current = (olderThanMs) => {
      if (pending) {
        if (olderThanMs === 0) asked += 1;
        return;
      }
      if (readAt.current === null || Date.now() - readAt.current < olderThanMs) return;
      asked += 1;
      read();
    };
    read();
    return () => {
      controller.abort();
      request.current = null;
    };
  }, [grantId, accountId, attempt]);
  const refresh = useCallback((olderThanMs = 0) => request.current?.(olderThanMs), []);
  return {
    found,
    reads,
    retry: useCallback(() => setAttempt((value) => value + 1), []),
    refresh,
  };
}

/**
 * The workspace's Groups beside its files. One follow serves every Group; the
 * open one shows its messages, and the others count what arrives. `shown`
 * says whether the person can see the panel, so a phone's hidden tab counts too.
 * The follow carries every Group the member reaches, so a message in a Group the list lacks calls `onUnlisted`.
 */
export function MemberChats({
  found,
  reads,
  onRetry,
  onUnlisted,
  shown,
  onEnded,
  onUnread,
}: {
  found: MemberListing;
  // Counts the reads of the Groups that arrived, so a follow that came back 404 starts again after one.
  reads: number;
  onRetry(): void;
  onUnlisted(): void;
  shown: boolean;
  onEnded(reason: Ended): void;
  onUnread(count: number): void;
}) {
  const [open, setOpen] = useState<string | null>(null),
    [unread, setUnread] = useState<ReadonlyMap<string, number>>(new Map());
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const onUnlistedRef = useRef(onUnlisted);
  onUnlistedRef.current = onUnlisted;
  const seen = useRef({ open, shown });
  seen.current = { open, shown };
  const listed = useRef<HTMLButtonElement | null>(null),
    back = useRef<HTMLButtonElement | null>(null),
    returning = useRef<string | null>(null);
  const opened = typeof found === "object" ? found : null;
  // The first Group opens once the Groups arrive.
  useEffect(() => {
    if (opened) setOpen((current) => current ?? opened.groups[0]?.channelWireId ?? null);
  }, [opened]);

  const listedIds = useRef(new Set<string>());
  listedIds.current = new Set(opened?.groups.map((item) => item.channelWireId));
  // A follow that came back 404 stops. If the next read of the Groups arrives, the membership still holds,
  // so a new follow starts.
  const followEnded = useRef(false),
    [follows, setFollows] = useState(0);
  const followGone = (reason: Ended) => {
    followEnded.current = true;
    onEndedRef.current(reason);
  };
  useEffect(() => {
    if (!followEnded.current) return;
    followEnded.current = false;
    setFollows((count) => count + 1);
  }, [reads]);
  // A read of the Groups that brings a new one keeps the follow, so the open Group keeps its messages.
  // A new follow starts where the last one stopped, so All Groups keeps counting with no Group open.
  const shareId = opened?.shareId,
    userId = opened?.userId;
  const lastHub = useRef<ReturnType<typeof createGroupFollow> | null>(null);
  const hub = useMemo(
    () =>
      shareId && userId
        ? createGroupFollow({
            shareId,
            userId,
            since: lastHub.current?.cursor(),
            onEnded: followGone,
            onMessages: (counts) => {
              if ([...counts.keys()].some((wireId) => !listedIds.current.has(wireId)))
                onUnlistedRef.current();
              setUnread((current) => {
                const next = new Map(current);
                for (const [wireId, count] of counts) {
                  // The Group in view has nothing unread.
                  if (wireId === seen.current.open && seen.current.shown) continue;
                  next.set(wireId, (next.get(wireId) ?? 0) + count);
                }
                return next;
              });
            },
          })
        : null,
    [shareId, userId, follows],
  );
  lastHub.current = hub;
  useEffect(() => {
    hub?.start();
    return () => hub?.close();
  }, [hub]);

  // Opening a Group, or showing the panel, reads what it holds.
  useEffect(() => {
    if (open === null || !shown) return;
    setUnread((current) =>
      current.has(open) ? new Map([...current].filter(([wireId]) => wireId !== open)) : current,
    );
  }, [open, shown]);
  const total = [...unread.values()].reduce((sum, count) => sum + count, 0);
  useEffect(() => onUnread(total), [total, onUnread]);
  // Focus follows the person between the list and a Group.
  useEffect(() => {
    if (returning.current === null) return;
    if (open === null) listed.current?.focus();
    else back.current?.focus();
    returning.current = null;
  }, [open]);

  const go = (wireId: string | null) => {
    returning.current = open ?? "";
    setOpen(wireId);
  };
  const group = opened?.groups.find((item) => item.channelWireId === open) ?? null;
  const others = total - (group ? (unread.get(group.channelWireId) ?? 0) : 0);
  return (
    <section
      className="comments-panel link-channel member-chats"
      aria-label="Chats"
      aria-busy={found === "loading"}
    >
      {group && opened && hub ? (
        <>
          <div className="chats-head">
            {opened.groups.length > 1 && (
              <button
                ref={back}
                className="icon-button"
                type="button"
                aria-label={others > 0 ? `All Groups, ${others} unread` : "All Groups"}
                title="All Groups"
                onClick={() => go(null)}
              >
                <Icon name="chevron-left" />
                {others > 0 && <span className="unread-count">{others}</span>}
              </button>
            )}
            <span className="chats-hash">
              <Icon name="hash" size={14} />
            </span>
            <h2>{group.name ?? "Group"}</h2>
          </div>
          {/* A Group rule can set its level apart from the member level. A changed level reaches the open Group in place. */}
          <ChannelView
            key={`${opened.shareId}\n${group.channelWireId}\n${follows}`}
            client={hub.client(group)}
            name={group.name}
            onEnded={followGone}
            readOnlyNote={READ_ONLY}
            empty={EMPTY}
            threads={group.type ?? "both"}
            draftKey={`${opened.userId}\n${opened.shareId}\ngroup\n${group.channelWireId}`}
          />
        </>
      ) : (
        <>
          <div className="chats-head">
            <h2>Groups</h2>
          </div>
          {found === "loading" ? (
            <p className="chat-state">Loading Groups…</p>
          ) : found === "failed" ? (
            <LoadFailed onRetry={onRetry} />
          ) : !found.groups.length ? (
            <p className="chat-state">No Groups in this workspace yet.</p>
          ) : (
            <ul className="group-list">
              {found.groups.map((item) => {
                const count = unread.get(item.channelWireId) ?? 0;
                return (
                  <li key={item.channelWireId}>
                    <button
                      ref={returning.current === item.channelWireId ? listed : undefined}
                      type="button"
                      className={count ? "group-row unread" : "group-row"}
                      onClick={() => go(item.channelWireId)}
                    >
                      <Icon name="hash" size={14} />
                      <span className="group-name">{item.name ?? "Group"}</span>
                      {count > 0 && (
                        <span className="unread-count">
                          {count}
                          <span className="sr-only"> unread</span>
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

// A list that could not load keeps one line in its place, beside its Try again. The toast says the same, and the rest.
// One read lists the Groups and the membership that Comments use, so either list names both.
function LoadFailed({ onRetry }: { onRetry(): void }) {
  return (
    <div className="load-failed" role="alert">
      <p>{LISTING_FAILED}.</p>
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/**
 * A file's Comments beside it: the threads on the file that the owner's dohc and every member read.
 * At View there is nothing to write in, only the note.
 * The relay keeps Comments on the file's object, so a new object at the same path opens its own, with its own draft.
 */
export function MemberComments({
  found,
  onRetry,
  path,
  objectId,
  access,
  onEnded,
}: {
  found: MemberListing;
  onRetry(): void;
  path: string;
  objectId: string;
  access: NamedChatAccess;
  onEnded(reason: Ended): void;
}) {
  const opened = typeof found === "object" ? found : null;
  const client = useMemo(
    () =>
      opened &&
      commentsClient({
        shareId: opened.shareId,
        userId: opened.userId,
        path,
        access,
        maxPostBytes: opened.maxPostBytes,
        maxBodyBytes: opened.maxBodyBytes,
      }),
    [opened, path, access],
  );
  const name = path.split("/").at(-1) ?? path;
  return (
    <section className="comments-panel link-channel member-comments" aria-label="Comments">
      <div className="chats-head">
        <h2>Comments</h2>
        <span className="comments-file" title={path}>
          {name}
        </span>
      </div>
      {client && opened ? (
        <ChannelView
          key={`${opened.shareId}\n${path}\n${objectId}\n${access}`}
          client={client}
          name={`Comments on ${name}`}
          onEnded={onEnded}
          readOnlyNote={READ_ONLY}
          empty={NO_COMMENTS}
          messageLabel="Comment"
          placeholder="Comment on this file…"
          draftKey={`${opened.userId}\n${opened.shareId}\nfile\n${objectId}`}
        />
      ) : found === "failed" ? (
        <LoadFailed onRetry={onRetry} />
      ) : (
        <p className="chat-state">Loading comments…</p>
      )}
    </section>
  );
}
