// A vitest reporter that appends each test that passed only on retry, failed on
// its last try, or took at least two seconds to DOHC_TEST_RECORD, one JSON line
// per test. The gate runs it beside the default reporter.

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
}
