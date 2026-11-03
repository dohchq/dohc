import {
  MAX_ACTIVITY_EVENT_PATHS,
  type WorkspaceActivityEvent,
} from "./bridgeContract";
import { CHANNELS } from "./channels";

// What a call site knows about the activity it reports. `workspaceId` scopes
// the send to windows with that workspace active. No scope means a genuinely global event (logout, registry change,
// daemon relaunch) that every window must hear.
export interface WorkspaceActivityScope {
  workspaceId: string;
  paths?: readonly string[];
  pathSetChanged?: boolean;
  summaryChanged?: true;
  liveDocumentStopped?: string;
}

/** Independent capture and observation wakes share one bounded IPC window. */
export function coalesceWorkspaceActivity(send: (scope?: WorkspaceActivityScope) => void, delayMs = 100) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let global = false;
  const pending = new Map<string, { paths: Set<string> | null; pathSetChanged: boolean | undefined; summaryChanged?: true }>();
  const flush = () => {
    timer = undefined;
    const scopes = [...pending]; pending.clear();
    if (global) { global = false; send(); return; }
    for (const [workspaceId, entry] of scopes) send({ workspaceId,
      ...(entry.paths?.size ? { paths: [...entry.paths] } : {}),
      ...(entry.pathSetChanged !== undefined ? { pathSetChanged: entry.pathSetChanged } : {}),
      ...(entry.summaryChanged ? { summaryChanged: true } : {}) });
  };
  return (scope?: WorkspaceActivityScope): void => {
    if (!scope) global = true;
    else {
      let entry = pending.get(scope.workspaceId);
      if (!entry) { entry = { paths: new Set(), pathSetChanged: scope.pathSetChanged }; pending.set(scope.workspaceId, entry); }
      else if (entry.pathSetChanged !== undefined) {
        entry.pathSetChanged = scope.pathSetChanged === undefined ? undefined : entry.pathSetChanged || scope.pathSetChanged;
      }
      if (scope.summaryChanged) entry.summaryChanged = true;
      if (!scope.paths?.length) entry.paths = null;
      if (entry.paths && scope.paths) for (const path of scope.paths) {
        entry.paths.add(path);
        if (entry.paths.size > MAX_ACTIVITY_EVENT_PATHS) { entry.paths = null; break; }
      }
    }
    if (!timer) { timer = setTimeout(flush, delayMs); timer.unref?.(); }
  };
}

interface ActivityWindow {
  webContents: {
    id: number;
    send(channel: string, payload: unknown): void;
  };
}

// Sends a workspace's event only to live windows whose current session shows
// that workspace.
export function sendToWorkspaceWindows<Contents extends {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}>(options: {
  windows: Iterable<{ webContents: Contents }>;
  workspaceIdOf: (webContents: Contents) => string | undefined;
  channel: string;
  event: { workspaceId: string };
}): void {
  for (const window of options.windows) {
    if (window.webContents.isDestroyed()) continue;
    if (options.workspaceIdOf(window.webContents) !== options.event.workspaceId) continue;
    window.webContents.send(options.channel, options.event);
  }
}

export function workspaceActivityPayload(
  scope?: WorkspaceActivityScope,
): WorkspaceActivityEvent {
  if (!scope) return {};
  const paths =
    scope.paths && scope.paths.length > 0 && scope.paths.length <= MAX_ACTIVITY_EVENT_PATHS
      ? [...scope.paths]
      : undefined;
  return { workspaceId: scope.workspaceId, ...(paths ? { paths } : {}),
    ...(scope.pathSetChanged !== undefined ? { pathSetChanged: scope.pathSetChanged } : {}),
    ...(scope.summaryChanged ? { summaryChanged: true } : {}),
    ...(scope.liveDocumentStopped ? { liveDocumentStopped: scope.liveDocumentStopped } : {}) };
}

// One send decision for the workspace-activity channel: a scoped event
// reaches only windows whose active workspace matches; a global event reaches every window. A window on
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
