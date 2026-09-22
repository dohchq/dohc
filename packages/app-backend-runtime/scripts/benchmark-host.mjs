import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { cpus, totalmem, freemem, platform, release, loadavg } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { build } from 'esbuild';
import { createDatasetHost } from '../dist/dataset-host.mjs';
import { createDatasetJournal } from '../dist/journal.mjs';
import { createDatasetSupervisor } from '../dist/supervisor.mjs';
import { isExpectedOverload, summarizeBenchmark } from './benchmark-summary.mjs';

// Run after the package build. Evidence and databases remain in the supplied directory.
const output = resolve(process.argv[2] ?? 'dataset-host-benchmark');
const soakSeconds = Number(process.argv[3] ?? 3600);
const resumeDirectory=process.argv[4] ? resolve(process.argv[4]) : undefined;
if (!Number.isInteger(soakSeconds) || soakSeconds < 0 || soakSeconds > 86400) throw new Error('Invalid soak duration.');
await mkdir(output, { recursive: true });
const artifactBundle = await build({ entryPoints: [fileURLToPath(new URL('../../security-contract/src/datasetArtifacts.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' });
const contractPath=join(output,'dataset-artifacts.mjs');
await writeFile(contractPath,artifactBundle.outputFiles[0].text);
const { describeDatasetRevision } = await import(pathToFileURL(contractPath).href);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MiB = 1024 * 1024;
const schemaSql = 'CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT NOT NULL,version INTEGER NOT NULL);';
const operationSource = `globalThis.operations={
 seed(ctx,input){ctx.db.execute("WITH RECURSIVE seq(n) AS (SELECT ? UNION ALL SELECT n+1 FROM seq WHERE n<?) INSERT INTO items SELECT n,?,0 FROM seq",[input.start,input.start+input.count-1,'x'.repeat(input.width)]);return {inserted:input.count};},
 read(ctx,input){return ctx.db.query('SELECT id,version FROM items WHERE id=?',[input.id]);},
 page(ctx,input){return ctx.db.query('SELECT id,version FROM items WHERE id>? ORDER BY id LIMIT 50',[input.after]);},
 write(ctx,input){ctx.db.execute('UPDATE items SET version=version+1 WHERE id=?',[input.id]);return {updated:input.id};},
 submit(ctx,input){ctx.db.execute('INSERT INTO items VALUES(?,?,0)',[input.id,'submission']);return {accepted:input.id};},
 count(ctx){return ctx.db.query('SELECT count(*) AS count,sum(version) AS versions FROM items');}
};`;
const operationNames = ['seed','read','page','write','submit','count'];
const operationId = name => uuid(100 + operationNames.indexOf(name));
function definition(index) {
  return { formatVersion:1,datasetId:uuid(index),name:`Benchmark ${index}`,schemaPath:'benchmark/schema.sql',operationsPath:'benchmark/operations.js',
    tables:[{tableId:uuid(20),name:'Items',sqlName:'items',primaryKey:'id',fields:[
      {fieldId:uuid(21),name:'ID',sqlColumn:'id',type:'number',required:true,unique:true},
      {fieldId:uuid(22),name:'Value',sqlColumn:'value',type:'text',required:true,unique:false},
      {fieldId:uuid(23),name:'Version',sqlColumn:'version',type:'number',required:true,unique:false},
    ]}],operations:operationNames.map(name=>({operationId:operationId(name),name,label:name,tableId:uuid(20),kind:name==='submit'?'create':name==='seed'?'action':name==='write'?'edit':'read',access:name==='submit'?'link':'owner',readOnly:['read','page','count'].includes(name),fieldIds:name==='write'?[uuid(23)]:[uuid(21),uuid(22),uuid(23)]})) };
}
const startedAt = new Date().toISOString();
let windowsEnvironment;
if(platform()==='win32') {
  windowsEnvironment=JSON.parse(execFileSync('pwsh',['-NoProfile','-Command',"$antivirus=Get-MpComputerStatus -ErrorAction SilentlyContinue; $load=Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\"; @{antivirusEnabled=$antivirus.AntivirusEnabled;realTimeProtectionEnabled=$antivirus.RealTimeProtectionEnabled;cpuBusyPercent=$load.PercentProcessorTime;processCount=(Get-Process).Count}|ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true}));
}
const evidence = { startedAt, processId:process.pid, command:process.argv, commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(), machine:{platform:platform(),release:release(),cpu:cpus()[0].model,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),freeMemoryBytes:freemem(),node:process.version,versions:process.versions,load:loadavg(),antivirus:'Not measured'},
  windowsEnvironment,boundaries:{path:'Built dataset host, permissions SQL, approved binding, supervisor, sandbox worker, FULL/WAL journal, transactional quota callback',network:false,desktopRenderer:false,attachments:false,ordinaryHardware:false,queueWait:'Not instrumented separately',commitTime:'Host SQL transaction duration; excludes worker finalization',memory:'Samples at stage boundaries, not a process peak guarantee'},
  fixtures:[],stages:[],memory:[],transactions:[],errors:[],workerPids:[] };
const alive = new Set();
const launch = options => {
  const child = spawn(process.execPath,['--disable-warning=ExperimentalWarning','--max-old-space-size=96',options.entryPath],{cwd:options.cwd,env:options.env,stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',windowsHide:true});
  evidence.workerPids.push(child.pid);alive.add(child.pid);
  child.on('message',options.onMessage);child.on('error',options.onError);child.on('close',code=>{alive.delete(child.pid);options.onExit(code);});
  return {postMessage(message){child.send(message,error=>{if(error)options.onError(error);});},kill(){child.kill('SIGKILL');}};
};
let transactionSamples = [];
let resumed;
if(resumeDirectory) {
  const original=await readFile(join(resumeDirectory,'result.json'));
  resumed=JSON.parse(original.toString());
  const source=new DatabaseSync(join(resumeDirectory,'authority.sqlite'),{readOnly:true});
  try {await backup(source,join(output,'authority.sqlite'));}finally{source.close();}
  evidence.resume={directory:resumeDirectory,evidenceSha256:sha256(original),originalCommit:resumed.commit,checkpointVerification:'Every retained fixture checkpoint hash checked against its recorded seed.'};
}
const db = new DatabaseSync(join(output,'authority.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
if(!resumed)db.exec("CREATE TABLE permissions(user TEXT PRIMARY KEY,active INTEGER); INSERT INTO permissions VALUES('owner',1),('friend',1); CREATE TABLE accounting(bytes INTEGER); INSERT INTO accounting VALUES(0);");
evidence.sqlite = {version:db.prepare('SELECT sqlite_version() AS version').get().version,journalMode:db.prepare('PRAGMA journal_mode').get(),synchronous:db.prepare('PRAGMA synchronous').get()};
const transaction = run => { const start=performance.now();db.exec('BEGIN IMMEDIATE');try{const result=run();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}finally{transactionSamples.push(performance.now()-start);} };
const journal = createDatasetJournal({db,transaction});
let supervisor,host;
function account(allocation) {
  if (!db.isTransaction) throw new Error('Quota outside commit transaction.');
  const current = Number(db.prepare('SELECT bytes FROM accounting').get().bytes);
  if (current + allocation.bytes > 8*1024*MiB) throw new Error('Benchmark quota exceeded.');
  db.prepare('UPDATE accounting SET bytes=bytes+?').run(allocation.bytes);
}
async function open() {
  supervisor=await createDatasetSupervisor({journal,directory:join(output,'workers'),runtime:{launch},maxWorkers:4});
  host=createDatasetHost({db,transaction,journal,supervisor,
    resolveAuthority(context,request){if(request.workspaceId!=='workspace'||db.prepare('SELECT active FROM permissions WHERE user=?').get(context)?.active!==1)throw new Error('Permission denied.');if(request.access.kind==='app'&&request.access.appId!=='form')throw new Error('Publication denied.');return{principalKey:context,...(request.access.kind==='app'?{appId:'form'}:{}),caller:context==='owner'?{kind:'owner',userId:'owner'}:{kind:'link',principalId:'friend',grantId:'benchmark-public-link'}};},
    accountCreation:(_context,allocation)=>account(allocation),accountMetadata:(_context,allocation)=>account(allocation),accountMigration:(_context,allocation)=>account(allocation),accountCheckpointStage:(_context,allocation)=>account(allocation),
    operationResources(){return{accountAndAttach:allocation=>account(allocation)};},
  });
}
const datasets = [];
let requestNumber=0;
function invoke(dataset,name,input={},context='owner') {
  return host.invoke(context,{workspaceId:'workspace',datasetId:dataset.definition.datasetId,revision:dataset.revision.revision,revisionSha256:dataset.revision.revisionSha256,operationId:operationId(name),input,idempotencyKey:`benchmark-${startedAt}-${++requestNumber}`,...(context==='friend'?{access:{kind:'app',appId:'form'}}:{})});
}
function statistics(samples) {
  const sorted=[...samples].sort((a,b)=>a-b),percentile=p=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??null;
  return{count:sorted.length,p50:percentile(.5),p95:percentile(.95),p99:percentile(.99),max:sorted.at(-1)??null};
}
async function persist() {await writeFile(join(output,'result.json'),JSON.stringify(evidence,null,2));}
async function memory(label) {
  let processes=[];
  if(platform()==='win32') {
    const ids=[process.pid,...alive].join(',');
    const raw=execFileSync('pwsh',['-NoProfile','-Command',`@(Get-Process -Id ${ids} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PrivateMemorySize64,CPU) | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true});
    const parsed=JSON.parse(raw||'[]');processes=Array.isArray(parsed)?parsed:[parsed];
  }
  evidence.memory.push({label,at:new Date().toISOString(),parent:process.memoryUsage(),workers:[...alive],processes,workerWorkingSetBytes:processes.filter(p=>p.Id!==process.pid).reduce((sum,p)=>sum+p.WorkingSet64,0),workerPrivateBytes:processes.filter(p=>p.Id!==process.pid).reduce((sum,p)=>sum+p.PrivateMemorySize64,0)});
}
async function stage(label,count,call,concurrent=false,before) {
  transactionSamples=[];
  const samples=[],failures=[];const start=performance.now();
  const one=async index=>{if(before)await before(index);const begin=performance.now();try{await call(index);samples.push(performance.now()-begin);}catch(error){failures.push({index,ms:performance.now()-begin,name:error.name,code:error.code,message:error.message});}};
  if(concurrent)await Promise.all(Array.from({length:count},(_,index)=>one(index)));else for(let i=0;i<count;i++)await one(i);
  const acceptedFailures=failures.filter(failure=>isExpectedOverload(label,failure));
  const unexpectedFailures=failures.filter(failure=>!acceptedFailures.includes(failure));
  const record={label,attempts:count,elapsedMs:performance.now()-start,...statistics(samples),failures,acceptedFailures,unexpectedFailures,samples,transactions:statistics(transactionSamples)};
  evidence.stages.push(record);console.log(JSON.stringify({...record,samples:undefined}));await persist();return record;
}
async function create(index,rows,width) {
  const dataset={definition:definition(index),rows,width};
  dataset.revision=describeDatasetRevision({definition:dataset.definition,revision:1,schemaSql,operationSource});
  const start=performance.now();await host.activate('owner',{workspaceId:'workspace',revision:dataset.revision,schemaSql,operationSource,capacityBytes:128*MiB});
  const activationMs=performance.now()-start;
  for(let begin=1;begin<=rows;begin+=128)await invoke(dataset,'seed',{start:begin,count:Math.min(128,rows-begin+1),width});
  // An approved no-op owner migration captures seeded data through the production checkpoint path.
  const scope={workspaceId:'workspace',datasetId:dataset.definition.datasetId};
  const next=describeDatasetRevision({definition:dataset.definition,revision:2,schemaSql,operationSource});
  await host.migrate('owner',{...scope,revision:next,schemaSql,operationSource,migrationSql:'SELECT 1;',expected:journal.head(scope,()=>{}).cursor});dataset.revision=next;
  host.setBinding('owner',{...scope,appId:'form',binding:{kind:'dataset',datasetId:scope.datasetId,revision:2,revisionSha256:next.revisionSha256,operationIds:[operationId('submit')]}});
  const checkpoint=journal.captureExport({scope,authorize(){},capture(){return null;}}).checkpoint;
  const count=(await invoke(dataset,'count')).result[0].count;if(count!==rows)throw new Error('Seed row count mismatch.');
  evidence.fixtures.push({index,rows,width,activationMs,seedAndCheckpointMs:performance.now()-start,checkpointBytes:checkpoint.byteLength,checkpointSha256:checkpoint.sha256,revision:next,schemaSha256:sha256(schemaSql),sourceSha256:sha256(operationSource)});
  datasets.push(dataset);await persist();console.log(`Seeded ${rows} rows, ${checkpoint.byteLength} checkpoint bytes`);return dataset;
}
try {
  await open();
  if(resumed) {
    for(const fixture of resumed.fixtures) {
      const checkpoint=journal.captureExport({scope:{workspaceId:'workspace',datasetId:fixture.revision.datasetId},authorize(){},capture(){return null;}}).checkpoint;
      if(checkpoint.sha256!==fixture.checkpointSha256||checkpoint.byteLength!==fixture.checkpointBytes)throw new Error('Resumed checkpoint differs from recorded fixture.');
      evidence.fixtures.push(fixture);datasets.push({definition:fixture.revision.definition,revision:fixture.revision,rows:fixture.rows,width:fixture.width});
    }
  }
  const narrow=resumed?datasets[0]:await create(1,100000,24),wide=resumed?datasets[1]:await create(2,25600,4096);
  if(evidence.fixtures[1].checkpointBytes<100*MiB)throw new Error('Large fixture is under 100 MiB.');
  for(const dataset of [narrow,wide]) {
    if(!resumed) {
    await invoke(dataset,'read',{id:1});
    for(let round=1;round<=3;round++) {
      await stage(`${dataset.definition.name}/warm-read/${round}`,200,i=>invoke(dataset,'read',{id:1+(i*7919)%dataset.rows}));
      await stage(`${dataset.definition.name}/warm-write/${round}`,200,i=>invoke(dataset,'write',{id:1+(i*7919)%dataset.rows}));
    }
    await stage(`${dataset.definition.name}/late-page`,100,()=>invoke(dataset,'page',{after:dataset.rows-50}));
    for(const size of [10,100]) {
      const before=(await invoke(dataset,'count')).result[0].count;
      const result=await stage(`${dataset.definition.name}/burst-${size}`,size,i=>invoke(dataset,'submit',{id:dataset.rows+size*1000+i},'friend'),true);
      const after=(await invoke(dataset,'count')).result[0].count;
      result.rowsAdded=after-before;if(result.rowsAdded!==result.count)throw new Error('Burst rows differ from acknowledged submissions.');
    }
    await memory(`${dataset.definition.name}/warm`);
    }
    await stage(`${dataset.definition.name}/cold-reopen`,30,()=>invoke(dataset,'read',{id:dataset.rows}),false,async()=>{await supervisor.close();await open();});
  }
  for(let index=datasets.length+1;index<=10;index++)await create(index,100,24);
  await stage('ten-dataset-churn',100,i=>invoke(datasets[i%datasets.length],i%2?'read':'write',{id:1}));
  await memory('before-soak');
  const soakStart=performance.now();let cycle=0;
  while(performance.now()-soakStart<soakSeconds*1000) {
    await stage(`soak/${cycle}`,100,i=>{const dataset=datasets[(i+cycle)%datasets.length];return invoke(dataset,i%3?'read':'write',{id:1+(i*13)%dataset.rows});});
    await memory(`soak/${cycle++}`);
    // Idle across the configured worker expiry, then exercise cold churn again.
    await new Promise(resolve=>setTimeout(resolve,31000));
    await memory(`soak/${cycle}/after-idle`);await persist();
  }
  evidence.soak={requestedSeconds:soakSeconds,actualSeconds:(performance.now()-soakStart)/1000,cycles:cycle};
  evidence.storage={accountedBytes:Number(db.prepare('SELECT bytes FROM accounting').get().bytes),authorityBytes:(await stat(join(output,'authority.sqlite'))).size,walBytes:await stat(join(output,'authority.sqlite-wal')).then(s=>s.size,()=>0),history:db.prepare('SELECT count(*) AS events,sum(storage_bytes) AS bytes FROM dohc_dataset_events').get()};
} catch(error) { evidence.errors.push({name:error.name,message:error.message,stack:error.stack});process.exitCode=1;console.error(error); }
finally {
  try {if(supervisor)await supervisor.close();}catch(error){evidence.errors.push({name:error.name,message:error.message,phase:'close'});}
  try {db.close();}catch(error){evidence.errors.push({name:error.name,message:error.message,phase:'database-close'});}
  evidence.completedAt=new Date().toISOString();evidence.remainingOwnedPids=[...alive];
  evidence.verdict=summarizeBenchmark(evidence);
  if(!evidence.verdict.passed)process.exitCode=1;
  await persist();await writeFile(join(output,'summary.json'),JSON.stringify(evidence.verdict,null,2));
}
