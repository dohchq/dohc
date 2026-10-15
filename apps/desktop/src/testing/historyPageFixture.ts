import type { HistoryCursor } from "@dohc/workspace-engine-client";
import type { ActorPresentation } from "../ipc/bridgeContract";
export function historyCursor(momentOrder = 0): HistoryCursor {
  return { format: 1, engineUuid: "test", workspaceId: "workspace", versionId: "main", objectId: null,
    textFence: 10000, protectedFence: 10000, markerFence: 10000,
    text: { recordedAtMs: momentOrder, momentOrder }, protected: null, marker: null };
}
export const historyPageFields = { startCursor: historyCursor(), versionMarkers: [] };
/** Every author's token for a History read whose test does not look at tokens. */
export const neutralHistoryPresentations = (authors: readonly unknown[]): ActorPresentation[] =>
  authors.map(() => ({ group: "", hue: null, self: false }));
