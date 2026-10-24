import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import TestRecordReporter from "./test-record-reporter.mjs";
import { nextestFailures, nextestFlaky, nextestTimes, nodeTestFailures, nodeTestPassed, nodeTestTimes, playwrightFailures, playwrightFlaky, playwrightTimes, readTestRecord, recordedRun, rerunCommand, slowest, vitestFailures } from "./flaky.mjs";

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

test("nextest's summary names the tests that failed on their last try, as FLAKY names the ones that passed on retry", () => {
  // cargo-nextest 0.9.143 with one retry: an in-run failure that passed on retry is not a failure.
  const retried = [
    "  \x1b[31mTRY 1 FAIL\x1b[0m [   0.027s] (───) sample tests::flaky_once",
    "  stdout ───",
    "    test tests::flaky_once ... FAILED",
    "        PASS [   0.035s] (1/3) sample tests::passes",
    "  TRY 1 FAIL [   0.043s] (───) sample tests::fails_twice",
    "  TRY 2 PASS [   0.019s] (2/3) sample tests::flaky_once",
    "  TRY 2 FAIL [   0.021s] (3/3) sample tests::fails_twice",
    "────────────",
    "     Summary [   0.069s] 3 tests run: 2 passed (1 flaky), 1 failed, 0 skipped",
    "   FLAKY 2/2 [   0.019s] (2/3) sample tests::flaky_once",
    "  TRY 2 FAIL [   0.021s] (3/3) sample tests::fails_twice",
    "error: test run failed",
  ].join("\n");
  assert.deepEqual(nextestFailures(retried), ["sample tests::fails_twice"]);
  assert.deepEqual(nextestFlaky(retried), ["sample tests::flaky_once"]);
  // A gate log without retries: a timeout, a Windows abort, and a test binary that could not start all fail.
  const crashed = [
    "        FAIL [   3.748s] (2361/3893) dohc-engine-sync tests::file_export_lane::lane_delete",
    "     Summary [1253.042s] 3893 tests run: 3873 passed (11 slow), 2 failed, 1 exec failed, 1 timed out, 32 skipped",
    "        FAIL [   3.748s] (2361/3893) dohc-engine-sync tests::file_export_lane::lane_delete",
    "       XFAIL [   0.001s] (2406/3893) dohc-engine-sync tests::owner_publication::reused_state",
    "       ABORT [   0.018s] (2411/3893) dohc-engine-sync tests::owner_publication::blocked_origin",
    "           - with code 0xc000012d: The paging file is too small for this operation to complete. (os error 1455)",
    "     TIMEOUT [ 180.077s] (3142/3893) dohc-engine-sync tests::passive_store::first_pull",
    "error: test run failed",
    "",
    "--- doctests ---",
  ].join("\n");
  assert.deepEqual(nextestFailures(crashed), ["dohc-engine-sync tests::file_export_lane::lane_delete", "dohc-engine-sync tests::owner_publication::reused_state",
    "dohc-engine-sync tests::owner_publication::blocked_origin", "dohc-engine-sync tests::passive_store::first_pull"]);
  assert.deepEqual(nextestFailures("  TRY 1 FAIL [   0.9s] (───) sample tests::interrupted\nCancelling due to interrupt"), [], "a run without a summary names none");
});

test("a node:test report names its failed tests by file and parent tests, and a failure outside the tests names none", () => {
  // Node 24's spec report, with a subtest and a file that failed to load.
  const log = [
    "✔ passes (1.2ms)",
    "✖ times out under load (30231.7603ms)",
    "▶ parent",
    "  ✖ leaf fails (0.2463ms)",
    "  ✔ leaf passes (0.8482ms)",
    "✖ parent (3.8197ms)",
    "✖ scripts\\verification\\broken.test.mjs (95.4427ms)",
    "ℹ fail 3",
    "✖ failing tests:",
    "",
    "test at scripts\\verification\\queue.test.mjs:182:1",
    "✖ times out under load (30231.7603ms)",
    "  'test timed out after 30000ms'",
    "",
    "test at scripts\\verification\\queue.test.mjs:190:11",
    "✖ leaf fails (0.2463ms)",
    "",
    "test at scripts\\verification\\broken.test.mjs:1:1",
    "✖ scripts\\verification\\broken.test.mjs (95.4427ms)",
  ].join("\r\n");
  assert.deepEqual(nodeTestFailures(log), ["scripts/verification/queue.test.mjs › times out under load",
    "scripts/verification/queue.test.mjs › parent > leaf fails", "scripts/verification/broken.test.mjs › scripts\\verification\\broken.test.mjs"]);
  assert.deepEqual(nodeTestFailures("✖ failing tests:\n\n✖ times out under load (30231ms)\n"), ["times out under load"], "a report without locations names the test alone");
  assert.deepEqual(nodeTestFailures("check-brand: 2 files use the old name\nELIFECYCLE Command failed"), []);
});

