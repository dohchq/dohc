import {
  lutimes,
  mkdir,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupSuiteTestScratch,
  createTestScratch,
  sweepScratchParent,
  testScratchRunRoot,
} from "./testTemp";

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

  // `join` folds `.` and `..` away before mkdtemp adds its suffix, so a scratch
  // named for a direction lands beside the run root, or beside the managed
  // parent — loose in %TEMP%, seen by neither the reporter nor the sweep.
  it.each([".", ".."])(
    "keeps a scratch named %j inside the run root",
    async (prefix) => {
      const scratch = await createTestScratch(prefix);

      expect(
        dirname(scratch),
        "a prefix that is a direction, not a name, must not move the scratch",
      ).toBe(testScratchRunRoot());
    },
  );

  // A link is a leaf, not a door. Reading through one asks about a tree the
  // abandoned run does not own, and the answer pins it: an external target
  // still being written to reads as recent work, so the dead run is never
  // swept. The Rust twin uses `symlink_metadata` and this must match it.
  // `symlink(..., "junction")` is a junction on Windows — no privilege needed —
  // and an ordinary symlink everywhere else, where the type argument is ignored.
  it("does not follow a link out of an abandoned run", async () => {
    const harness = await createTestScratch("linked-activity-");
    const parent = join(harness, "runs");
    const abandoned = join(parent, "killed-run");
    const outside = join(harness, "someone-elses-workspace");
    await mkdir(abandoned, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "engine.db"), "live");
    const link = join(abandoned, "link-to-live-work");
    await symlink(outside, link, "junction");

    const nowMs = Date.now();
    // The link and the run are ancient; only the link's target is recent.
    const when = new Date(nowMs - 49 * HOUR_MS);
    await lutimes(link, when, when);
    await age(abandoned, nowMs, 49);

    await sweepScratchParent(parent, join(parent, "current-run"), nowMs);

    expect(
      await pathExists(abandoned),
      "recent work behind a link is not this run's work, so the run is idle",
    ).toBe(false);
    expect(
      await pathExists(join(outside, "engine.db")),
      "the sweep must never delete through a link",
    ).toBe(true);
  });

  // Every worker of a vitest run shares one handed-down root, and each test
  // file drains at its own `afterAll`. A suite that removed the root while it
  // was momentarily empty would ENOENT the next `mkdtemp` in another worker.
  // The supplier reclaims its own root; nothing here may.
  it("leaves a handed-down run root for whoever handed it down", async () => {
    const handedDown = await createTestScratch("handed-down-root-");
    const previous = process.env.DOHC_TEST_SCRATCH_ROOT;
    process.env.DOHC_TEST_SCRATCH_ROOT = handedDown;
    try {
      await cleanupSuiteTestScratch();

      expect(
        await pathExists(handedDown),
        "a suite must not remove a root it was handed",
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.DOHC_TEST_SCRATCH_ROOT;
      else process.env.DOHC_TEST_SCRATCH_ROOT = previous;
    }
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
