import { useCallback, useRef, useState } from "react";
import type { ChatFeedItemRecord, ChatReactionRecord } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";

// The viewer's own presence on one (message, emoji) cell while its write is
// in flight. `prior` holds the viewer's rows on that cell before the click,
// and `priorAt` where they sat, so a failed write puts back exactly what was
// there, where it was.
interface PendingCell {
  messageId: string;
  threadId: string;
  emoji: string;
  authorId: string;
  label: string;
  present: boolean;
  prior: ChatReactionRecord[];
  priorAt: number;
}

// One pending reaction write per message. `cell` is null when the item named
// no viewer: the write still goes, and the listing that answers it paints
// the item and names the viewer.
interface PendingReaction {
  cell: PendingCell | null;
}

function isViewerCell(reaction: ChatReactionRecord, cell: PendingCell): boolean {
  return (
    reaction.messageId === cell.messageId &&
    reaction.emoji === cell.emoji &&
    reaction.authorId === cell.authorId
  );
}

function optimisticRows(cell: PendingCell): ChatReactionRecord[] {
  return cell.present
    ? [
        {
          reactionId: `optimistic:${cell.messageId}:${cell.emoji}:${cell.authorId}`,
          messageId: cell.messageId,
          threadId: cell.threadId,
          emoji: cell.emoji,
          authorId: cell.authorId,
          authorKind: "human",
          authorDisplayName: cell.label,
        },
      ]
    : [];
}

// Replace the viewer's rows on one cell, leaving peers and other emoji alone.
// New rows go last; restored rows go back where they were.
function withViewerRows(
  reactions: ChatReactionRecord[],
  cell: PendingCell,
  rows: ChatReactionRecord[],
  at = Number.POSITIVE_INFINITY,
): ChatReactionRecord[] {
  const kept = reactions.filter((reaction) => !isViewerCell(reaction, cell));
  const index = Math.min(at, kept.length);
  return [...kept.slice(0, index), ...rows, ...kept.slice(index)];
}

