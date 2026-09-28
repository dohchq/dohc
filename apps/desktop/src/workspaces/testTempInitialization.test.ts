import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestScratch } from "./testTemp";

async function initialization(mode: string) {
  const root = await createTestScratch("scratch-initialization-");
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./testTempInitialization.fixture.mjs", import.meta.url)), mode],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TEMP: root,
        TMP: root,
        TMPDIR: root,
        DOHC_TEST_SCRATCH_ROOT: "",
        DOHC_TEST_SCRATCH_RUN: "",
      },
    },
  );
  return JSON.parse(output);
}

describe("test scratch initialization", () => {
  it("setup sweeps once before synchronous and asynchronous allocations", async () => {
    expect(await initialization("setup")).toEqual({ scans: 1, rootCreates: 1, agedExists: false });
  });

  it("concurrent direct asynchronous callers share the startup sweep", async () => {
    expect(await initialization("async")).toEqual({ scans: 1, rootCreates: 1, agedExists: false });
  });

  it("removes a worker's empty run root when the worker exits", async () => {
    const { root } = await initialization("exit");
    expect(existsSync(root)).toBe(false);
  });

  it("keeps a run root that still holds scratch when the worker exits", async () => {
    const { root } = await initialization("exit-occupied");
    expect(existsSync(root)).toBe(true);
  });

  it.each(["scan-failure", "mkdir-failure"])("preserves a rejected startup after %s", async (mode) => {
    expect(await initialization(mode)).toEqual({
      scans: 1,
      rootCreates: mode === "mkdir-failure" ? 1 : 0,
      sameFailure: true,
    });
  });
});
