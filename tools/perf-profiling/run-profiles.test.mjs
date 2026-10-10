import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createSummary, runProfilingScenarios } from "./run-profiles.mjs";

async function commandFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "dohc-profile-report-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const put = async (path, source) => {
    const target = join(root, path);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, source);
  };
  await put("package.json", '{"type":"module"}');
  return {root, put};
}

test("relay profiling preserves interruption evidence with missing or incomplete measurements", async t => {
  for (const contents of [null, "{", '{"measurements":{"partial":true}}']) await t.test(String(contents), async context => {
    const {root, put} = await commandFixture(context);
    await put("tools/perf-profiling/live-authorship-sync.mjs", await readFile(new URL("./live-authorship-sync.mjs", import.meta.url)));
    await put("services/sync-relay/package.json", "{}");
    await put("services/sync-relay/src/storage/liveUpdateJournal.ts", "export const fixture = 1;");
    await put("services/sync-relay/src/storage/readRevision.ts", "export const fixture = 1;");
    await put("tools/perf-profiling/live-authorship-sync.bench.ts", "export const fixture = 1;");
    await put("baseline.ts", "export const fixture = 1;");
    await put("node_modules/vitest/package.json", '{"name":"vitest"}');
    await put("node_modules/yjs/package.json", '{"name":"yjs","main":"yjs.cjs"}');
    await put("node_modules/yjs/yjs.cjs", "");
    await put("tools/perf-profiling/admission.mjs", `
      import {writeFileSync} from 'node:fs';
      export const acquireProfilingSlot=()=>({signal:new AbortController().signal,evidence:{scope:'fixture host context'},
        check(){},update(){},release(){writeFileSync(new URL('../../released',import.meta.url),'released');}});
    `);
    await put("scripts/verification/process.mjs", `
      import {writeFileSync} from 'node:fs';
      export const pnpm=args=>['pnpm',args];
      export async function run(command) {
        if(command==='pnpm')return {};
        if(${JSON.stringify(contents)}!==null)writeFileSync(new URL('../../results/result.json',import.meta.url),${JSON.stringify(contents)});
        throw Error('fixture benchmark interrupted');
      }
    `);
    const result = spawnSync(process.execPath, [join(root, "tools/perf-profiling/live-authorship-sync.mjs"),
      "--baseline-source", "baseline.ts", "--output", "results"], {cwd: root, encoding: "utf8", timeout: 10000});
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /fixture benchmark interrupted/);
    const receipt = JSON.parse(await readFile(join(root, "results/result.json"), "utf8"));
    assert.equal(receipt.status, "failed");
    assert.match(receipt.error, /fixture benchmark interrupted/);
    assert.equal(receipt.hostContext.scope, "fixture host context");
    if (contents?.includes("partial")) assert.equal(receipt.measurements.partial, true);
    assert.equal(existsSync(join(root, "released")), true);
    for (const path of ["baseline.runtime.ts", "admission.test.ts", "vitest.config.mjs"])
      assert.equal(existsSync(join(root, "results", path)), false, path);
  });
});

