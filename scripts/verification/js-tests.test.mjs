import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runBounded, testPlan } from "./js-tests.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((pass, fail) => { resolve = pass; reject = fail; });
  return { promise, resolve, reject };
}

test("package scheduling bounds concurrency and serializes shared database consumers", async () => {
  const tasks = [{name: "db-one", resource: "postgres"}, {name: "db-two", resource: "postgres"}, {name: "disk"}, {name: "last"}];
  const controls = new Map(tasks.map(task => [task.name, deferred()]));
  const started = [], active = new Set();
  const arrivals = new Map(tasks.map(task => [task.name, deferred()]));
  const run = runBounded(tasks, async task => {
    started.push(task.name); active.add(task.name); arrivals.get(task.name).resolve();
    assert.ok(active.size <= 2);
    assert.ok(!(active.has("db-one") && active.has("db-two")));
    await controls.get(task.name).promise;
    active.delete(task.name);
  });
  await arrivals.get("disk").promise;
  assert.deepEqual(started, ["db-one", "disk"]);
  controls.get("db-one").resolve();
  await arrivals.get("db-two").promise;
  assert.deepEqual(started, ["db-one", "disk", "db-two"]);
  controls.get("disk").resolve();
  await arrivals.get("last").promise;
  controls.get("db-two").resolve(); controls.get("last").resolve();
  await run;
  assert.equal(active.size, 0);
});

test("a failed package stops admission and waits for its running sibling", async () => {
  const failure = new Error("package failed"), sibling = deferred(), entered = deferred(), started = [];
  const run = runBounded([{name:"fail"}, {name:"sibling"}, {name:"must-not-start"}], async task => {
    started.push(task.name);
    if (task.name === "fail") { await entered.promise; throw failure; }
    entered.resolve();
    await sibling.promise;
  });
  // Observe rejection immediately so the test cannot create an unhandled rejection.
  const outcome = run.then(() => assert.fail("must fail"), error => assert.equal(error, failure));
  await entered.promise;
  sibling.resolve();
  await outcome;
  assert.deepEqual(started, ["fail", "sibling"]);
});

test("the plan retains every package test and preserves stricter worker caps", () => {
  const pkg = (name, scripts = {test: "vitest run"}) => ({name: `@dohc/${name}`, manifest: {scripts}});
  const tasks = testPlan([pkg("future-package"), pkg("workspace-auth"), pkg("workspace-postgres"), pkg("share-web"), pkg("workspace-api"),
    pkg("app-backend-runtime", {test: "build then test", "test:prepared": "vitest run"}),
    pkg("desktop", {test: "unit then scripts", "test:unit": "vitest run"}), pkg("ydoc-projection"), pkg("no-tests", {})]);
  assert.equal(tasks.length, 8);
  assert.equal(tasks[0].name, "@dohc/ydoc-projection");
  assert.equal(tasks[1].name, "@dohc/desktop");
  assert.equal(tasks.find(task => task.name === "@dohc/app-backend-runtime").args.at(-1), "--maxWorkers=2");
  assert.equal(tasks.find(task => task.name === "@dohc/future-package").script, "test");
  assert.equal(tasks.filter(task => task.resource === "postgres").length, 4);
  assert.throws(() => testPlan([pkg("desktop")]), /Missing test:unit/);
});

