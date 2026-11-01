import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { repoRoot, run } from "./process.mjs";
import { createPrepareFixture } from "./prepare-fixture.mjs";
import { copyFlakyFixture } from "./flaky-fixture.mjs";

// Each case starts the verifier in its own Node process. On Windows, run() would
// add two to three seconds of PowerShell job setup to every case.
function runFixture(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", error;
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (failure) => { error = failure; });
    // A child that a signal ended reports no exit status, so it never counts as an ordinary exit.
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr,
      error: error ?? (status === null ? new Error(`The fixture stopped on ${signal}.`) : undefined) }));
  });
}

test("a failed final log write rejects a command that succeeded, without calling it an exit failure", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-fixture-log-error-"));
  const failure = Object.assign(new Error("fixture log final write failed"), { code: "EIO" });
  const output = new Writable({
    write(_chunk, _encoding, done) { done(); },
    final(done) { done(failure); },
  });
  const mocked = mock.method(fs, "createWriteStream", () => output);
  syncBuiltinESMExports();
  try {
    const error = await run(process.execPath, ["-e", "console.log('command succeeded')"], {
      timeoutMs: 15_000, log: join(root, "command.log"), quietStdout: true,
    }).then(() => assert.fail("a failed log write must reject"), (error) => error);
    assert.equal(error, failure);
    assert.equal(error.exitCode, 0);
    assert.equal(error.signal, null);
    assert.match(error.stdout, /command succeeded/);
    assert.equal(error.commandExitFailure, false);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    output.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture reports an ordinary nonzero command exit as status", { timeout: 20_000 }, async () => {
  const result = await runFixture(process.execPath, ["-e", "console.error('ordinary failure');process.exitCode=7"], { timeout: 15_000 });
  assert.equal(result.status, 7);
  assert.equal(result.signal, null);
  assert.equal(result.error, undefined);
  assert.match(result.stderr, /ordinary failure/);
});

const packages = ["@dohc/desktop", "@dohc/fixture", "@dohc/mcp", "@dohc/share-web", "@dohc/site", "@dohc/unrelated", "@dohc/workspace-api"];
const desktopWorkers = Math.min(4, Math.max(2, Math.floor(availableParallelism() / 4)));

