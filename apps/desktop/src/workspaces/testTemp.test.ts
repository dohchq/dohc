import { mkdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestScratch, sweepScratchParent } from "./testTemp";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

describe("test scratch", () => {
  it("sweeps aged runs without removing recent or current runs", async () => {
    const harness = await createTestScratch("sweep-test-");
    const parent = join(harness, "runs");
    const old = join(parent, "old-run");
    const live = join(parent, "live-run");
    const current = join(parent, "current-run");
    await Promise.all([
      mkdir(old, { recursive: true }),
      mkdir(live, { recursive: true }),
      mkdir(current, { recursive: true }),
    ]);
    const nowMs = Date.now();
    const oldTime = new Date(nowMs - 7 * 60 * 60 * 1_000);
    await utimes(old, oldTime, oldTime);

    await sweepScratchParent(parent, current, nowMs);

    expect(await pathExists(old), "the sweep must remove an aged run").toBe(false);
    expect(await pathExists(live), "the sweep removed a recent run").toBe(true);
    expect(await pathExists(current), "the sweep removed the current run").toBe(true);
  });
});
