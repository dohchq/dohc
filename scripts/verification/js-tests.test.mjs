import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cancellationScope } from "./cancellation.mjs";
import { runBounded, testPlan, testWorkspace } from "./js-tests.mjs";
import { affectedPackages, packageReferences, readWorkspacePackages, rootInputs } from "./selection.mjs";

test("a malformed proof continuation cannot silently omit proofs", async () => {
  await assert.rejects(testWorkspace({runProofs: true}), /runProofs must be a function/);
});

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

test("a node:test step that failed only in its tests runs once more and records them as flaky", t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-js-rerun-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts/verification"), { recursive: true });
  for (const file of ["js-tests.mjs", "timing.mjs", "cancellation.mjs", "flaky.mjs", "selection.mjs"]) copyFileSync(new URL(file, import.meta.url), join(root, "scripts/verification", file));
  mkdirSync(join(root, "packages/tail"), { recursive: true });
  writeFileSync(join(root, "packages/tail/package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  // The fake repository step fails in a test the first time and passes the second; a check failure always fails.
  writeFileSync(join(root, "scripts/verification/process.mjs", ), `
    import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
    import {resolve} from 'node:path';
    export const repoRoot=resolve(import.meta.dirname,'../..');
    export const pnpm=args=>['pnpm',args];
    export const calls=[];
    export async function run(_command,args,{log}){
      calls.push(args.join(' '));
      if(args.includes('list'))return {stdout:JSON.stringify([{name:'@dohc/tail',path:resolve('packages/tail')}])};
      if(args.includes('test:repo')&&process.env.SCENARIO==='check'){writeFileSync(log,'check-brand: 2 files use the old name');throw Object.assign(Error('check failed'),{commandExitFailure:true});}
      if(args.includes('test:repo')&&!existsSync('ran')){writeFileSync('ran','');writeFileSync(log,'✖ failing tests:\\n\\n✖ times out under load (30231ms)\\n');throw Object.assign(Error('tests failed'),{commandExitFailure:true});}
      writeFileSync(log,'ok');return {stdout:''};
    }
  `);
  writeFileSync(join(root, "driver.mjs"), `
    import {readFileSync} from 'node:fs';
    import {testWorkspace} from './scripts/verification/js-tests.mjs';
    import {calls} from './scripts/verification/process.mjs';
    await testWorkspace({prepared:true,output:'evidence'}).catch(error=>console.log('ERROR',error.message));
    const report=JSON.parse(readFileSync('evidence/result.json','utf8'));
    console.log(JSON.stringify({repo:calls.filter(call=>call.includes('test:repo')).length,flaky:report.flaky}));
  `);
  const drive = scenario => {
    rmSync(join(root, "ran"), { force: true });
    rmSync(join(root, "evidence"), { recursive: true, force: true });
    const result = spawnSync(process.execPath, ["driver.mjs"], { cwd: root, encoding: "utf8", timeout: 20_000, env: { ...process.env, SCENARIO: scenario } });
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  };
  assert.deepEqual(drive("flaky"), { repo: 2, flaky: [{ step: "repository", test: "times out under load" }] });
  assert.deepEqual(drive("check"), { repo: 1, flaky: [] });
});

test("a confirmed failure stops the running steps unless the run keeps going, and a retried pass does not", t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-js-stop-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts/verification"), { recursive: true });
  for (const file of ["js-tests.mjs", "timing.mjs", "cancellation.mjs", "flaky.mjs", "selection.mjs"]) copyFileSync(new URL(file, import.meta.url), join(root, "scripts/verification", file));
  for (const name of ["a-fail", "b-sibling", "c-queued"]) {
    mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(join(root, "packages", name, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  }
  // Running commands hold until the failure. A stop interrupts them as run() does; otherwise they finish.
  writeFileSync(join(root, "scripts/verification/process.mjs"), `
    import {existsSync,writeFileSync} from 'node:fs';
    import {resolve} from 'node:path';
    export const repoRoot=resolve(import.meta.dirname,'../..');
    export const pnpm=args=>['pnpm',args];
    const scenario=process.env.SCENARIO;
    async function until(file,signal){
      while(!existsSync(file)){
        if(signal.aborted)throw Object.assign(Error('pnpm failed (interrupted).'),{interrupted:true});
        await new Promise(done=>setTimeout(done,10));
      }
    }
    export async function run(_command,args,{log,signal}){
      if(args.includes('list'))return {stdout:JSON.stringify(['a-fail','b-sibling','c-queued'].map(name=>({name:'@dohc/'+name,path:resolve('packages',name)})))};
      const name=args[0]==='run'?'repository':args[1];
      writeFileSync(log,'ok');
      if(scenario==='flaky'){
        if(name==='repository'&&!existsSync('ran')){writeFileSync('ran','');await until('sibling-started',signal);writeFileSync(log,'✖ failing tests:\\n\\n✖ times out under load (30231ms)\\n');throw Object.assign(Error('tests failed'),{commandExitFailure:true});}
        if(name==='repository')writeFileSync('repository-passed','');
        if(name==='@dohc/b-sibling'){writeFileSync('sibling-started','');await until('repository-passed',signal);}
        return {stdout:''};
      }
      if(name==='@dohc/a-fail'){await until('sibling-started',signal);writeFileSync('failed','');throw Object.assign(Error('package failed'),{commandExitFailure:true});}
      if(name==='@dohc/b-sibling')writeFileSync('sibling-started','');
      await until(scenario==='stop'?'never':'failed',signal);
      return {stdout:''};
    }
  `);
  writeFileSync(join(root, "driver.mjs"), `
    import {existsSync,readFileSync} from 'node:fs';
    import {cancellationScope} from './scripts/verification/cancellation.mjs';
    import {testWorkspace} from './scripts/verification/js-tests.mjs';
    const stop=cancellationScope('Fixture',{stopOnFailure:process.env.SCENARIO!=='keep-going'});
    const error=await testWorkspace({prepared:true,output:'evidence',stop,runProofs:async()=>{}}).then(()=>null,error=>error);
    await stop.dispose();
    const report=JSON.parse(readFileSync('evidence/result.json','utf8'));
    console.log(JSON.stringify({error:error?.message??null,stoppedBy:stop.stopped?.step??null,verdict:report.verdict,stopped:report.stopped??null,
      steps:Object.fromEntries(report.steps.filter(step=>step.name!=='inventory').map(step=>[step.name,step.verdict])),flaky:report.flaky}));
  `);
  const drive = scenario => {
    for (const file of ["ran", "sibling-started", "repository-passed", "failed", "evidence"]) rmSync(join(root, file), { recursive: true, force: true });
    const result = spawnSync(process.execPath, ["driver.mjs"], { cwd: root, encoding: "utf8", timeout: 20_000, env: { ...process.env, SCENARIO: scenario } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  };
  const stopped = drive("stop");
  assert.equal(stopped.error, "package failed");
  assert.equal(stopped.stoppedBy, "@dohc/a-fail");
  assert.equal(stopped.verdict, "FAIL");
  assert.deepEqual(stopped.steps, { repository: "NOT RUN", "@dohc/a-fail": "FAIL", "@dohc/b-sibling": "NOT RUN", "@dohc/c-queued": "NOT RUN", proofs: "NOT RUN" });
  assert.equal(stopped.stopped.after, "@dohc/a-fail");
  assert.deepEqual(stopped.stopped.notRun.toSorted(), ["@dohc/b-sibling", "@dohc/c-queued", "proofs", "repository"]);

  const kept = drive("keep-going");
  assert.equal(kept.error, "package failed");
  assert.equal(kept.stoppedBy, null);
  assert.equal(kept.stopped, null);
  assert.deepEqual(kept.steps, { repository: "PASS", "@dohc/a-fail": "FAIL", "@dohc/b-sibling": "PASS" }, "running steps finish; nothing new starts, as before");

  const flaky = drive("flaky");
  assert.equal(flaky.error, null);
  assert.equal(flaky.stoppedBy, null);
  assert.equal(flaky.verdict, "PASS");
  assert.deepEqual(flaky.steps, { repository: "PASS", "@dohc/a-fail": "PASS", "@dohc/b-sibling": "PASS", "@dohc/c-queued": "PASS", proofs: "PASS" });
  assert.deepEqual(flaky.flaky, [{ step: "repository", test: "times out under load" }]);
});

test("a step stopped by another job's failure is reported as not run", async () => {
  const scope = cancellationScope("Fixture", { stopOnFailure: true });
  try {
    const failure = new Error("fixture Rust failed");
    assert.equal(scope.notRun({}, failure), false, "nothing is stopped before a failure");
    scope.stop("rust", failure);
    scope.stop("tests", new Error("a later failure"));
    assert.equal(scope.stopped.step, "rust", "the first confirmed failure is the cause");
    assert.equal(scope.signal.aborted, true);
    const own = { verdict: "FAIL" }, interrupted = { verdict: "FAIL" }, later = { verdict: "FAIL" };
    assert.equal(scope.notRun(own, failure), false);
    assert.equal(scope.notRun(interrupted, Object.assign(new Error("pnpm failed (interrupted)."), { interrupted: true })), true);
    assert.equal(scope.notRun(later, new Error("an assertion failed after the stop")), false, "a real failure is not hidden");
    assert.deepEqual([own.verdict, interrupted, later.verdict], ["FAIL", { verdict: "NOT RUN", reason: "stopped after rust failed" }, "FAIL"]);
    const steps = [{ name: "rust", verdict: "FAIL" }, { name: "typecheck", ...interrupted }];
    assert.deepEqual(scope.unfinished(steps, ["rust", "rust-verdict", "typecheck", "tests"]), { after: "rust", notRun: ["typecheck", "rust-verdict", "tests"] });
  } finally { await scope.dispose(); }
  const kept = cancellationScope("Fixture");
  kept.stop("rust", new Error("fixture Rust failed"));
  assert.equal(kept.stopped, null, "a run that keeps going never stops");
  await kept.dispose();
  const signalled = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import {cancellationScope} from ${JSON.stringify(new URL("./cancellation.mjs", import.meta.url).href)};
    const scope=cancellationScope('Fixture',{stopOnFailure:true});
    process.emit('SIGTERM');
    scope.stop('tests',new Error('pnpm failed (interrupted).'));
    console.log(JSON.stringify({stopped:scope.stopped,error:(await scope.dispose()).message}));
  `], { encoding: "utf8", timeout: 20_000 });
  assert.deepEqual(JSON.parse(signalled.stdout), { stopped: null, error: "Fixture interrupted by SIGTERM." }, "a signal's interruption is not a failure");
});

test("a change affects its own packages and every package that depends on them", () => {
  const pkg = (name, path, dependencies = {}, devDependencies = {}) => ({ name, path, manifest: { dependencies, devDependencies } });
  const packages = [pkg("@dohc/runtime", "packages/runtime"), pkg("@dohc/relay", "services/relay", { "@dohc/runtime": "workspace:*" }),
    pkg("@dohc/desktop", "apps/desktop", {}, { "@dohc/relay": "workspace:*", react: "^19" }), pkg("@dohc/site", "apps/site"),
    pkg("@dohc/runtime-tools", "packages/runtime/tools")];
  assert.deepEqual(affectedPackages(["apps/site/src/index.ts", "docs/notes.md"], packages), ["@dohc/site"]);
  assert.deepEqual(affectedPackages(["packages/runtime/src/a.ts"], packages), ["@dohc/desktop", "@dohc/relay", "@dohc/runtime"], "dependents, through a dev dependency too");
  assert.deepEqual(affectedPackages(["packages/runtime/tools/build.mjs"], packages), ["@dohc/runtime-tools"], "the nested package owns its files");
  assert.deepEqual(affectedPackages(["README.md", "docs/a.md"], packages), [], "documentation affects no package");
  assert.equal(affectedPackages(["docs/reference/generated.md"], packages), null, "a generated reference that tests compare against is not documentation");
  assert.equal(affectedPackages([], packages), null, "with nothing to attribute, every package runs");
  // A root module that relay imports without its extension counts as relay's, so relay's dependents run too.
  assert.deepEqual(affectedPackages(["scripts/lib/fixture.mjs"], packages, [["scripts/lib/fixture", "@dohc/relay"]]), ["@dohc/desktop", "@dohc/relay"],
    "a declared path outside the packages runs the packages that read it");
  assert.equal(affectedPackages(["notes/plan.txt"], packages, [["notes/plan.txt", "@dohc/relay"]]), null, "a reference alone does not declare a path");
  const aliased = [...packages, pkg("@dohc/consumer", "packages/consumer", { renamed: "workspace:@dohc/site@*" })];
  assert.deepEqual(affectedPackages(["apps/site/src/index.ts"], aliased), ["@dohc/consumer", "@dohc/site"], "a workspace alias is a dependency");
  assert.deepEqual(affectedPackages(["apps/site/src/index.ts"], packages, [["@dohc/site", "@dohc/runtime"]]), ["@dohc/desktop", "@dohc/relay", "@dohc/runtime", "@dohc/site"],
    "a package another package's tests import affects it, and its dependents in turn");
});

test("undeclared relative imports between packages count as dependencies", t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-references-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  put("apps/desktop/src/ipc/channels.ts", "export const channel = 'a';\n");
  put("services/relay/src/edits.test.ts", "import { channel } from '../../../apps/desktop/src/ipc/channels';\nimport { local } from './local';\n");
  put("services/relay/dist/bundle.js", "require('../../../apps/site/index.js');\n");
  put("packages/x/src/a.ts", "const fixture = new URL(\x60../../../services/relay/src/edits.test.ts\x60, import.meta.url);\n");
  put("packages/x/src/cases.test.ts", "read(new URL('../../../crates/engine/tests/cases/', import.meta.url));\nconst root = new URL('../../..', import.meta.url);\n");
  const packages = [{ name: "@dohc/desktop", path: "apps/desktop" }, { name: "@dohc/relay", path: "services/relay" },
    { name: "@dohc/site", path: "apps/site" }, { name: "@dohc/x", path: "packages/x" }];
  assert.deepEqual(packageReferences(root, packages), [["@dohc/desktop", "@dohc/relay"], ["@dohc/relay", "@dohc/x"], ["crates/engine/tests/cases", "@dohc/x"]],
    "a path outside the packages is a reference, but the repository root and build output are not");
});

test("a change outside the packages runs the packages that read it", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const packages = readWorkspacePackages(root);
  const references = packageReferences(root, packages);
  const select = files => affectedPackages(files, packages, references);
  // The engine's readers, but not the packages that depend on them.
  assert.deepEqual(select(["crates/dohc-engine-runtime/src/actor.rs", "Cargo.lock", "vendor/yrs-0.27.3/src/id_set.rs"]), ["@dohc/desktop", "@dohc/sync-relay"]);
  assert.ok(select(["crates/dohc-engine-files/src/pathFoldFixtures.json"]).includes("@dohc/security-contract"),
    "a crate's fixture also runs the packages whose tests read it by relative path");
  assert.ok(select(["scripts/lib/apply-migrations.mjs"]).includes("@dohc/workspace-postgres"));
  assert.deepEqual(select(["docs/reference/cli-mcp-sdk.md"]), ["@dohc/mcp"]);
  assert.deepEqual(select(["tools/self-host/Caddyfile", "docker-compose.self-host.yml", ".env.self-host.example", "tools/perf-profiling/admission.mjs",
    "scripts/self-host-compose.test.mjs", "scripts/ipc-sites.json"]), [], "the repository checks test these, and they always run");
  for (const outside of ["pnpm-lock.yaml", "package.json", "pnpm-workspace.yaml", "tsconfig.base.json", "scripts/verification/close-electron.mjs",
    "tools/rust-engine-program/build-slot.mjs", "docs/reference/desktop-capabilities.md", "notes/undeclared.txt"]) {
    assert.equal(select(["crates/dohc-engine-runtime/src/actor.rs", outside]), null, `${outside} can affect any package`);
  }
});

test("the packages whose tests reach the staged engine are its declared readers", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const packages = readWorkspacePackages(root);
  const readers = new Set();
  // The gate hands package tests the engine only through these variables, which the shared resolver reads.
  for (const pkg of packages) {
    for (const file of globSync(`${pkg.path}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}`, { cwd: root, exclude: name => /(^|[\\/])(node_modules|dist)$/u.test(name) })) {
      if (/DOHC_TEST_ENGINE_BINARY|DOHC_REQUIRE_ENGINE_E2E|testing\/engineBinary/u.test(readFileSync(join(root, file), "utf8"))) readers.add(pkg.name);
    }
  }
  assert.deepEqual([...readers].sort(), rootInputs.find(input => input.paths.includes("crates/**")).readers);
  for (const { readers } of rootInputs) for (const name of readers) assert.ok(packages.some(pkg => pkg.name === name), `${name} is a workspace package`);
});

test("the real tree's undeclared test imports select their importers", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const packages = readWorkspacePackages(root);
  const references = packageReferences(root, packages);
  // sync-relay's tests import desktop source, and ydoc-projection's tests import sync-relay's.
  assert.ok(affectedPackages(["apps/desktop/src/ipc/stopAndRestoreIpc.ts"], packages, references).includes("@dohc/sync-relay"));
  assert.ok(affectedPackages(["services/sync-relay/src/liveTickets.ts"], packages, references).includes("@dohc/ydoc-projection"));
});

test("a narrowed run tests only the affected packages, and records the rest as skipped", t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-js-only-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts/verification"), { recursive: true });
  for (const file of ["js-tests.mjs", "timing.mjs", "cancellation.mjs", "flaky.mjs", "selection.mjs"]) copyFileSync(new URL(file, import.meta.url), join(root, "scripts/verification", file));
  for (const name of ["tail", "head"]) {
    mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(join(root, "packages", name, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  }
  writeFileSync(join(root, "scripts/verification/process.mjs"), `
    import {resolve} from 'node:path';
    export const repoRoot=resolve(import.meta.dirname,'../..');
    export const pnpm=args=>['pnpm',args];
    export const calls=[];
    export async function run(_command,args){
      calls.push(args.join(' '));
      if(args.includes('list'))return {stdout:JSON.stringify(['tail','head'].map(name=>({name:'@dohc/'+name,path:resolve('packages',name)})))};
      return {stdout:''};
    }
  `);
  writeFileSync(join(root, "driver.mjs"), `
    import {readFileSync} from 'node:fs';
    import {testWorkspace} from './scripts/verification/js-tests.mjs';
    import {calls} from './scripts/verification/process.mjs';
    await testWorkspace({prepared:true,output:'evidence',changed:JSON.parse(process.env.CHANGED)});
    const report=JSON.parse(readFileSync('evidence/result.json','utf8'));
    console.log(JSON.stringify({ran:calls.filter(call=>call.startsWith('--filter')).map(call=>call.split(' ')[1]),skipped:report.skippedPackages??null,verdict:report.verdict}));
  `);
  const drive = changed => JSON.parse(spawnSync(process.execPath, ["driver.mjs"], { cwd: root, encoding: "utf8", timeout: 20_000, env: { ...process.env, CHANGED: JSON.stringify(changed) } }).stdout.trim().split("\n").at(-1));
  assert.deepEqual(drive(["packages/head/src/a.ts"]), { ran: ["@dohc/head"], skipped: ["@dohc/tail"], verdict: "PASS" });
  assert.deepEqual(drive(["docs/a.md"]), { ran: [], skipped: ["@dohc/head", "@dohc/tail"], verdict: "PASS" }, "a documentation change runs no package tests");
  assert.deepEqual(drive(["pnpm-lock.yaml", "packages/head/src/a.ts"]), { ran: ["@dohc/head", "@dohc/tail"], skipped: null, verdict: "PASS" });
  assert.deepEqual(drive(null), { ran: ["@dohc/head", "@dohc/tail"], skipped: null, verdict: "PASS" }, "--full runs every package");
});

test("the plan retains every package test and preserves stricter worker caps", () => {
  const pkg = (name, scripts = {test: "vitest run"}) => ({name: `@dohc/${name}`, manifest: {scripts}});
  const tasks = testPlan([pkg("future-package"), pkg("workspace-auth"), pkg("workspace-postgres"), pkg("share-web"), pkg("workspace-api"),
    pkg("app-backend-runtime", {test: "build then test", "test:prepared": "vitest run"}),
    pkg("desktop", {test: "unit then scripts", "test:unit": "vitest run"}), pkg("ydoc-projection"), pkg("no-tests", {})]);
  assert.equal(tasks.length, 8);
  assert.equal(tasks[0].name, "@dohc/ydoc-projection");
  assert.equal(tasks[1].name, "@dohc/desktop");
  const runtime = tasks.find(task => task.name === "@dohc/app-backend-runtime").args;
  assert.ok(runtime.includes("--maxWorkers=1"), runtime.join(" "));
  // Every vitest package retries a failing test once and records the tests that needed it.
  assert.ok(runtime.includes("--retry=1") && runtime.some(arg => arg.endsWith("test-record-reporter.mjs")), runtime.join(" "));
  assert.equal(tasks.find(task => task.name === "@dohc/future-package").script, "test");
  assert.equal(tasks.filter(task => task.resource === "postgres").length, 4);
  assert.throws(() => testPlan([pkg("desktop")]), /Missing test:unit/);
});

for (const scenario of ["success", "proof-failure", "package-failure", "repository-failure", "cancel"]) {
  test(`proofs reuse the repository lane and settle every reader: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-proof-lane-"));
    const put = (path, value) => {
      mkdirSync(dirname(join(root, path)), {recursive: true});
      writeFileSync(join(root, path), value);
    };
    try {
      put("package.json", '{"type":"module"}');
      for (const name of ["desktop", "share-web", "workspace-api", "new-package", "tail"]) {
        put(`packages/${name}/package.json`, JSON.stringify({name: `@dohc/${name}`, scripts: {
          test: "vitest run", ...(name === "desktop" ? {"test:unit": "vitest run"} : {}),
        }}));
      }
      for (const file of ["js-tests.mjs", "timing.mjs", "cancellation.mjs", "flaky.mjs", "selection.mjs"]) {
        put(`scripts/verification/${file}`, readFileSync(new URL(file, import.meta.url)));
      }
      put("scripts/verification/process.mjs", `
        import assert from 'node:assert/strict';
        import {resolve} from 'node:path';
        export const repoRoot=resolve(import.meta.dirname,'../..');
        export const pnpm=args=>['pnpm',args];
        const controls=new Map(), arrivals=new Map();
        function control(map,name){if(!map.has(name))map.set(name,Promise.withResolvers());return map.get(name);}
        export const when=name=>control(arrivals,name).promise;
        export const release=(name,error)=>error?control(controls,name).reject(error):control(controls,name).resolve();
        export const started=new Set(), active=new Set();
        export let peak=0, packagePeak=0, databasePeak=0;
        const database=new Set(['@dohc/share-web','@dohc/workspace-api']);
        export async function run(_command,args){
          if(args.includes('list'))return {stdout:JSON.stringify(['desktop','share-web','workspace-api','new-package','tail']
            .map(name=>({name:'@dohc/'+name,path:resolve('packages',name)})))};
          const name=args[0]==='proof'?args[1]:args[0]==='run'?'repository':args[3].startsWith('test:scripts:')?args[3]:args[1];
          assert.ok(!started.has(name),'command ran twice: '+name);
          started.add(name);active.add(name);
          peak=Math.max(peak,active.size);
          const packages=[...active].filter(name=>name.startsWith('@dohc/'));
          packagePeak=Math.max(packagePeak,packages.length);
          const databases=[...active].filter(name=>database.has(name));
          databasePeak=Math.max(databasePeak,databases.length);
          assert.ok(active.size<=3);assert.ok(packages.length<=2);assert.ok(databases.length<=1);
          if(name.startsWith('proof-'))assert.equal(databases.length,0,'proof raced a package database consumer');
          if(databases.length)assert.ok(![...active].some(name=>name.startsWith('proof-')));
          control(arrivals,name).resolve();
          try{await control(controls,name).promise;return {stdout:''};}
          finally{active.delete(name);}
        }
      `);
      put("driver.mjs", `
        import assert from 'node:assert/strict';
        import {readFileSync} from 'node:fs';
        import {setImmediate} from 'node:timers/promises';
        import {testWorkspace} from './scripts/verification/js-tests.mjs';
        import {run,when,release,started,active,peak,packagePeak,databasePeak} from './scripts/verification/process.mjs';
        const scenario=${JSON.stringify(scenario)}, rust=Promise.withResolvers(), barrier=Promise.withResolvers();
        const proofs=['proof-native','proof-browser','proof-accounts','proof-desktop'];
        let barrierEntered=false, settled=false;
        const work=testWorkspace({prepared:true,output:'evidence',beforeDesktopScripts:async()=>{barrierEntered=true;barrier.resolve();await rust.promise;},
          runProofs:async checkpoint=>{for(const name of proofs){await checkpoint();await run('fixture',['proof',name]);}}});
        const outcome=work.then(()=>{settled=true;return null;},error=>{settled=true;return error;});
        const drain=async()=>{for(let i=0;i<6;i++)await setImmediate();};
        await when('@dohc/desktop');await when('@dohc/share-web');await when('repository');
        if(scenario==='repository-failure'){
          release('repository',Error('repository blocker'));await drain();
          assert.equal(settled,false);assert.equal(started.has('test:scripts:isolated'),false);
          release('@dohc/desktop');release('@dohc/share-web');
          assert.match((await outcome).message,/repository blocker/);
          assert.equal(started.has('@dohc/workspace-api'),false);
        }else{
          release('repository');await when('test:scripts:isolated');release('test:scripts:isolated');await drain();
          assert.equal(started.has('proof-native'),false,'proof started before all database packages');
          release('@dohc/share-web');await when('@dohc/workspace-api');await drain();
          assert.equal(started.has('proof-native'),false);
          release('@dohc/workspace-api');await when('proof-native');await when('@dohc/new-package');
          assert.ok(active.has('@dohc/desktop')&&active.has('@dohc/new-package'));
          assert.equal(peak,3);assert.equal(packagePeak,2);assert.equal(databasePeak,1);
          if(scenario==='success'){
            release('@dohc/new-package');await when('@dohc/tail');release('@dohc/tail');release('@dohc/desktop');await drain();
            assert.equal(barrierEntered,false,'packaging barrier started with a proof reader active');
            for(const name of proofs){await when(name);release(name);}
            await barrier.promise;assert.equal(started.has('test:scripts:runtime'),false);
            rust.resolve();await when('test:scripts:runtime');release('test:scripts:runtime');
            assert.equal(await outcome,null);
            assert.ok(proofs.every(name=>started.has(name)));
          }else{
            if(scenario==='package-failure'){
              release('@dohc/new-package',Error('package blocker'));await drain();
              assert.equal(settled,false,'active proof was not settled');release('proof-native');
            }else{
              if(scenario==='cancel')process.emit('SIGTERM');
              release('proof-native',scenario==='proof-failure'?Error('proof blocker'):undefined);await drain();
              assert.equal(settled,false,'active package readers were not settled');release('@dohc/new-package');
            }
            release('@dohc/desktop');const error=await outcome;
            assert.match(error.message,scenario==='package-failure'?/package blocker/:scenario==='proof-failure'?/proof blocker/:/interrupted/);
            assert.equal(started.has('@dohc/tail'),false,'queued package started after failure');
            assert.equal(started.has('proof-browser'),false,'proof command admitted after failure');
            assert.equal(barrierEntered,false);
          }
        }
        assert.equal(active.size,0);
        const report=JSON.parse(readFileSync('evidence/result.json','utf8'));
        assert.equal(report.verdict,scenario==='success'?'PASS':'FAIL');
        assert.equal(report.concurrency,2);assert.equal(report.proofs,true);
        assert.equal(started.has('test:scripts:runtime'),scenario==='success');
      `);
      const result = spawnSync(process.execPath, ["driver.mjs"], {cwd: root, encoding: "utf8", timeout: 20_000});
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, scenario === "cancel" ? 143 : 0, result.stderr);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
}

for (const {name, cancel = false, repoFail = false, packageFail = false, overlap = false, barrier = false, barrierCancel = false, scriptOverlap = false, scriptFail = false, scriptCancel = false} of [
  {name:"isolated scripts reuse the repository lane while packages continue, before runtime packaging",overlap:true,scriptOverlap:true},
  {name:"cancellation rejects queued packages before launching their commands",cancel:true,overlap:true},
  {name:"packaging waits for the external runtime reader",barrier:true},
  {name:"cancellation while waiting for the runtime reader skips packaging",barrier:true,barrierCancel:true},
  {name:"a repository failure stops new commands and skips the packaging step",repoFail:true,overlap:true},
  {name:"the first failure in time is the one reported",repoFail:true,packageFail:true,overlap:true},
  {name:"isolated script failure stops package admission and skips runtime packaging",overlap:true,scriptOverlap:true,scriptFail:true},
  {name:"isolated script cancellation settles running packages and skips runtime packaging",overlap:true,scriptOverlap:true,scriptCancel:true},
]) test(name, () => {
  // The inventory's package without a test script is not scheduled.
  const expectedPackages = ["@dohc/desktop", "@dohc/app-backend-runtime", "@dohc/new-package"];
  const root = mkdtempSync(join(tmpdir(), "dohc-js-schedule-"));
  const put = (path, data) => { mkdirSync(dirname(join(root, path)), {recursive:true}); writeFileSync(join(root, path), data); };
  try {
    put("package.json", '{"type":"module","scripts":{"test":"node scripts/verification/js-tests.mjs"}}');
    for (const file of ["js-tests.mjs", "timing.mjs", "cancellation.mjs", "flaky.mjs", "selection.mjs"]) {
      mkdirSync(join(root, "scripts/verification"), {recursive:true});
      copyFileSync(new URL(file, import.meta.url), join(root, "scripts/verification", file));
    }
    put("apps/desktop/package.json", JSON.stringify({scripts:{test:"unused", "test:unit":"vitest run", "test:scripts":"scripts", "test:scripts:isolated":"isolated", "test:scripts:runtime":"runtime"}}));
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
      const waitFor=async file=>{for(let i=0;i<200&&!existsSync(file);i++)await new Promise(r=>setTimeout(r,50));};
      let active=0, peak=0;
      export async function run(command,args) {
        active++;peak=Math.max(peak,active);
        assert.ok(active<=3,'no more than two package commands and the repository/script lane');
        try{return await execute(command,args);}
        finally{active--;writeFileSync('command-counts.json',JSON.stringify({active,peak}));}
      }
      async function execute(command,args) {
        appendFileSync('commands.jsonl',JSON.stringify(args)+'\\n');
        if(args.includes('build')){completed.add(args[1]);return {stdout:''};}
        assert.ok(completed.has('@dohc/app-backend-runtime'));
        if(args[1]==='test:repo'){
          // Held open until a package starts (or fails), so the lanes must overlap.
          if(process.env.FIXTURE_OVERLAP==='1'){
            await waitFor(process.env.FIXTURE_PACKAGE_FAIL==='1'?'package-failed':'package-started');
            if(existsSync('package-started'))writeFileSync('repository-saw-package','yes');
          }
          if(process.env.FIXTURE_REPO_FAIL==='1'){writeFileSync('repository-failed','yes');throw Error('fixture repository failed');}
          writeFileSync('repository-complete','yes');return {stdout:''};
        }
        if(args.includes('list'))return {stdout:JSON.stringify([
          {name:'dohc',path:process.platform==='win32'?repoRoot.toUpperCase():repoRoot}, {name:'@dohc/desktop',path:resolve('apps/desktop')},
          {name:'@dohc/app-backend-runtime',path:resolve('packages/app-backend-runtime')},
          {name:'@dohc/new-package',path:resolve('packages/new-package')},
          {name:'@dohc/no-tests',path:resolve('packages/no-tests')}
        ])};
        if(args.includes('test:scripts:isolated')) {
          assert.ok(existsSync('repository-complete'));
          writeFileSync('isolated-started','yes');
          if(process.env.FIXTURE_SCRIPT_FAIL==='1'){writeFileSync('isolated-finished','yes');throw Error('fixture isolated script failed');}
          if(process.env.FIXTURE_SCRIPT_CANCEL==='1'){writeFileSync('isolated-finished','yes');process.emit('SIGTERM');throw Error('fixture isolated script interrupted');}
          writeFileSync('isolated-complete','yes');writeFileSync('isolated-finished','yes');return {stdout:''};
        }
        if(args.includes('test:scripts:runtime')) {
          assert.ok(existsSync('isolated-complete') && ${JSON.stringify(expectedPackages)}.every(name=>completed.has('test:'+name)));
          return {stdout:''};
        }
        if(args[2]==='run')writeFileSync('package-started','yes');
        // Hold the running packages until the repository fails, so the queued one must not start.
        if(args[2]==='run' && process.env.FIXTURE_REPO_FAIL==='1' && process.env.FIXTURE_PACKAGE_FAIL!=='1')await waitFor('repository-failed');
        if(args[1]==='@dohc/new-package' && process.env.FIXTURE_PACKAGE_FAIL==='1'){writeFileSync('package-failed','yes');throw Error('fixture package failed');}
        if(args.includes('test:unit') && process.env.FIXTURE_CANCEL==='1') {
          process.emit('SIGINT');
          throw Error('fixture command interrupted');
        }
        if(args[2]==='run' && process.env.FIXTURE_SCRIPT_OVERLAP==='1'){
          await waitFor('isolated-finished');
          assert.ok(existsSync('isolated-started'));
          writeFileSync('package-saw-isolated','yes');
        }
        completed.add('test:'+args[1]);
        return {stdout:''};
      }
    `);
    // The standalone CLI runs every case except the packaging barrier, which needs a caller.
    const args = !barrier ? ["scripts/verification/js-tests.mjs", "--output", "evidence"] : ["--input-type=module", "-e", `
      import {testWorkspace} from './scripts/verification/js-tests.mjs';
      import assert from 'node:assert/strict';
      import {readFileSync,writeFileSync} from 'node:fs';
      import {setImmediate} from 'node:timers/promises';
      const beforeDesktopScripts = async () => {
        writeFileSync('barrier-entered','yes');
        // Drain command admission while the reader remains unresolved.
        for(let i=0;i<4;i++)await setImmediate();
        assert.ok(!readFileSync('commands.jsonl','utf8').includes('test:scripts:runtime'));
        if(${barrierCancel})process.emit('SIGTERM');
      };
      try {await testWorkspace({output:'evidence',beforeDesktopScripts});}
      catch(error){console.error(error.message);process.exitCode ||= 1;}
    `];
    const result = spawnSync(process.execPath, args, {
      cwd:root, encoding:"utf8", timeout:20_000, env:{...process.env, FIXTURE_CANCEL:cancel ? "1" : "0", FIXTURE_REPO_FAIL:repoFail ? "1" : "0",
        FIXTURE_PACKAGE_FAIL:packageFail ? "1" : "0", FIXTURE_OVERLAP:overlap ? "1" : "0",
        FIXTURE_SCRIPT_OVERLAP:scriptOverlap ? "1" : "0", FIXTURE_SCRIPT_FAIL:scriptFail ? "1" : "0", FIXTURE_SCRIPT_CANCEL:scriptCancel ? "1" : "0"},
    });
    assert.equal(result.error, undefined);
    const failed = repoFail || packageFail || scriptFail;
    assert.equal(result.status, barrierCancel || scriptCancel ? 143 : cancel ? 130 : failed ? 1 : 0, result.stderr);
    const report = JSON.parse(readFileSync(join(root, "evidence/result.json"), "utf8"));
    assert.equal(report.verdict, cancel || barrierCancel || scriptCancel || failed ? "FAIL" : "PASS");
    assert.equal(JSON.parse(readFileSync(join(root,"command-counts.json"),"utf8")).active,0,"all commands must settle before the runner exits");
    if (barrier) assert.ok(existsSync(join(root, "barrier-entered")));
    if (overlap && !cancel) assert.ok(existsSync(join(root, "repository-saw-package")), "the repository lane must still be open when a package starts");
    if (scriptOverlap) assert.ok(existsSync(join(root,"package-saw-isolated")),"isolated scripts must start while package commands remain active");
    const commands = readFileSync(join(root,"commands.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
    assert.ok(commands.some(args => args[0] === "run" && args[1] === "test:repo"));
    assert.deepEqual(report.packages.map(pkg=>pkg.name).sort(),expectedPackages.toSorted());
    if (barrierCancel) {
      assert.match(report.error, /interrupted by SIGTERM/);
      assert.equal(commands.some(args => args.includes("test:scripts:runtime")), false);
    } else if (cancel) {
      assert.match(report.error, /interrupted/);
      assert.equal(commands.some(args => args.some(arg=>arg.startsWith("test:scripts:")) || args.includes("test:prepared") || args.includes("test")), false);
      assert.equal(report.steps.at(-1).verdict, "FAIL");
    } else if (repoFail) {
      assert.match(report.error, packageFail ? /fixture package failed/ : /fixture repository failed/);
      if (!packageFail) assert.equal(commands.filter(args=>args[2]==="run").length, 2, "the queued package must not start after the failure");
      assert.equal(commands.some(args=>args.some(arg=>arg.startsWith("test:scripts:"))),false);
    } else if (scriptFail || scriptCancel) {
      assert.match(report.error,scriptCancel ? /interrupted/ : /fixture isolated script failed/);
      assert.equal(commands.filter(args=>args[2]==="run" && !args[3].startsWith("test:scripts:")).length,2,"queued packages must not start after an isolated script fails");
      assert.equal(commands.some(args=>args.includes("test:scripts:runtime")),false);
    } else {
      assert.deepEqual(commands.filter(args=>args[2]==="run" && !args[3].startsWith("test:scripts:")).map(args=>args[1]).sort(),expectedPackages.toSorted());
      assert.ok(commands.some(args=>args.includes("test:scripts:isolated")));
      assert.ok(commands.some(args=>args.includes("test:scripts:runtime")));
      assert.ok(report.steps.every(step => step.verdict === "PASS"));
    }
    assert.ok(report.steps.every(step => step.seconds >= 0 && step.finishedAt));
    assert.ok(report.seconds >= Math.max(...report.steps.map(step => step.seconds)));
  } finally { rmSync(root, {recursive:true, force:true}); }
});
