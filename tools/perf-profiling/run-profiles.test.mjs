import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSummary, runProfilingScenarios } from "./run-profiles.mjs";

test("a successful Playwright run without a fresh artifact is a failure", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "dohc-run-profiles-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const scenario = { artifact: "skipped-profile", spec: "skipped-profile.spec.ts" };
  await writeFile(join(output, `${scenario.artifact}.json`), "stale\n");

  const failures = await runProfilingScenarios({
    output,
    headed: false,
    env: {},
    scenarios: [scenario],
    execute: async () => {},
  });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].scenario, scenario.artifact);
  assert.match(failures[0].error, /did not produce.*skipped-profile\.json/i);
});

test("a summary cannot be complete when an artifact is missing", () => {
  const scenario = { artifact: "switch-profile", spec: "switch-profile.spec.ts" };
  const summary = createSummary({}, [], {}, [scenario]);

  assert.equal(summary.complete, false);
  assert.equal(summary.scenarios.switch, null);
});

test("a fresh artifact permits a complete summary", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "dohc-run-profiles-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const scenario = { artifact: "fresh-profile", spec: "fresh-profile.spec.ts" };
  const artifact = { measurements: {} };

  const failures = await runProfilingScenarios({
    output,
    headed: false,
    env: {},
    scenarios: [scenario],
    execute: async () => {
      await writeFile(join(output, `${scenario.artifact}.json`), JSON.stringify(artifact));
    },
  });
  const summary = createSummary(
    {},
    failures,
    { [scenario.artifact]: artifact },
    [scenario],
  );

  assert.deepEqual(failures, []);
  assert.equal(summary.complete, true);
});
