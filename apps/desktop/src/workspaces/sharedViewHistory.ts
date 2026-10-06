import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import type { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";

type HistoryStore = Pick<ReturnType<typeof createCaptureLiveStores>["store"], "listHistoryPage" | "getMoment">;

/**
 * A received share's imported history, read from its own share-mount store.
 * That store holds only what the share's selectors imported, so a moment
 * outside the share has no row to list or open. It lists and opens moments,
 * and nothing else: a shared view keeps no capture, so it neither records nor
 * restores. Protected files never reach a received share's store.
 */
export function sharedViewHistory(store: HistoryStore, workspaceId: string):
  Pick<WorkspaceEngineCapture, "listMoments" | "readMoment"> {
  return {
    async listMoments(input = {}) {
      const history = await store.listHistoryPage({
        workspaceId,
        ...(input.objectId !== undefined ? { objectId: input.objectId } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.beforeMomentOrder !== undefined ? { beforeMomentOrder: input.beforeMomentOrder } : {}),
      });
      const page = history.textMomentPage;
      return {
        moments: page.moments.map((moment) => ({ ...moment, protected: false as const })),
        nextBeforeMomentOrder: page.nextBeforeMomentOrder,
        latestMomentOrder: page.latestMomentOrder,
        activeVersionId: history.activeVersion.id,
        protectedTruncated: false,
      };
    },
    async readMoment(momentId) {
      const moment = await store.getMoment({ workspaceId, momentId });
      return moment ? { protected: false, moment } : null;
    },
  };
}
