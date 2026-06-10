import { describe, expect, it } from "vitest";
import { createMarkRecorder } from "./desktopMarks";

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
});
