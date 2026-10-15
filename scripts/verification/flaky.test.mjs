import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import TestRecordReporter from "./test-record-reporter.mjs";
import { nextestFlaky, nextestTimes, nodeTestFailures, nodeTestTimes, playwrightFlaky, playwrightTimes, readTestRecord, slowest, vitestFailures } from "./flaky.mjs";

test("nextest's FLAKY lines name each test once", () => {
  const log = [
    "        PASS [   1.047s] (1540/3882) dohc-engine-runtime::automation_claims rolls_back",
    "  \x1b[33m     FLAKY\x1b[0m 2/2 [   1.085s] (3463/3882) dohc-workspace-engine::configured_live_host reloads_accepted_edits",
    "     Summary [ 990.757s] 3882 tests run: 3882 passed, 1 flaky, 32 skipped",
    "       FLAKY 2/2 [   1.085s] dohc-workspace-engine::configured_live_host reloads_accepted_edits",
  ].join("\n");
  assert.deepEqual(nextestFlaky(log), ["dohc-workspace-engine::configured_live_host reloads_accepted_edits"]);
  assert.deepEqual(nextestFlaky("     Summary [ 9.0s] 3 tests run: 3 passed"), []);
});

test("a node:test report names its failed tests, and a failure outside the tests names none", () => {
  const log = [
    "✔ passes (1.2ms)",
    "✖ times out under load (30231.7603ms)",
    "ℹ fail 1",
    "✖ failing tests:",
    "",
    "test at scripts\\verification\\queue.test.mjs:182:1",
    "✖ times out under load (30231.7603ms)",
    "  'test timed out after 30000ms'",
  ].join("\n");
  assert.deepEqual(nodeTestFailures(log), ["times out under load"]);
  assert.deepEqual(nodeTestFailures("check-brand: 2 files use the old name\nELIFECYCLE Command failed"), []);
});

test("Playwright and vitest reports name their flaky and failed tests", t => {
  const suites = [{ specs: [{ file: "a.spec.ts", title: "steady", tests: [{ status: "expected" }] }],
    suites: [{ specs: [{ file: "b.spec.ts", title: "settles on retry", tests: [{ status: "flaky" }] }] }] }];
  assert.deepEqual(playwrightFlaky(suites), ["b.spec.ts › settles on retry"]);
  const root = mkdtempSync(join(tmpdir(), "dohc-flaky-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = join(root, "vitest.json");
  writeFileSync(report, JSON.stringify({ testResults: [{ assertionResults: [{ status: "passed", fullName: "ok" }, { status: "failed", fullName: "proof › acknowledged" }] }] }));
  assert.deepEqual(vitestFailures(report), ["proof › acknowledged"]);
  assert.deepEqual(vitestFailures(join(root, "missing.json")), []);
});

test("the vitest reporter records the tests that passed on retry, and the slow ones", t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-flaky-"));
  const log = join(root, "tests.jsonl");
  const previous = process.env.DOHC_TEST_RECORD;
  process.env.DOHC_TEST_RECORD = log;
  t.after(() => { rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.DOHC_TEST_RECORD; else process.env.DOHC_TEST_RECORD = previous; });
  const testCase = (fullName, flaky, duration) => ({ fullName, module: { moduleId: join(process.cwd(), "src", "a.test.ts") }, diagnostic: () => ({ flaky, duration }) });
  const reporter = new TestRecordReporter();
  reporter.onTestCaseResult(testCase("steady", false, 30));
  reporter.onTestCaseResult(testCase("settles on retry", true, 40));
  reporter.onTestCaseResult(testCase("drives a whole scenario", false, 12_500));
  assert.deepEqual(readTestRecord(log), [
    { test: "src/a.test.ts › settles on retry", flaky: true, seconds: 0.04 },
    { test: "src/a.test.ts › drives a whole scenario", flaky: false, seconds: 12.5 },
  ]);
  assert.deepEqual(readTestRecord(join(root, "missing.jsonl")), []);
});

test("each runner's report gives its test times, and the slowest are kept longest first", () => {
  const rust = [
    "        PASS [   0.093s] (   1/3900) dohc-engine-collab author_coverage::separate_authors",
    "        SLOW [> 60.000s] (─────────) dohc-engine-runtime::replay admitted_baselines_commit",
    "        PASS [  71.250s] (3712/3900) dohc-engine-runtime::replay admitted_baselines_commit",
    "        SLOW [> 60.000s] (─────────) dohc-engine-collab adoption::rescue_streams_past_a_large_baseline",
    "  TRY 1 FAIL [   0.900s] (  12/3900) dohc-workspace-engine::configured_live_host reloads",
    "       FLAKY 2/2 [   1.085s] (  12/3900) dohc-workspace-engine::configured_live_host reloads",
    "       FLAKY 2/2 [   1.085s] dohc-workspace-engine::configured_live_host reloads",
  ].join("\n");
  assert.deepEqual(nextestTimes(rust), [
    { test: "dohc-engine-collab author_coverage::separate_authors", seconds: 0.093 },
    { test: "dohc-engine-runtime::replay admitted_baselines_commit", seconds: 71.25 },
    { test: "dohc-workspace-engine::configured_live_host reloads", seconds: 1.085 },
    { test: "dohc-engine-collab adoption::rescue_streams_past_a_large_baseline", seconds: 60 },
  ], "one time per test, a finished attempt over a SLOW report");
  assert.deepEqual(nextestFlaky(rust), ["dohc-workspace-engine::configured_live_host reloads"], "a padded counter is not part of the name");
  assert.deepEqual(nodeTestTimes("✔ quick (21.6ms)\n✖ broken (3.1ms)\n  ✔ nested setup (2400.5ms)"), [
    { test: "quick", seconds: 0.0216 }, { test: "nested setup", seconds: 2.4005 }]);
  assert.deepEqual(playwrightTimes([{ specs: [
    { file: "a.spec.ts", title: "restarts", tests: [{ results: [{ status: "failed", duration: 9000 }, { status: "passed", duration: 66_000 }] }] },
    { file: "a.spec.ts", title: "breaks", tests: [{ results: [{ status: "failed", duration: 5000 }, { status: "failed", duration: 4000 }] }] },
    { file: "a.spec.ts", title: "skipped", tests: [{ results: [{ status: "skipped", duration: 0 }] }] },
  ] }]), [{ test: "a.spec.ts › restarts", seconds: 66 }], "the attempt that passed, and no time for a test that never passed");
  assert.deepEqual(slowest([{ test: "a", seconds: 1.04 }, { test: "b", seconds: 40.26 }, { test: "c", seconds: 3 }], 2),
    [{ test: "b", seconds: 40.3 }, { test: "c", seconds: 3 }]);
});
