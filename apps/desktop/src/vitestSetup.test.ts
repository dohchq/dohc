// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { getConfig } from "@testing-library/dom";
import { describe, expect, it, vi } from "vitest";

// Guards that `vitest.setup.ts` is registered, not what it does.
//
// The setup file gives jsdom the document.elementFromPoint that
// prosemirror-view's posAtCoords calls. Without it that call throws inside a
// mousedown listener rather than inside a test, so vitest fails the run on an
// unhandled error and reports 0 failed tests. A run that exits 1 while naming
// nothing costs a review round to attribute.
//
// So the protection needs a name of its own. Drop `./vitest.setup.ts` from
// `setupFiles` and these two tests fail, deterministically, in one worker,
// pointing at the config line to restore.
//
// Setup files run per test file, so the method being present here is the same
// registration that puts it in every other file.
describe("apps/desktop vitest setup", () => {
  it("honors an explicit CLI worker limit in every resolved project", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import { createVitest, parseCLI } from "vitest/node";
      const { options } = parseCLI("vitest run --maxWorkers=1");
      const context = await createVitest("test", {
        ...options, config: "./vitest.config.ts", watch: false,
      });
      try {
        console.log(JSON.stringify(context.projects.map(project => ({
          name: project.name,
          maxWorkers: project.config.maxWorkers ?? context.config.maxWorkers,
        }))));
      } finally {
        await context.close();
      }
    `], {
      cwd: resolve(import.meta.dirname, ".."),
      encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, VITEST_MAX_WORKERS: "" },
    });
    expect(JSON.parse(output.trim().split(/\r?\n/u).at(-1)!)).toEqual([
      { name: "desktop", maxWorkers: 1 },
      { name: "file-inspector-helpers", maxWorkers: 1 },
    ]);
  });

  it("is registered, so jsdom has the document.elementFromPoint ProseMirror calls", () => {
    expect(typeof document.elementFromPoint).toBe("function");
  });

  it("answers a hit test rather than throwing the TypeError that failed whole runs", () => {
    expect(() => document.elementFromPoint(0, 0)).not.toThrow();
  });

  it("gives Testing Library waits the loaded-machine window, not its own 1 s default", () => {
    expect(getConfig().asyncUtilTimeout).toBe(10_000);
  });

  it("gives vi.waitFor and expect.poll the same window, not vitest's 1 s default", async () => {
    const start = performance.now();
    const elapsed = () => performance.now() - start;
    await Promise.all([
      vi.waitFor(() => expect(elapsed()).toBeGreaterThan(1_100)),
      expect.poll(elapsed).toBeGreaterThan(1_100),
    ]);
  });

  it("keeps vitest's default for vi.waitFor under fake timers, where each check advances the clock", async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      await expect(vi.waitFor(() => expect(false).toBe(true))).rejects.toThrow();
      expect(Date.now() - start).toBeLessThanOrEqual(1_100);
    } finally {
      vi.useRealTimers();
    }
  });
});
