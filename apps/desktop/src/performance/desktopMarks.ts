// Tiny named mark/measure recorder used by BOTH the Electron main process and
// the renderer (each bundle gets its own instance). Marks store absolute
// wall-clock epochs (Date.now()) so durations remain comparable across the
// two processes; measures store computed durations between marks. The
// snapshots reach Playwright only through test-gated seams: main via the
// double-gated getDesktopMarks IPC, renderer via the window hook in
// rendererMarks.ts.

export interface MarksSnapshot {
  marks: Record<string, number>;
  measures: Record<string, number>;
}

export function createMarkRecorder(now: () => number = Date.now) {
  const marks = new Map<string, number>();
  const measures = new Map<string, number>();
  return {
    // Last write wins: repeatable interactions (open file N times) re-mark.
    mark(name: string): void {
      marks.set(name, now());
    },
    // First write wins: launch-style once-per-process facts.
    markOnce(name: string): void {
      if (!marks.has(name)) marks.set(name, now());
    },
    // Duration from a previously recorded start mark to now, stored as a
    // named measure. Returns null (and records nothing) when the start mark
    // was never recorded — a measure must bracket real observed work, never
    // fabricate a number.
    measureSince(name: string, startMark: string): number | null {
      const start = marks.get(startMark);
      if (start === undefined) return null;
      const duration = now() - start;
      measures.set(name, duration);
      return duration;
    },
    // Explicitly computed duration (e.g. a render-body filter timed with
    // performance.now) recorded under a stable name.
    record(name: string, durationMs: number): void {
      measures.set(name, durationMs);
    },
    snapshot(): MarksSnapshot {
      return {
        marks: Object.fromEntries(marks),
        measures: Object.fromEntries(measures),
      };
    },
  };
}

export type MarkRecorder = ReturnType<typeof createMarkRecorder>;

// The main-process recorder. Renderer code must import rendererMarks instead.
export const desktopMarks: MarkRecorder = createMarkRecorder();
