import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertTaskCoverage, javascriptGroups, javascriptTasks, nativeTestFiles, partitionJavascript, partitionTasks, preparedArtifactPaths } from "./shards.mjs";
import { readWorkspacePackages } from "./selection.mjs";
import { CLOUD_JOB_GRAPH, aggregateCloud, aggregateJavascript, aggregateRust, completedGateTiming, verifyCompletedCloud, waitForGate } from "./cloud-aggregate.mjs";
import { JS_SHARDS } from "./cloud.mjs";
import { RUST_ARCHIVE_PROOFS, RUST_POLICY_STEPS, RUST_READER_SHARD, RUST_SHARDS, RUST_TEST_PROOFS, passedRustTests, rustTestInventory } from "./cloud-rust.mjs";
import { waitForPreparation } from "./wait-preparation.mjs";
import { cloudApi } from "./cloud-api.mjs";
import { runVitestGroup } from "./vitest-group.mjs";

// A successful group wait records when it ended. These tests keep that record out of the checkout.
const waitOutput = mkdtempSync(join(tmpdir(), "gate-wait-"));
process.on("exit", () => rmSync(waitOutput, { recursive: true, force: true }));

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

test("package typechecks stay complete when changed files select no package tests", async () => {
  const packages = readWorkspacePackages(process.cwd()).filter(pkg => pkg.manifest.scripts?.typecheck);
  const tasks = await javascriptTasks({ changed: ["docs/guide.md"], proofs: false });
  const typechecks = tasks.filter(task => task.id.startsWith("typecheck:"));
  assert.deepEqual(typechecks.map(task => task.id).sort(), packages.map(pkg => `typecheck:${pkg.name}`).sort());
  assert.ok(!tasks.some(task => task.id === "typecheck"));
  for (const pkg of packages) {
    const task = typechecks.find(task => task.id === `typecheck:${pkg.name}`);
    assert.equal(task.cwd, pkg.path);
    assert.equal(task.command, "pnpm");
    assert.deepEqual(task.args, ["run", "typecheck"]);
    assert.ok(!task.native);
  }
  const mobile = typechecks.find(task => task.id === "typecheck:@dohc/mobile");
  const groups = javascriptGroups([mobile, { id: "mobile-test", kind: "vitest", package: "@dohc/mobile", weight: 1 }]);
  assert.ok(groups[0].resource);
  assert.equal(groups[0].resource, groups[1].resource);
});

test("native fixture dependencies propagate through helpers and cycles", () => {
  const graph = new Map([
    ["native-test", ["helper"]], ["helper", ["cycle", "engine"]], ["cycle", ["helper"]],
    ["pure-test", ["pure-helper"]], ["pure-helper", []], ["engine", []],
  ]);
  assert.deepEqual(nativeTestFiles(["native-test", "pure-test"], { dependencies: file => graph.get(file), roots: ["engine"] }), new Set(["native-test"]));
});

test("prepared artifact references keep tests and their helpers behind restoration", t => {
  const parent = resolve(".agent-artifacts/verification/prepared-readers");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workflow = readFileSync(resolve(".github/workflows/pr-checks.yml"), "utf8");
  const pack = workflow.match(/- name: Pack prepared artifacts\s+run: >-\s+([\s\S]*?)(?=\r?\n      -)/u)[1];
  const paths = pack.trim().split(/\s+/u).slice(pack.trim().split(/\s+/u).indexOf("/tmp/javascript-prepared.tar.zst") + 1);
  assert.deepEqual(new Set(paths), new Set(preparedArtifactPaths));
  const expected = [];
  for (const [index, path] of paths.entries()) {
    for (const [style, expression] of Object.entries({
      literal: `join(repoRoot, ${JSON.stringify(path)})`,
      joined: `join(repoRoot, ${path.split("/").map(part => JSON.stringify(part)).join(", ")})`,
      relative: `new URL(${JSON.stringify(relative(root, resolve(path)).replaceAll("\\", "/"))}, import.meta.url)`,
      template: '`${repoRoot}/' + path + '`',
    })) {
      const file = join(root, `${index}-${style}.test.mjs`);
      writeFileSync(file, `statSync(${expression});`);
      expected.push(file);
    }
  }
  for (const name of ["DOHC_TEST_ENGINE_BINARY", "DOHC_TEST_RELAY_MAIN"]) {
    const helper = join(root, `${name}.mjs`), file = join(root, `${name}.test.mjs`);
    writeFileSync(helper, `export const path = process.env.${name};`);
    writeFileSync(file, `import {path} from './${name}.mjs'; statSync(path);`);
    expected.push(file);
  }
  const pure = join(root, "pure.test.mjs");
  writeFileSync(pure, `statSync(join(scratch, 'dist')); statSync(new URL('../packages/app-backend-runtime/dist', import.meta.url));`);
  assert.deepEqual(nativeTestFiles([...expected, pure]), new Set(expected));
});

test("prepared artifact readers include the share-web dist fingerprint regression", () => {
  const file = resolve("services/share-web/src/deviceControl.integration.test.ts");
  assert.ok(nativeTestFiles([file]).has(file));
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

test("only browser groups reserve two slots and double their partition cost", () => {
  const tasks = ["desktop", "accounts", "self-host-native", "command"].map(kind => ({id:kind, kind, weight:20, native:true}));
  const files = [{id:"file", kind:"vitest", package:"example", weight:20}];
  const groups = javascriptGroups([...tasks, ...files]);
  for (const task of tasks) {
    const group = groups.find(group => group.id === task.id);
    assert.equal(group.weight, ["desktop", "accounts"].includes(task.kind) ? 40 : 20);
    assert.equal(group.slots, ["desktop", "accounts"].includes(task.kind) ? 2 : undefined);
    assert.equal(task.weight, 20);
  }
  const vitest = groups.find(group => group.kind === "vitest");
  assert.equal(vitest.weight, 24);
  assert.equal(vitest.slots, undefined);
  assert.deepEqual(partitionTasks(groups.filter(group => group.kind !== "vitest"), 2)
    .map(shard => shard.reduce((n, group) => n + group.weight, 0)), [60, 60]);
});

test("JavaScript receipts reject missing, failed, duplicated, or different-head work", () => {
  const records = [{ part: "prepare-0", commit: "head", verdict: "PASS" }];
  for (let index = 0; index < JS_SHARDS; index++) records.push({
    part: `worker-${index}`, commit: "head", verdict: "PASS", planned: Array.from({ length: JS_SHARDS }, (_, id) => `task-${id}`),
    assigned: [`task-${index}`], completed: [`task-${index}`], tests: [], ...(!index ? { selfHostNative: {} } : {}),
  });
  assert.equal(aggregateJavascript(records).tasks, JS_SHARDS);
  assert.throws(() => aggregateJavascript(records.slice(1)), {
    message: "The JavaScript preparation receipt is missing, duplicated, or unsuccessful; check preparation and worker jobs.",
  });
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
    planned: all, assigned: [id], completed: [id], scratch: { status: "PASS" }, steps: index === RUST_READER_SHARD ? RUST_TEST_PROOFS.map(name => ({ name, verdict: "PASS" })) : [],
  }))];
  assert.equal(aggregateRust(records).tasks, RUST_SHARDS);
  for (const mutate of [
    rows => { rows[0].steps.pop(); }, rows => { rows[0].steps[0].status = "SKIP"; }, rows => { rows[2].completed = []; },
    rows => { rows[2].completed.push(rows[3].completed[0]); }, rows => { rows[2].scratch.status = "FAIL"; }, rows => { rows[2].provenance.status = "FAIL"; },
    rows => { rows[1].planned.push("unrun"); }, rows => { rows[1].commit = "other"; }, rows => rows.pop(),
    rows => { rows[1].steps.pop(); }, rows => { rows[1].steps[0].verdict = "FAIL"; }, rows => { rows[1].scratch.status = "FAIL"; },
    rows => { rows[RUST_READER_SHARD + 2].steps = []; }, rows => { rows[RUST_READER_SHARD + 2].steps[0].verdict = "FAIL"; },
    rows => { rows[2].steps = structuredClone(rows[RUST_READER_SHARD + 2].steps); },
    rows => { rows[1].steps.push(...structuredClone(rows[RUST_READER_SHARD + 2].steps)); },
    rows => { rows[2].steps = rows[RUST_READER_SHARD + 2].steps; rows[RUST_READER_SHARD + 2].steps = []; },
  ]) {
    const broken = structuredClone(records); mutate(broken);
    assert.throws(() => aggregateRust(broken));
  }
});

