import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir,readlink} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

// The coordinator supplies pins from the successful native build and admits the runtime lease.
const admissionPath=process.argv[2];
assert.ok(admissionPath,'Usage: node run-public-link-native-proof.mjs <admission.json>');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const admissionBytes=await readFile(admissionPath),admission=JSON.parse(admissionBytes);
assert.equal(admission.nativeLeaseGranted,true,'Coordinator native lease required');
const root=resolve(admission.root),output=resolve(admission.output),head=admission.head;
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});
async function verify(pin){const bytes=await readFile(pin.path);assert.equal(hash(bytes),pin.sha256,pin.path);return bytes;}
const receipt=JSON.parse(await verify(admission.buildReceipt));
const manifest=JSON.parse(await verify(admission.inputManifest));
assert.equal(receipt.status,'PASS','Canonical native seal must pass');
const nativeHead=admission.nativeHead ?? head,nativeSource=resolve(admission.nativeSource ?? root);
assert.equal(receipt.head,nativeHead,'Seal must name the native source head');
assert.equal(resolve(receipt.source),nativeSource,'Seal must name the native checkout');
assert.ok(Array.isArray(manifest),'Canonical tracked inputs must be an array');
assert.equal(resolve(receipt.sourceManifest.path),resolve(admission.inputManifest.path),'Canonical source manifest path');
assert.equal(receipt.sourceManifest.sha256,admission.inputManifest.sha256,'Canonical source manifest digest');
const binary=admission.binary;
assert.equal(resolve(receipt.binary.path),resolve(binary.path),'Canonical executable path');
assert.equal(receipt.binary.sha256,binary.sha256,'Canonical executable digest');
assert.equal(receipt.binary.hardlinks,1,'Canonical executable must be an independent copy');
const canonical=JSON.parse(await verify(receipt.canonicalResult));
assert.equal(canonical.verdict,'PASS','Canonical Rust verdict');
assert.equal(canonical.commit,nativeHead,'Canonical Rust source');
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
const proofNativePaths=new Set(tracked.filter(row=>nativePath(row.path)).map(row=>row.path));
assert.equal(proofNativePaths.size,nativeInputs.size,'Native source inventory must match the seal exactly');
for(const path of nativeInputs.keys())assert.ok(proofNativePaths.has(path),'Native input removed from proof source: '+path);
async function snapshot(){
 assert.equal(git('rev-parse','HEAD').trim(),head);assert.equal(git('status','--porcelain').trim(),'');
 await verify(binary);
 for(const input of nativeInputs.values())assert.equal(hash(await readFile(join(root,input.path))),input.sha256,input.path);
 const files=[];
 for(const entry of tracked){const path=join(root,entry.path);files.push(entry.mode==='160000'?entry:entry.mode==='120000'?{...entry,target:await readlink(path)}:{...entry,sha256:hash(await readFile(path))});}
 return{head,tree:git('rev-parse','HEAD^{tree}').trim(),files};
}
const releaseBytes=await verify(admission.publicRelease),release=JSON.parse(releaseBytes);
assert.equal(release.publicEditGateGranted,true,'Public Edit release decision required');
assert.ok(Number.isSafeInteger(release.admittedConcurrency)&&release.admittedConcurrency>=2,'At least two admitted sessions required');
assert.ok(Number.isSafeInteger(release.ordinaryMaxRequestBytes)&&release.ordinaryMaxRequestBytes>0,'Finite ordinary replication request bound required');
assert.equal(release.editor.provider.frames.receive.maxFrameBytes,release.frames.receive.maxFrameBytes);
assert.ok(release.workload?.path && release.workload?.sha256,'Selected public workload manifest required');
assert.ok(isAbsolute(release.workload.path),'Public workload manifest path must be absolute');
const workload=JSON.parse(await verify(release.workload));
assert.equal(workload.version,1);assert.equal(workload.concurrency,release.admittedConcurrency);assert.ok(workload.rounds.length>0);
const workloadPins=[workload.baseline.checkpoint,workload.baseline.markdown,
 ...workload.rounds.flatMap(round=>[...round.updates.map(update=>update.bytes),round.markdown])]
 .map(pin=>({...pin,path:resolve(dirname(release.workload.path),pin.path)}));
