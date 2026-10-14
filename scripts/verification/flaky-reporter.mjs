// A vitest reporter that appends each test that passed only on retry to
// DOHC_FLAKY_LOG, one JSON line per test. The gate runs it beside the default reporter.

import { appendFileSync } from "node:fs";
import { relative } from "node:path";

export default class FlakyReporter {
  onTestCaseResult(testCase) {
    const path = process.env.DOHC_FLAKY_LOG;
    if (!path || !testCase.diagnostic()?.flaky) return;
    const file = relative(process.cwd(), testCase.module.moduleId).replaceAll("\\", "/");
    appendFileSync(path, JSON.stringify({ test: `${file} › ${testCase.fullName}` }) + "\n");
  }
}