test("reader proofs fit beside the lightest measured partition", () => {
  // Run 43196624375 execution times, excluding setup and transfer.
  const ordinary = [109.688, 60.09, 91.792, 78.737, 118.796, 88.909, 102.22, 105.92, 82.694, 101.816,
    94.654, 122.536, 94.212, 83.972, 76.527, 79.268, 98.246, 98.599, 103.154, 91.983];
  const reader = 53.275;
  assert.equal(ordinary.length, RUST_SHARDS);
  assert.equal(RUST_READER_SHARD, ordinary.indexOf(Math.min(...ordinary)));
  assert.ok(ordinary[RUST_READER_SHARD] + reader <= Math.max(...ordinary), "reader proofs must fit within the longest ordinary partition");
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

function passingCloudJobs() {
  const { jobs } = JSON.parse(readFileSync(new URL("./fixtures/passing-cloud-jobs.json", import.meta.url), "utf8"));
  // Split the saved combined job at its artifact publication and proof start.
  const prepared = jobs.find(job => job.name === "shared preparation + confinement");
  prepared.name = "shared preparation";
  jobs.push({ ...prepared, name: "compiler confinement", created_at: "2026-11-11T13:06:40Z", started_at: "2026-11-11T13:06:40Z" });
  jobs.push({ ...jobs.at(-1), name: "relay confinement", completed_at: "2026-11-11T13:07:00Z" });
  prepared.completed_at = "2026-11-11T13:06:40Z";
  // Extend the historical topology with copies of an existing worker's timing.
  for (const [prefix, count] of [["JS worker", JS_SHARDS], ["Rust tests", RUST_SHARDS]]) {
    const workers = jobs.filter(job => job.name.startsWith(`${prefix} `));
    for (let part = workers.length + 1; part < count; part++) {
      jobs.push({ ...workers[0], name: `${prefix} ${part}` });
    }
  }
  return jobs;
}

const apiEnv = { GITHUB_API_URL: "https://api.example.test", GITHUB_REPOSITORY: "test/repo", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "2", GITHUB_TOKEN: "fixture" };
const apiResponse = (value, status = 200, etag = '"fixture"') => new Response(status === 304 ? null : JSON.stringify(value), {
  status, headers: { etag, "x-ratelimit-limit": "1000", "x-ratelimit-remaining": "997", "x-ratelimit-used": "3" },
});
const withoutWaits = () => passingCloudJobs().map(job => ({ ...job, created_at: job.started_at }));

test("the timing fixture covers every current workflow job name exactly once", () => {
  const expected = Object.values(CLOUD_JOB_GRAPH).flatMap(job => job.names).sort();
  assert.deepEqual(passingCloudJobs().filter(job => expected.includes(job.name)).map(job => job.name).sort(), expected);
});

test("the saved passing run includes both confinement jobs in the gate span", () => {
  const jobs = passingCloudJobs();
  for (const [scope, seconds] of [["js", 241], ["rust", 419]]) {
    const result = completedGateTiming(scope, jobs, jobs[0].head_sha);
    assert.equal(result.spanSeconds, seconds);
    assert.equal("confinementSeconds" in result, false);
    assert.equal(result.seconds, seconds);
    assert.equal(result.contended, false);
    assert.equal(result.timing, "within budget");
    assert.ok(result.jobs.every(job => Number.isFinite(job.runnerWaitSeconds)));
  }
  const relay = jobs.find(job => job.name === "relay confinement");
  relay.completed_at = new Date(Date.parse(relay.started_at) + 90_000).toISOString();
  assert.equal(completedGateTiming("js", jobs, jobs[0].head_sha).seconds, 242, "the last proof job sets the span");
});

test("uncontended ceiling overruns fail; contended overruns retain their measured span", t => {
  const warn = t.mock.method(console, "warn", () => {});
  for (const [scope, finalJob, budget] of [["js", "typecheck + tests", 400], ["rust", "engine gate", 700]]) {
    const jobs = withoutWaits(), start = Date.parse(jobs[0].started_at);
    const last = jobs.find(job => job.name === finalJob);
    last.completed_at = new Date(start + (budget + 50) * 1000).toISOString();
    assert.throws(() => completedGateTiming(scope, jobs, jobs[0].head_sha), error => {
      assert.equal(error.timing.seconds, budget + 50);
      assert.equal(error.timing.timing, "over budget");
      return /exceeding.*budget/u.test(error.message);
    });
    last.created_at = new Date(Date.parse(last.started_at) - 30_000).toISOString();
    assert.throws(() => completedGateTiming(scope, jobs, jobs[0].head_sha), /exceeding/u, "30 seconds does not count as contention");
    last.created_at = new Date(Date.parse(last.started_at) - 31_000).toISOString();
    const result = completedGateTiming(scope, jobs, jobs[0].head_sha);
    assert.equal(result.contended, true);
    assert.equal(result.timing, "unmeasured");
    assert.match(result.warning, new RegExp(`${budget + 50}s.*${budget - 100}s.*${finalJob.replaceAll("+", "\\+")}.*31s`, "u"));
    last.completed_at = new Date(start + (budget - 100) * 1000).toISOString();
    const within = completedGateTiming(scope, jobs, jobs[0].head_sha);
    assert.equal(within.contended, true);
    assert.equal(within.timing, "within budget");
    assert.equal(within.warning, undefined);
  }
  assert.equal(warn.mock.calls.length, 0, "timing classification leaves warning emission to final verification");
});

test("confinement execution uses the wall span and its runner wait counts as contention", t => {
  t.mock.method(console, "warn", () => {});
  for (const name of ["compiler confinement", "relay confinement"]) for (const scope of ["js", "rust"]) {
    const jobs = withoutWaits(), proof = jobs.find(job => job.name === name);
    proof.completed_at = new Date(Date.parse(jobs[0].started_at) + 750_000).toISOString();
    assert.throws(() => completedGateTiming(scope, jobs, jobs[0].head_sha), error => {
      assert.equal(error.timing.seconds, 750);
      assert.equal(error.timing.contended, false);
      return /exceeding/u.test(error.message);
    });
    proof.started_at = new Date(Date.parse(proof.started_at) + 7_200_000).toISOString();
    proof.completed_at = new Date(Date.parse(proof.completed_at) + 7_200_000).toISOString();
    const result = completedGateTiming(scope, jobs, jobs[0].head_sha);
    assert.equal(result.seconds, 7950);
    assert.equal(result.spanSeconds, result.seconds);
    assert.equal(result.contended, true);
    assert.equal(result.timing, "unmeasured");
    assert.ok(result.warning.includes(name));
  }
});

test("confinement runner waits count only after preparation has finished", t => {
  t.mock.method(console, "warn", () => {});
  for (const scope of ["js", "rust"]) for (const name of ["compiler confinement", "relay confinement"]) {
    for (const offset of [-1000, 0, 1000]) {
      const jobs = withoutWaits(), proof = jobs.find(job => job.name === name);
      const preparedAt = Date.parse(jobs.find(job => job.name === "shared preparation").completed_at);
      proof.started_at = new Date(preparedAt + offset).toISOString();
      proof.created_at = new Date(preparedAt + offset - 35_000).toISOString();
      proof.completed_at = new Date(Date.parse(jobs[0].started_at) + 750_000).toISOString();
      if (offset <= 0) {
        assert.throws(() => completedGateTiming(scope, jobs, jobs[0].head_sha), error => {
          assert.equal(error.timing.contended, false);
          assert.equal(error.timing.timing, "over budget");
          assert.equal(error.timing.jobs.find(job => job.name === name).runnerWaitSeconds, 35);
          return /exceeding/u.test(error.message);
        });
        const otherName = scope === "js" ? "JS worker 1" : "Rust tests 1";
        const other = jobs.find(job => job.name === otherName);
        other.created_at = new Date(Date.parse(other.started_at) - 31_000).toISOString();
        const result = completedGateTiming(scope, jobs, jobs[0].head_sha);
        assert.equal(result.timing, "unmeasured");
        assert.match(result.warning, new RegExp(`longest runner wait ${otherName}: 31s`, "u"));
      } else {
        const result = completedGateTiming(scope, jobs, jobs[0].head_sha);
        assert.equal(result.contended, true);
        assert.equal(result.timing, "unmeasured");
        assert.match(result.warning, new RegExp(`longest runner wait ${name}: 35s`, "u"));
      }
    }
  }
});

test("a failed JavaScript worker leaves Rust's independent verdict visible", () => {
  const jobs = passingCloudJobs();
  jobs.find(job => job.name === "JS worker 1").conclusion = "failure";
  assert.throws(() => completedGateTiming("js", jobs, jobs[0].head_sha), /unsuccessful/u);
  assert.equal(completedGateTiming("rust", jobs, jobs[0].head_sha).timing, "within budget");
  const last = jobs.find(job => job.name === "engine gate");
  last.completed_at = new Date(Date.parse(jobs[0].started_at) + 750_000).toISOString();
  assert.throws(() => completedGateTiming("rust", jobs, jobs[0].head_sha), /exceeding/u);
});

test("contention counts only waits that can occur inside the gate span", t => {
  t.mock.method(console, "warn", () => {});
  const jobs = withoutWaits(), start = Date.parse(jobs[0].started_at);
  jobs[0].created_at = new Date(start - 31_000).toISOString();
  jobs.find(job => job.name === "typecheck + tests").completed_at = new Date(start + 450_000).toISOString();
  assert.throws(() => completedGateTiming("js", jobs, jobs[0].head_sha), /exceeding/u);
  jobs.find(job => job.name === "engine gate").completed_at = new Date(start + 750_000).toISOString();
  assert.throws(() => completedGateTiming("rust", jobs, jobs[0].head_sha), /exceeding/u);
  const reporting = jobs.find(job => job.name === "typecheck + tests");
  reporting.created_at = new Date(Date.parse(reporting.started_at) - 300_000).toISOString();
  assert.throws(() => completedGateTiming("rust", jobs, jobs[0].head_sha), /exceeding/u, "Rust does not wait for JS reporting");
  const js = jobs.find(job => job.name === "JS worker 1");
  js.created_at = new Date(Date.parse(js.started_at) - 300_000).toISOString();
  js.conclusion = "failure";
  const rust = completedGateTiming("rust", jobs, jobs[0].head_sha);
  assert.equal(rust.timing, "unmeasured");
  assert.match(rust.warning, /JS worker 1: 300s/u);
  for (const absent of [false, true]) {
    const onlyRust = withoutWaits().filter(job => !absent || !/^JS worker|^typecheck \+ tests$/u.test(job.name));
    for (const job of onlyRust.filter(job => /^JS worker|^typecheck \+ tests$/u.test(job.name))) {
      Object.assign(job, { conclusion: "skipped", started_at: null, completed_at: null });
    }
    assert.equal(completedGateTiming("rust", onlyRust, jobs[0].head_sha).timing, "within budget");
  }
});

test("negative waits clamp to zero and invalid or incomplete evidence always fails", () => {
  const jobs = withoutWaits();
  jobs.forEach(job => { job.created_at = job.completed_at; });
  assert.ok(completedGateTiming("js", jobs, jobs[0].head_sha).jobs.every(job => job.runnerWaitSeconds === 0));
  for (const scope of ["js", "rust"]) for (const mutate of [
    ...["compiler confinement", "relay confinement"].flatMap(name => [
      rows => rows.splice(rows.findIndex(job => job.name === name), 1),
      rows => rows.push(rows.find(job => job.name === name)),
      ...["cancelled", "failure", "skipped"].map(conclusion => rows => { rows.find(job => job.name === name).conclusion = conclusion; }),
      rows => { rows.find(job => job.name === name).head_sha = "other"; },
    ]),
    ...[scope === "js" ? `JS worker ${JS_SHARDS - 2}` : "Rust tests 1", scope === "js" ? `JS worker ${JS_SHARDS - 1}` : `Rust tests ${RUST_SHARDS - 1}`].flatMap(name => [
      rows => rows.splice(rows.findIndex(job => job.name === name), 1),
      rows => rows.push(rows.find(job => job.name === name)),
      rows => { rows.find(job => job.name === name).conclusion = "cancelled"; },
      rows => { rows.find(job => job.name === name).head_sha = "other"; },
    ]),
    rows => rows.push(rows.find(job => job.name === "shared preparation")),
    ...["cancelled", "failure", "skipped"].map(conclusion => rows => { rows.find(job => job.name === "compiler confinement").conclusion = conclusion; }),
    rows => { rows[0].head_sha = "other-head"; },
    rows => { rows[0].created_at = "invalid"; },
    rows => { rows[0].completed_at = rows[0].created_at; rows[0].started_at = "invalid"; },
  ]) {
    const broken = passingCloudJobs();
    const prepared = broken.find(job => job.name === "shared preparation");
    prepared.created_at = new Date(Date.parse(prepared.started_at) - 31_000).toISOString();
    mutate(broken);
    assert.throws(() => completedGateTiming(scope, broken, jobs[0].head_sha));
  }
});

test("prepared artifact body aborts get one fresh transfer inside the preparation cap", async t => {
  t.mock.method(console, "log", () => {});
  for (const failures of [0, 1, 2]) for (const kind of ["TimeoutError", "AbortError", "TypeError"]) {
    let clock = 0, downloads = 0;
    const cause = kind === "TypeError" ? new TypeError("terminated") : new DOMException("body aborted", kind);
    const result = waitForPreparation("js", { env: apiEnv, now: () => clock, pause: async () => assert.fail("no readiness pause for body aborts"),
      download: response => response.text(), request: async url => {
        if (url.includes("/jobs?")) return apiResponse({ jobs: [{ name: "shared preparation", status: "completed", conclusion: "success" }] });
        if (url.includes("/artifacts?")) return apiResponse({ artifacts: [{ id: 42, name: "javascript-prepared-2" }] });
        downloads++;
        return new Response(downloads > failures ? "complete archive" : new ReadableStream({ pull(controller) {
          clock += 60_000; controller.error(cause);
        } }, { highWaterMark: 0 }));
      } });
    if (failures === 2) await assert.rejects(result, error => {
      assert.equal(error.cause, cause);
      assert.equal(error.message, "Preparation artifact javascript-prepared-2 (42) body transfer failed after 120s (2 attempts).");
      return true;
    });
    else assert.equal((await result).value, "complete archive");
    assert.equal(downloads, failures === 0 ? 1 : 2);
  }
  let clock = 0, downloads = 0;
  await assert.rejects(waitForPreparation("js", { env: apiEnv, now: () => clock, download: response => response.text(), request: async url => {
    if (url.includes("/jobs?")) return apiResponse({ jobs: [{ name: "shared preparation", status: "in_progress" }] });
    if (url.includes("/artifacts?")) { clock = 850_000; return apiResponse({ artifacts: [{ id: 42, name: "javascript-prepared-2" }] }); }
    downloads++;
    return new Response(new ReadableStream({ pull(controller) { clock = 900_000; controller.error(new DOMException("body aborted", "TimeoutError")); } }, { highWaterMark: 0 }));
  } }), /javascript-prepared-2.*body transfer failed after 50s \(1 attempt\)/u);
  assert.equal(downloads, 1, "the preparation deadline must prevent a second transfer");
});

test("workflow reads retry transient responses and request errors within their caller's deadline", async t => {
  for (const first of [500, 429, new TypeError("fetch failed"), new DOMException("request stalled", "TimeoutError")]) {
    let clock = 0, attempts = 0;
    const api = cloudApi({ env: apiEnv, now: () => clock, deadline: 15_000, pause: async ms => { assert.equal(ms, 1_000); clock += ms; },
      request: async () => { if (++attempts > 1) return apiResponse({ ok: true }); if (typeof first !== "number") throw first; return apiResponse(null, first); } });
    assert.deepEqual(await api.read("/artifacts"), { ok: true });
    assert.equal(attempts, 2);
    assert.equal(clock, 1_000);
  }
  for (const [status, expected] of [[500, 3], [429, 3], [404, 1]]) {
    let clock = 0, attempts = 0;
    const api = cloudApi({ env: apiEnv, now: () => clock, pause: async ms => { clock += ms; }, request: async () => { attempts++; return apiResponse(null, status); } });
    await assert.rejects(api.read("/artifacts"), new RegExp(`Cannot read workflow /artifacts: HTTP ${status} after ${expected} attempt`, "u"));
    assert.equal(attempts, expected);
    assert.equal(clock, (expected - 1) * 1_000);
  }
  for (const deadline of [0, 500, 1_500]) {
    let clock = 0, attempts = 0;
    const api = cloudApi({ env: apiEnv, now: () => clock, deadline, pause: async ms => { clock += ms; }, request: async () => {
      assert.ok(clock < deadline); attempts++; return apiResponse(null, 500);
    } });
    await assert.rejects(api.jobs(), /Cannot read workflow.*after.*attempt/u);
    assert.equal(clock, deadline);
    assert.equal(attempts, Math.ceil(deadline / 1_000));
  }
  for (const scope of ["js", "rust"]) {
    let clock = 0, reads = 0;
    const jobs = passingCloudJobs(), waitOutput = mkdtempSync(join(tmpdir(), "read-retry-"));
    t.after(() => rmSync(waitOutput, { recursive: true, force: true }));
    await waitForGate(scope, { env: apiEnv, outputDirectory: waitOutput, now: () => clock, pause: async ms => { clock += ms; },
      request: async () => ++reads === 1 ? apiResponse(null, 500) : apiResponse({ jobs }) });
    assert.equal(reads, 2);
    assert.equal(clock, 1_000);
  }
  for (const failedRead of ["jobs", "artifacts"]) {
    let clock = 0, failures = 0;
    await waitForPreparation("js", { env: apiEnv, now: () => clock, pause: async ms => { clock += ms; }, request: async url => {
      if (url.includes(`/${failedRead}?`) && failures++ === 0) return apiResponse(null, 500);
      if (url.includes("/jobs?")) return apiResponse({ jobs: [{ name: "shared preparation", status: "completed", conclusion: "success" }] });
      if (url.includes("/artifacts?")) return apiResponse({ artifacts: [{ id: 42, name: "javascript-prepared-2" }] });
      return apiResponse("archive");
    } });
    assert.equal(failures, 2);
    assert.equal(clock, 1_000);
  }
});

test("workflow reads retry cut-off JSON bodies within the caller deadline", async () => {
  for (const kind of ["TypeError", "TimeoutError"]) for (const failures of [0, 1, 3]) {
    let clock = 0, requests = 0;
    const cause = kind === "TypeError" ? new TypeError("terminated") : new DOMException("body timed out", kind);
    const api = cloudApi({ env: apiEnv, now: () => clock, deadline: 15_000, pause: async ms => { clock += ms; }, request: async () => {
      requests++;
      return requests > failures ? apiResponse({ ok: true }) : new Response(new ReadableStream({ pull(controller) {
        clock += 200; controller.error(cause);
      } }, { highWaterMark: 0 }));
    } });
    if (failures === 3) await assert.rejects(api.read("/artifacts"), error => {
      assert.equal(error.cause, cause);
      assert.equal(error.message, `Cannot read workflow /artifacts: ${cause.message} after 3 attempts.`);
      return true;
    });
    else assert.deepEqual(await api.read("/artifacts"), { ok: true });
    assert.equal(requests, failures === 0 ? 1 : failures === 1 ? 2 : 3);
    assert.equal(clock, failures === 0 ? 0 : failures === 1 ? 1_200 : 2_600);
  }
  let clock = 0, requests = 0;
  const api = cloudApi({ env: apiEnv, now: () => clock, deadline: 500, pause: async ms => { clock += ms; }, request: async () => {
    requests++;
    return new Response(new ReadableStream({ pull(controller) { clock = 200; controller.error(new TypeError("terminated")); } }, { highWaterMark: 0 }));
  } });
  await assert.rejects(api.read("/artifacts"), /terminated after 1 attempt/u);
  assert.equal(clock, 500);
  assert.equal(requests, 1, "the deadline prevents another JSON-body attempt");
});

test("prepared artifact body timing excludes readiness retries", async t => {
  t.mock.method(console, "log", () => {});
  let clock = 0, downloads = 0;
  await assert.rejects(waitForPreparation("js", { env: apiEnv, now: () => clock, pause: async ms => { clock += ms; },
    download: response => response.text(), request: async url => {
      if (url.includes("/jobs?")) return apiResponse({ jobs: [{ name: "shared preparation", status: "completed", conclusion: "success" }] });
      if (url.includes("/artifacts?")) return apiResponse({ artifacts: [{ id: 42, name: "javascript-prepared-2" }] });
      if (++downloads <= 2) return apiResponse(null, 404);
      return new Response(new ReadableStream({ pull(controller) { clock += 1000; controller.error(new TypeError("terminated")); } }, { highWaterMark: 0 }));
    } }), /body transfer failed after 2s \(2 attempts\)/u);
  assert.equal(clock, 6000);
  assert.equal(downloads, 4);
});

for (const [scope, jobName, artifact] of [["js", "shared preparation", "javascript-prepared"], ["rust", "Rust build once", "rust-tests"]]) {
  test(`${scope} preparation polls conditionally only after the build starts`, async t => {
    let clock = 0, jobReads = 0, artifactReads = 0;
    const log = t.mock.method(console, "log", () => {});
    const result = await waitForPreparation(scope, { env: apiEnv, now: () => clock, pause: async ms => { clock += ms; },
      request: async (url, { headers }) => {
        assert.equal(headers.Authorization, "Bearer fixture");
        if (url.includes("/jobs?")) {
          jobReads++;
          return apiResponse({ jobs: [{ name: jobName, status: clock < 60_000 ? "queued" : "in_progress" }] }, 200, `"jobs-${jobReads}"`);
        }
        if (url.endsWith("/zip")) return apiResponse("archive");
        assert.ok(clock >= 60_000, "queued builds cannot have published artifacts");
        artifactReads++;
        if (artifactReads === 1) return apiResponse({ artifacts: [{ name: `${artifact}-1`, expired: false }, { name: `${artifact}-2`, expired: true }] }, 200, '"empty"');
        assert.equal(headers["If-None-Match"], '"empty"');
        return artifactReads === 2 ? apiResponse(null, 304) : apiResponse({ artifacts: [{ id: 42, name: `${artifact}-2`, expired: false }] });
      },
    });
    assert.equal(result.artifact.id, 42);
    assert.equal(clock, 65_000);
    assert.equal(jobReads, 2);
    assert.match(log.mock.calls.at(-1).arguments[0], /x-ratelimit-limit=1000 x-ratelimit-remaining=997 x-ratelimit-used=3 counted=5 304=1/u);
  });

  test(`${scope} listed artifacts retry transient download statuses before returning`, async () => {
    for (const status of [404, 429, 500, 503]) {
      let clock = 0, downloads = 0;
      const result = await waitForPreparation(scope, { env: apiEnv, download: scope === "js" ? response => response.json() : false, now: () => clock,
        pause: async ms => { assert.equal(ms, 2_000); clock += ms; },
        request: async (url, { headers }) => {
          if (url.includes("/jobs?")) return apiResponse({ jobs: [{ name: jobName, status: "in_progress" }] });
          if (url.includes("/artifacts?")) return apiResponse({ artifacts: [{ id: 42, name: `${artifact}-2` }] });
          assert.equal(url, "https://api.example.test/repos/test/repo/actions/artifacts/42/zip");
          assert.equal(headers["If-None-Match"], undefined);
          return ++downloads < 3 ? apiResponse(null, status) : apiResponse("archive");
        },
      });
      assert.equal(downloads, 3);
      assert.equal(clock, 4_000);
      assert.equal(result.artifact.id, 42);
      if (scope === "js") assert.equal(result.value, "archive", "JS consumes the successful response without another request");
      else assert.equal(result.value, undefined, "Rust only checks readiness before its download action");
    }
  });

  test(`${scope} listed artifacts cap transient download statuses at 30 seconds and reject other failures`, async () => {
    for (const status of [404, 429, 500, 503, 403]) {
      let clock = 0, downloads = 0;
      await assert.rejects(waitForPreparation(scope, { env: apiEnv, now: () => clock, pause: async ms => { clock += ms; },
        request: async url => {
          if (url.includes("/jobs?")) return apiResponse({ jobs: [{ name: jobName, status: "in_progress" }] });
          if (url.includes("/artifacts?")) return apiResponse({ artifacts: [{ id: 42, name: `${artifact}-2` }] });
          downloads++; return apiResponse(null, status);
        },
      }), status !== 403 ? /listed but never became downloadable.*30/u : /HTTP 403/u);
      assert.equal(clock, status !== 403 ? 30_000 : 0);
      assert.equal(downloads, status !== 403 ? 15 : 1);
    }
  });

  test(`${scope} download caps preserve the cause and distinguish stalls from observed 404s`, async () => {
    for (const saw404 of [false, true]) for (const capped of [false, true]) {
      let clock = 0, downloads = 0;
      const cause = new Error("download connection stalled");
      await assert.rejects(waitForPreparation(scope, { env: apiEnv, now: () => clock, pause: async ms => { clock += ms; },
        request: async url => {
          if (url.includes("/jobs?")) return apiResponse({ jobs: [{ name: jobName, status: "in_progress" }] });
          if (url.includes("/artifacts?")) return apiResponse({ artifacts: [{ id: 42, name: `${artifact}-2` }] });
          if (++downloads === 1 && saw404) return apiResponse(null, 404);
          clock = capped ? 30_000 : 3_000;
          throw cause;
        },
      }), error => {
        if (!capped) assert.equal(error, cause, "errors before the cap are not wrapped or retried");
        else {
          assert.equal(error.cause, cause);
          assert.match(error.message, saw404 ? /listed but never became downloadable.*30/u : /download timed out waiting for a response.*30/u);
        }
        return true;
      });
      assert.equal(downloads, saw404 ? 2 : 1);
    }
  });

  test(`${scope} unchanged artifact bodies on 200 permanently slow polling to 10 seconds`, async () => {
    let clock = 0, reads = 0;
    const pauses = [];
    await waitForPreparation(scope, { env: apiEnv, now: () => clock, pause: async ms => { pauses.push(ms); clock += ms; },
      request: async (url, { headers }) => {
        if (url.includes("/jobs?")) return apiResponse({ jobs: [{ name: jobName, status: "in_progress" }] });
        if (url.endsWith("/zip")) return apiResponse("archive");
        reads++;
        if (reads > 1) assert.equal(headers["If-None-Match"], reads === 2 ? '"first"' : '"changed"');
        if (reads <= 2) return apiResponse({ artifacts: [] }, 200, reads === 1 ? '"first"' : '"changed"');
        if (reads === 3) return apiResponse(null, 304);
        return apiResponse({ artifacts: [{ id: 42, name: `${artifact}-2` }] });
      },
    });
    assert.deepEqual(pauses, [2_500, 10_000, 10_000]);
    assert.equal(clock, 22_500);
  });

  test(`${scope} preparation stops after 15 minutes with the last observed build state`, async () => {
    for (const state of ["queued", "in_progress", "missing", "completed"]) {
      let clock = 0, lastJobRead = -1;
      await assert.rejects(waitForPreparation(scope, { env: apiEnv, now: () => clock, pause: async ms => { clock += ms; },
        request: async url => {
          if (url.includes("/jobs?")) { lastJobRead = clock; return apiResponse({ jobs: state === "missing" ? [] : [{ name: jobName, status: state, conclusion: state === "completed" ? "success" : null }] }); }
          assert.ok(["in_progress", "completed"].includes(state));
          return apiResponse({ artifacts: [] });
        },
      }), new RegExp(`15-minute wait cap.*${state === "missing" ? "build job missing from the job list" : state === "completed" ? "no published artifact" : state === "queued" ? "queued for a runner" : "running"}`, "u"));
      assert.equal(clock, 900_000);
      assert.ok(lastJobRead >= 840_000 && lastJobRead < 900_000, "the last build read is within a minute of the cap, before its deadline");
    }
    for (const conclusion of ["failure", "cancelled", "skipped"]) await assert.rejects(waitForPreparation(scope, {
      env: apiEnv, request: async () => apiResponse({ jobs: [{ name: jobName, status: "completed", conclusion }] }),
    }), new RegExp(`ended with ${conclusion}`, "u"));
    await assert.rejects(waitForPreparation(scope, { env: apiEnv,
      request: async () => apiResponse({ jobs: [{ name: jobName }, { name: jobName }] }),
    }), /Duplicate/u);
  });
}

test("compiler preparation waits for exactly both consumed artifacts under one cap", async () => {
  for (const publishArchive of [false, true]) {
    let clock = 0;
    const listed = [], downloaded = [];
    const waiting = waitForPreparation("compiler", { env: apiEnv, now: () => clock, pause: async ms => { clock += ms; },
      request: async url => {
        if (url.includes("/jobs?")) return apiResponse({ jobs: [{ name: "shared preparation", status: "in_progress" }] });
        if (url.endsWith("/zip")) {
          downloaded.push(url);
          return apiResponse("archive");
        }
        const name = new URL(url).searchParams.get("name");
        listed.push(name);
        const ready = name === "javascript-prepared-2" ? clock >= 840_000 : publishArchive && clock >= 850_000;
        return apiResponse({ artifacts: ready ? [{ id: name === "javascript-prepared-2" ? 41 : 42, name }] : [] });
      },
    });
    if (publishArchive) await waiting;
    else await assert.rejects(waiting, /15-minute wait cap.*still running/u);
    assert.deepEqual([...new Set(listed)], ["javascript-prepared-2", "compiler-tests-2"]);
    assert.equal(downloaded.length, publishArchive ? 2 : 1);
    assert.ok(clock <= 900_000, "the second artifact cannot restart the 15-minute cap");
  }
  for (const conclusion of ["failure", "cancelled", "skipped"]) await assert.rejects(waitForPreparation("compiler", {
    env: apiEnv, request: async () => apiResponse({ jobs: [{ name: "shared preparation", status: "completed", conclusion }] }),
  }), new RegExp(`shared preparation ended with ${conclusion}`, "u"));
});

test("reporting joins its own successful group and caps queued or running siblings at 20 minutes", async () => {
  for (const scope of ["js", "rust"]) {
    const jobs = passingCloudJobs();
    const sibling = jobs.find(job => job.name === (scope === "js" ? "JS worker 1" : "Rust tests 1"));
    for (const state of ["queued", "in_progress"]) {
      let clock = 0;
      Object.assign(sibling, { status: state, conclusion: null });
      await assert.rejects(waitForGate(scope, { readJobs: async () => jobs, now: () => clock, pause: async ms => { clock += ms; } }),
        new RegExp(`20-minute wait cap.*${state === "queued" ? "queued for a runner" : "running"}`, "u"));
      assert.equal(clock, 1_200_000);
    }
    for (const conclusion of ["failure", "cancelled", "skipped"]) {
      Object.assign(sibling, { status: "completed", conclusion });
      await assert.rejects(waitForGate(scope, { readJobs: async () => jobs }), /did not finish successfully/u);
    }
    Object.assign(sibling, { conclusion: "success" });
    const proof = jobs.find(job => job.name === "compiler confinement");
    Object.assign(proof, { status: "queued", conclusion: null });
    let polls = 0;
    await waitForGate(scope, { outputDirectory: waitOutput, readJobs: async () => {
      if (++polls === 2) Object.assign(proof, { status: "completed", conclusion: "success" });
      return jobs;
    }, pause: async () => {} });
    assert.equal(polls, 2, "reporting waits for confinement before deciding timing and contention");
    await assert.rejects(waitForGate(scope, { readJobs: async () => [...jobs, sibling] }), /Duplicate/u);
  }
});

test("API-backed group waits retain the cap message and last observed jobs", async t => {
  t.mock.method(console, "log", () => {});
  for (const scope of ["js", "rust"]) for (const state of ["queued", "in_progress", "missing"]) {
    let clock = 0, lastRead = -1;
    const jobs = passingCloudJobs(), sibling = jobs.find(job => job.name === (scope === "js" ? "JS worker 1" : "Rust tests 1"));
    Object.assign(sibling, { status: state, conclusion: null });
    await assert.rejects(waitForGate(scope, { env: apiEnv, now: () => clock, pause: async ms => { clock += ms; }, request: async () => {
      assert.ok(clock < 1_200_000, "requests must start before the group deadline");
      lastRead = clock;
      return apiResponse({ jobs: state === "missing" ? jobs.filter(job => job !== sibling) : jobs });
    } }), { message: `The ${scope} group exceeded its 20-minute wait cap; awaited jobs ${state === "queued" ? "still queued for a runner" : state === "in_progress" ? "still running" : "missing"}.` });
    assert.equal(clock, 1_200_000);
    assert.ok(lastRead >= 1_190_000 && lastRead < 1_200_000);
  }
  let clock = 0;
  await assert.rejects(waitForGate("js", { env: apiEnv, now: () => clock, request: async () => {
    clock = 1_200_000;
    return apiResponse({ jobs: [{ name: "JS worker 1", status: "completed", conclusion: "failure" }] });
  } }), /did not finish successfully/u, "a failure returned by the last permitted read still takes precedence");
});

test("aggregate polling bounds latency by scope and counts each jobs request", async t => {
  const log = t.mock.method(console, "log", () => {});
  for (const [scope, interval, name] of [["js", 3_000, "JS worker 1"], ["rust", 10_000, "Rust tests 1"]]) {
    const jobs = passingCloudJobs(), sibling = jobs.find(job => job.name === name);
    Object.assign(sibling, { status: "in_progress", conclusion: null });
    let clock = 0, reads = 0;
    await waitForGate(scope, { env: apiEnv, outputDirectory: waitOutput, now: () => clock, pause: async ms => { assert.equal(ms, interval); clock += ms; },
      request: async (url, { headers }) => {
        assert.equal(headers["If-None-Match"], undefined);
        if (++reads === 3) Object.assign(sibling, { status: "completed", conclusion: "success" });
        return apiResponse({ jobs });
      },
    });
    assert.equal(clock, interval * 2);
    assert.match(log.mock.calls.at(-1).arguments[0], /counted=3 304=0/u);
  }
});

test("polling waits for initially missing jobs and rejects invalid HTTP responses", async () => {
  for (const scope of ["js", "rust"]) {
    const jobs = passingCloudJobs(), name = scope === "js" ? "JS worker 1" : "Rust tests 1";
    let reads = 0, pauses = 0;
    await waitForGate(scope, { outputDirectory: waitOutput, readJobs: async () => ++reads === 1 ? jobs.filter(job => job.name !== name) : jobs,
      pause: async () => { pauses++; } });
    assert.equal(pauses, 1);
  }
  let clock = 0, reads = 0;
  await waitForPreparation("js", { env: apiEnv, now: () => clock, pause: async ms => { clock += ms; },
    request: async url => url.includes("/jobs?") ? apiResponse({ jobs: ++reads === 1 ? [] : [{ name: "shared preparation", status: "in_progress" }] })
      : apiResponse({ artifacts: [{ id: 1, name: "javascript-prepared-2" }] }) });
  assert.equal(clock, 60_000);
  for (const status of [304, 503]) {
    await assert.rejects(waitForPreparation("js", { env: apiEnv, pause: async () => {}, request: async () => apiResponse(null, status) }),
      status === 304 ? /no cached data/u : /HTTP 503/u);
    await assert.rejects(waitForGate("js", { env: apiEnv, pause: async () => {}, request: async () => apiResponse(null, status) }),
      status === 304 ? /no cached data/u : /HTTP 503/u);
  }
  await assert.rejects(waitForPreparation("js", { env: apiEnv, request: async url => url.includes("/jobs?")
    ? apiResponse({ jobs: [{ name: "shared preparation", status: "in_progress" }] }) : apiResponse(null, 304) }), /no cached data/u);
});

function writeTimingReceipts(root, scope, commit) {
  const all = Array.from({ length: scope === "js" ? JS_SHARDS : RUST_SHARDS }, (_, i) => `task-${i}`);
  const records = scope === "js"
    ? [{ part: "prepare-0" }, ...all.map((id, index) => ({ part: `worker-${index}`, planned: all, assigned: [id], completed: [id], tests: [], ...(!index ? { selfHostNative: {} } : {}) }))]
    : [{ part: "policy", steps: RUST_POLICY_STEPS.map(name => ({ name, status: "PASS" })) },
      { part: "archive-0", planned: all, steps: RUST_ARCHIVE_PROOFS.map(name => ({ name, verdict: "PASS" })) },
      ...all.map((id, index) => ({ part: `tests-${index}`, planned: all, assigned: [id], completed: [id],
        steps: index === RUST_READER_SHARD ? RUST_TEST_PROOFS.map(name => ({ name, verdict: "PASS" })) : [] }))];
  for (const row of records) {
    const directory = join(root, row.part); mkdirSync(directory);
    writeFileSync(join(directory, "result.json"), JSON.stringify({ scope, commit, verdict: "PASS", provenance: { status: "PASS" }, scratch: { status: "PASS" }, ...row }));
  }
}

for (const [scope, finalJob, target, ceiling] of [["js", "typecheck + tests", 300, 400], ["rust", "engine gate", 600, 700]]) {
  test(`${scope} timing boundaries agree in aggregate and completed receipts; only final verification warns`, async t => {
    const parent = resolve(".agent-artifacts/verification");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "timing-boundaries-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const outputDirectory = join(root, "aggregate"), summary = join(root, "summary.md");
    const commit = passingCloudJobs()[0].head_sha;
    const env = { GITHUB_SHA: commit, DOHC_WORKFLOW_HEAD_SHA: commit, GITHUB_STEP_SUMMARY: summary };
    writeTimingReceipts(root, scope, commit);
    t.mock.method(console, "log", () => {});
    const warn = t.mock.method(console, "warn", () => {});
    for (const seconds of [target, target + 1, ceiling, ceiling + 1]) for (const wait of [0, 30, 31]) {
      await t.test(`${seconds}s with ${wait}s runner wait`, async () => {
        const jobs = withoutWaits(), start = Date.parse(jobs[0].started_at);
        const final = jobs.find(job => job.name === finalJob);
        final.completed_at = new Date(start + seconds * 1000).toISOString();
        final.created_at = new Date(Date.parse(final.started_at) - wait * 1000).toISOString();
        const timing = seconds <= target ? "within budget" : wait > 30 ? "unmeasured" : seconds <= ceiling ? "over target" : "over budget";
        const fails = timing === "over budget";
        const warning = timing === "over target" ? `${scope} timing over target: ${seconds}s exceeds the ${target}s target; the gate fails above ${ceiling}s.`
          : timing === "unmeasured" ? `${scope} timing unmeasured: ${seconds}s exceeds the ${target}s target; longest runner wait ${finalJob}: ${wait}s.` : undefined;
        const run = aggregateCloud(scope, root.replaceAll("\\", "/"), { env, outputDirectory, now: () => Date.parse(final.completed_at), readJobs: async () => jobs });
        const before = warn.mock.calls.length;
        if (fails) await assert.rejects(run, /exceeding.*budget/u); else await run;
        const aggregate = JSON.parse(readFileSync(join(outputDirectory, `${scope}-result.json`), "utf8"));
        assert.equal(aggregate.complete, false);
        assert.equal(warn.mock.calls.length, before, "the aggregate must not emit an annotation");
        assert.equal(existsSync(summary), false, "the aggregate must not write the step summary");
        // The completed check must independently catch reporting crossing the ceiling.
        if (scope === "js") writeFileSync(join(outputDirectory, "js-result.json"), JSON.stringify({ verdict: "PASS", commit }));
        const completedRun = verifyCompletedCloud(scope, { env, outputDirectory, readJobs: async () => jobs });
        if (fails) await assert.rejects(completedRun, /exceeding.*budget/u); else await completedRun;
        const completed = JSON.parse(readFileSync(join(outputDirectory, `${scope}-completed-result.json`), "utf8"));
        assert.equal(completed.complete, true);
        for (const report of [aggregate, completed]) {
          assert.equal(report.verdict, fails ? "FAIL" : "PASS");
          assert.equal(report.seconds, seconds);
          assert.equal(report.spanSeconds, seconds);
          assert.equal(report.targetSeconds, target);
          assert.equal(report.budgetSeconds, ceiling);
          assert.equal(report.contended, wait > 30);
          assert.equal(report.timing, timing);
          assert.equal(report.warning, warning);
        }
        assert.deepEqual(warn.mock.calls.slice(before).map(call => call.arguments[0]), warning ? [`::warning::${warning}`] : []);
        if (warning) {
          assert.equal(readFileSync(summary, "utf8"), warning + "\n");
          rmSync(summary);
        } else assert.equal(existsSync(summary), false);
      });
    }
  });
}

for (const [scope, finalJob, target, ceiling] of [["js", "typecheck + tests", 300, 400], ["rust", "engine gate", 600, 700]]) {
  test(`${scope} receipt transfer contention requires known evidence above 30 seconds`, async t => {
    const parent = resolve(".agent-artifacts/verification");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "transfer-boundaries-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const outputDirectory = join(root, "aggregate"); mkdirSync(outputDirectory);
    const jobs = withoutWaits(), commit = jobs[0].head_sha, start = Date.parse(jobs[0].started_at);
    const env = { GITHUB_SHA: commit, DOHC_WORKFLOW_HEAD_SHA: commit };
    writeTimingReceipts(root, scope, commit);
    t.mock.method(console, "log", () => {});
    t.mock.method(console, "warn", () => {});
    // ceiling + 32 stays over the ceiling after a 31 s transfer is taken out.
    for (const seconds of [target, target + 1, ceiling + 1, ceiling + 31, ceiling + 32]) {
      for (const [label, transfer, marker, step, runnerWait = 0] of [["30", 30, true, true], ["31", 31, true, true],
        ["missing wait file", 31, false, true], ["missing download step", 31, true, false],
        ["missing both", 31, false, false], ["invalid marker", 31, "invalid", true],
        ["stale marker", 31, "stale", true], ["future marker", 31, "future", true], ["runner and transfer", 31, true, true, 35]]) {
        await t.test(`${seconds}s: ${label}`, async () => {
          const rows = structuredClone(jobs), final = rows.find(job => job.name === finalJob);
          const end = start + seconds * 1000, waitedAt = new Date(end - transfer * 1000).toISOString();
          final.completed_at = new Date(end).toISOString();
          final.created_at = new Date(Date.parse(final.started_at) - runnerWait * 1000).toISOString();
          final.steps = [
            { name: "Run actions/download-artifact@unrelated-archive", started_at: new Date(start).toISOString(), completed_at: new Date(start + 80_000).toISOString() },
            { name: `Wait for the complete ${scope === "js" ? "JavaScript" : "Rust"} group`, completed_at: waitedAt },
            ...(step ? [{ name: "Run actions/download-artifact@different-pin", started_at: waitedAt, completed_at: final.completed_at }] : []),
            { name: `Require complete proof and the ${scope} timing ceiling`, started_at: final.completed_at },
          ];
          const path = join(outputDirectory, `${scope}-wait-finished.json`);
          if (existsSync(path)) rmSync(path);
          if (marker) writeFileSync(path, marker === "invalid" ? "{" : JSON.stringify({ finishedAt: marker === "stale"
            ? new Date(Date.parse(final.started_at) - 1).toISOString() : marker === "future" ? new Date(end + 1).toISOString() : waitedAt }));
          const expected = known => ({ transferSeconds: known ? transfer : null, contended: runnerWait > 30 || known && transfer > 30,
            timing: seconds <= target ? "within budget" : runnerWait > 30 || known && transfer > 30 && seconds - transfer <= ceiling ? "unmeasured"
              : seconds <= ceiling ? "over target" : "over budget" });
          const aggregateExpected = expected(marker === true), completedExpected = expected(step);
          const run = aggregateCloud(scope, root.replaceAll("\\", "/"), { env, outputDirectory, now: () => end, readJobs: async () => rows });
          if (aggregateExpected.timing === "over budget") await assert.rejects(run, /exceeding/u); else await run;
          const aggregate = JSON.parse(readFileSync(join(outputDirectory, `${scope}-result.json`), "utf8"));
          if (scope === "js") writeFileSync(join(outputDirectory, "js-result.json"), JSON.stringify({ verdict: "PASS", commit }));
          const finalRun = verifyCompletedCloud(scope, { env, outputDirectory, readJobs: async () => rows });
          if (completedExpected.timing === "over budget") await assert.rejects(finalRun, /exceeding/u); else await finalRun;
          const completed = JSON.parse(readFileSync(join(outputDirectory, `${scope}-completed-result.json`), "utf8"));
          for (const [report, expected] of [[aggregate, aggregateExpected], [completed, completedExpected]]) {
            assert.equal(report.transferSeconds, expected.transferSeconds);
            assert.equal(report.contended, expected.contended);
            assert.equal(report.timing, expected.timing);
            assert.equal(report.verdict, expected.timing === "over budget" ? "FAIL" : "PASS");
            if (expected.timing === "unmeasured") assert.equal(report.warning, `${scope} timing unmeasured: ${seconds}s exceeds the ${target}s target; ${runnerWait > 30 ? `longest runner wait ${finalJob}: ${runnerWait}s; ` : ""}receipt transfer took ${transfer}s.`);
          }
        });
      }
    }
  });
}

test("a saved 181-second receipt download is unmeasured in both timing checks", async t => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/stalled-receipt-transfer.json", import.meta.url), "utf8"));
  const parent = resolve(".agent-artifacts/verification"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "transfer-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outputDirectory = join(root, "aggregate"), jobs = withoutWaits();
  const shift = Date.parse(fixture.selectionStartedAt) - Date.parse(jobs[0].started_at);
  for (const job of jobs) {
    for (const field of ["created_at", "started_at", "completed_at"]) job[field] = new Date(Date.parse(job[field]) + shift).toISOString();
    job.head_sha = fixture.reportingJob.head_sha;
  }
  const final = jobs.find(job => job.name === "typecheck + tests");
  Object.assign(final, fixture.reportingJob);
  assert.throws(() => completedGateTiming("js", jobs, final.head_sha), /unsuccessful/u, "a failed job must still fail");
  // The recorded failure was timing-only; model the successful task verdict under the new rule.
  final.conclusion = "success";
  assert.equal(completedGateTiming("js", jobs, final.head_sha).timing, "unmeasured");
  const env = { ...apiEnv, GITHUB_SHA: final.head_sha, DOHC_WORKFLOW_HEAD_SHA: final.head_sha };
  writeTimingReceipts(root, "js", final.head_sha);
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const [wait, download, verify] = final.steps;
  await waitForGate("js", { env, outputDirectory, readJobs: async () => jobs, now: () => Date.parse(wait.completed_at) });
  assert.equal(JSON.parse(readFileSync(join(outputDirectory, "js-wait-finished.json"), "utf8")).finishedAt, new Date(wait.completed_at).toISOString());
  assert.equal((Date.parse(download.completed_at) - Date.parse(download.started_at)) / 1000, 181);
  let calls = 0;
  const aggregate = await aggregateCloud("js", root.replaceAll("\\", "/"), { env, outputDirectory, readJobs: async () => jobs,
    now: () => Date.parse(calls++ === 0 ? verify.started_at : verify.completed_at) });
  await verifyCompletedCloud("js", { env, outputDirectory, readJobs: async () => jobs });
  const completed = JSON.parse(readFileSync(join(outputDirectory, "js-completed-result.json"), "utf8"));
  for (const report of [aggregate, completed]) {
    assert.equal(report.verdict, "PASS");
    assert.equal(report.contended, true);
    assert.equal(report.transferSeconds, 181);
    assert.equal(report.timing, "unmeasured");
    assert.ok(report.jobs.every(job => job.runnerWaitSeconds <= 30));
    assert.equal(report.warning, `js timing unmeasured: ${report.seconds}s exceeds the 300s target; receipt transfer took 181s.`);
  }
  assert.equal(aggregate.seconds, 446);
  assert.equal(completed.seconds, 450, "completed timing also includes upload and post steps");
});

test("aggregate receipts use the same timing rule and remain incomplete", async t => {
  const parent = resolve(".agent-artifacts/verification");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "cloud-timing-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outputDirectory = join(root, "aggregate"), jobs = passingCloudJobs(), commit = jobs[0].head_sha;
  const records = [{ scope: "js", part: "prepare-0", commit, verdict: "PASS" }];
  for (let index = 0; index < JS_SHARDS; index++) records.push({ scope: "js",
    part: `worker-${index}`, commit, verdict: "PASS", planned: Array.from({ length: JS_SHARDS }, (_, id) => `task-${id}`),
    assigned: [`task-${index}`], completed: [`task-${index}`], tests: [], ...(!index ? { selfHostNative: {} } : {}),
  });
  for (const record of records) {
    const directory = join(root, record.part); mkdirSync(directory);
    writeFileSync(join(directory, "result.json"), JSON.stringify(record));
  }
  const final = jobs.find(job => job.name === "typecheck + tests");
  const now = Date.parse(final.completed_at);
  Object.assign(final, { status: "in_progress", conclusion: null, completed_at: null });
  const run = (rows, finish, env = { GITHUB_SHA: commit }) => aggregateCloud("js", root.replaceAll("\\", "/"), { readJobs: async () => rows, now: () => finish, env, outputDirectory });
  const passed = await run(jobs, now);
  assert.equal(passed.complete, false);
  assert.equal(passed.seconds, 241);
  assert.equal(passed.spanSeconds, 241);
  assert.equal("confinementSeconds" in passed, false);
  assert.equal(passed.timing, "within budget");
  const contended = structuredClone(jobs);
  for (const job of contended) if (job.name !== "what changed") {
    job.started_at = new Date(Date.parse(job.started_at) + 900_000).toISOString();
    if (job.completed_at) job.completed_at = new Date(Date.parse(job.completed_at) + 900_000).toISOString();
  }
  const adjusted = await run(contended, now + 900_000);
  assert.equal(adjusted.seconds, 1141);
  assert.equal(adjusted.timing, "unmeasured");
  assert.equal(adjusted.contended, true);
  const queuedProof = structuredClone(jobs);
  Object.assign(queuedProof.find(job => job.name === "compiler confinement"), { status: "queued", started_at: null, completed_at: null });
  await assert.rejects(run(queuedProof, now), /missing or did not finish successfully/u);
  const proofWait = structuredClone(jobs);
  const proof = proofWait.find(job => job.name === "compiler confinement");
  proof.created_at = new Date(Date.parse(proof.started_at) - 31_000).toISOString();
  await assert.rejects(run(proofWait, Date.parse(jobs[0].started_at) + 401_000), /exceeding.*budget/u);
  proof.started_at = new Date(Date.parse(proof.started_at) + 1000).toISOString();
  proof.created_at = new Date(Date.parse(proof.started_at) - 31_000).toISOString();
  const unmeasured = await run(proofWait, Date.parse(jobs[0].started_at) + 401_000);
  assert.equal(unmeasured.timing, "unmeasured", "a confinement wait after preparation also governs aggregate timing");
  const zeroWait = structuredClone(jobs);
  zeroWait.forEach(job => { job.created_at = job.started_at; });
  await assert.rejects(run(zeroWait, Date.parse(jobs[0].started_at) + 401_000), /exceeding.*budget/u);
  const failed = JSON.parse(readFileSync(join(outputDirectory, "js-result.json"), "utf8"));
  assert.equal(failed.verdict, "FAIL");
  assert.equal(failed.seconds, 401);
  assert.equal(failed.contended, false);
  for (const rows of [jobs.slice(1), [...jobs, jobs[0]], jobs.map(job => job.name === "JS worker 1" ? { ...job, conclusion: "cancelled" } : job)]) {
    await assert.rejects(run(rows, now), /missing or did not finish/u);
  }
  await assert.rejects(run(jobs, now, { GITHUB_SHA: "other-head" }), /requested commit/u);
});

test("JavaScript flaky evidence survives aggregation and the completed receipt without relaxing coverage", async t => {
  const parent = resolve(".agent-artifacts/verification");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "cloud-flaky-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outputDirectory = join(root, "aggregate"), summary = join(root, "summary.md"), jobs = passingCloudJobs();
  const commit = "checkout-merge-head", env = { GITHUB_SHA: commit, DOHC_WORKFLOW_HEAD_SHA: jobs[0].head_sha, GITHUB_STEP_SUMMARY: summary };
  const flaky = [{ id: "task-1", test: "recovered test", errors: ["first try"], retries: 1 }];
  const records = [{ scope: "js", part: "prepare-0", commit, verdict: "PASS" }, ...Array.from({ length: JS_SHARDS }, (_, index) => ({
    scope: "js", part: "worker-" + index, commit, verdict: "PASS", planned: Array.from({ length: JS_SHARDS }, (_, id) => "task-" + id),
    assigned: ["task-" + index], completed: ["task-" + index], tests: [], flaky: index === 1 ? flaky : [], ...(!index ? { selfHostNative: {} } : {}),
  }))];
  assert.deepEqual(aggregateJavascript(records).flaky, flaky);
  for (const mutate of [rows => rows[2].completed.pop(), rows => rows[2].completed.push("task-0")]) {
    const broken = structuredClone(records); mutate(broken);
    assert.throws(() => aggregateJavascript(broken));
  }
  for (const record of records) {
    const directory = join(root, record.part); mkdirSync(directory);
    writeFileSync(join(directory, "result.json"), JSON.stringify(record));
  }
  const log = t.mock.method(console, "log", () => {});
  const gate = await aggregateCloud("js", root.replaceAll("\\", "/"), { readJobs: async () => jobs, now: () => Date.parse(jobs.find(job => job.name === "typecheck + tests").completed_at), env, outputDirectory });
  assert.equal(gate.verdict, "PASS");
  assert.deepEqual(gate.flaky, flaky);
  assert.equal(existsSync(summary), false);
  assert.equal(log.mock.calls.some(call => call.arguments[0].startsWith("::warning")), false);
  await verifyCompletedCloud("js", { env, readJobs: async () => jobs, outputDirectory });
  const completed = JSON.parse(readFileSync(join(outputDirectory, "js-completed-result.json"), "utf8"));
  assert.equal(completed.verdict, "PASS");
  assert.deepEqual(completed.flaky, flaky);
  assert.equal(completed.commit, jobs[0].head_sha);
  assert.deepEqual(log.mock.calls.map(call => call.arguments[0]).filter(line => line.startsWith("Passed on retry:")), ["Passed on retry: task-1 › recovered test", "Passed on retry: task-1 › recovered test"]);
  assert.equal(readFileSync(summary, "utf8"), "Passed on retry: task-1 › recovered test\n");
  assert.deepEqual(log.mock.calls.map(call => call.arguments[0]).filter(line => line.startsWith("::warning")), ["::warning title=Passed on retry::task-1 › recovered test"]);
  await assert.rejects(verifyCompletedCloud("js", { env: { ...env, GITHUB_SHA: "another-checkout" }, readJobs: async () => jobs, outputDirectory }), /aggregate.*commit/u);
  rmSync(join(outputDirectory, "js-result.json"));
  await assert.rejects(verifyCompletedCloud("js", { env, readJobs: async () => jobs, outputDirectory }), /ENOENT/u);
});
