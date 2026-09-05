// Tiny named mark/measure recorder used by both the Electron main process and
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

export const SWITCH_TIMELINE_LIMIT = 20;

type SwitchTimelinePhase =
  | "switch-start"
  | "session-admitted"
  | "files-painted"
  | "files-revalidated"
  | "history-ready"
  | "restored-active-surface-ready";

export type SwitchCompletionPhase = Exclude<SwitchTimelinePhase, "switch-start">;

export interface SwitchPhaseDetails {
  listingSource?: "cached" | "fresh";
}

interface SwitchTimelineToken {
  readonly ordinal: number;
  readonly selectionGeneration: number;
}

export interface SwitchTimelineEntry {
  ordinal: number;
  phases: Partial<Record<SwitchTimelinePhase, number>>;
  listingSource?: "cached" | "fresh";
}

interface StoredSwitchTimeline {
  entry: SwitchTimelineEntry;
  selectionGeneration: number;
  startMs: number;
  lastOffsetMs: number;
  performanceMarkNames: string[];
}

interface MarkRecorderOptions {
  switchNow?: () => number;
  performanceMark?: (name: string) => void;
  clearPerformanceMark?: (name: string) => void;
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function markPerformanceEntry(name: string): void {
  globalThis.performance?.mark(name);
}

function clearPerformanceEntry(name: string): void {
  globalThis.performance?.clearMarks(name);
}

export function createMarkRecorder(
  now: () => number = Date.now,
  options: MarkRecorderOptions = {},
) {
  const marks = new Map<string, number>();
  const measures = new Map<string, number>();
  const switchNow = options.switchNow ?? monotonicNow;
  const performanceMark = options.performanceMark ?? markPerformanceEntry;
  const clearPerformanceMark =
    options.clearPerformanceMark ?? clearPerformanceEntry;
  const switchTimeline: StoredSwitchTimeline[] = [];
  let nextSwitchOrdinal = 0;
  let activeSwitch: StoredSwitchTimeline | null = null;

  const addPerformanceMark = (
    timeline: StoredSwitchTimeline,
    phase: SwitchTimelinePhase,
    listingSource?: "cached" | "fresh",
  ) => {
    const name =
      `dohc:workspace-switch:${timeline.entry.ordinal}:${phase}` +
      (listingSource ? `:${listingSource}` : "");
    performanceMark(name);
    timeline.performanceMarkNames.push(name);
  };

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
    startSwitch(selectionGeneration: number): SwitchTimelineToken {
      nextSwitchOrdinal += 1;
      const entry: SwitchTimelineEntry = {
        ordinal: nextSwitchOrdinal,
        phases: { "switch-start": 0 },
      };
      const timeline: StoredSwitchTimeline = {
        entry,
        selectionGeneration,
        startMs: switchNow(),
        lastOffsetMs: 0,
        performanceMarkNames: [],
      };
      switchTimeline.push(timeline);
      activeSwitch = timeline;
      addPerformanceMark(timeline, "switch-start");
      if (switchTimeline.length > SWITCH_TIMELINE_LIMIT) {
        const removed = switchTimeline.shift();
        for (const name of removed?.performanceMarkNames ?? []) {
          clearPerformanceMark(name);
        }
      }
      return { ordinal: entry.ordinal, selectionGeneration };
    },
    markSwitchPhase(
      token: SwitchTimelineToken,
      phase: SwitchCompletionPhase,
      details: SwitchPhaseDetails = {},
    ): boolean {
      if (
        activeSwitch === null ||
        activeSwitch.entry.ordinal !== token.ordinal ||
        activeSwitch.selectionGeneration !== token.selectionGeneration ||
        activeSwitch.entry.phases[phase] !== undefined
      ) {
        return false;
      }
      const offsetMs = Math.max(
        activeSwitch.lastOffsetMs,
        switchNow() - activeSwitch.startMs,
        0,
      );
      activeSwitch.lastOffsetMs = offsetMs;
      activeSwitch.entry.phases[phase] = offsetMs;
      const listingSource =
        phase === "files-painted" ? details.listingSource : undefined;
      if (listingSource) activeSwitch.entry.listingSource = listingSource;
      addPerformanceMark(activeSwitch, phase, listingSource);
      return true;
    },
    readSwitchTimeline(): SwitchTimelineEntry[] {
      return switchTimeline.map(({ entry }) => ({
        ...entry,
        phases: { ...entry.phases },
      }));
    },
    snapshot(): MarksSnapshot {
      return {
        marks: Object.fromEntries(marks),
        measures: Object.fromEntries(measures),
      };
    },
  };
}

type MarkRecorder = ReturnType<typeof createMarkRecorder>;

// The main-process recorder. Renderer code must import rendererMarks instead.
export const desktopMarks: MarkRecorder = createMarkRecorder();
