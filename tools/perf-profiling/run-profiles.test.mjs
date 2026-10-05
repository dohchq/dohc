import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createSummary, parseArgs, runProfilingScenarios } from "./run-profiles.mjs";
import { seedRichEdit } from "./seed-workspaces.mjs";

test("a scenario selector narrows the run and rejects unknown profiles", () => {
  const selected = parseArgs(["--output", "profile-output", "--scenario", "save-amplification-profile"]);
  assert.deepEqual(selected.scenarios.map(entry => entry.artifact), ["save-amplification-profile"]);
  assert.throws(() => parseArgs(["--output", "profile-output", "--scenario", "missing"]), /Unknown scenario/);
});

test("save-amplification summaries retain attribution scalars and exclude raw profile arrays", () => {
  const cases = [{ fixture: { name: "rich-edit-ordinary", files: 100 }, phases: [{
    name: "typing", complete: false, uniqueSavedNotifications: 0,
    countersPerSavedNotification: { main: null, renderer: null },
    delta: { main: { leasePublications: 3 }, renderer: { sessionPublications: 1 } },
    native: { status: "unavailable", reason: "generation changed" }, react: { commitCount: null, source: "unavailable" },
    error: { name: "Error", message: "persistence failed" },
    raw: { inputs: [{ trusted: true }], saves: [{ event: { state: "saved" } }], activities: [{ rawSentinel: "raw-events-stay-in-artifact" }] },
    cpuProfile: { nodes: [{ id: 1, callFrame: { functionName: "work", url: "profile.js" } }], samples: Array(10_000).fill(1), timeDeltas: Array(10_000).fill(2) },
    longTasks: { supported: true, count: 1, totalDurationMs: 55, entries: [{ duration: 55 }] },
  }] }];
  const summary = createSummary({}, [], { "save-amplification-profile": { measurements: { cases } } }, [{ artifact: "save-amplification-profile" }]);
  const phase = summary.scenarios.saveAmplification[0].phases[0];
  assert.equal(phase.uniqueSavedNotifications, 0);
  assert.deepEqual(phase.countersPerSavedNotification, { main: null, renderer: null });
  assert.deepEqual(phase.native, cases[0].phases[0].native);
  assert.deepEqual(phase.delta, cases[0].phases[0].delta);
  assert.deepEqual(phase.error, cases[0].phases[0].error);
  assert.deepEqual(phase.eventCounts, { inputs: 1, trustedInputs: 1, saveNotifications: 1, savedNotifications: 1, activityNotifications: 1 });
  assert.equal(phase.cpuProfileTop10SelfTimeFunctions[0].selfTimeUs, 20_000);
  assert.equal(phase.longTaskCount, 1);
  assert.equal(phase.longestTaskMs, 55);
  assert.equal(phase.reactCommitCount, null);
  assert.equal("cpuProfile" in phase, false);
  assert.equal("raw" in phase, false);
  assert.equal(JSON.stringify(summary).includes("raw-events-stay-in-artifact"), false);
  assert.ok(JSON.stringify(summary).length < 5000);
  assert.equal(summary.complete, true);
  assert.equal(createSummary({}, [], { "save-amplification-profile": { complete: false, measurements: { cases } } }, [{ artifact: "save-amplification-profile" }]).complete, false);
  assert.equal(createSummary({}, [], {}, []).scenarios.saveAmplification, null);
});

test("rich edit fixtures put the table below the first paragraph and record stable bytes", async t => {
  const output = await mkdtemp(join(tmpdir(), "dohc-rich-edit-fixture-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const ordinary = await seedRichEdit(join(output, "ordinary"));
  const repeat = await seedRichEdit(join(output, "repeat"));
  assert.deepEqual(ordinary, repeat);
  assert.equal(ordinary.files, 100);
  const text = await readFile(join(output, "ordinary", ordinary.path), "utf8");
  assert.equal(Buffer.byteLength(text), ordinary.bytes);
  assert.ok(text.indexOf("Type above this table.") < text.indexOf("| A |"));
  const stress = await seedRichEdit(join(output, "stress"), { stress: true, tiny: true });
  assert.equal(stress.files, 200);
  assert.ok(stress.bytes > 15 * 1024 && stress.bytes <= 16 * 1024);
  assert.equal(stress.tableRows, ordinary.tableRows);
  for (const [root, fixture] of [["ordinary", ordinary], ["stress", stress]]) {
    assert.equal(fixture.externalWritePaths.length, 10);
    assert.equal(new Set(fixture.externalWritePaths).size, 10);
    for (const path of fixture.externalWritePaths) {
      assert.ok((await stat(join(output, root, dirname(path)))).isDirectory());
      assert.equal(existsSync(join(output, root, path)), false);
    }
  }
  const full = await seedRichEdit(join(output, "full"), { stress: true });
  assert.equal(full.files, 5000);
  assert.ok(full.bytes > 39 * 1024 && full.bytes <= 40 * 1024);
  assert.ok(full.paragraphs < ordinary.paragraphs);
  assert.ok(full.paragraphs > stress.paragraphs);
  const stressText = await readFile(join(output, "full", full.path), "utf8");
  assert.equal(Buffer.byteLength(stressText), full.bytes);
  assert.equal(stressText.split("\n\n").filter(block => block && !block.startsWith("#") && !block.startsWith("|")).length, full.paragraphs);
  assert.equal(stressText.split("\n\n")[2], text.split("\n\n")[2]);
});

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
