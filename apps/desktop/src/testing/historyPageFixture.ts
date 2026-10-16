import type { HistoryCursor } from "@dohc/workspace-engine-client";
import type { ListHistoryResult, TimelineCursor, TimelineEntry } from "../ipc/bridgeContract";
export function historyCursor(momentOrder = 0): HistoryCursor {
  return { format: 1, engineUuid: "test", workspaceId: "workspace", versionId: "main", objectId: null, operationId: null,
    textFence: 10000, protectedFence: 10000, markerFence: 10000,
    text: { recordedAtMs: momentOrder, momentOrder }, protected: null, marker: null };
}
export const historyPageFields = { startCursor: historyCursor(), versionMarkers: [] };

// A History timeline cursor whose file position is `engine`.
export function timelineCursor(engine: HistoryCursor | number = 0, workspaceId = "workspace"): TimelineCursor {
  const position = typeof engine === "number" ? historyCursor(engine) : engine;
  return { format: 1, workspaceId, versionId: position.versionId, object: null, engine: { ...position, workspaceId },
    engineDone: false, collections: [], omittedSources: 0 };
}

export type TimelinePage = Extract<ListHistoryResult, { status: "ready" }>;
// One ready History page of `entries`, complete unless the overrides say so.
export function timelinePage(entries: TimelineEntry[], overrides: Partial<TimelinePage> = {}): TimelinePage {
  return { status: "ready", workspaceId: "workspace", versionId: "main", entries, nextCursor: null,
    unavailableSources: [], omittedSources: 0, completeness: "complete", ...overrides };
}
