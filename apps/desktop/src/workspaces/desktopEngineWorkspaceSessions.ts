import {
  EngineWorkspaceSessions,
  type EngineDaemonClientSource,
} from "@dohc/workspace-engine-client/daemon";

// A fresh debug-engine adoption measured 18.7 s for 5,000 files and 101.8 s
// for 15,000 files on the launch fixture. This finite bound contains that
// known path with 18.2 s of headroom. It is not a performance target: the
// renderer names the wait, and first-adoption speed remains launch work.
export const DESKTOP_WORKSPACE_OPEN_DEADLINE_MS = 120_000;

export function createDesktopEngineWorkspaceSessions(
  source: EngineDaemonClientSource,
): EngineWorkspaceSessions {
  return new EngineWorkspaceSessions(source, {
    workspaceOpenDeadlineMs: DESKTOP_WORKSPACE_OPEN_DEADLINE_MS,
  });
}