test("Rust profiling inspects every prepared scratch root without launching Cargo", async t => {
  for (const fault of ["none", "removed", "preflight", "context-unavailable"]) await t.test(fault, async context => {
    const {root, put} = await commandFixture(context);
    await put("tools/rust-engine-program/run-rust-profile.mjs", await readFile(new URL("../rust-engine-program/run-rust-profile.mjs", import.meta.url)));
    await put("tools/rust-engine-program/scratch-leak-report.mjs", await readFile(new URL("../rust-engine-program/scratch-leak-report.mjs", import.meta.url)));
    await put("scripts/verification/build.mjs", `export async function withBuildBudget(run){
      if(${JSON.stringify(fault)}==='preflight')throw Error('fixture admission denied');return run({});}`);
    await put("scripts/verification/cancellation.mjs", "export const cancellationScope=()=>({checkpoint:async()=>{},dispose:async()=>null});");
    await put("tools/rust-engine-program/tree-provenance.mjs", "export const readTreeState=()=>({});export const classifyTreeProvenance=()=>({status:'PASS'});");
    await put("tools/rust-engine-program/native-target.mjs", "export const verifyNativeTarget=()=>({ok:true});");
    await put("tools/perf-profiling/admission.mjs", `export function profilingHostContext(){
      if(${JSON.stringify(fault)}==='context-unavailable')throw Error('fixture queue unreadable');
      return {at:new Date().toISOString(),lanes:[{kind:'build-slot',owners:[{pid:process.pid}],
        waiters:[{pid:1,purpose:'fixture contention'}]}]};}`);
    await put("scripts/verification/process.mjs", `
      import {existsSync} from 'node:fs';
      import {rm} from 'node:fs/promises';
      import {fileURLToPath} from 'node:url';
      export const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
      export const git=()=>'';
      export async function run(command,args,{env}) {
        if(command!=='cargo')throw Error('Unexpected fixture command');
        if(!existsSync(env.DOHC_TEST_SCRATCH_ROOT))throw Error('Scratch was not prepared');
        if(args[0]==='nextest'&&${JSON.stringify(fault)}==='removed')await rm(env.DOHC_TEST_SCRATCH_ROOT,{recursive:true,force:true});
        return {code:0,stdout:'fixture cfg',stderr:''};
      }
    `);
    const result = spawnSync(process.execPath, [join(root, "tools/rust-engine-program/run-rust-profile.mjs"),
      "fixture", "--", "-p", "fixture-package"], {cwd: root, encoding: "utf8", timeout: 10000});
    const pass = ["none", "context-unavailable"].includes(fault);
    assert.equal(result.status, pass ? 0 : 1, result.stderr);
    const receiptPath = result.stdout.match(/separately: (.+result\.json)/u)?.[1];
    assert.ok(receiptPath, result.stdout);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.verdict, pass ? "PASS" : "FAIL");
    assert.match(receipt.hostContext.scope, /does not certify an idle host/);
    assert.deepEqual(receipt.hostContext.observations.map(reading => reading.phase), fault === "preflight"
      ? ["before-admission", "finished"] : ["before-admission", "admitted", "tests-start", "tests-finished", "finished"]);
    for (const reading of receipt.hostContext.observations) {
      if (fault === "context-unavailable") {
        assert.match(reading.error, /fixture queue unreadable/);
        assert.equal(reading.lanes, null);
      } else assert.equal(reading.lanes[0].waiters[0].purpose, "fixture contention");
    }
    if (fault === "preflight") {
      assert.match(receipt.error, /fixture admission denied/);
      assert.equal(receipt.scratch, undefined);
    } else {
      assert.equal(receipt.scratch.status, pass ? "PASS" : "FAIL");
      if (fault === "removed") assert.match(receipt.scratch.reason, /does not exist/);
    }
  });
});

test("a successful Playwright run without a fresh artifact is a failure", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "dohc-run-profiles-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const scenario = { artifact: "skipped-profile", spec: "skipped-profile.spec.ts" };
  await writeFile(join(output, `${scenario.artifact}.json`), "stale\n");

  const failures = await runProfilingScenarios({
    output,
    headed: false,
    env: {},
    scenarios: [scenario],
    execute: async () => {},
  });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].scenario, scenario.artifact);
  assert.match(failures[0].error, /did not produce.*skipped-profile\.json/i);
});

test("a summary cannot be complete when an artifact is missing", () => {
  const scenario = { artifact: "switch-profile", spec: "switch-profile.spec.ts" };
  const summary = createSummary({}, [], {}, [scenario]);

  assert.equal(summary.complete, false);
  assert.equal(summary.scenarios.switch, null);
});

