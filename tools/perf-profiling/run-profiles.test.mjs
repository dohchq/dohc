import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("a partial profile without fixture metadata still produces a summary", () => {
  const artifacts = {
    "excalidraw-profile": { measurements: {} },
    "bigdoc-profile": { measurements: {} },
    "bigdoc-read-profile": { measurements: {} },
  };

  const summary = createSummary({}, [], artifacts, []);

  assert.equal(summary.scenarios.excalidraw.elementCount, null);
  assert.equal(summary.scenarios.bigDoc.bytes, null);
  assert.equal(summary.scenarios.bigDocRead.bytes, null);
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

test("a successful profiling run removes mutable workspaces but keeps artifacts", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "dohc-run-profiles-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const scenario = { artifact: "clean-profile", spec: "clean-profile.spec.ts" };
  const artifactPath = join(output, `${scenario.artifact}.json`);
  const enginePath = join(output, "workspaces", "big-docs", ".dohc", "engine");

  const failures = await runProfilingScenarios({
    output,
    headed: false,
    env: {},
    scenarios: [scenario],
    execute: async () => {
      await mkdir(enginePath, { recursive: true });
      await writeFile(join(enginePath, "engine.db"), "mutable engine state");
      await writeFile(artifactPath, '{"measurements":{"elapsedMs":1}}\n');
    },
  });

  assert.deepEqual(failures, []);
  assert.equal(existsSync(join(output, "workspaces")), false);
  assert.equal(
    await readFile(artifactPath, "utf8"),
    '{"measurements":{"elapsedMs":1}}\n',
  );
});

test("a failed profiling run removes mutable workspaces but keeps artifacts", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "dohc-run-profiles-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const scenario = { artifact: "failed-profile", spec: "failed-profile.spec.ts" };
  const artifactPath = join(output, `${scenario.artifact}.json`);
  const enginePath = join(output, "workspaces", "big-docs", ".dohc", "engine");

  const failures = await runProfilingScenarios({
    output,
    headed: false,
    env: {},
    scenarios: [scenario],
    execute: async () => {
      await mkdir(enginePath, { recursive: true });
      await writeFile(join(enginePath, "engine.db"), "mutable engine state");
      await writeFile(artifactPath, '{"measurements":{"partial":true}}\n');
      throw new Error("profile process failed");
    },
  });

  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /profile process failed/);
  assert.equal(existsSync(join(output, "workspaces")), false);
  assert.equal(
    await readFile(artifactPath, "utf8"),
    '{"measurements":{"partial":true}}\n',
  );
});

test("an unexpected runner failure still removes mutable workspaces", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "dohc-run-profiles-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const scenario = { artifact: "partial-profile", spec: "partial-profile.spec.ts" };
  const artifactPath = join(output, `${scenario.artifact}.json`);
  const enginePath = join(output, "workspaces", "big-docs", ".dohc", "engine");
  function* interruptedScenarios() {
    yield scenario;
    throw new Error("scenario enumeration failed");
  }

  await assert.rejects(
    runProfilingScenarios({
      output,
      headed: false,
      env: {},
      scenarios: interruptedScenarios(),
      execute: async () => {
        await mkdir(enginePath, { recursive: true });
        await writeFile(join(enginePath, "engine.db"), "mutable engine state");
        await writeFile(artifactPath, '{"measurements":{"partial":true}}\n');
      },
    }),
    /scenario enumeration failed/,
  );

  assert.equal(existsSync(join(output, "workspaces")), false);
  assert.equal(
    await readFile(artifactPath, "utf8"),
    '{"measurements":{"partial":true}}\n',
  );
});
