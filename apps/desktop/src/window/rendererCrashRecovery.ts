// Renderer-crash recovery (render-process-gone). Without a handler, a crashed
// renderer (OOM, GPU/native fault) leaves the window permanently blank — the
// BrowserWindow survives but nothing repaints and every click lands on a dead
// page. Recovery: reload the window so the app comes back on its own, with a
// small crash-loop guard so a renderer that dies immediately on every load
// doesn't spin reload-crash-reload forever.

// The one exit reason that is not a crash: an intentional teardown
// (clean-exit) must not trigger a reload. "killed" is deliberately NOT
// excluded — Electron reports it for a renderer terminated externally (an OS
// task-killer, forcefullyCrashRenderer on some platforms), which leaves the
// window exactly as blank as a crash and must reload too. App-quit teardown
// races stay harmless: the isDestroyed() guard skips destroyed contents and
// the crash-loop cap bounds the worst case.
const CLEAN_REASONS = new Set(["clean-exit"]);

export const CRASH_LOOP_WINDOW_MS = 30_000;
export const CRASH_LOOP_MAX_RELOADS = 3;

// Pure policy, unit-tested: given the timestamps of recent crashes (newest
// appended) decide whether reloading is still sane. Returns the pruned
// timestamp list alongside the decision so callers keep bounded state.
export function crashLoopPolicy(
  recentCrashesMs: readonly number[],
  nowMs: number,
): { reload: boolean; recentCrashesMs: number[] } {
  const pruned = recentCrashesMs.filter(
    (at) => nowMs - at < CRASH_LOOP_WINDOW_MS,
  );
  pruned.push(nowMs);
  return { reload: pruned.length <= CRASH_LOOP_MAX_RELOADS, recentCrashesMs: pruned };
}

export function isCleanRendererExit(reason: string): boolean {
  return CLEAN_REASONS.has(reason);
}

// The minimal surface this needs from Electron — injectable for tests.
type RecoverableWebContents = {
  on(
    event: "render-process-gone",
    listener: (event: unknown, details: { reason: string; exitCode: number }) => void,
  ): unknown;
  reload(): void;
  isDestroyed(): boolean;
};

export function installRendererCrashRecovery(
  webContents: RecoverableWebContents,
  now: () => number = Date.now,
): void {
  let recentCrashesMs: number[] = [];
  webContents.on("render-process-gone", (_event, details) => {
    if (isCleanRendererExit(details.reason)) return;
    const decision = crashLoopPolicy(recentCrashesMs, now());
    recentCrashesMs = decision.recentCrashesMs;
    console.error(
      `[desktop] renderer process gone (reason: ${details.reason}, exitCode: ${details.exitCode}) — ${
        decision.reload
          ? "reloading the window"
          : "crash loop detected, leaving the window for manual reload"
      }`,
    );
    if (!decision.reload || webContents.isDestroyed()) return;
    webContents.reload();
  });
}
