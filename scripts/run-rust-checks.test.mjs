import assert from "node:assert/strict";
import test from "node:test";
import { buildRustCheckReport } from "../tools/rust-engine-program/rust-check-report.mjs";

const reportContext = {
  stamp: "2026-07-31T07:15:38.034Z",
  platform: "win32",
  arch: "x64",
};

test("an early failure stays aligned in the summary and evidence", () => {
  const report = buildRustCheckReport(
    [
      { name: "fixture drift", status: "FAIL", required: true },
      { name: "fmt --check", status: "PASS", required: true },
      { name: "cargo-audit", status: "PASS", required: false },
    ],
    reportContext,
  );

  assert.equal(
    report.summary,
    "  FAIL fixture drift\n  PASS fmt --check\n  PASS cargo-audit",
  );
  assert.equal(
    report.evidence,
    "- 2026-07-31T07:15:38.034Z | run-rust-checks | win32/x64 | FAIL | fixture drift=FAIL fmt --check=PASS cargo-audit=PASS",
  );
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.exitCode, 1);
});

test("a late failure stays aligned in the summary and evidence", () => {
  const report = buildRustCheckReport(
    [
      { name: "fixture drift", status: "PASS", required: true },
      { name: "fmt --check", status: "PASS", required: true },
      { name: "cargo-audit", status: "FAIL", required: false },
    ],
    reportContext,
  );

  assert.equal(
    report.summary,
    "  PASS fixture drift\n  PASS fmt --check\n  FAIL cargo-audit",
  );
  assert.equal(
    report.evidence,
    "- 2026-07-31T07:15:38.034Z | run-rust-checks | win32/x64 | FAIL | fixture drift=PASS fmt --check=PASS cargo-audit=FAIL",
  );
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.exitCode, 1);
});

test("a required skip fails the report", () => {
  const reason =
    "yjs/tsx unavailable; fixture drift not checked; required step skipped → verdict FAIL";
  const report = buildRustCheckReport(
    [
      {
        name: "fixture drift",
        status: "SKIP",
        required: true,
        reason,
      },
      { name: "fmt --check", status: "PASS", required: true },
    ],
    reportContext,
  );

  assert.equal(
    report.summary,
    `  SKIP fixture drift — ${reason}\n  PASS fmt --check`,
  );
  assert.equal(
    report.evidence,
    `- 2026-07-31T07:15:38.034Z | run-rust-checks | win32/x64 | FAIL | fixture drift=SKIP[${reason}] fmt --check=PASS`,
  );
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.exitCode, 1);
});

test("an optional skip passes when every executed step passes", () => {
  const report = buildRustCheckReport(
    [
      { name: "fixture drift", status: "PASS", required: true },
      { name: "cargo-audit", status: "SKIP", required: false },
    ],
    reportContext,
  );

  assert.equal(
    report.summary,
    "  PASS fixture drift\n  SKIP cargo-audit",
  );
  assert.equal(
    report.evidence,
    "- 2026-07-31T07:15:38.034Z | run-rust-checks | win32/x64 | PASS | fixture drift=PASS cargo-audit=SKIP",
  );
  assert.equal(report.verdict, "PASS");
  assert.equal(report.exitCode, 0);
});
