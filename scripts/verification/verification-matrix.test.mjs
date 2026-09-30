import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoRoot } from "./process.mjs";
import { createPrepareFixture } from "./prepare-fixture.mjs";

// Resolve only after the owned child closes, including timeout or cancellation.
function runFixture(command, args, { timeout, signal, encoding, ...options }) {
  if (signal?.aborted) throw new Error("Fixture cancelled before launch.");
  return new Promise(resolve => {
    const child = spawn(command, args, { ...options, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    let error;
    child.on("error", cause => { error ??= cause; });
    const stop = message => {
      error ??= new Error(message);
      child.kill("SIGKILL");
    };
    const collect = chunks => {
      let bytes = 0;
      return chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) stop("Fixture output exceeded its buffer.");
        else chunks.push(chunk);
      };
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    const abort = () => stop("Fixture cancelled.");
    signal?.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => stop("Fixture timed out."), timeout);
    child.once("close", (status, exitSignal) => {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      resolve({ status, signal: exitSignal, error, stdout: Buffer.concat(stdout).toString(encoding),
        stderr: Buffer.concat(stderr).toString(encoding) });
    });
    if (signal?.aborted) abort();
  });
}

test("verification selects packages and proofs and prepares before parallel jobs", { concurrency: 2 }, async (t) => {
  const siteFiles = ["src/renderer/workbench/ChatLane.test.tsx", "src/renderer/workbench/ProductDemo.test.tsx"];
  const cases = [];
  for (const [mode, job, fault, changed = "pnpm-lock.yaml", full = false] of [
    ["pr", null, null], ["pr", "rust", null], ["pr", "js", null],
    ["smoke", null, null], ["e2e", null, null],
    ["pr", null, "rust-verdict"], ["pr", "rust", "cargo-version"], ["pr", null, "source"],
    ["pr", null, "rust"], ["pr", null, "rust-and-js"], ["pr", "rust", "rust"], ["pr", "js", "js"], ["pr", null, "js"],
    ["pr", null, "rust-source"], ["pr", null, "rust-cancel"],
    ["pr", "js", "accounts-skipped"], ["pr", "js", "desktop-skipped"], ["pr", "js", "onboarding-missing"],
    ["pr", null, null, "packages/fixture/src/index.ts"],
    ["pr", null, null, "packages/mcp/src/index.ts"],
    ["pr", null, null, "services/workspace-api/src/index.ts"],
    ["pr", null, null, "apps/site/src/index.ts"],
    ["pr", null, null, null, true], ["pr", "js", null, null, true], ["pr", "rust", null, null, true],
    ["pr", "js", null, null],
  ]) cases.push(t.test([mode, job, fault, changed ?? "empty diff", full ? "full" : ""].filter(Boolean).join(" "), async (context) => {
    const rust = mode === "pr" && job !== "js" && (full || job === "rust" || changed === "pnpm-lock.yaml");
    const js = mode === "pr" && job !== "rust";
    const siteOnly = changed === "apps/site/src/index.ts" && !full;
    const selected = changed === "packages/fixture/src/index.ts" ? ["@dohc/fixture"]
      : changed === "packages/mcp/src/index.ts" ? ["@dohc/mcp", "@dohc/share-web"]
      : changed === "services/workspace-api/src/index.ts" ? ["@dohc/workspace-api"]
      : siteOnly ? ["@dohc/desktop", "@dohc/site"]
      : ["@dohc/desktop", "@dohc/fixture", "@dohc/mcp", "@dohc/share-web", "@dohc/site", "@dohc/unrelated", "@dohc/workspace-api"];
    const desktopScripts = js && selected.includes("@dohc/desktop") && !siteOnly;
    const desktop = mode !== "pr" || desktopScripts || js && changed === "services/workspace-api/src/index.ts";
    const nativeProof = js && selected.includes("@dohc/share-web");
    const accounts = js && selected.includes("@dohc/workspace-api");
    const prepare = desktop || nativeProof;
    const database = js && (desktop || nativeProof || accounts);
    const browser = js && (desktop || accounts);
    const previousIncremental = fault === "source" || full && !job ? undefined : "1";
    const expectedIncremental = mode === "pr" ? "0" : previousIncremental;
    const root = mkdtempSync(join(tmpdir(), "dohc-verify-build-order-"));
    const put = (path, contents) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    };
    const git = (args) => execFileSync("git", ["-c", `core.hooksPath=${join(root, "no-hooks")}`,
      "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd: root, encoding: "utf8" }).trim();
    try {
      createPrepareFixture(root, new URL("./build.mjs", import.meta.url), { commit: false });
      git(["config", "core.logAllRefUpdates", "true"]);
      mkdirSync(join(root, ".dohc-dev"), { recursive: true });
      for (const path of ["scripts/verification/verify.mjs", "scripts/verification/js-tests.mjs", "scripts/verification/selection.mjs", "scripts/verification/timing.mjs", "tools/rust-engine-program/tree-provenance.mjs",
        "apps/desktop/scripts/require-e2e-engine.mjs", ".github/workflows/pr-checks.yml"]) {
        put(path, readFileSync(join(repoRoot, path)));
      }
      put("scripts/verification/js-tests-real.mjs", readFileSync(join(root, "scripts/verification/js-tests.mjs")));
      put("scripts/verification/js-tests.mjs", `
        import assert from 'node:assert/strict';
        import {testWorkspace as realTests} from './js-tests-real.mjs';
        import {finishRuntimeReader} from './process.mjs';
        export const testWorkspace = options => realTests({...options, beforeDesktopScripts: async () => {
          const pending = options.beforeDesktopScripts();
          let settled = false;
          pending.then(() => {settled = true;});
          await Promise.resolve();
          if(${rust})assert.equal(settled, false, 'Packaging barrier did not wait for Rust');
          finishRuntimeReader();
          await pending;
        }});
      `);
      put(".gitignore", readFileSync(join(root, ".gitignore"), "utf8") + ".agent-artifacts/\napps/desktop/.env.local\n");
      put("apps/desktop/package.json", '{"name":"@dohc/desktop","scripts":{"test":"unused","test:unit":"vitest run","test:scripts":"scripts","test:scripts:isolated":"isolated","test:scripts:runtime":"runtime"}}');
      for (const file of siteFiles) put(`apps/desktop/${file}`, "// fixture compatibility test\n");
      for (const name of ["fixture", "mcp", "share-web", "site", "unrelated", "workspace-api"]) {
        const path = `${name === "workspace-api" ? "services" : name === "site" ? "apps" : "packages"}/${name}`;
        put(`${path}/package.json`, JSON.stringify({name:`@dohc/${name}`,scripts:{test:"vitest run"}}));
        put(`${path}/src/index.ts`, "export const value = 1;\n");
      }
      put("pnpm-workspace.yaml", 'packages: ["apps/*", "packages/*", "services/*"]\n');
      for (const name of ["dohc", "dohc-mcp"]) {
        put(`apps/desktop/resources/cli-bin/${name}`, "fixture launcher");
        chmodSync(join(root, "apps/desktop/resources/cli-bin", name), 0o755);
      }
      put("scripts/verification/doctor.mjs", `
        import assert from 'node:assert/strict';
        import {readFileSync} from 'node:fs';
        export function doctor(options) {
          assert.deepEqual(options,${JSON.stringify({engine:rust || prepare,desktop,browser:desktop || accounts})});
          if(process.env.FIXTURE_MODE==='pr' && readFileSync('node_modules/installed.txt','utf8')!==readFileSync('pnpm-lock.yaml','utf8'))
            throw Error('doctor ran before verifier installation');
          if(${desktop})assert.equal(readFileSync('.dohc-dev/electron-installed','utf8'),'yes');
          return {checks:[]};
        }
      `);
      const adapterPath = "scripts/verification/process.mjs";
      put(adapterPath, readFileSync(join(root, adapterPath), "utf8").replace("export async function run(", "async function prepareRun(") + `
        let releaseRust, releaseJavascript, runtimeBuilt = false, rustFinished = false, repositoryFinished = false, isolatedScriptsFinished = false;
        const javascriptStarted=new Promise(resolve=>{releaseRust=resolve;});
        const rustStarted=new Promise(resolve=>{releaseJavascript=resolve;});
        export const finishRuntimeReader = () => releaseRust();
        export async function run(command,args,options={}) {
          const {enginePath,stagedEnginePath,assertPrepared,hashFile}=await import('./build.mjs');
          appendFileSync(join(repoRoot,'.dohc-dev/all-calls.jsonl'),JSON.stringify({command,args})+'\\n');
          if(command==='cargo' || args[0]==='tools/rust-engine-program/run-rust-checks.mjs') {
            assert.equal(process.env.CARGO_INCREMENTAL,${JSON.stringify(expectedIncremental)},'Verifier compilation policy');
            assert.equal(options.env.CARGO_INCREMENTAL,${JSON.stringify(expectedIncremental)},'Build child compilation policy');
          }
          if(args[0]==='apps/desktop/scripts/ensure-electron-installed.mjs') {
            assert.ok(${desktop},'Unselected Electron installation');
            writeFileSync(join(repoRoot,'.dohc-dev/electron-installed'),'yes');
            return {stdout:''};
          }
          if(command==='xvfb-run') {
            assert.equal(process.platform,'linux');assert.ok(!process.env.DISPLAY);
            assert.equal(args[0],'-a');assert.equal(args[1],process.execPath);
            assert.ok(args.includes('apps/desktop/playwright.config.ts'));
            command=args[1];args=args.slice(2);
          }
          if(command==='cargo' && !${rust || prepare})throw Error('Native tools unavailable for this JavaScript change');
          if(command==='pnpm' && args[1]==='@dohc/desktop' && args.includes('build') && !${desktop})throw Error('Electron unavailable for this change');
          if(command==='pnpm' && args[1]==='@dohc/app-backend-runtime') {
            assert.deepEqual(args,['--filter','@dohc/app-backend-runtime','build']);
            runtimeBuilt = true;
            return {stdout:'compiled runtime'};
          }
          if(command==='pnpm' && args[0]==='install' && !existsSync(join(repoRoot,'.dohc-dev/verification/build.json.lock'))) {
            assert.deepEqual(args,['install','--frozen-lockfile']);
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
            if(${prepare})assertPrepared({engineOnly:!${desktop},engineBinary:stagedEnginePath});
            mkdirSync(dirname(enginePath),{recursive:true});writeFileSync(enginePath,'workspace engine');chmodSync(enginePath,0o755);
            if(${rust && js}) {
              writeFileSync(join(repoRoot,'.dohc-dev/rust-running'),'yes');
              releaseJavascript();
              await javascriptStarted;
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
            if(!${database})throw Error('Docker unavailable for this change');
            if(args[0]==='run'){writeFileSync(join(repoRoot,'.dohc-dev/database-started'),'yes');return {stdout:'a'.repeat(64)};}
            if(args[0]==='inspect')return {stdout:'healthy'};
            if(args[0]==='port')return {stdout:'127.0.0.1:1234'};
            assert.deepEqual(args,['rm','--force','a'.repeat(64)]);
            writeFileSync(join(repoRoot,'.dohc-dev/database-stopped'),'yes');return {stdout:''};
          }
          if(command==='pnpm' && args[0]==='run') {
            assert.ok(['typecheck','test:repo','test:repo:source'].includes(args[1]));
            if(args[1]!=='typecheck')assert.equal(args[1],${JSON.stringify(full || job === "js" && !changed || changed === "pnpm-lock.yaml" ? "test:repo" : "test:repo:source")});
            if(args[1]==='typecheck' && ${rust && js}) {
              await rustStarted;
              assert.equal(readFileSync(join(repoRoot,'.dohc-dev/rust-running'),'utf8'),'yes');
              writeFileSync(join(repoRoot,'.dohc-dev/jobs-overlapped'),'yes');
              if(['js','rust-and-js'].includes(process.env.FIXTURE_FAULT))releaseRust();
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
            assert.ok(${desktopScripts}, 'Unselected desktop scripts');
            assert.ok(repositoryFinished, 'Desktop scripts started before repository checks finished');
            if(args[3]==='test:scripts:isolated') {
              assert.ok(!isolatedScriptsFinished, 'Isolated scripts ran twice');
              if(${rust})assert.equal(rustFinished, false, 'Isolated scripts unnecessarily waited for Rust');
              isolatedScriptsFinished = true;
            } else {
              assert.ok(isolatedScriptsFinished, 'Runtime packaging started before isolated scripts finished');
              assert.ok(!${rust} || rustFinished, 'Packaging raced the Rust runtime reader');
            }
            return {stdout:''};
          }
          if(command==='pnpm' && args[2]==='run' && ['test','test:unit'].includes(args[3])) {
            assert.deepEqual(args,['--filter',args[1],'run',args[1]==='@dohc/desktop'?'test:unit':'test',args[1]==='@dohc/desktop'?args[4]:'--maxWorkers=4',
              ...(args[1]==='@dohc/desktop' && ${siteOnly} ? ${JSON.stringify(siteFiles)} : [])]);
            assert.ok(${JSON.stringify(selected)}.includes(args[1]),'Unselected package executed: '+args[1]);
            assert.equal(options.env.POSTGRES_URL,${JSON.stringify(database ? "postgres://dohc:dohc@127.0.0.1:1234/dohc" : "")});
            for(const flag of ['DOHC_REQUIRE_POSTGRES','DOHC_REQUIRE_ENGINE_E2E'])assert.equal(options.env[flag],'1');
            return {stdout:''};
          }
          if(command==='pnpm' && args[0]==='exec') {
            if(!${browser})throw Error('Browser tools unavailable for this change');
            assert.deepEqual(args,['exec','playwright','install',...(process.platform==='linux'?['--with-deps']:[]),'chromium']);
            assert.equal(options.env.DOHC_REQUIRE_POSTGRES,'1');
            writeFileSync(join(repoRoot,'.dohc-dev/browser-installed'),'yes');
            return {stdout:''};
          }
          if(command==='pnpm' && args.includes('vitest.self-host-native.config.ts')) {
            assert.ok(${nativeProof},'Unselected native proof');
            assertPrepared({engineOnly:!${desktop},engineBinary:stagedEnginePath});
            assert.equal(options.env.DOHC_SERVICE_HOST_PROOF_BINARY,stagedEnginePath);
            assert.equal(options.env.DOHC_SERVICE_HOST_PROOF_SHA256,hashFile(stagedEnginePath));
            assert.equal(options.env.DOHC_REQUIRE_POSTGRES,'1');
            const output=options.env.DOHC_SERVICE_HOST_PROOF_OUTPUT;
            mkdirSync(join(output,'self-host-live-fixture'),{recursive:true});
            writeFileSync(join(output,'vitest.json'),JSON.stringify({success:true,numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:0}));
            writeFileSync(join(output,'self-host-live-fixture/result.json'),JSON.stringify({verdict:'PASS',executable:stagedEnginePath,sha256:hashFile(stagedEnginePath),results:{ownerDelivery:{restartPreservedDraft:true,concurrentOwnerAndNamedEditsMerged:true,idleOwnerPulledRecipientEdit:true},settledAndPublished:{ordinaryOwnerReadMatched:true}}}));
            return {stdout:''};
          }
          if(args[0]==='apps/desktop/scripts/run-playwright.mjs') {
            if(!${desktop || accounts})throw Error('Browser tools unavailable for this change');
            if(${desktop})assertPrepared({engineBinary:stagedEnginePath});
            const pr=process.env.FIXTURE_MODE==='pr';
            if(pr) {
              assert.equal(options.env.POSTGRES_URL,'postgres://dohc:dohc@127.0.0.1:1234/dohc');
              assert.equal(options.env.DOHC_REQUIRE_POSTGRES,'1');
              assert.equal(existsSync(join(repoRoot,'.dohc-dev/database-started')),true);
              assert.equal(existsSync(join(repoRoot,'.dohc-dev/database-stopped')),false);
              assert.equal(existsSync(join(repoRoot,'.dohc-dev/browser-installed')),true);
            }
            if(args.includes('services/workspace-api/playwright.config.ts')) {
              assert.ok(${accounts},'Unselected account proof');
              assert.ok(pr);
              writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME,JSON.stringify({stats:{expected:2,unexpected:0,flaky:0,skipped:process.env.FIXTURE_FAULT==='accounts-skipped'?1:0}}));
              return {stdout:''};
            }
            assert.ok(${desktop},'Unselected desktop proof');
            const expected=process.env.FIXTURE_MODE==='e2e'?['--project','fixture']:['--grep',pr?'@verification-smoke|@self-host-onboarding':'@verification-smoke'];
            assert.ok(args.some((arg,index)=>arg===expected[0] && args[index+1]===expected[1]));
            const titles=['@verification-smoke persistence',...(pr?[process.env.FIXTURE_FAULT==='onboarding-missing'?'@verification-smoke another persistence':'@self-host-onboarding account and sync']:[])];
            writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME,JSON.stringify({
              stats:{expected:pr?2:1,unexpected:0,flaky:0,skipped:process.env.FIXTURE_FAULT==='desktop-skipped'?1:0},
              suites:[{suites:[{specs:titles.map(title=>({title,ok:true,tests:[{results:[{status:'passed'}]}]}))}]}],
            }));
            return {stdout:''};
          }
          return prepareRun(command,args,options);
        }
      `);
      git(["add", "."]); git(["commit", "-m", "Verification fixture"]);
      const base = git(["rev-parse", "HEAD"]);
      if (changed) {
        put(changed, changed === "pnpm-lock.yaml" ? "gate-lock" : "export const value = 2;\n");
        git(["add", "."]); git(["commit", "-m", "Change fixture input"]);
      }
      const args = mode === "pr" ? [mode, "--base", base, ...(job ? ["--job", job] : []), ...(full ? ["--full"] : [])]
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
            if(!${rust || prepare})throw Error('Native tools unavailable for this JavaScript change');
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
      `, ...args], { cwd: root, encoding: "utf8", timeout: 120_000, signal: context.signal, env: { ...process.env,
        NODE_PATH: dirname(dirname(require.resolve("js-yaml/package.json"))), FIXTURE_MODE: mode, FIXTURE_FAULT: fault ?? "",
        CARGO_INCREMENTAL: previousIncremental,
        POSTGRES_URL:"postgres://must-not-use-inherited-database/foreign" } });
      assert.equal(result.error, undefined, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(join(root, ".dohc-dev/incremental.json"), "utf8")),
        { value: previousIncremental ?? null, present: previousIncremental !== undefined }, "Verifier must restore the caller's compilation policy");
      const report = JSON.parse(readFileSync(join(root, ".dohc-dev/report.json"), "utf8"));
      if (fault) {
        assert.equal(result.status, fault === "rust-cancel" ? 143 : 1, result.stderr);
        assert.equal(report.verdict, "FAIL");
        assert.ok(report.steps.every(step => ["PASS", "FAIL"].includes(step.verdict)));
        if (fault === "rust-and-js") assert.match(report.rustError, /fixture Rust failed/);
        if (fault === "js" && rust) assert.equal(report.steps.find(step => step.name === "rust-verdict").verdict, "PASS");
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
          "desktop-skipped": /A mandatory desktop smoke test was skipped/,
          "onboarding-missing": /did not pass both persistence and self-host onboarding proofs/,
        };
        assert.match(result.stderr, messages[fault]);
        const ranJs = js;
        assert.equal(existsSync(join(root, ".dohc-dev/verification/build.json")), prepare);
        assert.equal(existsSync(join(root, ".dohc-dev/database-stopped")), ranJs);
        assert.equal(report.steps.some(step => step.name === "typecheck"), ranJs);
        if (["rust", "rust-verdict", "rust-and-js"].includes(fault)) {
          const failedStep = fault === "rust-verdict" ? "rust-verdict" : "rust";
          assert.equal(report.steps.find(step => step.name === failedStep).verdict, "FAIL");
          if (js) {
            const typecheck = report.steps.find(step => step.name === "typecheck");
            assert.equal(typecheck.verdict, fault === "rust-and-js" ? "FAIL" : "PASS");
            if (fault !== "rust-and-js") assert.equal(report.steps.find(step => step.name === "tests").verdict, "PASS");
          }
        }
        if (fault === "js") {
          assert.equal(report.steps.find(step => step.name === "typecheck").verdict, "FAIL");
          assert.equal(report.steps.some(step => step.name === "rust"), rust);
        }
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(report.steps.map(({name})=>name).sort(), [
          ...(mode === "pr" ? ["install"] : []),
          ...(desktop ? ["electron-install"] : []),
          "app-backend-runtime",
          ...(rust ? ["cargo-deny-version", "cargo-audit-version", "cargo-nextest-version", "rust", "rust-verdict"] : []),
          ...(js ? ["typecheck", "tests"] : []),
          ...(nativeProof ? ["self-host-native"] : []), ...(browser ? ["browser-install"] : []),
          ...(accounts ? ["accounts"] : []), ...(desktop ? ["desktop"] : []),
        ].sort());
        if (rust && js) assert.equal(readFileSync(join(root, '.dohc-dev/jobs-overlapped'), 'utf8'), 'yes');
        assert.equal(report.verdict, "PASS");
        assert.ok(report.seconds >= 0 && report.startedAt && report.finishedAt);
        assert.ok(report.steps.every(step => step.startedAt && step.finishedAt && step.seconds >= 0));
        assert.ok(report.timings.every(phase => phase.startedAt && phase.finishedAt && phase.seconds >= 0));
        assert.equal(report.timings.some(phase => phase.name === "queue"), mode === "pr");
        assert.equal(report.timings.some(phase => phase.name === "prepare"), prepare);
        assert.equal(report.timings.some(phase => phase.name === "postgres-start"), database);
        assert.equal(report.timings.some(phase => phase.name === "postgres-stop"), database);
        assert.equal(report.provenance.status, "PASS");
        assert.equal(Boolean(report.build), prepare);
        assert.equal(existsSync(join(root, ".dohc-dev/database-stopped")), database);
        assert.deepEqual(report.gates,{rust,js});
        assert.equal(report.full,full);
        if (js) {
          assert.deepEqual(report.javascript.packages,selected);
          assert.deepEqual(report.javascript.proofs,{accounts,selfHostNative:nativeProof,desktop});
          assert.equal(report.javascript.desktopScripts, desktopScripts);
          assert.deepEqual(report.javascript.testFiles, siteOnly ? {"@dohc/desktop": siteFiles} : {});
          const tests=JSON.parse(readFileSync(report.jsTests,"utf8"));
          assert.equal(tests.desktopScripts, desktopScripts);
          assert.deepEqual(tests.selectedPackages,selected);
          assert.deepEqual(tests.packages.map(pkg=>pkg.name).sort(),selected);
          const calls=readFileSync(join(root,".dohc-dev/all-calls.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
          assert.deepEqual(calls.filter(({args})=>args[2]==="run" && ["test","test:unit"].includes(args[3])).map(({args})=>args[1]).sort(),tests.packages.map(pkg=>pkg.name).sort());
          for (const script of ["test:scripts:isolated", "test:scripts:runtime"]) {
            assert.equal(calls.filter(({args}) => args[3] === script).length, desktopScripts ? 1 : 0);
          }
          assert.equal(calls.some(({args}) => args[3] === "test:scripts"), false);
          if (siteOnly) assert.deepEqual(tests.packages.find(pkg => pkg.name === "@dohc/desktop").files, siteFiles);
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }));
  const results = await Promise.allSettled(cases);
  for (const result of results) if (result.status === "rejected") throw result.reason;
});
