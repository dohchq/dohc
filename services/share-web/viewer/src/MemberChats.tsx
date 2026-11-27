import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChannelView, ended, type Ended } from "./ChatChannel";
import { Icon } from "./icons";
import {
  commentsClient,
  createGroupFollow,
  openMemberGroups,
  type MemberGroups,
} from "./memberWorkspace";
import type { ShareAccess } from "./model";
import type { NamedChatAccess } from "./namedChat";
import "./namedChat.css";
import { RETRY_INITIAL_MS, RETRY_MAX_MS } from "./retry";

// The app's sentences for a joined workspace's Groups and a file's Comments.
const READ_ONLY = "Only people who can comment post here.";
const EMPTY = "No messages yet.";
const NO_COMMENTS = "No comments yet.";
/** The membership's Groups and Comments come from one read, so its failure names both. */
export const LISTING_FAILED = "dohc could not load Groups and comments";

export type MemberListing = "loading" | "failed" | MemberGroups;

/**
 * The membership's share and Groups, which Chats and Comments both use, read once `place` is set:
 * after the workspace opens, so an account that holds no membership reads as refused, not ended. `retry` reads them again.
 * `refresh` reads them again without showing a load, so a Group added while the workspace is open appears.
 * A refresh that fails keeps the Groups shown and tries again with backoff.
 * `reads` counts the reads that arrived, including one that brought the same Groups.
 */
export function useMemberListing(
  place: string | null,
  accountId: string,
  onEnded: (reason: Ended) => void,
) {
  const [found, setFound] = useState<MemberListing>("loading"),
    [reads, setReads] = useState(0),
    [attempt, setAttempt] = useState(0);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const request = useRef<(() => void) | null>(null);
  useEffect(() => {
    setFound("loading");
    if (place === null) return;
    const controller = new AbortController();
    // A rule can change while a read is out. A refresh asked for then reads once more after it,
    // and only the newest read asked for shows, so an older answer never replaces a newer level.
    let asked = 0,
      pending = false,
      loaded = false,
      retry: ReturnType<typeof setTimeout> | undefined,
      delay = RETRY_INITIAL_MS;
    const read = () => {
      const number = asked;
      pending = true;
      clearTimeout(retry);
      void openMemberGroups(place, controller.signal)
        .then(
          (groups) => {
            if (controller.signal.aborted || number !== asked) return;
            if (groups.userId !== accountId) {
              if (!loaded) setFound("failed");
              return;
            }
            loaded = true;
            delay = RETRY_INITIAL_MS;
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
            if (number !== asked) return;
            if (!loaded) setFound("failed");
            else if (!reason) {
              retry = setTimeout(refresh, delay);
              delay = Math.min(delay * 2, RETRY_MAX_MS);
            }
          },
        )
        .finally(() => {
          pending = false;
          if (!controller.signal.aborted && number !== asked) read();
        });
    };
    const refresh = () => {
      if (pending) {
        asked += 1;
        return;
      }
      if (!loaded) return;
      asked += 1;
      read();
    };
    request.current = refresh;
    read();
    return () => {
      controller.abort();
      clearTimeout(retry);
      request.current = null;
    };
  }, [place, accountId, attempt]);
  const refresh = useCallback(() => request.current?.(), []);
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
 * The follow wakes whenever the workspace's log moves, so each move calls `onMoved`: it may have added a Group.
 */
export function MemberChats({
  found,
  reads,
  onRetry,
  onMoved,
  since,
  shown,
  onEnded,
  onUnread,
  memberLevel,
}: {
  found: MemberListing;
  // Counts the reads of the Groups that arrived, so a follow that came back 404 starts again after one.
  reads: number;
  onRetry(): void;
  onMoved(): void;
  // Where the workspace's log was when its files were read. The follow starts there, so a Group added after
  // the first read of the Groups appears even when no Group is open.
  since: number;
  shown: boolean;
  onEnded(reason: Ended): void;
  onUnread(count: number): void;
  // A Group listed at View only for a member who can comment is closed by its own rule, so its note names who posts.
  memberLevel: ShareAccess;
}) {
  const [open, setOpen] = useState<string | null>(null),
    [unread, setUnread] = useState<ReadonlyMap<string, number>>(new Map());
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const onMovedRef = useRef(onMoved);
  onMovedRef.current = onMoved;
  const firstSince = useRef(since);
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
            since: lastHub.current?.cursor() ?? firstSince.current,
            onEnded: followGone,
            onMoved: () => onMovedRef.current(),
            onMessages: (counts) => {
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
  // Only listed Groups count, so a Group a rule hides takes its count with it.
  const total = (opened?.groups ?? []).reduce(
    (sum, item) => sum + (unread.get(item.channelWireId) ?? 0),
    0,
  );
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
            client={hub.client(group, opened.moderates)}
            name={group.name}
            onEnded={followGone}
            readOnlyNote={
              group.access === "read-only" && memberLevel !== "view"
                ? `Only admins and the owner post in ${group.name ?? "this Group"}.`
                : READ_ONLY
            }
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
      commentsClient(
        {
          shareId: opened.shareId,
          userId: opened.userId,
          path,
          access,
          maxPostBytes: opened.maxPostBytes,
          maxBodyBytes: opened.maxBodyBytes,
        },
        opened.moderates,
      ),
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
          // A relay without a link key lists no identity, so the path tells files apart.
          draftKey={`${opened.userId}\n${opened.shareId}\nfile\n${objectId || `path\n${path}`}`}
        />
      ) : found === "failed" ? (
        <LoadFailed onRetry={onRetry} />
      ) : (
        <p className="chat-state">Loading comments…</p>
      )}
    </section>
  );
}
