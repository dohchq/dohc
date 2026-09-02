import type { Event } from "@dohc/workspace-engine-client";
import { z } from "zod";
import {
  PluginPanelRecordChangedData,
  PluginPanelRecordFieldChangedData,
} from "../ipc/bridgeContract";
import type { PluginRecordEvent } from "../plugins/pluginWorkspaceEvents";

/** Emitted by the daemon once per record create / update / field change. */
export const RECORD_CREATED_EVENT = "record.created";
export const RECORD_UPDATED_EVENT = "record.updated";
export const RECORD_FIELD_CHANGED_EVENT = "record.field.changed";

/** What one daemon record event routes to: one workspace's registry. */
interface RoutedRecordEvent {
  workspaceId: string;
  event: PluginRecordEvent;
}

// The daemon's record event payloads are a fixed contract
// (crates/dohc-workspace-engine's record events) and the panel IPC schemas
// are that contract; the bridge validates against them once, plus the
// workspace the payload names. Read strictly: unlike the capture bridge's
// repaint ping, a record event is data a plugin acts on, so a shape drift is
// dropped rather than delivered malformed. Delivery is at most once anyway —
// a subscriber already reconciles missed events from record history.
const WORKSPACE_SCOPED = { workspaceId: z.string().min(1) };
const RecordChangedPayload = PluginPanelRecordChangedData.extend(WORKSPACE_SCOPED);
const RecordFieldChangedPayload =
  PluginPanelRecordFieldChangedData.extend(WORKSPACE_SCOPED);

function routeOf(event: Event): RoutedRecordEvent | null {
  if (event.name === RECORD_CREATED_EVENT || event.name === RECORD_UPDATED_EVENT) {
    const parsed = RecordChangedPayload.safeParse(event.payload);
    if (!parsed.success) return null;
    const { workspaceId, ...data } = parsed.data;
    return { workspaceId, event: { name: event.name, data } };
  }
  const parsed = RecordFieldChangedPayload.safeParse(event.payload);
  if (!parsed.success) return null;
  const { workspaceId, ...data } = parsed.data;
  return { workspaceId, event: { name: RECORD_FIELD_CHANGED_EVENT, data } };
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
