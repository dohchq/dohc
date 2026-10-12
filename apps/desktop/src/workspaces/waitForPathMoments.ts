import { setTimeout as delay } from "node:timers/promises";
import { isWorkspaceUpdatingRefusal } from "@dohc/workspace-engine-client";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import type {
  WorkspaceEngineCapture,
  WorkspaceEngineMomentSummary,
} from "./workspaceEngineCapture";

// Shared by the two-daemon and single-daemon Rust e2e suites. `listMoments`
// uses the daemon's aggregate history read, which settles capture before it
// takes the page snapshot. A separate flush would repeat the same wait.
//
// A busy capture chain can still exhaust that bounded wait. Treat it like any
// other not-yet-arrived poll. Use the real-daemon deadline: the watcher can
// coalesce a continuous event burst for four seconds before publishing it.
export async function waitForPathMoments(
  capture: WorkspaceEngineCapture,
  path: string,
  count: number,
): Promise<WorkspaceEngineMomentSummary[]> {
  const deadline = performance.now() + REAL_DAEMON_DEADLINE_MS;
  while (performance.now() < deadline) {
    let page;
    try {
      page = await capture.listMoments({ limit: 100 });
    } catch (error) {
      if (!isWorkspaceUpdatingRefusal(error)) throw error;
      await delay(25);
      continue;
    }
    const matching = page.moments.filter((moment) => moment.path === path);
    if (matching.length >= count) return matching;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${count} captured moment(s) for ${path}.`);
}
