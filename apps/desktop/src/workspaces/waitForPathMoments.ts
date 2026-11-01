import { createHash } from "node:crypto";
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
export function waitForPathMoments(
  capture: WorkspaceEngineCapture,
  path: string,
  count: number,
): Promise<WorkspaceEngineMomentSummary[]> {
  return pollPathMoments(capture, path, `${count} captured moment(s)`,
    (matching) => matching.length >= count ? matching : undefined);
}

/**
 * Waits until the path has `count` moments and its newest one holds exactly
 * `contents`. A protected moment shows no contents, so only its count counts.
 */
export async function waitForCapturedContents(
  capture: WorkspaceEngineCapture,
  path: string,
  contents: string | Uint8Array,
  count: number,
): Promise<void> {
  const sha256 = hash(contents);
  await pollPathMoments(capture, path, `moment ${count} with contents ${sha256}`, async (matching) => {
    if (matching.length < count) return undefined;
    const newest = matching.reduce((a, b) => (a.momentOrder > b.momentOrder ? a : b));
    const detail = await capture.readMoment(newest.id);
    if (detail?.protected) return true;
    const after = detail?.moment.payload.after;
    return after && (after.sha256 ?? hash(after.text)) === sha256 ? true : undefined;
  });
}

function hash(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function pollPathMoments<T>(
  capture: WorkspaceEngineCapture,
  path: string,
  waitingFor: string,
  found: (matching: WorkspaceEngineMomentSummary[]) => T | undefined | Promise<T | undefined>,
): Promise<T> {
  const deadline = performance.now() + REAL_DAEMON_DEADLINE_MS;
  while (performance.now() < deadline) {
    try {
      const page = await capture.listMoments({ limit: 100 });
      const result = await found(page.moments.filter((moment) => moment.path === path));
      if (result !== undefined) return result;
    } catch (error) {
      if (!isWorkspaceUpdatingRefusal(error)) throw error;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${waitingFor} for ${path}.`);
}