test("a node:test report shows a failed test passed alone only when the test itself ran", () => {
  const leaf = "scripts/a.test.mjs › parent > leaf fails", broken = "scripts/broken.test.mjs › scripts\\broken.test.mjs";
  assert.equal(nodeTestPassed("▶ parent\n  ✔ leaf fails (0.2ms)\n✔ parent (1.1ms)\nℹ pass 1", leaf), true, "its top-level test passed");
  assert.equal(nodeTestPassed("✔ scripts\\a.test.mjs (107.3ms)\nℹ pass 1", leaf), false, "node:test passes a file whose tests the pattern skipped");
  assert.equal(nodeTestPassed("✔ loads (2.1ms)\nℹ pass 1", broken), true, "a file that failed to load passes when its tests do");
  assert.equal(nodeTestPassed("✔ scripts\\broken.test.mjs (95.4ms)\nℹ pass 1", broken), false);
});

test("each failed test maps to the command that reruns it alone, and a test without one maps to none", () => {
  const command = (step, test) => rerunCommand({ step, test });
  // vitest matches suites and name joined by spaces; a name can contain " > " and characters a shell reads.
  assert.equal(command("@dohc/desktop", "src/renderer/shell/ShellChatsView.test.tsx › ShellChatsView > shows Chats from View > Chats and the palette"),
    `pnpm --filter @dohc/desktop exec vitest run src/renderer/shell/ShellChatsView.test.tsx -t "^ShellChatsView (> )?shows Chats from View (> )?Chats and the palette$"`);
  assert.equal(command("@dohc/workspace-core", "src/a.test.ts › top (x) [y] $HOME 'q' \"w\" `b` 50% a|b"),
    `pnpm --filter @dohc/workspace-core exec vitest run src/a.test.ts -t "^top \\(x\\) \\[y\\] .HOME 'q' .w. .b. 50. a\\|b$"`);
  // node:test reruns the top-level test, and a file that failed to load runs whole.
  assert.equal(command("repository", "scripts/verification/queue.test.mjs › parent > leaf fails"),
    `node --test --test-name-pattern "^parent( > |$)" scripts/verification/queue.test.mjs`);
  assert.equal(command("repository", "scripts/verification/broken.test.mjs › scripts\\verification\\broken.test.mjs"), "node --test scripts/verification/broken.test.mjs");
  assert.equal(command("desktop-scripts", "../../examples/fundraiser/recovery.test.ts › recovers (a) draft"),
    `pnpm --filter @dohc/desktop exec node --experimental-transform-types --test --test-name-pattern "^recovers \\(a\\) draft( > |$)" ../../examples/fundraiser/recovery.test.ts`);
  assert.equal(command("desktop-runtime-packaging", "scripts/stage-app-backend-runtime.test.mjs › stages the runtime"),
    `pnpm --filter @dohc/desktop exec node --test --test-name-pattern "^stages the runtime( > |$)" scripts/stage-app-backend-runtime.test.mjs`);
  // Playwright matches the file, the title, then the tags.
  assert.equal(command("desktop", "verification-smoke.spec.ts › @verification-smoke an editor change reaches disk"),
    `pnpm qa:e2e -- verification-smoke.spec.ts --grep "(^| )verification-smoke\\.spec\\.ts @verification-smoke an editor change reaches disk( @\\S+)*$"`);
  assert.equal(command("accounts", "account-security.spec.ts › a device verification request cannot turn next into an external redirect"),
    `node apps/desktop/scripts/run-playwright.mjs --config services/workspace-api/playwright.config.ts account-security.spec.ts --grep "(^| )account-security\\.spec\\.ts a device verification request cannot turn next into an external redirect( @\\S+)*$"`);
  // nextest names the binary, a library's or an integration test's, then the test.
  assert.equal(command("rust", "dohc-engine-sync tests::file_export_lane::lane_delete"),
    `node tools/rust-engine-program/run-rust-profile.mjs rerun -- --filter-expr "binary_id(=dohc-engine-sync) & test(=tests::file_export_lane::lane_delete)"`);
  assert.equal(command("rust", "dohc-engine-runtime::owner_publication accepted_prefix_settles"),
    `node tools/rust-engine-program/run-rust-profile.mjs rerun -- --filter-expr "binary_id(=dohc-engine-runtime::owner_publication) & test(=accepted_prefix_settles)"`);
  // A reader regression reruns through the gate's reader phase, which stages the reader and selects ignored tests.
  assert.equal(command("rust", "dohc-engine-collab live_update_application::adoption::tests::a_reader_built_lineage_adopts_its_successor"),
    "node tools/rust-engine-program/reader-tests.mjs");
  for (const [step, test] of [["repository", "times out under load"], ["self-host-native", "src/a.test.ts › proof"], ["rust", "dohc-engine-sync"],
    ["@dohc/desktop", "C:\\w\\a.test.ts › absolute"], ["@dohc/desktop", null], [null, "src/a.test.ts › a"]]) assert.equal(command(step, test), null, `${step}: ${test}`);
  // A lane receipt is read back from disk, so a row can be anything.
  for (const row of [undefined, null, 7, "src/a.test.ts › a"]) assert.equal(rerunCommand(row), null);
});

