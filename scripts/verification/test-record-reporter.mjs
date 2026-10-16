// A vitest reporter that appends each test that passed only on retry, failed on
// its last try, or took at least two seconds to DOHC_TEST_RECORD, one JSON line
// per test, then one line for how the run ended. With DOHC_TEST_RECORD_ALL=1, as
// in a run alone, it appends every test, so the gate can tell each test passed.
// The gate runs it beside the default reporter.

import { appendFileSync } from "node:fs";
import { relative } from "node:path";

export default class TestRecordReporter {
  onTestCaseResult(testCase) {
    const path = process.env.DOHC_TEST_RECORD;
    if (!path) return;
    const diagnostic = testCase.diagnostic();
    // vitest reports a test once, after its retries. A skipped test has no diagnostic.
    const { state } = testCase.result();
    const failed = state === "failed";
    if (process.env.DOHC_TEST_RECORD_ALL !== "1" && (!diagnostic || !failed && !diagnostic.flaky && diagnostic.duration < 2000)) return;
    const file = relative(process.cwd(), testCase.module.moduleId).replaceAll("\\", "/");
    appendFileSync(path, JSON.stringify({ test: `${file} › ${testCase.fullName}`, flaky: diagnostic?.flaky ?? false, failed, passed: state === "passed", seconds: (diagnostic?.duration ?? 0) / 1000 }) + "\n");
  }

  // `outside` counts the errors no test owns: an unhandled error, a file that failed to load, or a failed hook.
  onTestRunEnd(testModules, unhandledErrors, reason) {
    const path = process.env.DOHC_TEST_RECORD;
    if (!path) return;
    const suites = testModules.flatMap(module => [module, ...module.children.allSuites()]);
    const outside = unhandledErrors.length + suites.reduce((sum, suite) => sum + suite.errors().length, 0);
    appendFileSync(path, JSON.stringify({ run: reason, outside }) + "\n");
  }
}