async function verifyWorkload(){await verify(release.workload);for(const pin of workloadPins)assert.equal((await verify(pin)).length,pin.byteLength);}
await verifyWorkload();
assert.ok(release.transitions?.path && release.transitions?.sha256,'Selected public transition manifest required');
assert.ok(isAbsolute(release.transitions.path),'Transition manifest path must be absolute');
const transitionManifest=JSON.parse(await verify(release.transitions));
const transitionNames=['restart','staleFrame','selectorDrift','accessChange','restore'];
assert.equal(transitionManifest.version,1);assert.equal(transitionManifest.concurrency,release.admittedConcurrency);
assert.deepEqual(Object.keys(transitionManifest.cases).sort(),[...transitionNames,'view'].sort());
const projectionPins=value=>[value.markdown,value.editorText,value.viewText];
const transitionPins=Object.values(transitionManifest.cases).flatMap(value=>[
 value.baseline.checkpoint,...projectionPins(value.baseline),
 ...value.updates.flatMap(update=>[update.bytes,...projectionPins(update.expected)]),
 ...(value.interrupted?[value.interrupted.bytes]:[]),...(value.resumed?[value.resumed.bytes,...projectionPins(value.resumed.expected)]:[]),
 ...(value.continuation?[value.continuation.recipe,...projectionPins(value.continuation.expected)]:[])
]).map(pin=>({...pin,path:resolve(dirname(release.transitions.path),pin.path)}));
async function verifyTransitions(){await verify(release.transitions);for(const pin of transitionPins)assert.equal((await verify(pin)).length,pin.byteLength);}
await verifyTransitions();
assert.ok(Number.isSafeInteger(release.automaticView.readContexts)&&release.automaticView.readContexts>=1,'Explicit concurrent View admission required');
const before=await snapshot();
await mkdir(output);
await writeFile(join(output,'source-before.json'),JSON.stringify(before,null,2)+'\n');
await writeFile(join(output,'admission.json'),admissionBytes,{flag:'wx'});
const runnerPin={path:import.meta.filename,sha256:hash(await readFile(import.meta.filename))};
const configPath=join(output,'vitest.config.mjs');
await writeFile(configPath,`export default ${JSON.stringify({root:join(root,'services/share-web'),test:{include:['src/publicLinkAuthenticatedNative.integration.ts'],maxWorkers:1,fileParallelism:false}})};\n`,{flag:'wx'});
const configPin={path:configPath,sha256:hash(await readFile(configPath))};
const caseOutput=join(output,'cases');await mkdir(caseOutput);
const {run,pnpm}=await import(pathToFileURL(join(root,'scripts/verification/process.mjs')));
const {postgres}=await import(pathToFileURL(join(root,'scripts/verification/verify.mjs')));
const result={author:'gpt-6-astra',root,head,nativeHead,nativeSource,nativeSourceBytesMatch:true,binary,runnerPin,configPin,admissionSha256:hash(admissionBytes),nativeInputCount:nativeInputs.size,
 workload:{manifest:release.workload,assets:workloadPins},transitions:{manifest:release.transitions,assets:transitionPins},startedAt:new Date().toISOString(),verdict:'RUNNING',fullGate:false};
