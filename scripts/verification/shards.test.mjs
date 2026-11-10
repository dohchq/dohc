import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertTaskCoverage, javascriptGroups, nativeTestFiles, partitionJavascript, partitionTasks } from "./shards.mjs";
import { aggregateJavascript, aggregateRust, waitForGate } from "./cloud-aggregate.mjs";
import { JS_SHARDS } from "./cloud.mjs";
import { RUST_ARCHIVE_PROOFS, RUST_POLICY_STEPS, RUST_SHARDS, RUST_TEST_PROOFS, passedRustTests, rustTestInventory } from "./cloud-rust.mjs";
import { waitForPreparation } from "./wait-preparation.mjs";
import { runVitestGroup } from "./vitest-group.mjs";

test("early reporting waits for every successful job and preserves the complete group deadline", async () => {
  const started_at = "2026-11-10T00:00:00Z", start = Date.parse(started_at);
  const names = ["what changed", "confinement", "JS shared preparation", ...Array.from({ length: JS_SHARDS - 1 }, (_, i) => `JS worker ${i + 1}`)];
  const complete = names.map(name => ({ name, started_at, status: "completed", conclusion: "success" }));
  let reads = 0, pauses = 0;
  await waitForGate("js", { now: () => start + 1000, pause: async () => { pauses++; }, readJobs: async () => {
    reads++;
    return reads === 1 ? complete.slice(0, -1) : reads === 2
      ? complete.map(row => row.name === "JS worker 1" ? { ...row, status: "in_progress", conclusion: null } : row) : complete;
  } });
  assert.equal(pauses, 2);
  for (const conclusion of ["failure", "cancelled", "skipped"]) {
    await assert.rejects(waitForGate("js", { now: () => start + 1000,
      readJobs: async () => complete.map(row => row.name === "JS worker 1" ? { ...row, conclusion } : row) }), /did not finish successfully/);
  }
  await assert.rejects(waitForGate("js", { now: () => start + 291_000, readJobs: async () => complete }), /no time left/);
  await assert.rejects(waitForGate("js", { now: () => start, readJobs: async () => [...complete, complete[1]] }), /Duplicate/);
});

