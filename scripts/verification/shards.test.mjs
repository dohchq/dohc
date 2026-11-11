import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertTaskCoverage, javascriptGroups, javascriptTasks, nativeTestFiles, partitionJavascript, partitionTasks } from "./shards.mjs";
import { readWorkspacePackages } from "./selection.mjs";
import { aggregateCloud, aggregateJavascript, aggregateRust, completedGateTiming, waitForGate } from "./cloud-aggregate.mjs";
import { JS_SHARDS } from "./cloud.mjs";
import { RUST_ARCHIVE_PROOFS, RUST_POLICY_STEPS, RUST_READER_SHARD, RUST_SHARDS, RUST_TEST_PROOFS, passedRustTests, rustTestInventory } from "./cloud-rust.mjs";
import { waitForPreparation } from "./wait-preparation.mjs";
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

function passingCloudJobs() {
  const { jobs } = JSON.parse(readFileSync(new URL("./fixtures/passing-cloud-jobs.json", import.meta.url), "utf8"));
  // Split the saved combined job at its artifact publication and proof start.
  const prepared = jobs.find(job => job.name === "shared preparation + confinement");
  prepared.name = "shared preparation";
  jobs.push({ ...prepared, name: "compiler and relay confinement", created_at: "2026-11-11T13:06:40Z", started_at: "2026-11-11T13:06:40Z" });
  prepared.completed_at = "2026-11-11T13:06:40Z";
  return jobs;
}

const apiEnv = { GITHUB_API_URL: "https://api.example.test", GITHUB_REPOSITORY: "test/repo", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "2", GITHUB_TOKEN: "fixture" };
const apiResponse = (value, status = 200, etag = '"fixture"') => new Response(status === 304 ? null : JSON.stringify(value), {
  status, headers: { etag, "x-ratelimit-limit": "1000", "x-ratelimit-remaining": "997", "x-ratelimit-used": "3" },
});
const withoutWaits = () => passingCloudJobs().map(job => ({ ...job, created_at: job.started_at }));

test("the saved passing run measures gate spans and confinement execution separately", () => {
  const jobs = passingCloudJobs();
  for (const [scope, seconds] of [["js", 241], ["rust", 419]]) {
    const result = completedGateTiming(scope, jobs, jobs[0].head_sha);
    assert.equal(result.spanSeconds, seconds);
    assert.equal(result.confinementSeconds, 228);
    assert.equal(result.seconds, seconds);
    assert.equal(result.contended, false);
    assert.equal(result.timing, "within budget");
    assert.ok(result.jobs.every(job => Number.isFinite(job.runnerWaitSeconds)));
  }
});

test("uncontended overruns fail; contended overruns warn without estimating workload", t => {
  const warn = t.mock.method(console, "warn", () => {});
  for (const [scope, finalJob, budget] of [["js", "typecheck + tests", 300], ["rust", "engine gate", 600]]) {
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
    assert.match(result.warning, new RegExp(`${budget + 50}s.*${budget}s.*${finalJob.replaceAll("+", "\\+")}.*31s`, "u"));
    last.completed_at = new Date(start + budget * 1000).toISOString();
    const within = completedGateTiming(scope, jobs, jobs[0].head_sha);
    assert.equal(within.contended, true);
    assert.equal(within.timing, "within budget");
    assert.equal(within.warning, undefined);
  }
  assert.equal(warn.mock.calls.length, 2);
  assert.ok(warn.mock.calls.every(call => call.arguments[0].startsWith("::warning::")));
});

test("confinement's runner queue is removed exactly, but its execution must fit", () => {
  const jobs = withoutWaits(), proof = jobs.find(job => job.name === "compiler and relay confinement");
  proof.started_at = new Date(Date.parse(proof.started_at) + 7_200_000).toISOString();
  proof.completed_at = new Date(Date.parse(proof.completed_at) + 7_200_000).toISOString();
  for (const scope of ["js", "rust"]) {
    const result = completedGateTiming(scope, jobs, jobs[0].head_sha);
    assert.equal(result.confinementSeconds, 228);
    assert.equal(result.contended, false);
    assert.equal(result.timing, "within budget");
    proof.completed_at = new Date(Date.parse(proof.completed_at) + 600_000).toISOString();
    assert.throws(() => completedGateTiming(scope, jobs, jobs[0].head_sha), error => {
      assert.equal(error.timing.confinementSeconds, 828);
      return /exceeding/u.test(error.message);
    });
    proof.completed_at = new Date(Date.parse(proof.completed_at) - 600_000).toISOString();
  }
});

