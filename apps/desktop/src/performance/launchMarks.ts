// Launch instrumentation, alive from the first scaffold per the plan's
// continuous performance enforcement: later phases append marks, Phase 16
// turns the numbers into a hard gate.

const processStart = Date.now();

interface LaunchMarks {
  appReadyMs: number;
  firstWindowMs: number;
  firstPaintMs: number;
}

const marks: Partial<LaunchMarks> = {};

function markOnce(key: keyof LaunchMarks): void {
  if (marks[key] === undefined) marks[key] = Date.now() - processStart;
}

export const launchMarks = {
  appReady: () => markOnce("appReadyMs"),
  firstWindow: () => markOnce("firstWindowMs"),
  firstPaint: () => markOnce("firstPaintMs"),
  snapshot: (): Partial<LaunchMarks> => ({ ...marks }),
};