test("native results retain declared opt-in skips but reject runtime skips and missing engines", async t => {
  const parent = resolve(".agent-artifacts/verification/native-report-tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "vitest.config.mjs"), "export default {test:{include:['*.test.mjs'],fileParallelism:false}};");
  const engineGate = pathToFileURL(resolve("apps/desktop/src/testing/engineBinary.ts")).href;
  const fixtures = {
    "pass": "import {it,expect} from 'vitest'; it('runs the native case',()=>expect(2+2).toBe(4));",
    "opt-in": "import {it} from 'vitest'; it.skip('manual benchmark',()=>{throw Error('must remain opt-in')});",
    "runtime-skip": "import {it} from 'vitest'; it('passes',()=>{}); it('required case',context=>context.skip());",
    "missing-engine": `import {it,vi} from 'vitest'; import {requireEngineBinaryOrSkip} from ${JSON.stringify(engineGate)};
      vi.stubEnv('DOHC_TEST_ENGINE_BINARY', ${JSON.stringify(join(root, "missing-engine"))});
      vi.stubEnv('DOHC_REQUIRE_ENGINE_E2E','1'); requireEngineBinaryOrSkip(); it.skip('native case',()=>{});`,
  };
  const tasks = Object.entries(fixtures).map(([name, source]) => {
    const file = relative(process.cwd(), join(root, `${name}.test.mjs`)).replaceAll("\\", "/");
    writeFileSync(resolve(file), source);
    return { id: `vitest:proof::${file}`, package: "proof", cwd: relative(process.cwd(), root), script: "vitest run", native: true };
  });
  const record = { tests: [], completed: [] }, originalExitCode = process.exitCode;
  try { await assert.rejects(runVitestGroup(tasks, record, () => {})); }
  finally { process.exitCode = originalExitCode; }
  assert.deepEqual(record.completed.sort(), tasks.slice(0, 2).map(task => task.id).sort());
  assert.equal(record.tests.find(row => row.id === tasks[1].id).skipped, 1);
  assert.match(JSON.stringify(record.tests.find(row => row.id === tasks[3].id).errors), /DOHC_REQUIRE_ENGINE_E2E/u);
});

test("shards cover every task once, including uneven and small workloads", () => {
  for (const count of [1, 3, 8]) for (const size of [1, 3, 31]) {
    const tasks = Array.from({ length: size }, (_, index) => ({ id: `task-${index}`, weight: index + 1 }));
    const shards = partitionTasks(tasks, count);
    assert.deepEqual(shards, partitionTasks(tasks.toReversed(), count));
    const records = shards.map((tasks, part) => ({ part, verdict: "PASS", completed: tasks.map(task => task.id) }));
    assertTaskCoverage(tasks, records);
    assert.throws(() => assertTaskCoverage(tasks, records.map(row => ({ ...row, completed: [] }))), /did not finish/u);
    assert.throws(() => assertTaskCoverage(tasks, [...records, records.find(row => row.completed.length)]), /repeated/u);
    assert.throws(() => assertTaskCoverage(tasks, records.map(row => ({ ...row, verdict: "FAIL" }))), /did not pass/u);
  }
});

test("native fixture dependencies propagate through helpers and cycles", () => {
  const graph = new Map([
    ["native-test", ["helper"]], ["helper", ["cycle", "engine"]], ["cycle", ["helper"]],
    ["pure-test", ["pure-helper"]], ["pure-helper", []], ["engine", []],
  ]);
  assert.deepEqual(nativeTestFiles(["native-test", "pure-test"], { dependencies: file => graph.get(file), roots: ["engine"] }), new Set(["native-test"]));
});

test("execution groups preserve files, projects, native prerequisites, and command tasks", () => {
  const files = Array.from({ length: 30 }, (_, index) => ({ id: `file-${index}`, kind: "vitest", package: index % 2 ? "@dohc/workspace-api" : "desktop",
    project: index % 3 ? "node" : "dom", native: index % 4 === 0, weight: index + 1 }));
  const tasks = [...files, { id: "typecheck", kind: "command", weight: 100 }];
  const groups = javascriptGroups(tasks);
  for (const group of groups.filter(group => group.kind === "vitest")) {
    assert.equal(new Set(group.tasks.map(task => task.package)).size, 1);
    assert.equal(new Set(group.tasks.map(task => task.project)).size, 1);
    assert.equal(new Set(group.tasks.map(task => task.native)).size, 1);
    assert.equal(group.native, group.tasks[0].native);
    assert.equal(group.resource === "postgres", group.pkg === "@dohc/workspace-api");
  }
  assert.deepEqual(javascriptGroups(tasks.toReversed()), groups);
  assertTaskCoverage(tasks, partitionTasks(groups, JS_SHARDS).map((groups, part) => ({ part, verdict: "PASS", completed: groups.flatMap(group => group.tasks.map(task => task.id)) })));
});

test("native preparation does not leave one worker with most of the native work", () => {
  const groups = [false, true].flatMap(native => [90, 70, 50, 30].map((weight, index) => ({ id: `${native}-${index}`, native, weight })));
  const shards = partitionJavascript(groups, 2);
  for (const native of [false, true]) {
    assert.deepEqual(shards.map(shard => shard.filter(group => group.native === native).reduce((total, group) => total + group.weight, 0)), [120, 120]);
  }
  assertTaskCoverage(groups, shards.map((shard, part) => ({ part, verdict: "PASS", completed: shard.map(group => group.id) })));
});

test("JavaScript receipts reject missing, failed, duplicated, or different-head work", () => {
  const records = [{ part: "prepare-0", commit: "head", verdict: "PASS" }];
  for (let index = 0; index < JS_SHARDS; index++) records.push({
    part: `worker-${index}`, commit: "head", verdict: "PASS", planned: Array.from({ length: JS_SHARDS }, (_, id) => `task-${id}`),
    assigned: [`task-${index}`], completed: [`task-${index}`], tests: [], ...(!index ? { selfHostNative: {} } : {}),
  });
  assert.equal(aggregateJavascript(records).tasks, JS_SHARDS);
  for (const mutate of [
    rows => rows.pop(), rows => { rows[1].completed = []; }, rows => { rows[1].verdict = "FAIL"; },
    rows => { rows[1].commit = "other"; }, rows => { rows[1].planned.push("forgotten"); }, rows => rows.push(rows[1]),
    rows => rows.push({ part: "unexpected", commit: "head", verdict: "FAIL" }),
  ]) {
    const broken = structuredClone(records); mutate(broken);
    assert.throws(() => aggregateJavascript(broken));
  }
});

test("Rust receipts require every policy row and exactly the full passing test inventory", () => {
  const steps = RUST_POLICY_STEPS.map(name => ({ name, status: "PASS" }));
  const all = Array.from({ length: RUST_SHARDS }, (_, index) => `crate test${index}`);
  const row = (part, extra = {}) => ({ part, commit: "head", verdict: "PASS", provenance: { status: "PASS" }, ...extra });
  const archiveSteps = RUST_ARCHIVE_PROOFS.map(name => ({ name, verdict: "PASS" }));
  const records = [row("policy", { steps }), row("archive-0", { planned: all, steps: archiveSteps, scratch: { status: "PASS" } }), ...all.map((id, index) => row(`tests-${index}`, {
    planned: all, assigned: [id], completed: [id], scratch: { status: "PASS" }, steps: index === 0 ? RUST_TEST_PROOFS.map(name => ({ name, verdict: "PASS" })) : [],
  }))];
  assert.equal(aggregateRust(records).tasks, RUST_SHARDS);
  for (const mutate of [
    rows => { rows[0].steps.pop(); }, rows => { rows[0].steps[0].status = "SKIP"; }, rows => { rows[2].completed = []; },
    rows => { rows[2].completed.push(rows[3].completed[0]); }, rows => { rows[2].scratch.status = "FAIL"; }, rows => { rows[2].provenance.status = "FAIL"; },
    rows => { rows[1].planned.push("unrun"); }, rows => { rows[1].commit = "other"; }, rows => rows.pop(),
    rows => { rows[1].steps.pop(); }, rows => { rows[1].steps[0].verdict = "FAIL"; }, rows => { rows[1].scratch.status = "FAIL"; },
    rows => { rows[2].steps = []; }, rows => { rows[2].steps[0].verdict = "FAIL"; },
    rows => { rows[3].steps = structuredClone(rows[2].steps); },
    rows => { rows[3].steps = rows[2].steps; rows[2].steps = []; },
  ]) {
    const broken = structuredClone(records); mutate(broken);
    assert.throws(() => aggregateRust(broken));
  }
});

test("Rust inventory retains selected ordinary tests and counts only actual passes", () => {
  const tests = { "rust-suites": { crate: { testcases: {
    retained: { ignored: false, "filter-match": { status: "matches" } },
    ignored: { ignored: true, "filter-match": { status: "matches" } },
    otherShard: { ignored: false, "filter-match": { status: "mismatch" } },
  } } } };
  assert.deepEqual(rustTestInventory(tests), [{ id: "crate retained" }]);
  assert.deepEqual(passedRustTests("PASS [ 0.1s] (1/2) crate retained\nFAIL [ 0.2s] crate broken\nFLAKY 2/2 [ 0.1s] crate retry"), ["crate retained"]);
});

test("shared preparation waits for this attempt and keeps the original group deadline", async () => {
  const env = { GITHUB_API_URL: "https://api.example.test", GITHUB_REPOSITORY: "test/repo", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "2", GITHUB_TOKEN: "fixture" };
  const started = Date.parse("2026-11-09T00:00:00Z");
  let clock = started + 10_000, reads = 0;
  const jobs = [{ name: "what changed", started_at: new Date(started).toISOString() }, { name: "JS shared preparation", status: "in_progress" }];
  const response = value => ({ ok: true, json: async () => value });
  await waitForPreparation("js", { env, now: () => clock, pause: async ms => { clock += ms; }, request: async url => {
    reads++;
    return response(url.includes("/jobs?") ? { jobs } : { artifacts: reads < 4 ? [] : [{ name: "javascript-prepared-2", expired: false }] });
  } });
  assert.equal(reads, 4);
  assert.equal(clock, started + 20_000);
  clock = started + 299_000;
  await assert.rejects(waitForPreparation("js", { env, now: () => clock, pause: async ms => { clock += ms; },
    request: async url => response(url.includes("/jobs?") ? { jobs } : { artifacts: [{ name: "javascript-prepared-1", expired: false }] }),
  }), /exceeded.*300s/u);
  await assert.rejects(waitForPreparation("js", { env, now: () => started + 1000, request: async () => response({
    jobs: [jobs[0], { ...jobs[1], status: "completed", conclusion: "failure" }],
  }) }), /ended with failure/u);
});
