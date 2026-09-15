import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir,readlink} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// The coordinator supplies pins from the successful native build and admits the runtime lease.
const admissionPath=process.argv[2];
assert.ok(admissionPath,'Usage: node run-desktop-named-native-proof.mjs <admission.json>');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const admissionBytes=await readFile(admissionPath),admission=JSON.parse(admissionBytes);
assert.equal(admission.nativeLeaseGranted,true,'Coordinator native lease required');
const root=resolve(admission.root),output=resolve(admission.output),head=admission.head;
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});
async function verify(pin){const bytes=await readFile(pin.path);assert.equal(hash(bytes),pin.sha256,pin.path);return bytes;}
const receipt=JSON.parse(await verify(admission.buildReceipt));
const manifest=JSON.parse(await verify(admission.inputManifest));
assert.equal(receipt.status,'PASS','Canonical native seal must pass');
assert.equal(receipt.head,head,'Seal must name the proof source head');
assert.equal(resolve(receipt.source),root,'Seal must name the proof checkout');
assert.ok(Array.isArray(manifest),'Canonical tracked inputs must be an array');
assert.equal(resolve(receipt.sourceManifest.path),resolve(admission.inputManifest.path),'Canonical source manifest path');
assert.equal(receipt.sourceManifest.sha256,admission.inputManifest.sha256,'Canonical source manifest digest');
const binary=admission.binary;
assert.equal(resolve(receipt.binary.path),resolve(binary.path),'Canonical executable path');
assert.equal(receipt.binary.sha256,binary.sha256,'Canonical executable digest');
assert.equal(receipt.binary.hardlinks,1,'Canonical executable must be an independent copy');
const canonical=JSON.parse(await verify(receipt.canonicalResult));
assert.equal(canonical.verdict,'PASS','Canonical Rust verdict');
assert.equal(canonical.commit,head,'Canonical Rust source');
assert.equal(canonical.scope,'rust','Canonical Rust scope');
await verify(receipt.driver);
await verify(receipt.gateLog);
const nativePath=path=>/^(Cargo\.(toml|lock)|rust-toolchain(\.toml)?|\.cargo\/|crates\/|vendor\/|fuzz\/|fixtures\/)/.test(path);
const tracked=git('ls-files','--stage','-z').split('\0').filter(Boolean).map(row=>{
 const [metadata,path]=row.split('\t');const [mode,object]=metadata.split(' ');return{mode,object,path};
});
assert.equal(new Set(manifest.map(row=>row.path)).size,manifest.length,'Duplicate build inputs');
const nativeInputs=new Map(manifest.filter(row=>nativePath(row.path)).map(row=>[row.path,row]));
for(const entry of tracked.filter(row=>nativePath(row.path))){assert.ok(nativeInputs.has(entry.path),`Unsealed native input: ${entry.path}`);}
async function snapshot(){
 assert.equal(git('rev-parse','HEAD').trim(),head);assert.equal(git('status','--porcelain').trim(),'');
 await verify(binary);
 for(const input of nativeInputs.values())assert.equal(hash(await readFile(join(root,input.path))),input.sha256,input.path);
 const files=[];
 for(const entry of tracked){const path=join(root,entry.path);files.push(entry.mode==='160000'?entry:entry.mode==='120000'?{...entry,target:await readlink(path)}:{...entry,sha256:hash(await readFile(path))});}
 return{head,tree:git('rev-parse','HEAD^{tree}').trim(),files};
}
const before=await snapshot();
await mkdir(output);
await writeFile(join(output,'source-before.json'),JSON.stringify(before,null,2)+'\n');
await writeFile(join(output,'admission.json'),admissionBytes,{flag:'wx'});
const runnerPin={path:import.meta.filename,sha256:hash(await readFile(import.meta.filename))};
const configPath=join(output,'vitest.config.mjs');
await writeFile(configPath,`export default ${JSON.stringify({root:join(root,'services/share-web'),test:{include:['src/namedDesktopAuthenticatedNative.integration.ts'],maxWorkers:1,fileParallelism:false}})};\n`,{flag:'wx'});
const configPin={path:configPath,sha256:hash(await readFile(configPath))};
const caseOutput=join(output,'cases');await mkdir(caseOutput);
const {run,pnpm}=await import(pathToFileURL(join(root,'scripts/verification/process.mjs')));
const {postgres}=await import(pathToFileURL(join(root,'scripts/verification/verify.mjs')));
const result={author:'gpt-6-astra',root,head,binary,runnerPin,configPin,admissionSha256:hash(admissionBytes),nativeInputCount:nativeInputs.size,
 startedAt:new Date().toISOString(),verdict:'RUNNING',fullGate:false};
const save=()=>writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');save();
let database;
try{
 database=await postgres(output);result.postgresId=database.id;save();
 const job=await run(...pnpm(['--filter','@dohc/share-web','exec','vitest','run','--config',configPath,'src/namedDesktopAuthenticatedNative.integration.ts']),{
  cwd:root,timeoutMs:300000,log:join(output,'run.log'),
  env:{...process.env,DOHC_SERVICE_HOST_PROOF_BINARY:binary.path,DOHC_SERVICE_HOST_PROOF_SHA256:binary.sha256,DOHC_SERVICE_HOST_PROOF_OUTPUT:caseOutput,
   NODE_EXTRA_CA_CERTS:join(root,'services/share-web/src/testing/device-control/localhost-cert.pem'),POSTGRES_URL:database.url,DOHC_REQUIRE_POSTGRES:'1'},onSpawn(child){result.jobOwnerPid=child.pid;save();}
 });
 result.process={pid:job.pid,code:job.code};assert.equal(job.code,0);
 const cases=await readdir(caseOutput);assert.equal(cases.length,1);
 const casePath=join(caseOutput,cases[0],'result.json'),bytes=await readFile(casePath),proof=JSON.parse(bytes);
 assert.equal(proof.verdict,'PASS');assert.ok(proof.results.nativeAck);assert.equal(proof.results.edit.ordinaryCaptureCalls,0);for(const value of Object.values(proof.results.lifecycle))assert.equal(value,true);
 result.caseResult={path:casePath,sha256:hash(bytes)};result.scope=proof.scope;result.omitted=proof.omissions;result.verdict='PASS';
}catch(error){result.verdict='FAIL';result.error=String(error);}
finally{
 try{if(database){await database.stop();assert.equal(execFileSync('docker',['ps','-aq','--filter',`id=${database.id}`],{encoding:'utf8',windowsHide:true}).trim(),'');result.postgresClosed=true;}}
 catch(error){result.verdict='FAIL';result.cleanupError=String(error);}
 try{const after=await snapshot();assert.deepEqual(after,before);await verify(runnerPin);await verify(configPin);await writeFile(join(output,'source-after.json'),JSON.stringify(after,null,2)+'\n');result.sourceUnchanged=true;}
 catch(error){result.verdict='FAIL';result.verificationError=String(error);}
 try{result.log={path:join(output,'run.log'),sha256:hash(await readFile(join(output,'run.log')))};}catch{}
 result.finishedAt=new Date().toISOString();save();
}
console.log(JSON.stringify({output,verdict:result.verdict,error:result.error,cleanupError:result.cleanupError,verificationError:result.verificationError}));
process.exitCode=result.verdict==='PASS'?0:1;
