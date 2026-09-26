import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The owner implementations are copied unchanged. External build, Git, Docker,
// YAML, and doctor boundaries use offline adapters; no service or build starts.
export function runOwnerCancellationFixture(root, sourceRoot, kind, signal, cleanupFails = false) {
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const copy = (path) => put(path, readFileSync(join(sourceRoot, path)));
  put("package.json", '{"type":"module"}');
  for (const file of ["build.mjs", "verify.mjs", "js-tests.mjs", "cancellation.mjs", "timing.mjs"]) {
    const path = `scripts/verification/${file}`;
    if (existsSync(join(sourceRoot, path))) copy(path);
  }
  put("apps/desktop/package.json", "{}");
  put(".github/workflows/pr-checks.yml", "fixture workflow");
  put("node_modules/js-yaml/index.js", "exports.load=s=>s==='fixture workflow'?{jobs:{changes:{steps:[{with:{filters:'fixture filters'}}]}}}:{rust:[],js:['**']};");
  put("tools/rust-engine-program/build-slot.mjs", "export const resolveBuildBudget=()=>null;export const freeDiskGb=()=>100;export const acquireBuildSlot=()=>{throw Error('unexpected slot acquisition')};");
  put("apps/desktop/scripts/require-e2e-engine.mjs", "export const requireE2eEngine=()=>{};");
  put("apps/desktop/scripts/stage-plugin-tools.mjs", "export const stagedEsbuildExecutable=()=>true;");
  put("scripts/verification/doctor.mjs", "export const doctor=()=>({checks:[]});");
  put("tools/rust-engine-program/tree-provenance.mjs", "export const readTreeState=()=>({head:'fixture'});export const classifyTreeProvenance=()=>({status:'PASS'});");
  if (kind === "verify") put("scripts/verification/build.mjs", `
    import {existsSync} from 'node:fs';
    import {interruptDuringSync} from './process.mjs';
    export const prepare=async()=>{};
    export const assertPrepared=()=>({});
    export const buildEnvironment=()=>process.env;
    export const enginePath='fixture-engine';
    export const hashFile=()=>{throw Error('unexpected engine hashing after cancellation');};
    export function sourceFingerprint(){if(existsSync('typecheck-complete'))interruptDuringSync();return 'fixture';}
  `);
  put("scripts/verification/process.mjs", `
    import {execFileSync} from 'node:child_process';
    import {appendFileSync,existsSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
    import {resolve} from 'node:path';
    export const repoRoot=resolve(import.meta.dirname,'../..');
    let interrupted=false;
    export function interruptDuringSync(){
      if(interrupted)return;interrupted=true;
      writeFileSync('sync-entered','yes');
      if(process.platform==='win32') {if(!process.emit('${signal}'))process.exit(${signal === "SIGINT" ? 130 : 143});}
      else execFileSync(process.execPath,['-e',"process.kill("+process.pid+",'${signal}')"]);
      writeFileSync('sync-returned','yes');
    }
    export const git=args=>args[0]==='status'?'':args[0]==='ls-files'?'':'fixture';
    export const readJson=path=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
    export const pnpm=args=>['pnpm',args];
    export async function run(command,args){
      appendFileSync('commands.jsonl',JSON.stringify({command,args})+'\\n');
      if(command==='docker'){
        if(args[0]==='run'){writeFileSync('container','a'.repeat(64));return {stdout:'a'.repeat(64)};}
        if(args[0]==='inspect')return {stdout:'healthy'};
        if(args[0]==='port')return {stdout:'127.0.0.1:1234'};
        if(args[0]==='rm'){
          if(args[2]!==readFileSync('container','utf8'))throw Error('wrong container');
          if(${cleanupFails})throw Error('fixture cleanup rejected');
          rmSync('container');return {stdout:'removed'};
        }
      }
      if(args.includes('typecheck'))writeFileSync('typecheck-complete','yes');
      return {stdout:''};
    }
  `);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {writeFileSync} from 'node:fs';
    const {interruptDuringSync}=await import('./scripts/verification/process.mjs');
    const original=cp.execFileSync;
    cp.execFileSync=(command,...args)=>{
      if(command==='git')return 'scripts/verification/verify.mjs\\0';
      if(command==='rustc'){interruptDuringSync();return Buffer.from('fixture rustc');}
      return original(command,...args);
    };
    syncBuiltinESMExports();
    let outcome;
    try {
      const owner=await import('./scripts/verification/${kind === "prepare" ? "build" : "verify"}.mjs');
      const result=await owner.${kind}(${kind === "prepare" ? "{engineOnly:true}" : "['pr','--base','fixture','--job','js']"});
      outcome={resolved:true,verdict:result.verdict};
    }catch(error){outcome={error:error.message,cleanupError:error.cleanupError};}
    writeFileSync('outcome.json',JSON.stringify({...outcome,listeners:[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')]}));
  `], { cwd: root, encoding: "utf8", timeout: 20_000 });
  const json = (path) => existsSync(join(root, path)) ? JSON.parse(readFileSync(join(root, path), "utf8")) : null;
  const reports = join(root, ".agent-artifacts/verification");
  return { pid: result.pid, status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr,
    entered: existsSync(join(root, "sync-entered")), syncReturned: existsSync(join(root, "sync-returned")),
    lockExists: existsSync(join(root, ".dohc-dev/verification/build.json.lock")), containerExists: existsSync(join(root, "container")),
    outcome: json("outcome.json"), commands: readFileSync(join(root, "commands.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse),
    report: existsSync(reports) ? json(`.agent-artifacts/verification/${readdirSync(reports)[0]}/result.json`) : null };
}
