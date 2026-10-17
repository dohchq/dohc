import type { HistoryCursor } from "@dohc/workspace-engine-client";
export function historyCursor(momentOrder = 0): HistoryCursor {
  return { format: 1, engineUuid: "test", workspaceId: "workspace", versionId: "main", objectId: null, operationId: null,
    textFence: 10000, protectedFence: 10000, markerFence: 10000,
    text: { recordedAtMs: momentOrder, momentOrder }, protected: null, marker: null };
}
export const historyPageFields = { startCursor: historyCursor(), versionMarkers: [] };
