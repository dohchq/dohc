import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createTestScratch } from "./testTemp";

async function runFixture(fail = false) {
  const directory = await createTestScratch("vitest-scratch-");
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./testTempVitest.fixture.mjs", import.meta.url)), directory], {
    encoding: "utf8", timeout: 70_000, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DOHC_SCRATCH_FIXTURE_FAIL: fail ? "1" : "0" },
  });
  return JSON.parse(output.trim().split(/\r?\n/u).at(-1)!);
}

it("sweeps once across isolated files while retaining per-test and per-file cleanup", async () => {
  expect(await runFixture()).toEqual({ status: 0, scans: 1, files: 3, roots: 3, clean: true, agedExists: false, recentExists: true });
}, 80_000);

it("fails before starting tests when the global sweep rejects", async () => {
  const result = await runFixture(true);
  expect(result).toMatchObject({ status: 1, scans: 1, files: 0, agedExists: true, recentExists: true });
  expect(result.output).toContain("injected global scratch failure");
}, 80_000);