test("each pattern matches its test and no sibling that differs at one regular expression character", () => {
  // Each runner compiles the text between the quotes. Playwright also ignores case.
  const pattern = (step, test, flags) => new RegExp(rerunCommand({ step, test }).match(/(?:-t|--test-name-pattern|--grep) "([^"]*)"/u)[1], flags);
  const name = "esc [a] (b) {c} d* e+ f? g.h ^i j|k l/m";
  const siblings = [..."[](){}*+?.^|"].map(character => name.replace(character, "X"));
  // vitest matches suites and name joined by spaces, node:test the top-level name, Playwright the file, title, then tags.
  for (const [step, test, title, flags] of [["@dohc/desktop", `src/a.test.ts › suite > ${name}`, text => `suite ${text}`],
    ["repository", `scripts/a.test.mjs › ${name}`, text => text],
    ["accounts", `a.spec.ts › ${name}`, text => `  a.spec.ts ${text} @tag`, "i"]]) {
    const matcher = pattern(step, test, flags);
    assert.ok(matcher.test(title(name)), `${step} matches its test`);
    for (const sibling of siblings) assert.ok(!matcher.test(title(sibling)), `${step} skips ${sibling}`);
  }
  // Characters no shell writes the same way inside double quotes match any character there.
  assert.ok(pattern("@dohc/desktop", "src/a.test.ts › costs $5 \"now\" `b` 50% hi! a\\b").test("costs X5 XnowX XbX 50X hiX aXb"));
});

