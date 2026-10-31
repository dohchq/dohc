// Tests that passed only on retry, tests that failed on their last try, and the
// slowest tests. The gate retries a failing test once, and a package or node:test
// step's test that fails both tries once more alone, so a flaky test no longer
// fails a change it has nothing to do with, and records each one here so it gets
// fixed instead of hidden. Failed tests use the same names, so the queue can tell
// when other branches fail the same test, and the gate can print the command that
// reruns each one. It also records the slowest tests, so the suites' time can be
// kept in budget.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { READER_TESTS } from "../../tools/rust-engine-program/reader-tests.mjs";

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

/**
 * The failed tests in a node:test spec report, named `file › test`, or
 * `file › parent > test` for a subtest. A run that failed outside its tests
 * names none.
 */
export function nodeTestFailures(log) {
  const text = plain(log);
  const start = text.indexOf("✖ failing tests:");
  if (start < 0) return [];
  // The report above the summary shows each failed test again, indented under its parents' ▶ lines.
  const report = text.slice(0, start).split("\n").map(line => line.trimEnd());
  const names = [...text.slice(start).matchAll(/^(?:test at (.+):\d+:\d+\s*\n)?(✖ (.+?) \([\d.]+ms\))\s*$/gmu)].map(([, file, result, name]) => {
    const parents = [];
    for (const line of report) {
      const depth = (line.length - line.trimStart().length) / 2;
      if (line.trimStart().startsWith("▶ ")) parents[depth] = line.trimStart().slice(2);
      else if (file && line.trimStart() === result) return `${file.replaceAll("\\", "/")} › ${[...parents.slice(0, depth), name].join(" > ")}`;
    }
    return name;
  });
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

const recordLines = path => read(path).split(/\r?\n/u).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });

/** The tests the vitest reporter recorded in `path`: { test, flaky, failed, passed, seconds }. */
export const readTestRecord = path => recordLines(path).filter(line => typeof line?.test === "string");

/** How the recorded vitest run ended: { run, outside }, with `outside` counting the errors no test owns. Null when it never ended. */
export const recordedRun = path => recordLines(path).findLast(line => typeof line?.run === "string") ?? null;

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

/**
 * Whether a spec report shows a failed test, named as nodeTestFailures names it,
 * passed when its rerun command ran it: its top-level test, or the tests of a file
 * that failed to load. node:test reports a file whose tests a pattern skipped as
 * a passed test named by the file, so that line is no pass.
 */
export function nodeTestPassed(log, test) {
  const at = test.indexOf(" › ");
  const file = test.slice(0, at), name = test.slice(at + 3);
  const passed = nodeTestTimes(log).map(row => row.test);
  return name.replaceAll("\\", "/") === file ? passed.some(row => row.replaceAll("\\", "/") !== file) : passed.includes(name.split(" > ")[0]);
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

// A pattern that matches `text`, written inside double quotes. A backslash there
// reaches the runner unchanged in bash, PowerShell, and cmd, so it escapes the
// regular expression syntax. Some characters cannot be written the same way in
// every shell: bash and PowerShell expand `$`, PowerShell escapes with the
// backtick, bash reads `\\` as one backslash, and cmd expands `%` and, with
// delayed expansion, `!`. Those, `"`, and characters outside ASCII, whose
// encoding depends on the shell, match as `.`, one per UTF-16 unit as the
// runners read them.
const literally = text => text.replace(/([[\](){}*+?.^|])|[^ -~]|[$"`\\%!]/g, (character, syntax) => syntax ? `\\${syntax}` : ".");

/**
 * The command that reruns one failed test from the repository root, with the
 * gate's builds in place, or null when no command reruns that test alone.
 * vitest and node:test pass when a pattern matches no test, so each pattern
 * matches the whole recorded name.
 */
export function rerunCommand(row) {
  const { step, test } = row ?? {};
  if (typeof step !== "string" || typeof test !== "string") return null;
  if (step === "rust") {
    // nextest names a test by its binary, then its path. The focused Rust runner reuses the gate's test build and budget.
    const [, binary, path] = test.match(/^([\w:/.-]+) ([\w:]+)$/u) ?? [];
    // A reader regression is ignored and needs a staged reader, which the gate's reader phase provides.
    if (binary === "dohc-engine-collab" && READER_TESTS.includes(path)) return "node tools/rust-engine-program/reader-tests.mjs";
    return binary ? `node tools/rust-engine-program/run-rust-profile.mjs rerun -- --filter-expr "binary_id(=${binary}) & test(=${path})"` : null;
  }
  const at = test.indexOf(" › ");
  const file = test.slice(0, at), name = test.slice(at + 3);
  if (at < 0 || !/^[\w./-]+$/u.test(file)) return null;
  // Playwright matches a test by its file, its title, then its tags.
  const title = `"(^| )${literally(file)} ${literally(name)}( @\\S+)*$"`;
  if (step === "desktop") return `pnpm qa:e2e -- ${file} --grep ${title}`;
  if (step === "accounts") return `node apps/desktop/scripts/run-playwright.mjs --config services/workspace-api/playwright.config.ts ${file} --grep ${title}`;
  // vitest matches a test's suites and name joined by spaces, and a name can contain " > ".
  if (step.startsWith("@dohc/")) return `pnpm --filter ${step} exec vitest run ${file} -t "^${name.split(" > ").map(literally).join(" (> )?")}$"`;
  // node:test runs a subtest only inside its top-level test, whose own name can contain " > ".
  // A file that failed to load runs whole.
  const pattern = name.replaceAll("\\", "/") === file ? "" : ` --test-name-pattern "^${literally(name.split(" > ")[0])}( > |$)"`;
  const nodeTest = `node${file.endsWith(".ts") ? " --experimental-transform-types" : ""} --test${pattern} ${file}`;
  if (step === "repository") return nodeTest;
  if (step === "desktop-scripts" || step === "desktop-runtime-packaging") return `pnpm --filter @dohc/desktop exec ${nodeTest}`;
  return null;
}

/** The slowest rows, longest first. */
export const slowest = (rows, count = slowestKept) => rows.toSorted((a, b) => b.seconds - a.seconds).slice(0, count)
  .map(row => ({ ...row, seconds: Math.round(row.seconds * 10) / 10 }));