const save=()=>writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');save();
let database;
try{
 const build=await run(...pnpm(['--filter','@dohc/share-web','build']),{cwd:root,timeoutMs:300000,log:join(output,'viewer-build.log')});
 assert.equal(build.code,0);result.viewerBuild={code:build.code};
 const assets=[];
 async function pinAssets(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);assert.ok(!entry.isSymbolicLink(),'Viewer asset symlink refused');if(entry.isDirectory())await pinAssets(path);else{assert.ok(entry.isFile());assets.push({path,sha256:hash(await readFile(path))});}}}
 await pinAssets(join(root,'services/share-web/viewer/dist'));assert.ok(assets.length>0);
 result.viewerAssets=assets;result.publicRelease={...admission.publicRelease,admittedConcurrency:release.admittedConcurrency};save();
 database=await postgres(output);result.postgresId=database.id;save();
 const job=await run(...pnpm(['--filter','@dohc/share-web','exec','vitest','run','--config',configPath,'src/publicLinkAuthenticatedNative.integration.ts']),{
  cwd:root,timeoutMs:420000,log:join(output,'run.log'),
  env:{...process.env,DOHC_SERVICE_HOST_PROOF_BINARY:binary.path,DOHC_SERVICE_HOST_PROOF_SHA256:binary.sha256,DOHC_SERVICE_HOST_PROOF_OUTPUT:caseOutput,
   NODE_EXTRA_CA_CERTS:join(root,'services/share-web/src/testing/device-control/localhost-cert.pem'),DOHC_PUBLIC_PROOF_ADMISSION:admission.publicRelease.path,DOHC_PUBLIC_PROOF_ADMISSION_SHA256:admission.publicRelease.sha256,POSTGRES_URL:database.url,DOHC_REQUIRE_POSTGRES:'1'},onSpawn(child){result.jobOwnerPid=child.pid;save();}
 });
 result.process={pid:job.pid,code:job.code};assert.equal(job.code,0);
 const cases=await readdir(caseOutput);assert.equal(cases.length,1);
 const casePath=join(caseOutput,cases[0],'result.json'),bytes=await readFile(casePath),proof=JSON.parse(bytes);
 assert.equal(proof.verdict,'PASS');assert.equal(proof.results.tinyBrowserLifecycle.concurrency,release.admittedConcurrency);
 assert.equal(proof.results.workloadBrowserBaseline.concurrency,release.admittedConcurrency);assert.equal(proof.results.workloadBrowserBaseline.ready,true);
 assert.equal(proof.results.workloadBrowserEdits.concurrency,release.admittedConcurrency);
 assert.equal(proof.results.suppliedWireWorkload.concurrency,release.admittedConcurrency);assert.equal(proof.results.suppliedWireWorkload.verdict,'PASS');
 assert.equal(proof.results.suppliedWireWorkload.rounds.length,workload.rounds.length);
 assert.deepEqual(proof.results.suppliedWireWorkload.manifest,release.workload);
 assert.deepEqual(proof.results.loadedTransitions.map(row=>row.name),transitionNames);
 for(const row of proof.results.loadedTransitions){assert.equal(row.verdict,'PASS');assert.equal(row.concurrency,release.admittedConcurrency);}
 const continuation=proof.results.loadedTransitions.find(row=>row.name==='restore').continuation;
 assert.equal(continuation.kind,'runtime-derived-after-native-restore');assert.equal(continuation.preselectedCandidate,false);
 assert.equal(continuation.verdict,'PASS');assert.equal(continuation.editorWitnessVerified,true);assert.equal(continuation.viewWitnessVerified,true);
 assert.equal(continuation.viewPublication,'fixture-relay-publication-of-native-file');assert.equal(continuation.automaticReplicationProven,false);
 assert.deepEqual(continuation.manifest,release.transitions);assert.equal(continuation.deliveryId,transitionManifest.cases.restore.continuation.deliveryId);
 assert.equal(continuation.recipe.sha256,transitionManifest.cases.restore.continuation.recipe.sha256);
 for(const pin of [continuation.restoredCheckpoint,continuation.candidate,continuation.projectedMarkdown,continuation.admissionReceipt])assert.equal((await verify(pin)).length,pin.byteLength);
 assert.equal(continuation.admission.updateSha256,continuation.candidate.sha256);
 assert.equal(continuation.admission.projectedMarkdownSha256,transitionManifest.cases.restore.continuation.expected.markdown.sha256);
 assert.equal(proof.results.publicMixedPresence.verdict,'PASS');assert.equal(proof.results.publicMixedPresence.concurrency,release.admittedConcurrency);
 assert.equal(proof.results.automaticView.verdict,'PASS');assert.equal(proof.results.automaticView.readContexts,release.automaticView.readContexts);
 assert.equal(proof.results.automaticView.manualSettlementsDuringMeasurement,0);assert.equal(proof.results.automaticView.acceptedEnvelopeMs,5000);
 assert.equal(proof.results.automaticView.rounds.length,transitionManifest.cases.view.updates.length);
 for(const row of proof.results.automaticView.rounds)for(const elapsed of row.conservativeSubmitToViewMs)assert.ok(elapsed>=0&&elapsed<=5000);
 await verifyTransitions();
 assert.equal(proof.results.restore.stalePartialRefused,true);assert.equal(proof.results.restart.oldPartialRefused,true);assert.equal(proof.results.credentials.privateCredentialsExcluded,true);for(const pin of assets)await verify(pin);await verify(admission.publicRelease);await verifyWorkload();
 result.caseResult={path:casePath,sha256:hash(bytes)};result.scope=proof.scope;result.omitted=proof.omissions;result.verdict='PASS';
}catch(error){result.verdict='FAIL';result.error=String(error);}
finally{
 try{if(database){await database.stop();assert.equal(execFileSync('docker',['ps','-aq','--filter',`id=${database.id}`],{encoding:'utf8',windowsHide:true}).trim(),'');result.postgresClosed=true;}}
 catch(error){result.verdict='FAIL';result.cleanupError=String(error);}
 try{const after=await snapshot();assert.deepEqual(after,before);await verify(runnerPin);await verify(configPin);await verifyWorkload();await verifyTransitions();await writeFile(join(output,'source-after.json'),JSON.stringify(after,null,2)+'\n');result.sourceUnchanged=true;}
 catch(error){result.verdict='FAIL';result.verificationError=String(error);}
 try{result.log={path:join(output,'run.log'),sha256:hash(await readFile(join(output,'run.log')))};}catch{}
 result.finishedAt=new Date().toISOString();save();
}
console.log(JSON.stringify({output,verdict:result.verdict,error:result.error,cleanupError:result.cleanupError,verificationError:result.verificationError}));
process.exitCode=result.verdict==='PASS'?0:1;
