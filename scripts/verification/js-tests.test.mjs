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

for (const cancel of [false, true]) test(cancel ? "cancellation rejects queued packages before launching their commands" : "workspace runner completes prerequisites and repository tests before package readers", () => {
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
          {name:'@dohc/new-package',path:resolve('packages/new-package')}
        ])};
        if(args.includes('test:unit') && process.env.FIXTURE_CANCEL==='1') {
          process.emit('SIGINT');
          throw Error('fixture command interrupted');
        }
        if(args.includes('test:scripts'))assert.ok(completed.has('test:@dohc/new-package') && completed.has('test:@dohc/app-backend-runtime') && completed.has('test:@dohc/desktop'));
        else completed.add('test:'+args[1]);
        return {stdout:''};
      }
    `);
    const result = spawnSync(process.execPath, ["scripts/verification/js-tests.mjs", "--output", "evidence"], {
      cwd:root, encoding:"utf8", timeout:20_000, env:{...process.env, FIXTURE_CANCEL:cancel ? "1" : "0"},
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, cancel ? 130 : 0, result.stderr);
    const report = JSON.parse(readFileSync(join(root, "evidence/result.json"), "utf8"));
    assert.equal(report.verdict, cancel ? "FAIL" : "PASS");
    assert.equal(report.packages.length, 3);
    if (cancel) {
      assert.match(report.error, /interrupted/);
      const commands = readFileSync(join(root,"commands.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
      assert.equal(commands.some(args => args.includes("test:scripts") || args.includes("test:prepared") || args.includes("test")), false);
      assert.equal(report.steps.at(-1).verdict, "FAIL");
    } else {
      assert.equal(report.steps.at(-1).name, "desktop-scripts");
      assert.ok(report.steps.every(step => step.verdict === "PASS"));
    }
    assert.ok(report.steps.every(step => step.seconds >= 0 && step.finishedAt));
    assert.ok(report.seconds >= Math.max(...report.steps.map(step => step.seconds)));
  } finally { rmSync(root, {recursive:true, force:true}); }
});