test("a partial profile without fixture metadata still produces a summary", () => {
  const artifacts = {
    "excalidraw-profile": { measurements: {} },
    "bigdoc-profile": { measurements: {} },
    "bigdoc-read-profile": { measurements: {} },
  };

  const summary = createSummary({}, [], artifacts, []);

  assert.equal(summary.scenarios.excalidraw.elementCount, null);
  assert.equal(summary.scenarios.bigDoc.bytes, null);
  assert.equal(summary.scenarios.bigDocRead.bytes, null);
});

test("a fresh artifact permits a complete summary", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "dohc-run-profiles-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const scenario = { artifact: "fresh-profile", spec: "fresh-profile.spec.ts" };
  const artifact = { measurements: {} };

  const failures = await runProfilingScenarios({
    output,
    headed: false,
    env: {},
    scenarios: [scenario],
    execute: async () => {
      await writeFile(join(output, `${scenario.artifact}.json`), JSON.stringify(artifact));
    },
  });
  const summary = createSummary(
    {},
    failures,
    { [scenario.artifact]: artifact },
    [scenario],
  );

  assert.deepEqual(failures, []);
  assert.equal(summary.complete, true);
});

test("a successful profiling run removes mutable workspaces but keeps artifacts", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "dohc-run-profiles-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const scenario = { artifact: "clean-profile", spec: "clean-profile.spec.ts" };
  const artifactPath = join(output, `${scenario.artifact}.json`);
  const enginePath = join(output, "workspaces", "big-docs", ".dohc", "engine");

  const failures = await runProfilingScenarios({
    output,
    headed: false,
    env: {},
    scenarios: [scenario],
    execute: async () => {
      await mkdir(enginePath, { recursive: true });
      await writeFile(join(enginePath, "engine.db"), "mutable engine state");
      await writeFile(artifactPath, '{"measurements":{"elapsedMs":1}}\n');
    },
  });

  assert.deepEqual(failures, []);
  assert.equal(existsSync(join(output, "workspaces")), false);
  assert.equal(
    await readFile(artifactPath, "utf8"),
    '{"measurements":{"elapsedMs":1}}\n',
  );
});

test("a failed profiling run removes mutable workspaces but keeps artifacts", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "dohc-run-profiles-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const scenario = { artifact: "failed-profile", spec: "failed-profile.spec.ts" };
  const artifactPath = join(output, `${scenario.artifact}.json`);
  const enginePath = join(output, "workspaces", "big-docs", ".dohc", "engine");

  const failures = await runProfilingScenarios({
    output,
    headed: false,
    env: {},
    scenarios: [scenario],
    execute: async () => {
      await mkdir(enginePath, { recursive: true });
      await writeFile(join(enginePath, "engine.db"), "mutable engine state");
      await writeFile(artifactPath, '{"measurements":{"partial":true}}\n');
      throw new Error("profile process failed");
    },
  });

  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /profile process failed/);
  assert.equal(existsSync(join(output, "workspaces")), false);
  assert.equal(
    await readFile(artifactPath, "utf8"),
    '{"measurements":{"partial":true}}\n',
  );
});

test("an unexpected runner failure still removes mutable workspaces", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "dohc-run-profiles-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const scenario = { artifact: "partial-profile", spec: "partial-profile.spec.ts" };
  const artifactPath = join(output, `${scenario.artifact}.json`);
  const enginePath = join(output, "workspaces", "big-docs", ".dohc", "engine");
  function* interruptedScenarios() {
    yield scenario;
    throw new Error("scenario enumeration failed");
  }

  await assert.rejects(
    runProfilingScenarios({
      output,
      headed: false,
      env: {},
      scenarios: interruptedScenarios(),
      execute: async () => {
        await mkdir(enginePath, { recursive: true });
        await writeFile(join(enginePath, "engine.db"), "mutable engine state");
        await writeFile(artifactPath, '{"measurements":{"partial":true}}\n');
      },
    }),
    /scenario enumeration failed/,
  );

  assert.equal(existsSync(join(output, "workspaces")), false);
  assert.equal(
    await readFile(artifactPath, "utf8"),
    '{"measurements":{"partial":true}}\n',
  );
});
