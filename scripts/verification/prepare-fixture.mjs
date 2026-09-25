import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Copy the actual preparer; replace only its external command and staging boundaries.
export function createPrepareFixture(root, buildSource) {
  const put = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  put("package.json", '{"type":"module"}\n');
  put(".gitignore", "node_modules/\ntarget/\n.dohc-dev/\napps/desktop/dist/\napps/desktop/resources/\npackages/sdk/dist/\n");
  put("pnpm-lock.yaml", "new-lock");
  put("node_modules/installed.txt", "old-lock");
  put("scripts/verification/build.mjs", readFileSync(buildSource));
  put("scripts/verification/cancellation.mjs", readFileSync(new URL("./cancellation.mjs", import.meta.url)));
  put("tools/rust-engine-program/build-slot.mjs", "export const resolveBuildBudget=()=>null; export const freeDiskGb=()=>100; export const acquireBuildSlot=()=>{throw Error('not expected')};");
  put("apps/desktop/scripts/require-e2e-engine.mjs", "export const requireE2eEngine=()=>{};");
  put("apps/desktop/scripts/stage-plugin-tools.mjs", "export const stagedEsbuildExecutable=()=>true;");
  put("scripts/verification/process.mjs", `
    import assert from 'node:assert/strict';
    import {execFileSync} from 'node:child_process';
    import {appendFileSync,chmodSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
    import {dirname,join,resolve} from 'node:path';
    export const repoRoot=resolve(import.meta.dirname,'../..');
    export const git=(args,root=repoRoot)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
    export const readJson=path=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
    export const pnpm=args=>['pnpm',args];
    export async function run(command,args,{log}={}) {
      const put=(path,bytes)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);};
      appendFileSync(join(repoRoot,'.dohc-dev/calls.jsonl'),JSON.stringify({command,args})+'\\n');
      if(command==='pnpm' && args[0]==='install') {
        put(log,'preparation install output');
        assert.deepEqual(args,['install','--frozen-lockfile']);
        assert.ok(existsSync(join(repoRoot,'.dohc-dev/verification/build.json.lock')));
        if(process.env.FIXTURE_INSTALL_FAIL==='1') throw new Error('frozen install rejected');
        put(join(repoRoot,'node_modules/installed.txt'),readFileSync(join(repoRoot,'pnpm-lock.yaml')));
        return {};
      }
      if(command==='cargo') {
        const executable=join(repoRoot,'target/debug/dohc-workspace-engine'+(process.platform==='win32'?'.exe':''));
        put(executable,'engine'); chmodSync(executable,0o755);
        return {stdout:JSON.stringify({reason:'compiler-artifact',target:{name:'dohc-workspace-engine'},executable})};
      }
      assert.deepEqual([command,...args],['pnpm','--filter','@dohc/desktop','build']);
      for(const path of ['apps/desktop/dist','apps/desktop/resources/cli-bin','apps/desktop/resources/plugin-tools','apps/desktop/resources/app-backend-runtime','packages/sdk/dist'])
        put(join(repoRoot,path,'built.txt'),readFileSync(join(repoRoot,'node_modules/installed.txt')));
      return {};
    }
  `);
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init"]);
  git(["add", "."]);
  git(["-c", `core.hooksPath=${join(root, "no-hooks")}`, "-c", "commit.gpgsign=false",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture"]);
  return ({ failInstall = false } = {}) => spawnSync(process.execPath, ["--input-type=module", "-e", `
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const exec=cp.execFileSync;
    cp.execFileSync=(command,...args)=>command==='rustc'?Buffer.from('fixture rustc'):exec(command,...args);
    syncBuiltinESMExports();
    const {prepare,preparedStatus}=await import('./scripts/verification/build.mjs');
    await prepare();
    console.log(JSON.stringify({desktopPrepared:preparedStatus('desktop')}));
  `], { cwd: root, encoding: "utf8", timeout: 20_000, env: { ...process.env, FIXTURE_INSTALL_FAIL: failInstall ? "1" : "0" } });
}