// Every case verifies the same committed checkout, so it is built once for each
// changed input and copied into each case. The stubs read what a case expects
// from FIXTURE_CASE.
function createVerificationFixtures(directory) {
  const root = join(directory, "base");
  const put = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  const git = (args, cwd = root) => execFileSync("git", ["-c", `core.hooksPath=${join(cwd, "no-hooks")}`,
    "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
  { cwd, encoding: "utf8" }).trim();
  createPrepareFixture(root, new URL("./build.mjs", import.meta.url), { commit: false });
  put("scripts/verification/admission.mjs", "export const admissionPreflight=()=>{};export const installedDependenciesMatch=()=>JSON.parse(process.env.FIXTURE_CASE).warm;");
  put("tools/rust-engine-program/build-slot.mjs", "import {writeFileSync} from 'node:fs';export const acquireExclusiveSlot=()=>null;export const buildQueueStatus=()=>({owners:[]});export const maxVerificationLanes=4;export const readVerificationLanes=()=>1;export const heldVerificationSlots=()=>[];export const macSlotRoot=()=>'';export const capBuildParallelism=source=>({...source});export const resolveBuildBudget=()=>null;export const freeDiskGb=()=>100;export const acquireBuildSlot=()=>{throw Error('not expected')};export const acquireVerificationSlot=()=>{writeFileSync('.dohc-dev/queued','yes');return {update(){},release(){}};};");
  git(["config", "core.logAllRefUpdates", "true"]);
  mkdirSync(join(root, ".dohc-dev"), { recursive: true });
  copyFlakyFixture(root);
  for (const path of ["scripts/verification/verify.mjs", "scripts/verification/ticket-evidence.mjs", "scripts/verification/queue.mjs", "scripts/verification/queue-supervisor.mjs", "scripts/verification/js-tests.mjs", "scripts/verification/selection.mjs", "scripts/verification/timing.mjs", "tools/rust-engine-program/tree-provenance.mjs",
    "tools/rust-engine-program/git-read.mjs", "tools/rust-engine-program/gate-commands.mjs",
    "apps/desktop/scripts/require-e2e-engine.mjs", ".github/workflows/pr-checks.yml"]) {
    put(path, readFileSync(join(repoRoot, path)));
  }
  put("scripts/verification/js-tests-real.mjs", readFileSync(join(root, "scripts/verification/js-tests.mjs")));
  put("scripts/verification/linux.mjs", "export const linuxDistro=()=>null;export const linuxRustJob=()=>{throw Error('not expected');};");
  put("scripts/verification/rust-reuse.mjs", "export const rustIdentity=()=>({incremental:process.env.CARGO_INCREMENTAL});export const finishRustEvidence=(_report,initial,final)=>{if(JSON.stringify(initial)!==JSON.stringify(final))throw Error('Rust identity changed');return {kind:'fixture'};};export const refreshRustReuse=()=>{throw Error('unexpected reuse');};");
  put("scripts/verification/js-tests.mjs", `
    import assert from 'node:assert/strict';
    import {testWorkspace as realTests} from './js-tests-real.mjs';
    import {finishRuntimeReader} from './process.mjs';
    export const testWorkspace = options => realTests({...options, beforeDesktopScripts: async () => {
      const pending = options.beforeDesktopScripts();
      let settled = false;
      pending.then(() => {settled = true;});
      await Promise.resolve();
      if(JSON.parse(process.env.FIXTURE_CASE).rust)assert.equal(settled, false, 'Packaging barrier did not wait for Rust');
      finishRuntimeReader();
      await pending;
    }});
  `);
  put(".gitignore", readFileSync(join(root, ".gitignore"), "utf8") + ".agent-artifacts/\napps/desktop/.env.local\n");
  put("apps/desktop/package.json", '{"name":"@dohc/desktop","devDependencies":{"@dohc/fixture":"workspace:*"},"scripts":{"test":"unused","test:unit":"vitest run","test:scripts":"scripts","test:scripts:isolated":"isolated","test:scripts:runtime":"runtime"}}');
  for (const name of ["fixture", "mcp", "share-web", "site", "unrelated", "workspace-api"]) {
    const path = `${name === "workspace-api" ? "services" : name === "site" ? "apps" : "packages"}/${name}`;
    put(`${path}/package.json`, JSON.stringify({name:`@dohc/${name}`,scripts:{test:"vitest run"}}));
    put(`${path}/src/index.ts`, "export const value = 1;\n");
  }
  for (const name of ["dohc", "dohc-mcp"]) {
    put(`apps/desktop/resources/cli-bin/${name}`, "fixture launcher");
    chmodSync(join(root, "apps/desktop/resources/cli-bin", name), 0o755);
  }
  put("scripts/verification/doctor.mjs", `
    import assert from 'node:assert/strict';
    import {readFileSync} from 'node:fs';
    export function doctor(options) {
      const fixture=JSON.parse(process.env.FIXTURE_CASE);
      assert.deepEqual(options,{engine:fixture.rust||fixture.desktop,desktop:fixture.desktop,browser:fixture.desktop});
      if(process.env.FIXTURE_MODE==='pr' && readFileSync('node_modules/installed.txt','utf8')!==readFileSync('pnpm-lock.yaml','utf8'))
        throw Error('doctor ran before verifier installation');
      if(fixture.desktop)assert.equal(readFileSync('.dohc-dev/electron-installed','utf8'),'yes');
      return {checks:[]};
    }
  `);
  const adapterPath = "scripts/verification/process.mjs";
  put(adapterPath, readFileSync(join(root, adapterPath), "utf8").replace("export async function run(", "async function prepareRun(") + `
    const fixture=JSON.parse(process.env.FIXTURE_CASE);
    let releaseRust, releaseJavascript, runtimeBuilt = false, rustFinished = false, repositoryFinished = false, isolatedScriptsFinished = false;
    const javascriptStarted=new Promise(resolve=>{releaseRust=resolve;});
    const rustStarted=new Promise(resolve=>{releaseJavascript=resolve;});
    export const finishRuntimeReader = () => releaseRust();
    export async function run(command,args,options={}) {
      const {enginePath,stagedEnginePath,assertPrepared,hashFile}=await import('./build.mjs');
      appendFileSync(join(repoRoot,'.dohc-dev/all-calls.jsonl'),JSON.stringify({command,args})+'\\n');
      if(command==='cargo' || args[0]==='tools/rust-engine-program/run-rust-checks.mjs') {
        assert.equal(process.env.CARGO_INCREMENTAL,fixture.incremental,'Verifier compilation policy');
        assert.equal(options.env.CARGO_INCREMENTAL,fixture.incremental,'Build child compilation policy');
      }
      const queued=existsSync(join(repoRoot,'.dohc-dev/queued'));
      if(command==='cargo' && (['fmt','clippy'].includes(args[0]) || args.includes('--no-run'))) {
        assert.ok(fixture.rust,'Unselected Rust check before queueing');
        assert.equal(queued,false,'Rust check ran after queueing');
        const {clippy,fmtCheck,nextest}=await import('../../tools/rust-engine-program/gate-commands.mjs');
        assert.deepEqual(args,args[0]==='fmt'?fmtCheck:args[0]==='clippy'?clippy:[...nextest,'--no-run']);
        if(args[0]!=='fmt')assert.equal(options.env.CARGO_TARGET_DIR,join(repoRoot,'target'));
        if(args[0]==='clippy' && process.env.FIXTURE_FAULT==='pre-clippy')throw Error('fixture clippy failed');
        return {stdout:''};
      }
      if(command==='pnpm' && args.at(-1)==='typecheck' && !queued) {
        assert.ok(fixture.js && fixture.warm,'Typecheck ran before queueing without installed dependencies');
        if(process.env.FIXTURE_FAULT==='pre-typecheck')throw Error('fixture typecheck failed');
        return {stdout:''};
      }
      if(args[0]==='apps/desktop/scripts/ensure-electron-installed.mjs') {
        assert.ok(fixture.desktop,'Unselected Electron installation');
        writeFileSync(join(repoRoot,'.dohc-dev/electron-installed'),'yes');
        return {stdout:''};
      }
      if(command==='xvfb-run') {
        assert.equal(process.platform,'linux');assert.ok(!process.env.DISPLAY);
        assert.equal(args[0],'-a');assert.equal(args[1],process.execPath);
        assert.ok(args.includes('apps/desktop/playwright.config.ts'));
        command=args[1];args=args.slice(2);
      }
      if(command==='cargo' && !(fixture.rust || fixture.desktop))throw Error('Native tools unavailable for this change');
      if(command==='pnpm' && args[1]==='@dohc/desktop' && args.includes('build') && !fixture.desktop)throw Error('Electron unavailable for this change');
      if(command==='pnpm' && args[1]==='@dohc/app-backend-runtime') {
        assert.deepEqual(args,['--filter','@dohc/app-backend-runtime','build']);
        runtimeBuilt = true;
        return {stdout:'compiled runtime'};
      }
      if(command==='pnpm' && args[0]==='install' && !existsSync(join(repoRoot,'.dohc-dev/verification/build.json.lock'))) {
        assert.deepEqual(args,['install','--frozen-lockfile','--config.confirm-modules-purge=false']);
        writeFileSync(join(repoRoot,'node_modules/installed.txt'),readFileSync(join(repoRoot,'pnpm-lock.yaml')));
        return {stdout:''};
      }
      if(command==='cargo' && args[1]==='--version') {
        const {createRequire}=await import('node:module');
        const pins=createRequire(import.meta.url)('js-yaml').load(readFileSync(join(repoRoot,'.github/workflows/pr-checks.yml'),'utf8')).env;
        if(process.env.FIXTURE_FAULT==='cargo-version' && args[0]==='deny')return {stdout:'cargo-deny 0.0.0'};
        return {stdout:'cargo-'+args[0]+' '+pins['CARGO_'+args[0].toUpperCase()+'_VERSION']};
      }
      if(args[0]==='tools/rust-engine-program/run-rust-checks.mjs') {
        assert.ok(runtimeBuilt, 'Rust started before the runtime build completed');
        assert.ok(args.includes('--prepared-runtime'));
        if(fixture.desktop)assertPrepared({engineBinary:stagedEnginePath});
        mkdirSync(dirname(enginePath),{recursive:true});writeFileSync(enginePath,'workspace engine');chmodSync(enginePath,0o755);
        if(fixture.rust && fixture.js) {
          writeFileSync(join(repoRoot,'.dohc-dev/rust-running'),'yes');
          releaseJavascript();
          // A stop interrupts the running Rust job as run() does.
          await Promise.race([javascriptStarted, new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(Error('cargo failed (interrupted).'), {interrupted: true}))))]);
          assert.equal(readFileSync(join(repoRoot,'.dohc-dev/jobs-overlapped'),'utf8'),'yes');
        }
        rustFinished = true;
        if(['source','rust-source'].includes(process.env.FIXTURE_FAULT))writeFileSync(join(repoRoot,'apps/desktop/.env.local'),'VITE_CHANGED=during-Rust');
        if(process.env.FIXTURE_FAULT==='rust-cancel')process.emit('SIGTERM');
        if(['rust','rust-and-js','rust-source','rust-cancel'].includes(process.env.FIXTURE_FAULT))throw Error('fixture Rust failed');
        return {stdout:'fixture Rust'};
      }
      if(args[0]==='tools/rust-engine-program/require-ci-pass-verdict.mjs') {
        if(process.env.FIXTURE_FAULT==='rust-verdict')throw Error('fixture Rust verdict rejected');
        return {stdout:'PASS'};
      }
      if(command==='docker') {
        if(!fixture.js)throw Error('Docker unavailable for this change');
        if(args[0]==='run'){writeFileSync(join(repoRoot,'.dohc-dev/database-started'),'yes');return {stdout:'a'.repeat(64)};}
        if(args[0]==='inspect')return {stdout:'healthy'};
        if(args[0]==='port')return {stdout:'127.0.0.1:1234'};
        assert.deepEqual(args,['rm','--force','--volumes','a'.repeat(64)]);
        writeFileSync(join(repoRoot,'.dohc-dev/database-stopped'),'yes');return {stdout:''};
      }
      if(command==='pnpm' && args[0]==='run') {
        assert.ok(['typecheck','test:repo','test:repo:tree'].includes(args[1]));
        if(args[1]!=='typecheck')assert.equal(args[1],fixture.repositoryTests,'Selected repository tests');
        if(args[1]==='typecheck' && fixture.rust && fixture.js) {
          await rustStarted;
          assert.equal(readFileSync(join(repoRoot,'.dohc-dev/rust-running'),'utf8'),'yes');
          writeFileSync(join(repoRoot,'.dohc-dev/jobs-overlapped'),'yes');
          if(process.env.FIXTURE_FAULT==='rust-and-js' || process.env.FIXTURE_FAULT==='js' && fixture.keepGoing)releaseRust();
        }
        if(args[1]==='typecheck' && ['js','rust-and-js'].includes(process.env.FIXTURE_FAULT))throw Error('fixture JS failed');
        for(const flag of ['DOHC_REQUIRE_POSTGRES','DOHC_REQUIRE_ENGINE_E2E'])assert.equal(options.env[flag],'1');
        assert.equal(options.env.DOHC_TEST_ENGINE_BINARY,stagedEnginePath);
        if(args[1]!=='typecheck')repositoryFinished = true;
        return {stdout:''};
      }
      if(command==='pnpm' && args.includes('list')) {
        return {stdout:JSON.stringify([
          {name:'@dohc/desktop',path:join(repoRoot,'apps/desktop')},
          ...['fixture','mcp','share-web','site','unrelated','workspace-api'].map(name=>({name:'@dohc/'+name,path:join(repoRoot,name==='workspace-api'?'services':name==='site'?'apps':'packages',name)}))
        ])};
      }
      if(command==='pnpm' && args[2]==='run' && ['test:scripts:isolated','test:scripts:runtime'].includes(args[3])) {
        assert.ok(fixture.js, 'Unselected desktop scripts');
        assert.ok(repositoryFinished, 'Desktop scripts started before repository checks finished');
        if(args[3]==='test:scripts:isolated') {
          assert.ok(!isolatedScriptsFinished, 'Isolated scripts ran twice');
          if(fixture.rust)assert.equal(rustFinished, false, 'Isolated scripts unnecessarily waited for Rust');
          isolatedScriptsFinished = true;
        } else {
          assert.ok(isolatedScriptsFinished, 'Runtime packaging started before isolated scripts finished');
          assert.ok(!fixture.rust || rustFinished, 'Packaging raced the Rust runtime reader');
        }
        return {stdout:''};
      }
      if(command==='pnpm' && args[2]==='run' && ['test','test:unit'].includes(args[3])) {
        assert.deepEqual(args.slice(0,5),['--filter',args[1],'run',...(args[1]==='@dohc/desktop'?['test:unit','--maxWorkers=${desktopWorkers}']:['test','--maxWorkers=4'])]);
        assert.deepEqual(args.slice(5,7),['--retry=1','--reporter=default']);assert.match(args[7],/test-record-reporter.mjs$/);assert.equal(args.length,8);
        assert.ok(${JSON.stringify(packages)}.includes(args[1]),'Unknown package executed: '+args[1]);
        assert.equal(options.env.POSTGRES_URL,'postgres://dohc:dohc@127.0.0.1:1234/dohc');
        for(const flag of ['DOHC_REQUIRE_POSTGRES','DOHC_REQUIRE_ENGINE_E2E'])assert.equal(options.env[flag],'1');
        if(['shared','passed-alone'].includes(process.env.FIXTURE_FAULT) && args[1]==='@dohc/fixture') {
          const ended=process.env.FIXTURE_FAULT==='passed-alone'?JSON.stringify({run:'failed',outside:0})+'\\n':'';
          appendFileSync(options.env.DOHC_TEST_RECORD,JSON.stringify({test:'src/index.test.ts › keeps its value',flaky:false,failed:true,passed:false,seconds:0.1})+'\\n'+ended);
          throw Object.assign(Error('fixture package test failed'),{commandExitFailure:true});
        }
        return {stdout:''};
      }
      if(command==='pnpm' && args[1]==='@dohc/fixture' && args[2]==='exec') {
        assert.equal(process.env.FIXTURE_FAULT,'passed-alone','Unexpected isolated retry');
        assert.deepEqual(args.slice(0,10),['--filter','@dohc/fixture','exec','vitest','run','src/index.test.ts','--maxWorkers=1','--no-file-parallelism','--retry=0','--reporter=default']);
        for(const flag of ['DOHC_REQUIRE_POSTGRES','DOHC_REQUIRE_ENGINE_E2E','DOHC_TEST_RECORD_ALL'])assert.equal(options.env[flag],'1');
        appendFileSync(options.env.DOHC_TEST_RECORD,[{test:'src/index.test.ts › keeps its value',flaky:false,failed:false,passed:true,seconds:0.1},{run:'passed',outside:0}].map(line=>JSON.stringify(line)+'\\n').join(''));
        return {stdout:''};
      }
      if(command==='pnpm' && args[0]==='exec') {
        const e2e=process.env.FIXTURE_MODE==='e2e';
        if(!fixture.js && !e2e)throw Error('Browser tools unavailable for this change');
        assert.deepEqual(args,['exec','playwright','install','chromium']);
        if(!e2e)assert.equal(options.env.DOHC_REQUIRE_POSTGRES,'1');
        writeFileSync(join(repoRoot,'.dohc-dev/browser-installed'),'yes');
        return {stdout:''};
      }
      if(command==='pnpm' && args.includes('vitest.self-host-native.config.ts')) {
        assert.ok(fixture.js,'Unselected native proof');
        assertPrepared({engineBinary:stagedEnginePath});
        assert.equal(options.env.DOHC_SERVICE_HOST_PROOF_BINARY,stagedEnginePath);
        assert.equal(options.env.DOHC_SERVICE_HOST_PROOF_SHA256,hashFile(stagedEnginePath));
        assert.equal(options.env.DOHC_REQUIRE_POSTGRES,'1');
        const output=options.env.DOHC_SERVICE_HOST_PROOF_OUTPUT;
        mkdirSync(join(output,'self-host-live-fixture'),{recursive:true});
        const skipped=process.env.FIXTURE_FAULT==='native-skipped';
        writeFileSync(join(output,'vitest.json'),JSON.stringify({success:true,numTotalTests:1,numPassedTests:skipped?0:1,numFailedTests:0,numPendingTests:skipped?1:0,numTodoTests:0}));
        writeFileSync(join(output,'self-host-live-fixture/result.json'),JSON.stringify({verdict:'PASS',executable:stagedEnginePath,sha256:hashFile(stagedEnginePath),results:{ownerDelivery:{restartPreservedDraft:true,concurrentOwnerAndNamedEditsMerged:true,idleOwnerPulledRecipientEdit:true},settledAndPublished:{ordinaryOwnerReadMatched:true}}}));
        return {stdout:''};
      }
      if(args[0]==='apps/desktop/scripts/run-playwright.mjs') {
        if(!fixture.desktop)throw Error('Browser tools unavailable for this change');
        assertPrepared({engineBinary:stagedEnginePath});
        const pr=process.env.FIXTURE_MODE==='pr';
        if(pr) {
          assert.equal(options.env.POSTGRES_URL,'postgres://dohc:dohc@127.0.0.1:1234/dohc');
          assert.equal(options.env.DOHC_REQUIRE_POSTGRES,'1');
          assert.equal(existsSync(join(repoRoot,'.dohc-dev/database-started')),true);
          assert.equal(existsSync(join(repoRoot,'.dohc-dev/database-stopped')),false);
        }
        assert.equal(existsSync(join(repoRoot,'.dohc-dev/browser-installed')),process.env.FIXTURE_MODE!=='smoke');
        if(args.includes('services/workspace-api/playwright.config.ts')) {
          assert.ok(pr,'Unselected account proof');
          writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME,JSON.stringify({stats:{expected:2,unexpected:process.env.FIXTURE_FAULT==='accounts-cancelled'?1:0,flaky:0,skipped:process.env.FIXTURE_FAULT==='accounts-skipped'?1:0}}));
          return {stdout:''};
        }
        const restartTags=['@restart-durability-idle-external','@restart-durability-overlapping-typing','@restart-durability-capture-before-reopen','@restart-durability-person-agent'];
        const expected=process.env.FIXTURE_MODE==='e2e'?['--project','fixture']:['--grep',pr?'@verification-smoke|'+restartTags.join('|')+'|@self-host-onboarding'+(fixture.gallery?'|@states-page':''):'@verification-smoke'];
        assert.ok(args.some((arg,index)=>arg===expected[0] && args[index+1]===expected[1]));
        const restartTitles=restartTags.map((tag,index)=>process.env.FIXTURE_FAULT==='restart-missing'||process.env.FIXTURE_FAULT==='restart-one-missing'&&index===3?'unrelated restart spec':tag+' restart proof');
        const titles=[process.env.FIXTURE_FAULT==='smoke-missing'?'unrelated passing spec':'@verification-smoke persistence',...(pr?restartTitles:[]),...(pr?[process.env.FIXTURE_FAULT==='onboarding-missing'?'@verification-smoke another persistence':'@self-host-onboarding account and sync']:[]),...(fixture.gallery?[process.env.FIXTURE_FAULT==='gallery-missing'?'@states-page the page stays closed':'@states-page @states-baselines every shared part']:[])];
        const restartSkipped=process.env.FIXTURE_FAULT==='restart-skipped';
        writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME,JSON.stringify({
          stats:{expected:titles.length-(restartSkipped?1:0),unexpected:process.env.FIXTURE_FAULT==='desktop-cancelled'?1:0,flaky:0,skipped:process.env.FIXTURE_FAULT==='desktop-skipped'||restartSkipped?1:0},
          suites:[{suites:[{specs:titles.map(title=>({title,ok:true,tests:[{results:[{status:restartSkipped&&title.startsWith('@restart-durability-person-agent ')?'skipped':'passed'}]}]}))}]}],
        }));
        return {stdout:''};
      }
      return prepareRun(command,args,options);
    }
  `);
  git(["add", "."]); git(["commit", "-m", "Verification fixture"]);
  const fixtures = { "": root };
  for (const [changed, contents] of [["pnpm-lock.yaml", "gate-lock"], ["packages/fixture/src/index.ts", "export const value = 2;\n"]]) {
    const copy = join(directory, changed.replaceAll("/", "-"));
    cpSync(root, copy, { recursive: true });
    writeFileSync(join(copy, changed), contents);
    git(["add", "."], copy); git(["commit", "-m", "Change fixture input"], copy);
    fixtures[changed] = copy;
  }
  return { fixtures, base: git(["rev-parse", "HEAD"]), branch: git(["symbolic-ref", "HEAD"]) };
}

test("verification prepares before parallel jobs and runs every JavaScript package and proof", { concurrency: 2 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dohc-verify-fixtures-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { fixtures, base, branch } = createVerificationFixtures(directory);
  const cases = [];
  for (const [mode, job, fault, changed = "pnpm-lock.yaml", full = false, keepGoing = false] of [
    ["pr", null, null], ["pr", "rust", null], ["pr", "js", null],
    ["smoke", null, null], ["e2e", null, null],
    ["pr", null, "rust-verdict"], ["pr", "rust", "cargo-version"], ["pr", null, "source"],
    ["pr", null, "rust"], ["pr", null, "rust-and-js"], ["pr", "rust", "rust"], ["pr", "js", "js"], ["pr", null, "js"],
    ["pr", null, "rust-source"], ["pr", null, "rust-cancel"],
    ["pr", "js", "accounts-skipped"], ["pr", "js", "desktop-skipped"], ["pr", "js", "onboarding-missing"], ["pr", "js", "smoke-missing"],
    ["pr", "js", "restart-missing"], ["pr", "js", "restart-one-missing"], ["pr", "js", "restart-skipped"],
    ["pr", "js", "native-skipped"], ["pr", "js", "accounts-cancelled"], ["pr", "js", "desktop-cancelled"],
    // The gallery is required only where it runs, so its missing-proof case exists only there.
    ...(process.platform === "win32" ? [["pr", "js", "gallery-missing"]] : []),
    // A change to one package selects only the JavaScript gate, which runs that package and its dependents, and only the repository tests that read the source tree.
    ["pr", null, null, "packages/fixture/src/index.ts"],
    // A run that keeps going runs every repository test.
    ["pr", "js", null, "packages/fixture/src/index.ts", false, true],
    ["pr", null, null, null, true], ["pr", "js", null, null, true], ["pr", "rust", null, null, true],
    ["pr", "js", null, null],
    ["pr", null, "warm"], ["pr", null, "pre-typecheck"], ["pr", "rust", "pre-clippy"],
    // A package test that another branch also failed in the last day, run inline beside a queue history.
    ["pr", "js", "shared"],
    // A package test that fails both tries and then passes alone passes the gate.
    ["pr", "js", "passed-alone"],
    // A failure stops the other job unless the run keeps going.
    ["pr", null, "js", undefined, false, true],
  ]) cases.push(t.test([mode, job, fault, changed ?? "empty diff", full ? "full" : "", keepGoing ? "keep-going" : ""].filter(Boolean).join(" "), async (context) => {
    const rust = mode === "pr" && job !== "js" && (full || job === "rust" || changed === "pnpm-lock.yaml");
    const js = mode === "pr" && job !== "rust";
    // The lockfile is a tooling input; a package's source is not. An empty diff narrows nothing.
    const repositoryTests = changed === "packages/fixture/src/index.ts" && !full && !keepGoing ? "test:repo:tree" : "test:repo";
    const warm = ["warm", "pre-typecheck"].includes(fault);
    const preQueueFault = ["pre-typecheck", "pre-clippy"].includes(fault);
    // Desktop smoke and e2e, and the JavaScript gate, prepare the engine and desktop.
    const desktop = mode !== "pr" || js;
    // Only Windows runs the gallery, where its pixels compare.
    const gallery = js && process.platform === "win32";
    const previousIncremental = fault === "source" || full && !job ? undefined : "1";
    const expectedIncremental = mode === "pr" ? "0" : previousIncremental;
    const root = mkdtempSync(join(tmpdir(), "dohc-verify-build-order-"));
    const put = (path, contents) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    };
    try {
      cpSync(fixtures[changed ?? ""], root, { recursive: true });
      const queue = join(root, ".dohc-dev/queue");
      if (fault === "shared") {
        const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
        const failed = [{ step: "@dohc/fixture", test: "src/index.test.ts › keeps its value" }];
        for (const [id, line] of [["000000001-aaaaaa", "refs/heads/feat/a"], ["000000002-bbbbbb", branch]]) put(`.dohc-dev/queue/requests/${id}/request.json`, JSON.stringify({ id, branch: line, checkout: "C:\\w\\other" }));
        put(".dohc-dev/queue/history.jsonl", ["000000001-aaaaaa", "000000002-bbbbbb"].map(id => JSON.stringify({ at: hourAgo, event: "finished", id, failed, outcome: "failed" })).join("\n") + "\n");
      }
      const args = mode === "pr" ? [mode, "--base", base, ...(job ? ["--job", job] : []), ...(full ? ["--full"] : []), ...(keepGoing ? ["--keep-going"] : []), ...(fault === "shared" ? ["--inline"] : [])]
        : mode === "e2e" ? [mode, "--", "--project", "fixture"] : [mode];
      const require = createRequire(join(repoRoot, "apps/desktop/package.json"));
      const result = await runFixture(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import cp from 'node:child_process';
        import {syncBuiltinESMExports} from 'node:module';
        import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
        const exec=cp.execFileSync;
        cp.execFileSync=(command,...args)=>{
          if(command==='rustc') {
            if(!${rust || desktop})throw Error('Native tools unavailable for this change');
            assert.equal(process.env.CARGO_INCREMENTAL,${JSON.stringify(expectedIncremental)},'Source fingerprint compilation policy');
            return Buffer.from('fixture rustc');
          }
          return exec(command,...args);
        };
        syncBuiltinESMExports();
        const {verify}=await import('./scripts/verification/verify.mjs');
        try {
          await verify(process.argv.slice(1));
        }
        catch(error) {console.error(error.message);process.exitCode ||= 1;}
        finally {
          const output='.agent-artifacts/verification';
          writeFileSync('.dohc-dev/report.json',readFileSync(output+'/'+readdirSync(output)[0]+'/result.json'));
          writeFileSync('.dohc-dev/incremental.json',JSON.stringify({value:process.env.CARGO_INCREMENTAL??null,present:Object.hasOwn(process.env,'CARGO_INCREMENTAL')}));
        }
      `, ...args], { cwd: root, timeout: 120_000, signal: context.signal, env: { ...process.env,
        NODE_PATH: join(dirname(require.resolve("js-yaml/package.json")), ".."), FIXTURE_MODE: mode, FIXTURE_FAULT: fault ?? "",
        FIXTURE_CASE: JSON.stringify({ rust, js, desktop, warm, keepGoing, gallery, incremental: expectedIncremental, repositoryTests }),
        CARGO_INCREMENTAL: previousIncremental, ...(fault === "shared" ? { DOHC_VERIFICATION_QUEUE_ROOT: queue } : {}),
        POSTGRES_URL:"postgres://must-not-use-inherited-database/foreign" } });
      assert.equal(result.error, undefined, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(join(root, ".dohc-dev/incremental.json"), "utf8")),
        { value: previousIncremental ?? null, present: previousIncremental !== undefined }, "Verifier must restore the caller's compilation policy");
      const report = JSON.parse(readFileSync(join(root, ".dohc-dev/report.json"), "utf8"));
      if (preQueueFault) {
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, fault === "pre-clippy" ? /fixture clippy failed/ : /fixture typecheck failed/);
        assert.equal(report.verdict, "FAIL");
        assert.equal(existsSync(join(root, ".dohc-dev/queued")), false);
        assert.equal(report.timings.some(phase => phase.name === "queue"), false);
        assert.deepEqual(report.steps.map(({name}) => name), [...(rust ? ["pre-queue-fmt"] : []), ...(js ? ["pre-queue-typecheck"] : []), ...(fault === "pre-clippy" ? ["pre-queue-clippy"] : [])]);
      } else if (fault && !warm && fault !== "passed-alone") {
        assert.equal(result.status, fault === "rust-cancel" ? 143 : 1, result.stderr);
        assert.equal(report.verdict, "FAIL");
        assert.ok(report.steps.every(step => ["PASS", "FAIL", "NOT RUN"].includes(step.verdict)));
        assert.equal(report.final, true);
        assert.equal(report.keepGoing, keepGoing);
        if (fault === "rust-and-js") assert.match(report.rustError, /fixture Rust failed/);
        if (fault === "js" && rust) {
          const verdicts = Object.fromEntries(report.steps.map(step => [step.name, step.verdict]));
          if (keepGoing) {
            assert.equal(verdicts["rust-verdict"], "PASS", "a run that keeps going finishes the other job");
            assert.equal(report.stopped, undefined);
          } else {
            // The failed typecheck interrupts the running Rust job, which never counts as a pass.
            assert.deepEqual([verdicts.typecheck, verdicts.rust, verdicts["rust-verdict"]], ["FAIL", "NOT RUN", "NOT RUN"]);
            assert.equal(report.steps.find(step => step.name === "rust").reason, "stopped after typecheck failed");
            // The tests the typecheck failure kept from starting are listed too.
            assert.deepEqual(report.stopped, { after: "typecheck", notRun: ["rust", "rust-verdict", "tests"] });
            assert.deepEqual(report.failure, { kind: "check", cause: "typecheck" });
            assert.equal(report.rustEvidence, undefined);
            assert.match(result.stdout, /Stopped after typecheck failed. These steps did not finish/);
          }
        }
        const messages = {
          source: /Source changed during verification/,
          "rust-source": /Source changed during verification/,
          "rust-cancel": /Verification interrupted by SIGTERM/,
          rust: /fixture Rust failed/,
          "rust-and-js": /fixture JS failed/,
          js: /fixture JS failed/,
          "rust-verdict": /fixture Rust verdict rejected/,
          "cargo-version": /Install cargo-deny .* to match the workflow/,
          "accounts-skipped": /Account browser verification did not complete without failures or skips/,
          "native-skipped": /self-host native proof did not complete its mandatory test/,
          "accounts-cancelled": /Account browser verification did not complete without failures or skips/,
          "desktop-cancelled": /Desktop verification did not complete a passing test run/,
          "desktop-skipped": /A mandatory desktop smoke test was skipped/,
          "smoke-missing": /did not pass every required proof: @verification-smoke/,
          "onboarding-missing": /did not pass every required proof: @verification-smoke, .*@self-host-onboarding/,
          "restart-missing": /did not pass every required proof: .*@restart-durability/,
          "restart-one-missing": /did not pass every required proof: .*@restart-durability-person-agent/,
          "restart-skipped": /A mandatory desktop smoke test was skipped/,
          "gallery-missing": /did not pass every required proof: .*@states-baselines/,
          shared: /fixture package test failed/,
        };
        assert.match(result.stderr, messages[fault]);
        if (fault === "shared") {
          const row = { step: "@dohc/fixture", test: "src/index.test.ts › keeps its value" };
          // The lookup only reports. The package test's failure decides the verdict, as it would without a queue.
          assert.deepEqual(report.failure, { kind: "check", cause: "tests" });
          assert.deepEqual(report.failed, [row]);
          assert.deepEqual(report.shared, [{ ...row, branches: ["feat/a"] }], "this branch's own run does not count");
          assert.match(result.stdout, /\[verification\] 1 failed test also failed on other branches in the last day\. [^\n]*:\n {2}@dohc\/fixture: src\/index\.test\.ts › keeps its value \(also feat\/a\)\n/u);
          const rerun = 'pnpm --filter @dohc/fixture exec vitest run src/index.test.ts -t "^keeps its value$"';
          assert.deepEqual(report.rerun, [rerun]);
          assert.ok(result.stdout.endsWith(`[verification] Rerun the failed tests locally before resubmitting. Set DOHC_REQUIRE_POSTGRES=1 and DOHC_REQUIRE_ENGINE_E2E=1, as the gate does, so a missing database or engine fails instead of skipping:\n  ${rerun}\n`), result.stdout);
        } else {
          assert.equal(report.shared, undefined, "a failure without failed tests looks nothing up");
          assert.equal(report.rerun, undefined, "a failure without failed tests has nothing to rerun");
          assert.doesNotMatch(result.stdout, /Rerun the failed tests/u);
        }
        if (fault === "restart-one-missing") {
          for (const tag of ["@restart-durability-idle-external", "@restart-durability-overlapping-typing", "@restart-durability-capture-before-reopen"]) {
            assert.ok(report.desktopProofs.some(title => title.split(/\s+/u).includes(tag)), `${tag} passed`);
          }
          assert.ok(!report.desktopProofs.some(title => title.split(/\s+/u).includes("@restart-durability-person-agent")));
        }
        assert.equal(existsSync(join(root, ".dohc-dev/verification/build.json")), desktop);
        assert.equal(existsSync(join(root, ".dohc-dev/database-stopped")), js);
        assert.equal(report.steps.some(step => step.name === "typecheck"), js);
        if (["rust", "rust-verdict", "rust-and-js"].includes(fault)) {
          const failedStep = fault === "rust-verdict" ? "rust-verdict" : "rust";
          assert.equal(report.steps.find(step => step.name === failedStep).verdict, "FAIL");
          if (js) {
            const typecheck = report.steps.find(step => step.name === "typecheck");
            assert.equal(typecheck.verdict, fault === "rust-and-js" ? "FAIL" : "PASS");
            // The Rust failure stops the tests before runtime packaging, their last step.
            if (fault !== "rust-and-js") {
              assert.equal(report.steps.find(step => step.name === "tests").verdict, "NOT RUN");
              assert.deepEqual(JSON.parse(readFileSync(report.jsTests, "utf8")).stopped.notRun, ["desktop-runtime-packaging"]);
              // A failed rust step also kept its verdict check from starting.
              assert.deepEqual(report.stopped, { after: failedStep, notRun: failedStep === "rust" ? ["tests", "rust-verdict", "tests: desktop-runtime-packaging"] : ["tests", "tests: desktop-runtime-packaging"] });
            }
          }
        }
        if (fault === "js") {
          assert.equal(report.steps.find(step => step.name === "typecheck").verdict, "FAIL");
          assert.equal(report.steps.some(step => step.name === "rust"), rust);
        }
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(report.rerun, undefined);
        assert.doesNotMatch(result.stdout, /Rerun the failed tests/u, "a passing run prints no commands");
        assert.deepEqual(report.steps.map(({name})=>name).sort(), [
          ...(mode === "pr" ? ["install"] : []),
          ...(desktop ? ["electron-install", "desktop"] : []),
          ...(mode === "e2e" ? ["browser-install"] : []),
          "app-backend-runtime",
          ...(rust ? ["pre-queue-fmt", "pre-queue-clippy", "pre-queue-test-build", "cargo-deny-version", "cargo-audit-version", "cargo-nextest-version", "rust", "rust-verdict"] : []),
          ...(js && warm ? ["pre-queue-typecheck"] : []),
          ...(js ? ["typecheck", "tests", "self-host-native", "browser-install", "accounts"] : []),
        ].sort());
        if (rust && js) assert.equal(readFileSync(join(root, '.dohc-dev/jobs-overlapped'), 'utf8'), 'yes');
        assert.equal(report.verdict, "PASS");
        if (fault === "passed-alone") {
          assert.deepEqual(report.flaky, [{ step: "@dohc/fixture", test: "src/index.test.ts › keeps its value", passedAlone: true }]);
          assert.deepEqual(report.failed, []);
          assert.match(result.stdout, /\[verification\] 1 flaky test\(s\) passed only on retry\. Each one is a defect to fix:\n {2}@dohc\/fixture: src\/index\.test\.ts › keeps its value \(failed both tries, passed alone\)\n/u);
        }
        assert.ok(report.seconds >= 0 && report.startedAt && report.finishedAt);
        assert.ok(report.steps.every(step => step.startedAt && step.finishedAt && step.seconds >= 0));
        assert.ok(report.timings.every(phase => phase.startedAt && phase.finishedAt && phase.seconds >= 0));
        assert.equal(report.timings.some(phase => phase.name === "queue"), mode === "pr");
        assert.equal(report.timings.some(phase => phase.name === "prepare"), desktop);
        assert.equal(report.timings.some(phase => phase.name === "postgres-start"), js);
        assert.equal(report.timings.some(phase => phase.name === "postgres-stop"), js);
        assert.equal(report.provenance.status, "PASS");
        assert.equal(Boolean(report.build), desktop);
        assert.equal(existsSync(join(root, ".dohc-dev/database-stopped")), js);
        assert.deepEqual(report.gates,{rust,js});
        assert.equal(report.full,full);
        assert.equal(report.repositoryTests, js ? repositoryTests : undefined);
        assert.equal(result.stdout.includes("[verification] repository tests: tree set only (no tooling change)."), js && repositoryTests === "test:repo:tree");
        if (js) {
          if (process.platform !== "win32") {
            assert.equal(report.statesPage, `not run: the states page compares pixels on win32 only, and this host is ${process.platform}`);
            assert.ok(report.desktopProofs.some(title => title.includes("@verification-smoke")));
          }
          const tests=JSON.parse(readFileSync(report.jsTests,"utf8"));
          assert.equal(tests.proofs, true);
          assert.equal(tests.steps.filter(step => step.name === "proofs").length, 1);
          // A change inside one package tests it and its dependents only.
          const tested = changed === "packages/fixture/src/index.ts" && !full ? ["@dohc/desktop", "@dohc/fixture"] : packages;
          assert.deepEqual(tests.packages.map(pkg=>pkg.name).sort(),tested);
          const calls=readFileSync(join(root,".dohc-dev/all-calls.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
          assert.deepEqual(calls.filter(({args})=>args[2]==="run" && ["test","test:unit"].includes(args[3])).map(({args})=>args[1]).sort(),tested);
          for (const script of ["test:scripts:isolated", "test:scripts:runtime"]) {
            assert.equal(calls.filter(({args}) => args[3] === script).length, 1);
          }
          assert.equal(calls.some(({args}) => args[3] === "test:scripts"), false);
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }));
  const results = await Promise.allSettled(cases);
  for (const result of results) if (result.status === "rejected") throw result.reason;
});
