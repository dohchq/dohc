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
        ...(input.cursor !== undefined ? { versionId: input.cursor.versionId } : {}),
        ...(input.objectId !== undefined ? { objectId: input.objectId } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      });
      return {
        moments: history.moments.map((moment) => ({ ...moment, protected: false as const })),
        startCursor: history.startCursor,
        nextCursor: history.nextCursor,
        versionMarkers: history.versionMarkers,
        latestMomentOrder: history.latestMomentOrder,
        activeVersionId: history.activeVersion.id,
      };
    },
    async readMoment(momentId) {
      const moment = await store.getMoment({ workspaceId, momentId });
      return moment ? { protected: false, moment } : null;
    },
  };
}
