import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import FlakyReporter from "./flaky-reporter.mjs";
import { nextestFlaky, nodeTestFailures, playwrightFlaky, readFlakyLog, vitestFailures } from "./flaky.mjs";

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

test("the vitest reporter records only tests that passed on retry", t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-flaky-"));
  const log = join(root, "flaky.jsonl");
  const previous = process.env.DOHC_FLAKY_LOG;
  process.env.DOHC_FLAKY_LOG = log;
  t.after(() => { rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.DOHC_FLAKY_LOG; else process.env.DOHC_FLAKY_LOG = previous; });
  const testCase = (fullName, flaky) => ({ fullName, module: { moduleId: join(process.cwd(), "src", "a.test.ts") }, diagnostic: () => ({ flaky }) });
  const reporter = new FlakyReporter();
  reporter.onTestCaseResult(testCase("steady", false));
  reporter.onTestCaseResult(testCase("settles on retry", true));
  assert.deepEqual(readFlakyLog(log), ["src/a.test.ts › settles on retry"]);
  assert.deepEqual(readFlakyLog(join(root, "missing.jsonl")), []);
});

test("nextest retries a failing test once in every gate", () => {
  assert.match(readFileSync(new URL("../../.config/nextest.toml", import.meta.url), "utf8"), /^retries = 1$/mu);
});
