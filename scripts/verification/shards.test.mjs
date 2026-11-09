import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertTaskCoverage, nativeTestFiles, partitionTasks } from "./shards.mjs";
import { aggregateJavascript, aggregateRust } from "./cloud-aggregate.mjs";
import { JS_SHARDS } from "./cloud.mjs";
import { RUST_ARCHIVE_PROOFS, RUST_POLICY_STEPS, RUST_SHARDS, passedRustTests, rustTestInventory } from "./cloud-rust.mjs";
import { runVitestGroup } from "./vitest-group.mjs";

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

test("JavaScript receipts reject missing, failed, duplicated, or different-head work", () => {
  const records = [{ part: "prepare-0", commit: "head", verdict: "PASS" }];
  for (const part of ["pure", "native"]) for (let index = 0; index < JS_SHARDS; index++) records.push({
    part: `${part}-${index}`, commit: "head", verdict: "PASS", planned: Array.from({ length: JS_SHARDS }, (_, id) => `${part}-${id}`),
    assigned: [`${part}-${index}`], completed: [`${part}-${index}`], tests: [], ...(part === "native" && !index ? { selfHostNative: {} } : {}),
  });
  assert.equal(aggregateJavascript(records).tasks, JS_SHARDS * 2);
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
    planned: all, assigned: [id], completed: [id], scratch: { status: "PASS" },
  }))];
  assert.equal(aggregateRust(records).tasks, RUST_SHARDS);
  for (const mutate of [
    rows => { rows[0].steps.pop(); }, rows => { rows[0].steps[0].status = "SKIP"; }, rows => { rows[2].completed = []; },
    rows => { rows[2].completed.push(rows[3].completed[0]); }, rows => { rows[2].scratch.status = "FAIL"; }, rows => { rows[2].provenance.status = "FAIL"; },
    rows => { rows[1].planned.push("unrun"); }, rows => { rows[1].commit = "other"; }, rows => rows.pop(),
    rows => { rows[1].steps.pop(); }, rows => { rows[1].steps[0].verdict = "FAIL"; }, rows => { rows[1].scratch.status = "FAIL"; },
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