test("a failed JavaScript worker leaves Rust's independent verdict visible", () => {
  const jobs = passingCloudJobs();
  jobs.find(job => job.name === "JS worker 1").conclusion = "failure";
  assert.throws(() => completedGateTiming("js", jobs, jobs[0].head_sha), /unsuccessful/u);
  assert.equal(completedGateTiming("rust", jobs, jobs[0].head_sha).timing, "within budget");
  const last = jobs.find(job => job.name === "engine gate");
  last.completed_at = new Date(Date.parse(jobs[0].started_at) + 650_000).toISOString();
  assert.throws(() => completedGateTiming("rust", jobs, jobs[0].head_sha), /exceeding/u);
});

test("negative waits clamp to zero and invalid or incomplete evidence always fails", () => {
  const jobs = withoutWaits();
  jobs.forEach(job => { job.created_at = job.completed_at; });
  assert.ok(completedGateTiming("js", jobs, jobs[0].head_sha).jobs.every(job => job.runnerWaitSeconds === 0));
  for (const scope of ["js", "rust"]) for (const mutate of [
    rows => rows.splice(rows.findIndex(job => job.name === "compiler and relay confinement"), 1),
    rows => rows.splice(rows.findIndex(job => job.name === (scope === "js" ? "JS worker 1" : "Rust tests 1")), 1),
    rows => rows.push(rows.find(job => job.name === "shared preparation")),
    ...["cancelled", "failure", "skipped"].map(conclusion => rows => { rows.find(job => job.name === "compiler and relay confinement").conclusion = conclusion; }),
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
        assert.ok(clock >= 60_000, "queued builds cannot have published artifacts");
        artifactReads++;
        if (artifactReads === 1) return apiResponse({ artifacts: [{ name: `${artifact}-1`, expired: false }, { name: `${artifact}-2`, expired: true }] }, 200, '"empty"');
        assert.equal(headers["If-None-Match"], '"empty"');
        return artifactReads === 2 ? apiResponse(null, 304) : apiResponse({ artifacts: [{ id: 42, name: `${artifact}-2`, expired: false }] });
      },
    });
    assert.equal(result.artifact.id, 42);
    assert.equal(clock, 80_000);
    assert.equal(jobReads, 2);
    assert.match(log.mock.calls.at(-1).arguments[0], /x-ratelimit-limit=1000 x-ratelimit-remaining=997 x-ratelimit-used=3 counted=4 304=1/u);
  });

  test(`${scope} preparation stops after 15 minutes with the final build state`, async () => {
    for (const state of ["queued", "in_progress"]) {
      let clock = 0, lastJobRead = -1;
      await assert.rejects(waitForPreparation(scope, { env: apiEnv, now: () => clock, pause: async ms => { clock += ms; },
        request: async url => {
          if (url.includes("/jobs?")) { lastJobRead = clock; return apiResponse({ jobs: [{ name: jobName, status: state }] }); }
          assert.equal(state, "in_progress");
          return apiResponse({ artifacts: [] });
        },
      }), new RegExp(`15-minute wait cap.*${state === "queued" ? "queued for a runner" : "running"}`, "u"));
      assert.equal(clock, 900_000);
      assert.equal(lastJobRead, 900_000);
    }
    for (const conclusion of ["failure", "cancelled", "skipped"]) await assert.rejects(waitForPreparation(scope, {
      env: apiEnv, request: async () => apiResponse({ jobs: [{ name: jobName, status: "completed", conclusion }] }),
    }), new RegExp(`ended with ${conclusion}`, "u"));
    await assert.rejects(waitForPreparation(scope, { env: apiEnv,
      request: async () => apiResponse({ jobs: [{ name: jobName }, { name: jobName }] }),
    }), /Duplicate/u);
  });
}

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
    const proof = jobs.find(job => job.name === "compiler and relay confinement");
    Object.assign(proof, { status: "queued", conclusion: null });
    await waitForGate(scope, { readJobs: async () => jobs });
    await assert.rejects(waitForGate(scope, { readJobs: async () => [...jobs, sibling] }), /Duplicate/u);
  }
});

