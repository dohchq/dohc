// Tests that passed only on retry, tests that failed on their last try, and the
// slowest tests. The gate retries a failing test once, so a flaky test no longer
// fails a change it has nothing to do with, and records each one here so it gets
// fixed instead of hidden. Failed tests use the same names, so the queue can tell
// when other branches fail the same test. It also records the slowest tests, so
// the suites' time can be kept in budget.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The vitest reporter that records the tests that passed only on retry, and the slow ones. */
export const testRecordReporter = fileURLToPath(new URL("./test-record-reporter.mjs", import.meta.url));

/** How many of the slowest tests a report keeps. */
export const slowestKept = 20;

const plain = text => text.replace(/\x1b\[[0-9;]*m/gu, "");
/** A log or report as text, empty when it is missing or unreadable. */
export const readLog = path => { try { return existsSync(path) ? readFileSync(path, "utf8") : ""; } catch { return ""; } };
const read = readLog;

/** Tests nextest reports as FLAKY: failed, then passed on a retry. */
export function nextestFlaky(log) {
  const names = [...plain(log).matchAll(/^\s*FLAKY\s+\d+\/\d+\s+\[[^\]]*\]\s+(?:\([^)]*\)\s+)?(.+?)\s*$/gmu)].map(match => match[1]);
  return [...new Set(names)];
}

/**
 * Tests nextest's summary lists as failed on their last try: a failure, a
 * timeout, a crash, or a test binary that could not start. A run that printed
 * no summary names none.
 */
export function nextestFailures(log) {
  const summary = plain(log).split(/^\s*Summary \[.*$/mu).slice(1).join("\n");
  const names = [...summary.matchAll(/^\s*(?:TRY \d+ )?(?:FAIL|TIMEOUT|ABORT|XFAIL|LEAK-FAIL|SIG\w+)\s+\[[^\]]*\]\s+(?:\([^)]*\)\s+)?(.+?)\s*$/gmu)].map(match => match[1]);
  return [...new Set(names)];
}

/** The failed tests in a node:test spec report, or none when the run failed outside its tests. */
export function nodeTestFailures(log) {
  const text = plain(log);
  const start = text.indexOf("✖ failing tests:");
  if (start < 0) return [];
  const names = [...text.slice(start).matchAll(/^✖ (.+?) \([\d.]+ms\)\s*$/gmu)].map(match => match[1]);
  return [...new Set(names)];
}

const playwrightSpecs = (suites = [], status) => suites.flatMap(suite => [
  ...(suite.specs ?? []).filter(spec => spec.tests?.some(test => test.status === status)).map(spec => `${spec.file} › ${spec.title}`),
  ...playwrightSpecs(suite.suites, status),
]);

/** Tests a Playwright JSON report marks flaky. */
export const playwrightFlaky = suites => playwrightSpecs(suites, "flaky");

/** Tests a Playwright JSON report marks unexpected: they failed on every try. An interrupted test counts as skipped. */
export const playwrightFailures = suites => playwrightSpecs(suites, "unexpected");

/** Failed tests in a vitest JSON report. */
export function vitestFailures(path) {
  try {
    const report = JSON.parse(read(path));
    return (report.testResults ?? []).flatMap(file => (file.assertionResults ?? []).filter(test => test.status === "failed").map(test => test.fullName));
  } catch { return []; }
}

/** The tests the vitest reporter recorded in `path`: { test, flaky, failed, seconds }. */
export function readTestRecord(path) {
  return read(path).split(/\r?\n/u).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

/**
 * nextest's per-test times, in seconds, one per test: the longest finished
 * attempt, or for a test that never finished, the longest SLOW report.
 */
export function nextestTimes(log) {
  const finished = new Map(), running = new Map();
  for (const match of plain(log).matchAll(/^\s*(?:TRY \d+ )?(PASS|FAIL|TIMEOUT|FLAKY\s+\d+\/\d+|SLOW)\s+\[\s*>?\s*([\d.]+)s\]\s+(?:\([^)]*\)\s+)?(.+?)\s*$/gmu)) {
    const times = match[1] === "SLOW" ? running : finished;
    times.set(match[3], Math.max(times.get(match[3]) ?? 0, Number(match[2])));
  }
  for (const [test, seconds] of running) if (!finished.has(test)) finished.set(test, seconds);
  return [...finished].map(([test, seconds]) => ({ test, seconds }));
}

/** node:test's per-test times from a spec report, in seconds. */
export function nodeTestTimes(log) {
  return [...plain(log).matchAll(/^\s*✔ (.+?) \(([\d.]+)ms\)\s*$/gmu)].map(match => ({ test: match[1], seconds: Number(match[2]) / 1000 }));
}

/** Playwright's per-test times from its JSON report, in seconds: the attempt that passed. A test with none has no time. */
export function playwrightTimes(suites = []) {
  return suites.flatMap(suite => [
    ...(suite.specs ?? []).flatMap(spec => (spec.tests ?? []).flatMap(test => {
      const passed = test.results?.find(result => result.status === "passed");
      return passed ? [{ test: `${spec.file} › ${spec.title}`, seconds: passed.duration / 1000 }] : [];
    })),
    ...playwrightTimes(suite.suites),
  ]);
}

/** The slowest rows, longest first. */
export const slowest = (rows, count = slowestKept) => rows.toSorted((a, b) => b.seconds - a.seconds).slice(0, count)
  .map(row => ({ ...row, seconds: Math.round(row.seconds * 10) / 10 }));