export function usePersonalChatFeed({ workspaceId, liveToken, onError }: {
  workspaceId: string;
  liveToken: Readonly<{ current: number }>;
  onError: (message: string, cause?: unknown) => void;
}) {
  const [personalFeed, setPersonalFeed] = useState<ChatFeedItemRecord[]>([]);
  const [personalFeedLoading, setPersonalFeedLoading] = useState(false);
  const [personalFeedNextCursor, setPersonalFeedNextCursor] = useState<string | undefined>();
  const feedRefreshSeq = useRef(0);
  // The page read now in flight, so a write's acknowledgement can start it
  // again instead of letting a pre-write page land over the saved change.
  const feedRead = useRef<{ cursor?: string } | null>(null);
  // The rows a click reads before painting. Mirrors state for the guard.
  const latestFeed = useRef(personalFeed);
  latestFeed.current = personalFeed;
  // Keyed by message: the guard is the map, the set is what renders as
  // disabled controls. Every other message on Home stays usable.
  const pendingReactions = useRef(new Map<string, PendingReaction>());
  const [pendingReactionMessageIds, setPendingReactionMessageIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const syncPending = useCallback(() => {
    setPendingReactionMessageIds(new Set(pendingReactions.current.keys()));
  }, []);
  // Pending state lives as long as the open Home. A workspace switch, a fresh
  // open, or unmount ends every pending write's claim on the controls; the
  // write's own answer is already stale by its token.
  const clearPending = useCallback(() => {
    if (pendingReactions.current.size === 0) return;
    pendingReactions.current.clear();
    syncPending();
  }, [syncPending]);

  const resetForWorkspace = useCallback(() => {
    feedRefreshSeq.current += 1;
    clearPending();
    setPersonalFeed([]);
    setPersonalFeedLoading(false);
    setPersonalFeedNextCursor(undefined);
  }, [clearPending]);

  const prepareOpen = useCallback(() => {
    feedRefreshSeq.current += 1;
    clearPending();
    setPersonalFeed([]);
    setPersonalFeedNextCursor(undefined);
  }, [clearPending]);

  const invalidate = useCallback(() => {
    feedRefreshSeq.current += 1;
    clearPending();
  }, [clearPending]);

  // A reaction listing answered for one message: only that item's rows for
  // that message change, so two Home items in one thread never erase each
  // other's answer.
  const setMessageReactions = useCallback(
    (messageId: string, reactions: ChatReactionRecord[], viewerAuthorId: string) => {
      const mine = reactions.filter((reaction) => reaction.messageId === messageId);
      setPersonalFeed((current) =>
        current.map((item) =>
          item.message.id === messageId
            ? {
                ...item,
                viewerAuthorId,
                reactions: [
                  ...item.reactions.filter((reaction) => reaction.messageId !== messageId),
                  ...mine,
                ],
              }
            : item,
        ),
      );
    },
    [],
  );

  const paintCell = useCallback((cell: PendingCell, rows: ChatReactionRecord[], at?: number) => {
    setPersonalFeed((current) =>
      current.map((item) =>
        item.message.id === cell.messageId
          ? { ...item, reactions: withViewerRows(item.reactions, cell, rows, at) }
          : item,
      ),
    );
  }, []);

  // A page that lands while a write is pending keeps the viewer's pending
  // cell, so Home never flashes back to the state the user just left. The
  // write's own answer, or its rollback, paints the settled state.
  const withPendingCells = useCallback((items: ChatFeedItemRecord[]) => {
    if (pendingReactions.current.size === 0) return items;
    return items.map((item) => {
      const cell = pendingReactions.current.get(item.message.id)?.cell;
      return cell
        ? { ...item, reactions: withViewerRows(item.reactions, cell, optimisticRows(cell)) }
        : item;
    });
  }, []);

  const loadPersonalFeed = useCallback(
    async (cursor?: string) => {
      const token = liveToken.current;
      const refreshSeq = ++feedRefreshSeq.current;
      const read = { ...(cursor ? { cursor } : {}) };
      feedRead.current = read;
      const requestIsCurrent = () =>
        token === liveToken.current && refreshSeq === feedRefreshSeq.current;
      setPersonalFeedLoading(true);
      try {
        const page = await bridge().listPersonalChatFeed({
          workspaceId,
          ...read,
          limit: 30,
        });
        if (!requestIsCurrent()) return;
        const items = withPendingCells(page.items);
        setPersonalFeed((current) => (cursor ? [...current, ...items] : items));
        setPersonalFeedNextCursor(page.nextCursor);
        if (!cursor && page.headCursor) {
          void bridge()
            .markPersonalChatFeedSeen({
              workspaceId,
              headCursor: page.headCursor,
            })
            .catch(() => {
              // Best-effort cursor: the next Feed open can retry.
            });
        }
      } catch (error) {
        if (requestIsCurrent()) {
          onError(ipcErrorMessage(error, "Could not load your Feed."), error);
        }
      } finally {
        if (feedRead.current === read) feedRead.current = null;
        if (requestIsCurrent()) setPersonalFeedLoading(false);
      }
    },
    [liveToken, onError, withPendingCells, workspaceId],
  );

  // Like from Home. A known viewer sees their own add or remove at once; the
  // listing that answers the write is the authority for the rows and for the
  // normalized viewer, so the write's own result never names the viewer.
  const toggleMessageReaction = useCallback(
    (input: {
      threadId: string;
      messageId: string;
      emoji: string;
      nextState: "added" | "removed";
      viewerAuthorId: string | undefined;
      viewerLabel: string;
    }) => {
      const { threadId, messageId, emoji } = input;
      if (pendingReactions.current.has(messageId)) return;
      const token = liveToken.current;
      const isCurrent = () => token === liveToken.current;
      const cell: PendingCell | null = input.viewerAuthorId
        ? {
            messageId,
            threadId,
            emoji,
            authorId: input.viewerAuthorId,
            label: input.viewerLabel,
            present: input.nextState === "added",
            prior: [],
            priorAt: 0,
          }
        : null;
      if (cell) {
        const rows = latestFeed.current.find((item) => item.message.id === messageId)?.reactions ?? [];
        cell.prior = rows.filter((reaction) => isViewerCell(reaction, cell));
        cell.priorAt = Math.max(0, rows.findIndex((reaction) => isViewerCell(reaction, cell)));
        paintCell(cell, optimisticRows(cell));
      }
      const entry: PendingReaction = { cell };
      pendingReactions.current.set(messageId, entry);
      syncPending();
      void bridge()
        .setChatReaction({ workspaceId, threadId, messageId, emoji, state: input.nextState })
        .then(
          () => {
            // The write is on the server. A page read before this moment may
            // not carry it: drop that read and start it again.
            if (isCurrent()) {
              const dropped = feedRead.current;
              feedRefreshSeq.current += 1;
              if (dropped) void loadPersonalFeed(dropped.cursor);
            }
            return bridge()
              .listChatReactions({ workspaceId, threadId })
              .then(
                (result) => {
                  if (!isCurrent()) return;
                  setMessageReactions(messageId, result.reactions, result.viewerAuthorId);
                },
                (error: unknown) => {
                  // The write landed, so the painted change stays.
                  if (!isCurrent()) return;
                  onError(
                    ipcErrorMessage(
                      error,
                      "Your reaction was saved, but Home could not reload reactions.",
                    ),
                    error,
                  );
                },
              );
          },
          (error: unknown) => {
            if (!isCurrent()) return;
            if (cell) paintCell(cell, cell.prior, cell.priorAt);
            onError(ipcErrorMessage(error, "Could not update that reaction."), error);
          },
        )
        .finally(() => {
          // Only this write's own claim ends here, never a newer one's.
          if (pendingReactions.current.get(messageId) !== entry) return;
          pendingReactions.current.delete(messageId);
          syncPending();
        });
    },
    [liveToken, loadPersonalFeed, onError, paintCell, setMessageReactions, syncPending, workspaceId],
  );

  return {
    personalFeed,
    personalFeedLoading,
    personalFeedNextCursor,
    pendingReactionMessageIds,
    loadPersonalFeed,
    resetForWorkspace,
    prepareOpen,
    invalidate,
    toggleMessageReaction,
  };
}
