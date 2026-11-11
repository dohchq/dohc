import { describe, expect, it } from "vitest";
import { readOptions } from "./options";

describe("eval command line", () => {
  it("reads every flag, and defaults the rest", () => {
    expect(readOptions(["--out", "runs/a"])).toEqual({
      out: "runs/a", model: "claude-sonnet-5-5", samples: 2, concurrency: 2, keepSessionRoute: false, dryRun: false, context: false,
    });
    expect(readOptions([
      "--out", "runs/b", "--model", "claude-haiku-5-5", "--case", "one,two", "--samples", "3", "--concurrency", "1",
      "--baseline", "runs/a/results.jsonl", "--keep-session-route", "--dry-run", "--context",
    ])).toEqual({
      out: "runs/b", model: "claude-haiku-5-5", cases: ["one", "two"], samples: 3, concurrency: 1,
      baseline: "runs/a/results.jsonl", keepSessionRoute: true, dryRun: true, context: true,
    });
  });

  // Each of these once started every case, or no case, without a word.
  it.each([
    [["--out", "runs/a", "--case"], "--case takes a value"],
    [["--out", "runs/a", "--baseline", "--dry-run"], "--baseline takes a value"],
    [["--out", "runs/a", "--baseline", ""], "--baseline takes a value"],
    [["--out", "runs/a", "--samples", "0"], "--samples takes a whole number of 1 or more"],
    [["--out", "runs/a", "--samples", "nope"], "--samples takes a whole number of 1 or more"],
    [["--out", "runs/a", "--samples", "Infinity"], "--samples takes a whole number of 1 or more"],
    [["--out", "runs/a", "--concurrency", "1.5"], "--concurrency takes a whole number of 1 or more"],
    [["--out", "runs/a", "--sample", "1"], "unknown argument '--sample'"],
    [["runs/a"], "unknown argument 'runs/a'"],
  ])("refuses %j", (argv, message) => {
    expect(() => readOptions(argv)).toThrow(message);
  });
});
