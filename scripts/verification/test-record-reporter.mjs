// A vitest reporter that appends each test that passed only on retry, or took
// at least two seconds, to DOHC_TEST_RECORD, one JSON line per test. The gate
// runs it beside the default reporter.

import { appendFileSync } from "node:fs";
import { relative } from "node:path";

export default class TestRecordReporter {
  onTestCaseResult(testCase) {
    const path = process.env.DOHC_TEST_RECORD;
    const diagnostic = testCase.diagnostic();
    if (!path || !diagnostic || !diagnostic.flaky && diagnostic.duration < 2000) return;
    const file = relative(process.cwd(), testCase.module.moduleId).replaceAll("\\", "/");
    appendFileSync(path, JSON.stringify({ test: `${file} › ${testCase.fullName}`, flaky: diagnostic.flaky, seconds: diagnostic.duration / 1000 }) + "\n");
  }
}
