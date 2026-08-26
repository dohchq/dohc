import { describe, expect, it } from "vitest";
import {
  SWITCH_TIMELINE_LIMIT,
  createMarkRecorder,
} from "./desktopMarks";

function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

describe("createMarkRecorder", () => {
  it("records named marks at the current time; mark overwrites, markOnce does not", () => {
    const clock = fakeClock();
    const recorder = createMarkRecorder(clock.now);
    recorder.mark("open");
    recorder.markOnce("first-paint");
    clock.tick(50);
    recorder.mark("open");
    recorder.markOnce("first-paint");
    const { marks } = recorder.snapshot();
    expect(marks.open).toBe(1050);
    expect(marks["first-paint"]).toBe(1000);
  });

  it("measures the duration between a start mark and now", () => {
    const clock = fakeClock();
    const recorder = createMarkRecorder(clock.now);
    recorder.mark("file-open-start");
    clock.tick(120);
    expect(recorder.measureSince("markdown-open", "file-open-start")).toBe(120);
    expect(recorder.snapshot().measures["markdown-open"]).toBe(120);
  });

  it("never fabricates a measure when the start mark does not exist", () => {
    const recorder = createMarkRecorder(fakeClock().now);
    expect(recorder.measureSince("markdown-open", "missing")).toBeNull();
    expect(recorder.snapshot().measures).toEqual({});
  });

  it("records explicit durations and returns an independent snapshot copy", () => {
    const recorder = createMarkRecorder(fakeClock().now);
    recorder.record("file-tree-search-query", 12);
    const snapshot = recorder.snapshot();
    snapshot.measures["file-tree-search-query"] = 9999;
    expect(recorder.snapshot().measures["file-tree-search-query"]).toBe(12);
  });

  it("records consecutive switch phases under distinct ordinals", () => {
    const clock = fakeClock();
    const performanceMarks: string[] = [];
    const recorder = createMarkRecorder(clock.now, {
      switchNow: clock.now,
      performanceMark: (name) => performanceMarks.push(name),
    });

    const first = recorder.startSwitch(7);
    clock.tick(8);
    recorder.markSwitchPhase(first, "session-admitted");
    clock.tick(12);
    recorder.markSwitchPhase(first, "files-painted", {
      listingSource: "cached",
    });

    clock.tick(30);
    const second = recorder.startSwitch(8);
    clock.tick(5);
    recorder.markSwitchPhase(second, "session-admitted");
    clock.tick(9);
    recorder.markSwitchPhase(second, "files-painted", {
      listingSource: "fresh",
    });

    expect(recorder.readSwitchTimeline()).toEqual([
      {
        ordinal: 1,
        phases: {
          "switch-start": 0,
          "session-admitted": 8,
          "files-painted": 20,
        },
        listingSource: "cached",
      },
      {
        ordinal: 2,
        phases: {
          "switch-start": 0,
          "session-admitted": 5,
          "files-painted": 14,
        },
        listingSource: "fresh",
      },
    ]);
    expect(first.ordinal).not.toBe(second.ordinal);
    expect(performanceMarks).toEqual([
      "dohc:workspace-switch:1:switch-start",
      "dohc:workspace-switch:1:session-admitted",
      "dohc:workspace-switch:1:files-painted:cached",
      "dohc:workspace-switch:2:switch-start",
      "dohc:workspace-switch:2:session-admitted",
      "dohc:workspace-switch:2:files-painted:fresh",
    ]);
  });

  it("drops a stale phase after a newer switch starts", () => {
    const clock = fakeClock();
    const recorder = createMarkRecorder(clock.now, {
      switchNow: clock.now,
      performanceMark: () => undefined,
    });
    const first = recorder.startSwitch(3);
    clock.tick(10);
    const second = recorder.startSwitch(4);
    clock.tick(25);

    expect(recorder.markSwitchPhase(first, "history-ready")).toBe(false);
    expect(recorder.markSwitchPhase(second, "history-ready")).toBe(true);
    expect(recorder.readSwitchTimeline()).toEqual([
      { ordinal: 1, phases: { "switch-start": 0 } },
      {
        ordinal: 2,
        phases: { "switch-start": 0, "history-ready": 25 },
      },
    ]);
  });

  it("keeps only the bounded tail of switch timelines", () => {
    const clock = fakeClock();
    const recorder = createMarkRecorder(clock.now, {
      switchNow: clock.now,
      performanceMark: () => undefined,
    });
    for (let generation = 0; generation < SWITCH_TIMELINE_LIMIT + 3; generation += 1) {
      recorder.startSwitch(generation);
    }

    const timeline = recorder.readSwitchTimeline();
    expect(timeline).toHaveLength(SWITCH_TIMELINE_LIMIT);
    expect(timeline[0]?.ordinal).toBe(4);
    expect(timeline.at(-1)?.ordinal).toBe(SWITCH_TIMELINE_LIMIT + 3);
  });
});
