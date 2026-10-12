import type {
  ActivityViewId,
  ViewId,
} from "../../desktop/src/renderer/workbench/workbenchState";

// The desktop views the demo implements. The rail offers only these.
export const DEMO_PANEL_IDS = [
  "explorer",
  "chats",
  "search",
  "graph",
  "history",
] as const satisfies readonly ViewId[];
export type DemoPanelId = (typeof DEMO_PANEL_IDS)[number];

export function isDemoPanelId(view: ActivityViewId): view is DemoPanelId {
  return (DEMO_PANEL_IDS as readonly string[]).includes(view);
}