test("aggregate job polling reuses ETags, waits 10 seconds, and logs rate usage", async t => {
  const jobs = passingCloudJobs(), sibling = jobs.find(job => job.name === "JS worker 1");
  Object.assign(sibling, { status: "in_progress", conclusion: null });
  let clock = 0, reads = 0;
  const log = t.mock.method(console, "log", () => {});
  await waitForGate("js", { env: apiEnv, now: () => clock, pause: async ms => { assert.equal(ms, 10_000); clock += ms; },
    request: async (url, { headers }) => {
      reads++;
      if (reads === 1) return apiResponse({ jobs }, 200, '"pending"');
      assert.equal(headers["If-None-Match"], '"pending"');
      if (reads === 2) return apiResponse(null, 304);
      Object.assign(sibling, { status: "completed", conclusion: "success" });
      return apiResponse({ jobs });
    },
  });
  assert.equal(clock, 20_000);
  assert.match(log.mock.calls.at(-1).arguments[0], /counted=2 304=1/u);
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
  const confinement = jobs.find(job => job.name === "compiler and relay confinement");
  Object.assign(confinement, { status: "in_progress", conclusion: null, completed_at: null });
  const run = (rows, finish, env = { GITHUB_SHA: commit }) => aggregateCloud("js", root.replaceAll("\\", "/"), { readJobs: async () => rows, now: () => finish, env, outputDirectory });
  const passed = await run(jobs, now);
  assert.equal(passed.complete, false);
  assert.equal(passed.seconds, 241);
  assert.equal(passed.spanSeconds, 241);
  assert.equal(passed.confinementSeconds, null);
  assert.equal(passed.timing, "within budget");
  const contended = structuredClone(jobs);
  for (const job of contended) if (job.name !== "what changed") {
    if (job.name === "compiler and relay confinement") job.created_at = new Date(Date.parse(job.created_at) + 900_000).toISOString();
    job.started_at = new Date(Date.parse(job.started_at) + 900_000).toISOString();
    if (job.completed_at) job.completed_at = new Date(Date.parse(job.completed_at) + 900_000).toISOString();
  }
  const adjusted = await run(contended, now + 900_000);
  assert.equal(adjusted.seconds, 1141);
  assert.equal(adjusted.timing, "unmeasured");
  assert.equal(adjusted.contended, true);
  const queuedProof = structuredClone(jobs);
  Object.assign(queuedProof.find(job => job.name === "compiler and relay confinement"), { status: "queued", started_at: null });
  const pending = await run(queuedProof, now);
  assert.equal(pending.seconds, 241, "queued confinement cannot change provisional timing");
  const zeroWait = structuredClone(jobs);
  zeroWait.forEach(job => { job.created_at = job.started_at; });
  await assert.rejects(run(zeroWait, Date.parse(jobs[0].started_at) + 301_000), /exceeding.*budget/u);
  const failed = JSON.parse(readFileSync(join(outputDirectory, "js-result.json"), "utf8"));
  assert.equal(failed.verdict, "FAIL");
  assert.equal(failed.seconds, 301);
  assert.equal(failed.contended, false);
  for (const rows of [jobs.slice(1), [...jobs, jobs[0]], jobs.map(job => job.name === "JS worker 1" ? { ...job, conclusion: "cancelled" } : job)]) {
    await assert.rejects(run(rows, now), /missing or did not finish/u);
  }
  await assert.rejects(run(jobs, now, { GITHUB_SHA: "other-head" }), /requested commit/u);
});
