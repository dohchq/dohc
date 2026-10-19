import { execFileSync } from "node:child_process";
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

  it("makes the run root again for the next file in the same worker, without a second sweep", async () => {
    expect(await initialization("next-file")).toEqual({ scans: 1, rootCreates: 2, rootRemoved: true, nextExists: true });
  });

  // Every account shares /tmp. A parent another account could enter is refused
  // before anything is swept or written in it.
  it.skipIf(process.platform === "win32")("refuses a scratch parent other accounts can enter, and writes nothing in it", async () => {
    expect(await initialization("loose-parent")).toEqual({
      scans: 0,
      rootCreates: 0,
      refused: true,
      entries: ["fixture-123-0000000000000001"],
    });
  });

  it.each(["scan-failure", "mkdir-failure"])("preserves a rejected startup after %s", async (mode) => {
    expect(await initialization(mode)).toEqual({
      scans: 1,
      rootCreates: mode === "mkdir-failure" ? 1 : 0,
      sameFailure: true,
    });
  });
});
