import { useCallback, useRef, useState } from "react";
import type { ChatFeedItemRecord, ChatReactionRecord } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";

export function usePersonalChatFeed({ workspaceId, liveToken, onError, onViewer }: {
  workspaceId: string;
  liveToken: Readonly<{ current: number }>;
  onError: (message: string) => void;
  // The listing names the viewer; Home draws a Like as theirs from it.
  onViewer: (viewerAuthorId: string) => void;
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

  const clearRows = useCallback(() => {
    setPersonalFeed([]);
  }, []);

  const invalidate = useCallback(() => {
    feedRefreshSeq.current += 1;
  }, []);

  // A reaction listing answered for one message: only that item's rows for
  // that message change, so two Home items in one thread never erase each
  // other's answer.
  const setMessageReactions = useCallback(
    (messageId: string, reactions: ChatReactionRecord[]) => {
      const mine = reactions.filter((reaction) => reaction.messageId === messageId);
      setPersonalFeed((current) =>
        current.map((item) =>
          item.message.id === messageId
            ? {
                ...item,
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

  const loadPersonalFeed = useCallback(
    async (cursor?: string) => {
      const token = liveToken.current;
      const refreshSeq = ++feedRefreshSeq.current;
      const requestIsCurrent = () =>
        token === liveToken.current && refreshSeq === feedRefreshSeq.current;
      setPersonalFeedLoading(true);
      try {
        const page = await bridge().listPersonalChatFeed({
          workspaceId,
          ...(cursor ? { cursor } : {}),
          limit: 30,
        });
        if (!requestIsCurrent()) return;
        setPersonalFeed((current) => (cursor ? [...current, ...page.items] : page.items));
        setPersonalFeedNextCursor(page.nextCursor);
        if (page.viewerAuthorId) onViewer(page.viewerAuthorId);
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
          onError(ipcErrorMessage(error, "Could not load your Feed."));
        }
      } finally {
        if (requestIsCurrent()) setPersonalFeedLoading(false);
      }
    },
    [liveToken, onError, onViewer, workspaceId],
  );

  return {
    personalFeed,
    personalFeedLoading,
    personalFeedNextCursor,
    loadPersonalFeed,
    resetForWorkspace,
    prepareOpen,
    clearRows,
    invalidate,
    setMessageReactions,
  };
}
