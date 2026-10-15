// A vitest reporter that appends each test that passed only on retry, failed on
// its last try, or took at least two seconds to DOHC_TEST_RECORD, one JSON line
// per test, then one line for how the run ended. The gate runs it beside the
// default reporter.

import { appendFileSync } from "node:fs";
import { relative } from "node:path";

export default class TestRecordReporter {
  onTestCaseResult(testCase) {
    const path = process.env.DOHC_TEST_RECORD;
    const diagnostic = testCase.diagnostic();
    // vitest reports a test once, after its retries.
    const failed = testCase.result().state === "failed";
    if (!path || !diagnostic || !failed && !diagnostic.flaky && diagnostic.duration < 2000) return;
    const file = relative(process.cwd(), testCase.module.moduleId).replaceAll("\\", "/");
    appendFileSync(path, JSON.stringify({ test: `${file} › ${testCase.fullName}`, flaky: diagnostic.flaky, failed, seconds: diagnostic.duration / 1000 }) + "\n");
  }

  // `outside` counts the errors no test owns: an unhandled error, a file that failed to load, or a failed hook.
  onTestRunEnd(testModules, unhandledErrors, reason) {
    const path = process.env.DOHC_TEST_RECORD;
    if (!path) return;
    const suites = testModules.flatMap(module => [module, ...module.children.allSuites()]);
    const outside = unhandledErrors.length + suites.reduce((sum, suite) => sum + suite.errors().length, 0);
    const passed = testModules.reduce((sum, module) => sum + [...module.children.allTests("passed")].length, 0);
    appendFileSync(path, JSON.stringify({ run: reason, outside, passed }) + "\n");
  }
}
