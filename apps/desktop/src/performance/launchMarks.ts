// Launch instrumentation, alive from the first scaffold per the plan's
// continuous performance enforcement: later phases append marks, Phase 16
// turns the numbers into a hard gate.

const processStart = Date.now();

interface LaunchMarks {
  appReadyMs: number;
  daemonReadyMs: number;
  firstWindowMs: number;
  firstPaintMs: number;
}

const marks: Partial<LaunchMarks> = {};

function markOnce(key: keyof LaunchMarks): void {
  if (marks[key] === undefined) marks[key] = Date.now() - processStart;
}

export const launchMarks = {
  appReady: () => markOnce("appReadyMs"),
  daemonReady: () => markOnce("daemonReadyMs"),
  firstWindow: () => markOnce("firstWindowMs"),
  firstPaint: () => markOnce("firstPaintMs"),
  snapshot: (): Partial<LaunchMarks> => ({ ...marks }),
};

// The one launch-speed log line. The daemon handshake and the renderer's
// first paint race each other, so whichever lands last prints the snapshot.
let logged = false;
export function logLaunchMarksOnce(): void {
  if (logged) return;
  const snapshot = launchMarks.snapshot();
  if (
    snapshot.appReadyMs === undefined ||
    snapshot.daemonReadyMs === undefined ||
    snapshot.firstWindowMs === undefined ||
    snapshot.firstPaintMs === undefined
  ) {
    return;
  }
  logged = true;
  console.info(
    "[desktop] launch marks (ms since process start): " +
      `app-ready ${snapshot.appReadyMs}, first-window ${snapshot.firstWindowMs}, ` +
      `daemon-ready ${snapshot.daemonReadyMs}, first-paint ${snapshot.firstPaintMs}`,
  );
}
