import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("file selection reaches Vitest and refuses unsupported or empty scopes", () => {
  const packages = [{name: "@dohc/fixture", manifest: {scripts: {test: "vitest run"}}}];
  const files = ["src/one.test.ts", "src/nested/two.test.ts"];
  assert.deepEqual(testPlan(packages, {"@dohc/fixture": files})[0].args.slice(-2), files);
  assert.equal(testPlan(packages)[0].files, undefined);
  assert.throws(() => testPlan(packages, {"@dohc/fixture": []}), /Invalid test file selection/);
  assert.throws(() => testPlan(packages, {missing: files}), /No selected test package/);
  assert.throws(() => testPlan([{name: "fixture", manifest: {scripts: {test: "node tests.js"}}}], {fixture: files}), /Invalid test file selection/);
});

for (const {name, cancel = false, selectedPackages, testFiles, missingFile = false, repoFail = false, packageFail = false, overlap = false} of [
  {name:"repository tests run beside the package tests and finish before the packaging step",overlap:true},
  {name:"cancellation rejects queued packages before launching their commands",cancel:true,overlap:true},
  {name:"selected packages run without unrelated desktop or runtime tests",selectedPackages:["@dohc/new-package"]},
  {name:"selected desktop tests retain their final script tests",selectedPackages:["@dohc/desktop"]},
  {name:"an explicit empty selection still runs repository checks",selectedPackages:[]},
  {name:"a selected package without tests still runs repository checks",selectedPackages:["@dohc/no-tests"]},
  {name:"a selected package missing from inventory fails before any package runs",selectedPackages:["@dohc/missing"]},
  {name:"selected test files reach the command and the evidence",selectedPackages:["@dohc/new-package"],testFiles:{"@dohc/new-package":["src/selected.test.ts"]}},
  {name:"a missing selected test file fails before any package runs",selectedPackages:["@dohc/new-package"],testFiles:{"@dohc/new-package":["src/selected.test.ts"]},missingFile:true},
  {name:"a repository failure stops new commands and skips the packaging step",repoFail:true,overlap:true},
  {name:"the first failure in time is the one reported",repoFail:true,packageFail:true,overlap:true},
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
    if (!missingFile) put("packages/new-package/src/selected.test.ts", "// fixture test\n");
    put("packages/no-tests/package.json", "{}");
    put("scripts/verification/process.mjs", `
      import assert from 'node:assert/strict';
      import {appendFileSync,writeFileSync,existsSync} from 'node:fs';
      import {resolve} from 'node:path';
      export const repoRoot=resolve(import.meta.dirname,'../..');
      export const pnpm=args=>['pnpm',args];
      const completed=new Set();
      const waitFor=async file=>{for(let i=0;i<200&&!existsSync(file);i++)await new Promise(r=>setTimeout(r,50));};
      export async function run(command,args) {
        appendFileSync('commands.jsonl',JSON.stringify(args)+'\\n');
        if(args.includes('build')){completed.add(args[1]);return {stdout:''};}
        assert.ok(completed.has('@dohc/app-backend-runtime'));
        if(args[1]==='test:repo'){
          // Held open until a package starts (or fails), so the lanes must overlap.
          if(process.env.FIXTURE_OVERLAP==='1'){
            await waitFor(process.env.FIXTURE_PACKAGE_FAIL==='1'?'package-failed':'package-started');
            if(existsSync('package-started'))writeFileSync('repository-saw-package','yes');
          }
          if(process.env.FIXTURE_REPO_FAIL==='1')throw Error('fixture repository failed');
          writeFileSync('repository-complete','yes');return {stdout:''};
        }
        if(args.includes('list'))return {stdout:JSON.stringify([
          {name:'dohc',path:process.platform==='win32'?repoRoot.toUpperCase():repoRoot}, {name:'@dohc/desktop',path:resolve('apps/desktop')},
          {name:'@dohc/app-backend-runtime',path:resolve('packages/app-backend-runtime')},
          {name:'@dohc/new-package',path:resolve('packages/new-package')},
          {name:'@dohc/no-tests',path:resolve('packages/no-tests')}
        ])};
        if(args[2]==='run')writeFileSync('package-started','yes');
        if(args[1]==='@dohc/new-package' && process.env.FIXTURE_PACKAGE_FAIL==='1'){writeFileSync('package-failed','yes');throw Error('fixture package failed');}
        if(args.includes('test:unit') && process.env.FIXTURE_CANCEL==='1') {
          process.emit('SIGINT');
          throw Error('fixture command interrupted');
        }
        if(args.includes('test:scripts'))assert.ok(existsSync('repository-complete') && ${JSON.stringify(expectedPackages)}.every(name=>completed.has('test:'+name)));
        else completed.add('test:'+args[1]);
        return {stdout:''};
      }
    `);
    const args = selectedPackages === undefined ? ["scripts/verification/js-tests.mjs", "--output", "evidence"] : ["--input-type=module", "-e", `
      import {testWorkspace} from './scripts/verification/js-tests.mjs';
      try {await testWorkspace({output:'evidence',selectedPackages:${JSON.stringify(selectedPackages)},testFiles:${JSON.stringify(testFiles)}});}
      catch(error){console.error(error.message);process.exitCode=1;}
    `];
    const result = spawnSync(process.execPath, args, {
      cwd:root, encoding:"utf8", timeout:20_000, env:{...process.env, FIXTURE_CANCEL:cancel ? "1" : "0", FIXTURE_REPO_FAIL:repoFail ? "1" : "0",
        FIXTURE_PACKAGE_FAIL:packageFail ? "1" : "0", FIXTURE_OVERLAP:overlap ? "1" : "0"},
    });
    assert.equal(result.error, undefined);
    const failed = missing || missingFile || repoFail || packageFail;
    assert.equal(result.status, cancel ? 130 : failed ? 1 : 0, result.stderr);
    const report = JSON.parse(readFileSync(join(root, "evidence/result.json"), "utf8"));
    assert.equal(report.verdict, cancel || failed ? "FAIL" : "PASS");
    if (overlap && !cancel) assert.ok(existsSync(join(root, "repository-saw-package")), "the repository lane must still be open when a package starts");
    const commands = readFileSync(join(root,"commands.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
    if (missing || missingFile) {
      assert.match(report.error,missing ? /selected workspace package is missing/ : /Selected test file is missing/);
      assert.equal(commands.some(args=>args[2]==="run"),false);
    } else assert.deepEqual(report.packages.map(pkg=>pkg.name).sort(),expectedPackages.toSorted());
    if (cancel) {
      assert.match(report.error, /interrupted/);
      assert.equal(commands.some(args => args.includes("test:scripts") || args.includes("test:prepared") || args.includes("test")), false);
      assert.equal(report.steps.at(-1).verdict, "FAIL");
    } else if (repoFail) {
      assert.match(report.error, packageFail ? /fixture package failed/ : /fixture repository failed/);
      assert.equal(commands.some(args=>args.includes("test:scripts")),false);
    } else if (!missing && !missingFile) {
      if (selectedPackages !== undefined) assert.deepEqual(report.selectedPackages,selectedPackages);
      assert.deepEqual(commands.filter(args=>args[2]==="run" && args[3]!=="test:scripts").map(args=>args[1]).sort(),expectedPackages.toSorted());
      assert.equal(commands.some(args=>args.includes("test:scripts")),expectedPackages.includes("@dohc/desktop"));
      assert.ok(report.steps.every(step => step.verdict === "PASS"));
      if (testFiles) {
        assert.deepEqual(report.packages[0].files, testFiles["@dohc/new-package"]);
        assert.equal(commands.find(args=>args[2]==="run").at(-1), "src/selected.test.ts");
      }
    }
    assert.ok(report.steps.every(step => step.seconds >= 0 && step.finishedAt));
    assert.ok(report.seconds >= Math.max(...report.steps.map(step => step.seconds)));
  } finally { rmSync(root, {recursive:true, force:true}); }
});
