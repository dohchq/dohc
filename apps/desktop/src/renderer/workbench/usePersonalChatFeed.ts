import { useCallback, useRef, useState } from "react";
import type { ChatFeedItemRecord } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import type { ReactionStore } from "./reactionStore";

export function usePersonalChatFeed({ workspaceId, liveToken, reactions, onError }: {
  workspaceId: string;
  liveToken: Readonly<{ current: number }>;
  // Each item's reactions are a read of its one message.
  reactions: ReactionStore;
  onError: (message: string, cause?: unknown) => void;
}) {
  const [personalFeed, setPersonalFeed] = useState<ChatFeedItemRecord[]>([]);
  const [personalFeedLoading, setPersonalFeedLoading] = useState(false);
  const [personalFeedNextCursor, setPersonalFeedNextCursor] = useState<string | undefined>();
  const feedRefreshSeq = useRef(0);

  const resetForWorkspace = useCallback(() => {
    feedRefreshSeq.current += 1;
    setPersonalFeed([]);
    setPersonalFeedLoading(false);
    setPersonalFeedNextCursor(undefined);
  }, []);

  const prepareOpen = useCallback(() => {
    feedRefreshSeq.current += 1;
    setPersonalFeed([]);
    setPersonalFeedNextCursor(undefined);
  }, []);

  const invalidate = useCallback(() => {
    feedRefreshSeq.current += 1;
  }, []);

  const loadPersonalFeed = useCallback(
    async (cursor?: string) => {
      const token = liveToken.current;
      const refreshSeq = ++feedRefreshSeq.current;
      const requestIsCurrent = () =>
        token === liveToken.current && refreshSeq === feedRefreshSeq.current;
      setPersonalFeedLoading(true);
      try {
        const ticket = reactions.ticket();
        const page = await bridge().listPersonalChatFeed({
          workspaceId,
          ...(cursor ? { cursor } : {}),
          limit: 30,
        });
        reactions.ingest(
          page.items.map((item) => ({
            threadId: item.thread.id,
            messageIds: [item.message.id],
            reactions: item.reactions,
            ...(item.viewerAuthorId ? { viewerAuthorId: item.viewerAuthorId } : {}),
            ticket,
          })),
        );
        if (!requestIsCurrent()) return;
        setPersonalFeed((current) => (cursor ? [...current, ...page.items] : page.items));
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
        if (requestIsCurrent()) setPersonalFeedLoading(false);
      }
    },
    [liveToken, onError, reactions, workspaceId],
  );

  return {
    personalFeed,
    personalFeedLoading,
    personalFeedNextCursor,
    loadPersonalFeed,
    resetForWorkspace,
    prepareOpen,
    invalidate,
  };
}
