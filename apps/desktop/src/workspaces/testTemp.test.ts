import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestScratch, sweepScratchParent } from "./testTemp";

const HOUR_MS = 60 * 60 * 1_000;

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

async function age(path: string, nowMs: number, hours: number): Promise<void> {
  const when = new Date(nowMs - hours * HOUR_MS);
  await utimes(path, when, when);
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
    await age(old, nowMs, 49);

    await sweepScratchParent(parent, current, nowMs);

    expect(await pathExists(old), "the sweep must remove an aged run").toBe(false);
    expect(await pathExists(live), "the sweep removed a recent run").toBe(true);
    expect(await pathExists(current), "the sweep removed the current run").toBe(true);
  });

  // This sweep walks the parent that every runtime shares, so the run it is
  // about to delete may be a live Rust soak. A soak writes into a workspace it
  // created in its first minute, which leaves the run root's own mtime
  // untouched all day: reading only the root would delete work in progress.
  it("keeps a run whose only recent write is deep inside it", async () => {
    const harness = await createTestScratch("deep-activity-");
    const parent = join(harness, "runs");
    const soak = join(parent, "live-soak");
    const engine = join(soak, "workspace", ".dohc", "engine");
    await mkdir(engine, { recursive: true });
    await writeFile(join(engine, "engine.db"), "live");

    const nowMs = Date.now();
    // Everything above the deep file looks long abandoned.
    await age(engine, nowMs, 49);
    await age(join(soak, "workspace", ".dohc"), nowMs, 49);
    await age(join(soak, "workspace"), nowMs, 49);
    await age(soak, nowMs, 49);

    await sweepScratchParent(parent, join(parent, "current-run"), nowMs);

    expect(
      await pathExists(soak),
      "a run with recent work deep inside is live and must survive",
    ).toBe(true);
  });
});
