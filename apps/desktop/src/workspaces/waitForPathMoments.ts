import { setTimeout as delay } from "node:timers/promises";
import type {
  WorkspaceEngineCapture,
  WorkspaceEngineMomentSummary,
} from "./workspaceEngineCapture";

// Shared by the two-daemon and single-daemon Rust e2e suites. `listMoments`
// already flushes daemon-owned capture before it reads
// (workspaceEngineCapture.ts's `flushCapture?.()` call), so this polls
// `listMoments` directly rather than calling `capture.flush()` first — a
// separate flush call would just repeat the same wait.
//
// A flush can throw "... did not settle." while the daemon's capture chain is
// still draining a just-written batch; that is a retryable transient, not a
// real failure, so it is swallowed here like every other not-yet-arrived poll.
export async function waitForPathMoments(
  capture: WorkspaceEngineCapture,
  path: string,
  count: number,
): Promise<WorkspaceEngineMomentSummary[]> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let page;
    try {
      page = await capture.listMoments({ limit: 100 });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith(" did not settle.")) {
        throw error;
      }
      await delay(25);
      continue;
    }
    const matching = page.moments.filter((moment) => moment.path === path);
    if (matching.length >= count) return matching;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${count} captured moment(s) for ${path}.`);
}