for (const {name, cancel = false, selectedPackages} of [
  {name:"workspace runner completes prerequisites and repository tests before package readers"},
  {name:"cancellation rejects queued packages before launching their commands",cancel:true},
  {name:"selected packages run without unrelated desktop or runtime tests",selectedPackages:["@dohc/new-package"]},
  {name:"selected desktop tests retain their final script tests",selectedPackages:["@dohc/desktop"]},
  {name:"an explicit empty selection still runs repository checks",selectedPackages:[]},
  {name:"a selected package without tests still runs repository checks",selectedPackages:["@dohc/no-tests"]},
  {name:"a selected package missing from inventory fails before any package runs",selectedPackages:["@dohc/missing"]},
]) test(name, () => {
  const missing = selectedPackages?.includes("@dohc/missing");
  const expectedPackages = (selectedPackages ?? ["@dohc/desktop", "@dohc/app-backend-runtime", "@dohc/new-package"])
    .filter(name => name !== "@dohc/no-tests");
  const root = mkdtempSync(join(tmpdir(), "dohc-js-schedule-"));
  const put = (path, data) => { mkdirSync(dirname(join(root, path)), {recursive:true}); writeFileSync(join(root, path), data); };
  try {
    put("package.json", '{"type":"module","scripts":{"test":"node scripts/verification/js-tests.mjs"}}');
    for (const file of ["js-tests.mjs", "timing.mjs", "cancellation.mjs"]) {
      mkdirSync(join(root, "scripts/verification"), {recursive:true});
      copyFileSync(new URL(file, import.meta.url), join(root, "scripts/verification", file));
    }
    put("apps/desktop/package.json", JSON.stringify({scripts:{test:"unused", "test:unit":"vitest run", "test:scripts":"scripts"}}));
    put("packages/app-backend-runtime/package.json", JSON.stringify({scripts:{test:"unused", "test:prepared":"vitest run"}}));
    put("packages/new-package/package.json", JSON.stringify({scripts:{test:"vitest run"}}));
    put("packages/no-tests/package.json", "{}");
    put("scripts/verification/process.mjs", `
      import assert from 'node:assert/strict';
      import {appendFileSync,writeFileSync,existsSync} from 'node:fs';
      import {resolve} from 'node:path';
      export const repoRoot=resolve(import.meta.dirname,'../..');
      export const pnpm=args=>['pnpm',args];
      const completed=new Set();
      export async function run(command,args) {
        appendFileSync('commands.jsonl',JSON.stringify(args)+'\\n');
        if(args.includes('build')){completed.add(args[1]);return {stdout:''};}
        assert.ok(completed.has('@dohc/sdk') && completed.has('@dohc/app-backend-runtime'));
        if(args[1]==='test:repo'){writeFileSync('repository-complete','yes');return {stdout:''};}
        assert.ok(existsSync('repository-complete'));
        if(args.includes('list'))return {stdout:JSON.stringify([
          {name:'dohc',path:process.platform==='win32'?repoRoot.toUpperCase():repoRoot}, {name:'@dohc/desktop',path:resolve('apps/desktop')},
          {name:'@dohc/app-backend-runtime',path:resolve('packages/app-backend-runtime')},
          {name:'@dohc/new-package',path:resolve('packages/new-package')},
          {name:'@dohc/no-tests',path:resolve('packages/no-tests')}
        ])};
        if(args.includes('test:unit') && process.env.FIXTURE_CANCEL==='1') {
          process.emit('SIGINT');
          throw Error('fixture command interrupted');
        }
        if(args.includes('test:scripts'))assert.ok(${JSON.stringify(expectedPackages)}.every(name=>completed.has('test:'+name)));
        else completed.add('test:'+args[1]);
        return {stdout:''};
      }
    `);
    const args = selectedPackages === undefined ? ["scripts/verification/js-tests.mjs", "--output", "evidence"] : ["--input-type=module", "-e", `
      import {testWorkspace} from './scripts/verification/js-tests.mjs';
      try {await testWorkspace({output:'evidence',selectedPackages:${JSON.stringify(selectedPackages)}});}
      catch(error){console.error(error.message);process.exitCode=1;}
    `];
    const result = spawnSync(process.execPath, args, {
      cwd:root, encoding:"utf8", timeout:20_000, env:{...process.env, FIXTURE_CANCEL:cancel ? "1" : "0"},
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, cancel ? 130 : missing ? 1 : 0, result.stderr);
    const report = JSON.parse(readFileSync(join(root, "evidence/result.json"), "utf8"));
    assert.equal(report.verdict, cancel || missing ? "FAIL" : "PASS");
    const commands = readFileSync(join(root,"commands.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
    if (missing) {
      assert.match(report.error,/selected workspace package is missing/);
      assert.equal(commands.some(args=>args[2]==="run"),false);
    } else assert.deepEqual(report.packages.map(pkg=>pkg.name).sort(),expectedPackages.toSorted());
    if (cancel) {
      assert.match(report.error, /interrupted/);
      assert.equal(commands.some(args => args.includes("test:scripts") || args.includes("test:prepared") || args.includes("test")), false);
      assert.equal(report.steps.at(-1).verdict, "FAIL");
    } else if (!missing) {
      if (selectedPackages !== undefined) assert.deepEqual(report.selectedPackages,selectedPackages);
      assert.deepEqual(commands.filter(args=>args[2]==="run" && args[3]!=="test:scripts").map(args=>args[1]).sort(),expectedPackages.toSorted());
      assert.equal(commands.some(args=>args.includes("test:scripts")),expectedPackages.includes("@dohc/desktop"));
      assert.ok(report.steps.every(step => step.verdict === "PASS"));
    }
    assert.ok(report.steps.every(step => step.seconds >= 0 && step.finishedAt));
    assert.ok(report.seconds >= Math.max(...report.steps.map(step => step.seconds)));
  } finally { rmSync(root, {recursive:true, force:true}); }
});
