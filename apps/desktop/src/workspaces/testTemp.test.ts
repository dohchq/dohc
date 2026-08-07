import {
  lutimes,
  mkdir,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
    const old = join(parent, "old-run-4821-0000000000000001");
    const live = join(parent, "live-run-4821-0000000000000002");
    const current = join(parent, "current-run-4821-0000000000000003");
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
    const abandoned = join(parent, "killed-run-4821-00000000000000dd");
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

    await sweepScratchParent(parent, join(parent, "current-run-4821-0000000000000003"), nowMs);

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
    const soak = join(parent, "live-soak-4821-00000000000000aa");
    const engine = join(soak, "workspace", ".dohc", "engine");
    await mkdir(engine, { recursive: true });
    await writeFile(join(engine, "engine.db"), "live");

    const nowMs = Date.now();
    // Everything above the deep file looks long abandoned.
    await age(engine, nowMs, 49);
    await age(join(soak, "workspace", ".dohc"), nowMs, 49);
    await age(join(soak, "workspace"), nowMs, 49);
    await age(soak, nowMs, 49);

    await sweepScratchParent(parent, join(parent, "current-run-4821-0000000000000003"), nowMs);

    expect(
      await pathExists(soak),
      "a run with recent work deep inside is live and must survive",
    ).toBe(true);
  });

  // The parent this sweep walks is a shared directory in the platform temp
  // dir, and anything can land in it. Age says nothing about who made a
  // directory, and what follows the decision is a recursive delete — so only
  // names carrying the run shape are swept. The Rust twin holds the same line
  // in `sweep_refuses_an_aged_directory_that_is_not_run_shaped`.
  it("removes an aged run root, and never an aged directory of somebody else's", async () => {
    const harness = await createTestScratch("shape-guard-");
    const parent = join(harness, "runs");
    const mine = join(parent, "process-4821-0f3a1c0d5e2b7648");
    const theirs = join(parent, "notes-from-a-conference");
    await mkdir(mine, { recursive: true });
    await mkdir(theirs, { recursive: true });
    const theirFile = join(theirs, "do-not-delete.md");
    await writeFile(theirFile, "a year of work");

    const nowMs = Date.now();
    await age(theirFile, nowMs, 49);
    await age(theirs, nowMs, 49);
    await age(mine, nowMs, 49);

    await sweepScratchParent(parent, join(parent, "process-5678-0000000000000000"), nowMs);

    expect(
      await pathExists(theirFile),
      "an aged directory that is not run-shaped is not this sweep's to remove",
    ).toBe(true);
    // And the guard did not just turn the sweep off.
    expect(
      await pathExists(mine),
      "an aged run-shaped root must still be swept",
    ).toBe(false);
  });

  // Ownership is the contract, and a name is only allowed to stand for it
  // because nothing else may take that shape. A configured id like
  // `ci-123-0123456789abcdef` would otherwise be swept as one this module
  // generated, which is the opposite of "a root you named is yours". The Rust
  // twin refuses the same ids in `safe_component_checked`.
  it("refuses a configured run id shaped like a generated one", () => {
    const previous = process.env.DOHC_TEST_SCRATCH_RUN;
    const root = process.env.DOHC_TEST_SCRATCH_ROOT;
    delete process.env.DOHC_TEST_SCRATCH_ROOT;
    try {
      process.env.DOHC_TEST_SCRATCH_RUN = "ci-123-0123456789abcdef";
      expect(() => testScratchRunRoot()).toThrow(/generated run id/);

      // A name of the caller's own is still theirs to choose.
      process.env.DOHC_TEST_SCRATCH_RUN = "ci-123";
      expect(basename(testScratchRunRoot())).toBe("ci-123");
    } finally {
      if (previous === undefined) delete process.env.DOHC_TEST_SCRATCH_RUN;
      else process.env.DOHC_TEST_SCRATCH_RUN = previous;
      if (root !== undefined) process.env.DOHC_TEST_SCRATCH_ROOT = root;
    }
  });

  // The guard is only as good as its agreement with the name this module gives
  // its own run root. A run id that drifted out of the shape would leak every
  // run it named, silently — so the producer is checked through the sweep, not
  // described in a comment. The Rust twin holds the same line in
  // `every_run_root_this_repo_creates_is_run_shaped`.
  it("sweeps a run root named the way this module names its own", async () => {
    const harness = await createTestScratch("own-name-");
    const parent = join(harness, "runs");
    const mine = join(parent, basename(testScratchRunRoot()));
    await mkdir(mine, { recursive: true });

    const nowMs = Date.now();
    await age(mine, nowMs, 49);

    await sweepScratchParent(parent, join(parent, "current-run-4821-0000000000000003"), nowMs);

    expect(
      await pathExists(mine),
      "this module's own run root name must be one the sweep can reclaim",
    ).toBe(false);
  });
});
