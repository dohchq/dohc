// Tests that passed only on retry. The gate retries a failing test once, so a
// flaky test no longer fails a change it has nothing to do with, and records
// each one here so it gets fixed instead of hidden.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The vitest reporter that records which tests passed only on retry. */
export const flakyReporter = fileURLToPath(new URL("./flaky-reporter.mjs", import.meta.url));

const plain = text => text.replace(/\x1b\[[0-9;]*m/gu, "");
/** A log or report as text, empty when it is missing or unreadable. */
export const readLog = path => { try { return existsSync(path) ? readFileSync(path, "utf8") : ""; } catch { return ""; } };
const read = readLog;

/** Tests nextest reports as FLAKY: failed, then passed on a retry. */
export function nextestFlaky(log) {
  const names = [...plain(log).matchAll(/^\s*FLAKY\s+\d+\/\d+\s+\[[^\]]*\]\s+(?:\(\d+\/\d+\)\s+)?(.+?)\s*$/gmu)].map(match => match[1]);
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

/** Tests a Playwright JSON report marks flaky. */
export function playwrightFlaky(suites = []) {
  return suites.flatMap(suite => [
    ...(suite.specs ?? []).filter(spec => spec.tests?.some(test => test.status === "flaky")).map(spec => `${spec.file} › ${spec.title}`),
    ...playwrightFlaky(suite.suites),
  ]);
}

/** Failed tests in a vitest JSON report. */
export function vitestFailures(path) {
  try {
    const report = JSON.parse(read(path));
    return (report.testResults ?? []).flatMap(file => (file.assertionResults ?? []).filter(test => test.status === "failed").map(test => test.fullName));
  } catch { return []; }
}

/** The tests the vitest reporter recorded in `path`. */
export function readFlakyLog(path) {
  return read(path).split(/\r?\n/u).filter(Boolean).flatMap(line => { try { return [JSON.parse(line).test]; } catch { return []; } });
}
