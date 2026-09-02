import type { Event, JsonValue } from "@dohc/workspace-engine-client";
import type {
  PluginRecordChangedEventData,
  PluginRecordEvent,
  PluginRecordFieldChangedEventData,
} from "../plugins/pluginWorkspaceEvents";

/** Emitted by the daemon once per record create / update / field change. */
export const RECORD_CREATED_EVENT = "record.created";
export const RECORD_UPDATED_EVENT = "record.updated";
export const RECORD_FIELD_CHANGED_EVENT = "record.field.changed";

/** What one daemon record event routes to: one workspace's registry. */
interface RoutedRecordEvent {
  workspaceId: string;
  event: PluginRecordEvent;
}

function jsonRecord(
  payload: JsonValue,
): { [key in string]?: JsonValue } | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  return payload;
}

// The daemon's record event payloads are a fixed contract
// (crates/dohc-workspace-engine's record events). Read strictly: unlike the
// capture bridge's repaint ping, a record event is data a plugin acts on, so
// a shape drift is dropped rather than delivered malformed. Delivery is at
// most once anyway — a subscriber already reconciles missed events from
// record history.
function changedDataOf(record: {
  [key in string]?: JsonValue;
}): (PluginRecordChangedEventData & { workspaceId: string }) | null {
  const { workspaceId, collectionPath, recordId, author, timestamp } = record;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return null;
  if (typeof collectionPath !== "string" || collectionPath.length === 0) return null;
  if (typeof recordId !== "string" || recordId.length === 0) return null;
  if (author !== null && typeof author !== "string") return null;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  return { workspaceId, collectionPath, recordId, author: author ?? null, timestamp };
}

function routeOf(event: Event): RoutedRecordEvent | null {
  const record = jsonRecord(event.payload);
  if (!record) return null;
  const base = changedDataOf(record);
  if (!base) return null;
  const { workspaceId, ...data } = base;
  if (event.name === RECORD_CREATED_EVENT || event.name === RECORD_UPDATED_EVENT) {
    return { workspaceId, event: { name: event.name, data } };
  }
  const { field, previous, next, historyId } = record;
  if (typeof field !== "string" || field.length === 0) return null;
  if (typeof historyId !== "number" || !Number.isFinite(historyId)) return null;
  // JSON cannot carry undefined, so an undefined here means the key is
  // absent — a missing value, not a null one, and the shape is rejected.
  if (previous === undefined || next === undefined) return null;
  const fieldData: PluginRecordFieldChangedEventData = {
    ...data,
    field,
    previous,
    next,
    historyId,
  };
  return {
    workspaceId,
    event: { name: RECORD_FIELD_CHANGED_EVENT, data: fieldData },
  };
}

/**
 * The daemon records collection changes autonomously, so its record events
 * are the only live signal a plugin's `collections.watch` subscription has.
 * This bridge validates each event against the fixed engine contract and
 * hands it to the plugin workspace-event registry of the workspace the
 * payload names. An event for a workspace that is not open, an unknown
 * event name, or a payload that does not match the contract is dropped —
 * a subscriber recovers missed events from record history, never from a
 * malformed delivery.
 */
export function bridgeRecordEventsToPlugins(
  daemon: { onEvent(handler: (event: Event) => void): () => void },
  registryFor: (
    workspaceId: string,
  ) => { handleRecordEvent(event: PluginRecordEvent): void } | undefined,
): () => void {
  return daemon.onEvent((event) => {
    if (
      event.name !== RECORD_CREATED_EVENT &&
      event.name !== RECORD_UPDATED_EVENT &&
      event.name !== RECORD_FIELD_CHANGED_EVENT
    ) {
      return;
    }
    const routed = routeOf(event);
    if (!routed) return;
    registryFor(routed.workspaceId)?.handleRecordEvent(routed.event);
  });
}