test("Playwright and vitest reports name their flaky and failed tests", t => {
  const suites = [{ specs: [{ file: "a.spec.ts", title: "steady", tests: [{ status: "expected" }] }],
    suites: [{ specs: [{ file: "b.spec.ts", title: "settles on retry", tests: [{ status: "flaky" }] },
      { file: "b.spec.ts", title: "@states-page every shared part matches its baseline", ok: false, tests: [{ status: "unexpected", results: [{ status: "failed", retry: 0 }, { status: "timedOut", retry: 1 }] }] },
      { file: "b.spec.ts", title: "stopped mid-run", tests: [{ status: "skipped", results: [{ status: "interrupted", retry: 0 }] }] }] }] }];
  assert.deepEqual(playwrightFlaky(suites), ["b.spec.ts › settles on retry"]);
  assert.deepEqual(playwrightFailures(suites), ["b.spec.ts › @states-page every shared part matches its baseline"]);
  assert.deepEqual(playwrightFailures(undefined), []);
  const root = mkdtempSync(join(tmpdir(), "dohc-flaky-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = join(root, "vitest.json");
  writeFileSync(report, JSON.stringify({ testResults: [{ assertionResults: [{ status: "passed", fullName: "ok" }, { status: "failed", fullName: "proof › acknowledged" }] }] }));
  assert.deepEqual(vitestFailures(report), ["proof › acknowledged"]);
  assert.deepEqual(vitestFailures(join(root, "missing.json")), []);
});

test("the vitest reporter records the tests that passed on retry, failed both tries, and the slow ones, and every test in a run alone", t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-flaky-"));
  const log = join(root, "tests.jsonl");
  const previous = process.env.DOHC_TEST_RECORD;
  process.env.DOHC_TEST_RECORD = log;
  t.after(() => { rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.DOHC_TEST_RECORD; else process.env.DOHC_TEST_RECORD = previous; });
  const testCase = (fullName, flaky, duration, state = "passed", errors = undefined) => ({ fullName, module: { moduleId: join(process.cwd(), "src", "a.test.ts") },
    diagnostic: () => state === "skipped" ? undefined : { flaky, duration }, result: () => ({ state, errors }) });
  const reporter = new TestRecordReporter();
  reporter.onTestCaseResult(testCase("steady", false, 30));
  // A test that passed on retry still carries what its failed try threw.
  reporter.onTestCaseResult(testCase("settles on retry", true, 40, "passed", [{ message: "EBUSY: resource busy or locked, rmdir 'C:\\tmp\\w'" }]));
  reporter.onTestCaseResult(testCase("drives a whole scenario", false, 12_500));
  // vitest reports a test that failed its retry too once, as failed and not flaky.
  reporter.onTestCaseResult(testCase("fails both tries", false, 25, "failed", [{ message: "expected 1 to be 2" }, { message: "expected 1 to be 2" }]));
  // The run ends with a file that failed to load, a failed beforeAll, and an unhandled error, none of which a test owns.
  const suite = errors => ({ errors: () => errors });
  const module = (errors, suites = []) => ({ ...suite(errors), children: { allSuites: () => suites.values() } });
  reporter.onTestRunEnd([module([], [suite([{ message: "beforeAll failed" }])]), module([{ message: "SyntaxError" }])], [{ message: "unhandled" }], "failed");
  assert.deepEqual(readTestRecord(log), [
    { test: "src/a.test.ts › settles on retry", flaky: true, failed: false, passed: true, seconds: 0.04, error: "EBUSY: resource busy or locked, rmdir 'C:\\tmp\\w'" },
    { test: "src/a.test.ts › drives a whole scenario", flaky: false, failed: false, passed: true, seconds: 12.5 },
    { test: "src/a.test.ts › fails both tries", flaky: false, failed: true, passed: false, seconds: 0.025, error: "expected 1 to be 2" },
  ]);
  assert.deepEqual(recordedRun(log), { run: "failed", outside: 3 });
  // A run alone records every test, so a test that skipped itself is no pass.
  const alone = join(root, "alone.jsonl");
  process.env.DOHC_TEST_RECORD = alone;
  process.env.DOHC_TEST_RECORD_ALL = "1";
  t.after(() => { delete process.env.DOHC_TEST_RECORD_ALL; });
  reporter.onTestCaseResult(testCase("steady", false, 30));
  reporter.onTestCaseResult(testCase("skips itself", false, 0, "skipped"));
  assert.deepEqual(readTestRecord(alone), [
    { test: "src/a.test.ts › steady", flaky: false, failed: false, passed: true, seconds: 0.03 },
    { test: "src/a.test.ts › skips itself", flaky: false, failed: false, passed: false, seconds: 0 },
  ]);
  assert.deepEqual(readTestRecord(join(root, "missing.jsonl")), []);
  assert.equal(recordedRun(join(root, "missing.jsonl")), null, "a run that never ended has no end");
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
