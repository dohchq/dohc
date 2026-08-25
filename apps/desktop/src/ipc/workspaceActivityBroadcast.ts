import {
  MAX_ACTIVITY_EVENT_PATHS,
  type WorkspaceActivityEvent,
} from "./bridgeContract";
import { CHANNELS } from "./channels";

// What a call site knows about the activity it reports. `workspaceId` scopes
// the send to windows with that workspace active — the pluginStatusChanged
// rule. No scope means a genuinely global event (logout, registry change,
// daemon relaunch) that every window must hear.
export interface WorkspaceActivityScope {
  workspaceId: string;
  paths?: readonly string[];
}

interface ActivityWindow {
  webContents: {
    id: number;
    send(channel: string, payload: unknown): void;
  };
}

function workspaceActivityPayload(
  scope?: WorkspaceActivityScope,
): WorkspaceActivityEvent {
  if (!scope) return {};
  const paths =
    scope.paths && scope.paths.length > 0 && scope.paths.length <= MAX_ACTIVITY_EVENT_PATHS
      ? [...scope.paths]
      : undefined;
  return { workspaceId: scope.workspaceId, ...(paths ? { paths } : {}) };
}

// One send decision for the workspace-activity channel: a scoped event
// reaches only windows whose ACTIVE workspace matches (exactly like
// pluginStatusChanged); a global event reaches every window. A window on
// workspace B must never be made to refetch its world for workspace A's
// activity.
export function broadcastWorkspaceActivity(options: {
  windows: Iterable<ActivityWindow>;
  activeWorkspaceIdOf: (webContentsId: number) => string | undefined;
  scope?: WorkspaceActivityScope;
}): void {
  const payload = workspaceActivityPayload(options.scope);
  for (const win of options.windows) {
    if (
      options.scope &&
      options.activeWorkspaceIdOf(win.webContents.id) !== options.scope.workspaceId
    ) {
      continue;
    }
    win.webContents.send(CHANNELS.workspaceActivity, payload);
  }
}
