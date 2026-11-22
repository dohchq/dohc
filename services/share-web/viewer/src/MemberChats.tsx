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
 */
export function useMemberListing(
  grantId: string | null,
  accountId: string,
  onEnded: (reason: Ended) => void,
) {
  const [found, setFound] = useState<MemberListing>("loading"),
    [attempt, setAttempt] = useState(0);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  // When the Groups last arrived, or null before they do.
  const readAt = useRef<number | null>(null),
    quiet = useRef<AbortController | null>(null);
  useEffect(() => {
    setFound("loading");
    readAt.current = null;
    if (grantId === null) return;
    const controller = new AbortController();
    void openMemberGroups(grantId, controller.signal).then(
      (groups) => {
        if (controller.signal.aborted) return;
        if (groups.userId === accountId) {
          readAt.current = Date.now();
          setFound(groups);
        } else setFound("failed");
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const reason = ended(error);
        // The page checks whether the membership ended. If it didn't, the Groups keep their Try again.
        if (reason) onEndedRef.current(reason);
        setFound("failed");
      },
    );
    return () => {
      controller.abort();
      quiet.current?.abort();
      quiet.current = null;
    };
  }, [grantId, accountId, attempt]);
  const refresh = useCallback(
    (olderThanMs = 0) => {
      if (
        grantId === null ||
        readAt.current === null ||
        quiet.current ||
        Date.now() - readAt.current < olderThanMs
      )
        return;
      const controller = new AbortController();
      quiet.current = controller;
      void openMemberGroups(grantId, controller.signal)
        .then(
          (groups) => {
            if (controller.signal.aborted || groups.userId !== accountId) return;
            readAt.current = Date.now();
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
            if (reason) onEndedRef.current(reason);
          },
        )
        .finally(() => {
          if (quiet.current === controller) quiet.current = null;
        });
    },
    [grantId, accountId],
  );
  return { found, retry: useCallback(() => setAttempt((value) => value + 1), []), refresh };
}

/**
 * The workspace's Groups beside its files. One follow serves every Group; the
 * open one shows its messages, and the others count what arrives. `shown`
 * says whether the person can see the panel, so a phone's hidden tab counts too.
 * The follow carries every Group the member reaches, so a message in a Group the list lacks calls `onUnlisted`.
 */
export function MemberChats({
  found,
  onRetry,
  onUnlisted,
  shown,
  onEnded,
  onUnread,
}: {
  found: MemberListing;
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
  // A read of the Groups that brings a new one keeps the follow, so the open Group keeps its messages.
  const shareId = opened?.shareId,
    userId = opened?.userId;
  const hub = useMemo(
    () =>
      shareId && userId
        ? createGroupFollow({
            shareId,
            userId,
            onEnded: (reason) => onEndedRef.current(reason),
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
    [shareId, userId],
  );
  useEffect(() => () => hub?.close(), [hub]);

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
            key={`${opened.shareId}\n${group.channelWireId}`}
            client={hub.client(group)}
            name={group.name}
            onEnded={(reason) => onEndedRef.current(reason)}
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
 * The relay keeps Comments on the file's object, so a new object at the same path opens its own.
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
          draftKey={`${opened.userId}\n${opened.shareId}\nfile\n${path}`}
        />
      ) : found === "failed" ? (
        <LoadFailed onRetry={onRetry} />
      ) : (
        <p className="chat-state">Loading comments…</p>
      )}
    </section>
  );
}
