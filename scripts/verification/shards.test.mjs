import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertTaskCoverage, javascriptGroups, javascriptTasks, nativeTestFiles, partitionJavascript, partitionTasks } from "./shards.mjs";
import { readWorkspacePackages } from "./selection.mjs";
import { aggregateCloud, aggregateJavascript, aggregateRust, completedGateTiming, gateDeadline, gateQueueTiming, waitForGate } from "./cloud-aggregate.mjs";
import { JS_SHARDS } from "./cloud.mjs";
import { RUST_ARCHIVE_PROOFS, RUST_POLICY_STEPS, RUST_READER_SHARD, RUST_SHARDS, RUST_TEST_PROOFS, passedRustTests, rustTestInventory } from "./cloud-rust.mjs";
import { waitForPreparation } from "./wait-preparation.mjs";
import { runVitestGroup } from "./vitest-group.mjs";

test("early reporting waits for every successful job and preserves the complete group deadline", async () => {
  const started_at = "2026-11-10T00:00:00Z", start = Date.parse(started_at);
  const names = ["what changed", "shared preparation", ...Array.from({ length: JS_SHARDS - 1 }, (_, i) => `JS worker ${i + 1}`)];
  const complete = names.map(name => ({ name, created_at: started_at, started_at, status: "completed", conclusion: "success" }));
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
  await assert.rejects(waitForGate("js", { now: () => start + 301_000, readJobs: async () => complete }), /no time left/);
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

test("Rust inventory retains selected ordinary tests and counts only actual passes", () => {
  const tests = { "rust-suites": { crate: { testcases: {
    retained: { ignored: false, "filter-match": { status: "matches" } },
    ignored: { ignored: true, "filter-match": { status: "matches" } },
    otherShard: { ignored: false, "filter-match": { status: "mismatch" } },
  } } } };
  assert.deepEqual(rustTestInventory(tests), [{ id: "crate retained" }]);
  assert.deepEqual(passedRustTests("PASS [ 0.1s] (1/2) crate retained\nFAIL [ 0.2s] crate broken\nFLAKY 2/2 [ 0.1s] crate retry"), ["crate retained"]);
});

for (const [scope, jobName, artifact, seconds] of [
  ["js", "shared preparation", "javascript-prepared", 300],
  ["rust", "Rust build once", "rust-tests", 600],
]) test(`${scope} preparation waits for this attempt and keeps the original group deadline`, async () => {
  const env = { GITHUB_API_URL: "https://api.example.test", GITHUB_REPOSITORY: "test/repo", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "2", GITHUB_TOKEN: "fixture" };
  const started = Date.parse("2026-11-09T00:00:00Z");
  let clock = started + 10_000, reads = 0;
  const timestamp = new Date(started).toISOString();
  const jobs = [{ name: "what changed", created_at: timestamp, started_at: timestamp, status: "completed" }, { name: jobName, created_at: timestamp, started_at: timestamp, status: "in_progress" }];
  const response = value => ({ ok: true, json: async () => value });
  await waitForPreparation(scope, { env, now: () => clock, pause: async ms => { clock += ms; }, request: async url => {
    reads++;
    return response(url.includes("/jobs?") ? { jobs } : { artifacts: reads < 4 ? [] : [{ name: `${artifact}-2`, expired: false }] });
  } });
  assert.equal(reads, 4);
  assert.equal(clock, started + 20_000);
  clock = started + seconds * 1000 - 1000;
  await assert.rejects(waitForPreparation(scope, { env, now: () => clock, pause: async ms => { clock += ms; },
    request: async url => response(url.includes("/jobs?") ? { jobs } : { artifacts: [{ name: `${artifact}-1`, expired: false }] }),
  }), new RegExp(`exceeded.*${seconds}s`, "u"));
  await assert.rejects(waitForPreparation(scope, { env, now: () => started + 1000, request: async () => response({
    jobs: [jobs[0], { ...jobs[1], status: "completed", conclusion: "failure" }],
  }) }), /ended with failure/u);
});

function passingCloudJobs() {
  const { jobs } = JSON.parse(readFileSync(new URL("./fixtures/passing-cloud-jobs.json", import.meta.url), "utf8"));
  // Split the saved combined job at its artifact publication and proof start.
  const prepared = jobs.find(job => job.name === "shared preparation + confinement");
  prepared.name = "shared preparation";
  jobs.push({ ...prepared, name: "compiler and relay confinement", created_at: "2026-11-11T13:06:40Z", started_at: "2026-11-11T13:06:40Z" });
  prepared.completed_at = "2026-11-11T13:06:40Z";
  return jobs;
}

test("contended completed gates discount runner waits by dependency stage", () => {
  const jobs = passingCloudJobs();
  const at = value => new Date(Date.parse(value) + 15 * 60_000).toISOString();
  for (const job of jobs) {
    if (job.name !== "what changed") {
      job.started_at = at(job.started_at);
      job.completed_at = at(job.completed_at);
      // The proof is created only after its build dependency completes.
      if (job.name === "compiler and relay confinement" || job.name.startsWith("Rust tests ") || job.name === "engine gate") job.created_at = at(job.created_at);
    }
  }
  // A second dependency stage waits another ten minutes for its runner.
  const confinement = jobs.find(job => job.name === "compiler and relay confinement");
  confinement.started_at = new Date(Date.parse(confinement.started_at) + 600_000).toISOString();
  confinement.completed_at = new Date(Date.parse(confinement.completed_at) + 600_000).toISOString();
  for (const [scope, budget] of [["js", 300], ["rust", 600]]) {
    const result = completedGateTiming(scope, jobs, jobs[0].head_sha);
    assert.ok(result.seconds > budget);
    assert.ok(result.seconds - result.runnerWaitSeconds <= budget);
    assert.deepEqual(result.stages.map(stage => stage.runnerWaitSeconds), [7, 908, 600]);
    assert.equal(result.runnerWaitSeconds, 1515, "parallel waits count once per stage");
  }
});

test("the saved passing run retains all jobs and dependency-ready creation timestamps", () => {
  const { runId, jobs } = JSON.parse(readFileSync(new URL("./fixtures/passing-cloud-jobs.json", import.meta.url), "utf8"));
  assert.equal(runId, 43025765573);
  assert.equal(jobs.length, 29);
  const selection = jobs.find(job => job.name === "what changed");
  const javascript = jobs.find(job => job.name === "typecheck + tests");
  const engine = jobs.find(job => job.name === "engine gate");
  assert.equal((Date.parse(javascript.completed_at) - Date.parse(selection.started_at)) / 1000, 241);
  assert.equal((Date.parse(engine.completed_at) - Date.parse(selection.started_at)) / 1000, 419);
  assert.equal(jobs.find(job => job.name === "shared preparation + confinement").created_at, selection.completed_at);
  for (const job of jobs.filter(job => job.name.startsWith("Rust tests ") || job.name === "engine gate")) {
    assert.equal(job.created_at, javascript.completed_at, "creation excludes dependency execution");
    assert.ok(Date.parse(job.started_at) >= Date.parse(job.created_at));
  }
  const split = passingCloudJobs();
  for (const [scope, seconds, waits] of [["js", 241, [7, 8, 0]], ["rust", 419, [7, 8, 8]]]) {
    const timing = completedGateTiming(scope, split, jobs[0].head_sha);
    assert.equal(timing.seconds, seconds);
    assert.deepEqual(timing.stages.map(stage => stage.runnerWaitSeconds), waits);
    assert.equal(timing.runnerWaitSeconds, waits.reduce((sum, wait) => sum + wait));
    assert.ok(timing.jobs.every(job => Number.isFinite(job.runnerWaitSeconds)));
  }
});

test("completed timing rejects uncontended overruns and invalid or incomplete jobs", () => {
  for (const scope of ["js", "rust"]) {
    const jobs = passingCloudJobs();
    jobs.forEach(job => { job.created_at = job.started_at; });
    const budget = scope === "js" ? 300 : 600;
    const last = jobs.find(job => job.name === "compiler and relay confinement");
    last.completed_at = new Date(Date.parse(jobs[0].started_at) + (budget + 1) * 1000).toISOString();
    assert.throws(() => completedGateTiming(scope, jobs, jobs[0].head_sha), error => {
      assert.equal(error.timing.seconds, budget + 1);
      assert.equal(error.timing.runnerWaitSeconds, 0);
      assert.equal(error.timing.withinBudget, false);
      return /exceeding.*budget/u.test(error.message);
    });
    for (const mutate of [
      rows => rows.splice(rows.findIndex(job => job.name === "compiler and relay confinement"), 1),
      rows => rows.push(rows.find(job => job.name === "shared preparation")),
      ...["cancelled", "failure", "skipped"].map(conclusion => rows => { rows.find(job => job.name === "compiler and relay confinement").conclusion = conclusion; }),
      rows => { rows[0].head_sha = "other-head"; },
      rows => { rows[0].created_at = "invalid"; },
      rows => { rows[0].created_at = rows[0].completed_at; },
      rows => { rows[0].completed_at = rows[0].created_at; rows[0].started_at = "invalid"; },
    ]) {
      const broken = passingCloudJobs(); mutate(broken);
      assert.throws(() => completedGateTiming(scope, broken, jobs[0].head_sha));
    }
  }
});

test("Rust-only timing removes skipped JavaScript dependencies from its stages", () => {
  const jobs = passingCloudJobs().filter(job => !job.name.startsWith("JS worker "));
  Object.assign(jobs.find(job => job.name === "typecheck + tests"), { status: "completed", conclusion: "skipped", created_at: null, started_at: null });
  const timing = completedGateTiming("rust", jobs, jobs[0].head_sha);
  assert.equal(timing.stages.find(stage => stage.stage === 1).jobs.includes("engine gate"), true);
  assert.ok(!timing.jobs.some(job => job.name === "typecheck + tests"));
});

test("reporting survives long sibling queues but does not wait for confinement", async () => {
  const jobs = passingCloudJobs().filter(job => job.name !== "typecheck + tests");
  const sibling = jobs.find(job => job.name === "JS worker 1");
  const created = Date.parse(sibling.created_at);
  Object.assign(sibling, { status: "queued", conclusion: null, started_at: null, completed_at: null });
  Object.assign(jobs.find(job => job.name === "compiler and relay confinement"), { status: "queued", conclusion: null, started_at: null, completed_at: null });
  let clock = created + 45 * 60_000, pauses = 0;
  await waitForGate("js", { readJobs: async () => jobs, now: () => clock, pause: async ms => {
    pauses++; clock += ms;
    Object.assign(sibling, { status: "completed", conclusion: "success", started_at: new Date(clock - 1000).toISOString(), completed_at: new Date(clock).toISOString() });
  } });
  assert.equal(pauses, 1);
  assert.ok(gateDeadline("js", jobs, clock) > clock);
  assert.ok(gateQueueTiming("js", jobs, clock, false).runnerWaitSeconds >= 2700);
});

for (const [scope, jobName, artifact] of [["js", "shared preparation", "javascript-prepared"], ["rust", "Rust build once", "rust-tests"]]) {
  test(`${scope} preparation keeps polling beyond the old request cap while queued`, async () => {
    const env = { GITHUB_API_URL: "https://api.example.test", GITHUB_REPOSITORY: "test/repo", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "2", GITHUB_TOKEN: "fixture" };
    const jobs = passingCloudJobs();
    const build = jobs.find(job => job.name === jobName);
    let clock = Date.parse(build.created_at) + 25 * 60_000, pauses = 0;
    Object.assign(build, { status: "queued", conclusion: null, started_at: build.created_at, completed_at: null });
    const result = await waitForPreparation(scope, { env, now: () => clock,
      request: async url => ({ ok: true, json: async () => url.includes("/jobs?") ? { jobs } : { artifacts: pauses < 140 ? [] : [{ id: 42, name: `${artifact}-2`, expired: false }] } }),
      pause: async ms => {
        clock += ms;
        if (++pauses === 140) Object.assign(build, { status: "completed", conclusion: "success", started_at: new Date(clock - 1000).toISOString(), completed_at: new Date(clock).toISOString() });
      },
    });
    assert.equal(pauses, 140);
    assert.equal(result.artifact.id, 42);
    assert.equal(result.deadline, gateDeadline(scope, jobs, clock));
    assert.ok(result.deadline > clock, "native transfer inherits the extended deadline");
  });
}

test("aggregate receipts apply the same workload rule before final completed timing", async t => {
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
  const confinement = jobs.find(job => job.name === "compiler and relay confinement");
  Object.assign(confinement, { status: "in_progress", conclusion: null, completed_at: null });
  const run = (rows, finish, env = { GITHUB_SHA: commit }) => aggregateCloud("js", root.replaceAll("\\", "/"), { readJobs: async () => rows, now: () => finish, env, outputDirectory });
  const passed = await run(jobs, now);
  assert.equal(passed.complete, false);
  assert.equal(passed.seconds, 241);
  assert.equal(passed.runnerWaitSeconds, 15);
  assert.equal(passed.workloadSeconds, 226);
  const contended = structuredClone(jobs);
  for (const job of contended) if (job.name !== "what changed") {
    if (job.name === "compiler and relay confinement") job.created_at = new Date(Date.parse(job.created_at) + 900_000).toISOString();
    job.started_at = new Date(Date.parse(job.started_at) + 900_000).toISOString();
    if (job.completed_at) job.completed_at = new Date(Date.parse(job.completed_at) + 900_000).toISOString();
  }
  const adjusted = await run(contended, now + 900_000);
  assert.equal(adjusted.seconds, 1141);
  assert.equal(adjusted.runnerWaitSeconds, 915);
  assert.equal(adjusted.workloadSeconds, 226);
  const queuedProof = structuredClone(jobs);
  Object.assign(queuedProof.find(job => job.name === "compiler and relay confinement"), { status: "queued", started_at: null });
  const pending = await run(queuedProof, now);
  assert.equal(pending.runnerWaitSeconds, 104, "provisional timing uses the same stage waits as deadlines and completed timing");
  const zeroWait = structuredClone(jobs);
  zeroWait.forEach(job => { job.created_at = job.started_at; });
  await assert.rejects(run(zeroWait, Date.parse(jobs[0].started_at) + 301_000), /exceeding.*budget/u);
  const failed = JSON.parse(readFileSync(join(outputDirectory, "js-result.json"), "utf8"));
  assert.equal(failed.verdict, "FAIL");
  assert.equal(failed.seconds, 301);
  assert.equal(failed.runnerWaitSeconds, 0);
  for (const rows of [jobs.slice(1), [...jobs, jobs[0]], jobs.map(job => job.name === "JS worker 1" ? { ...job, conclusion: "cancelled" } : job)]) {
    await assert.rejects(run(rows, now), /missing or did not finish/u);
  }
  await assert.rejects(run(jobs, now, { GITHUB_SHA: "other-head" }), /requested commit/u);
});
