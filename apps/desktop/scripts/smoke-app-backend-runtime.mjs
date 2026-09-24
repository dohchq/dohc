import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { stageAppBackendRuntime } from './stage-app-backend-runtime.mjs';

if (!['win32', 'linux'].includes(process.platform)) throw new Error('This directory smoke supports Windows and Linux.');
const require = createRequire(import.meta.url);
const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'dohc-app-runtime-fuses-'));
try {
  const electron = join(root, 'electron');
  await cp(join(dirname(require.resolve('electron/package.json')), 'dist'), electron, { recursive: true });
  const resources = join(electron, 'resources');
  await stageAppBackendRuntime({ destination: join(resources, 'app-backend-runtime') });
  const appRoot = join(root, 'app');
  await mkdir(appRoot);
  const resultPath = join(root, 'result.json');
  const userData = join(root, 'user-data');
  const source = `
    import {app, utilityProcess} from 'electron';
    import {join} from 'node:path';
    import {writeFileSync, mkdirSync} from 'node:fs';
    import {createHash} from 'node:crypto';
    import {openPersistentAppBackend} from '@dohc/app-backend-runtime/persistent';
    import {createDesktopAppBackendRuntime, createDesktopAppRuntimeLauncher} from ${JSON.stringify(join(desktopRoot, 'src/workspaces/localAppBackendRuntime.ts'))};
    app.setPath('userData', ${JSON.stringify(userData)});
    app.whenReady().then(async()=>{
      try {
        const runtime = createDesktopAppBackendRuntime(utilityProcess, join(process.resourcesPath,'app-backend-runtime','child.mjs'));
        const tables=['items'], schemaSql='CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL);';
        const database=await runtime.initializeAppDatabase({tables,schemaSql});
        const accepted=await runtime.evaluateAppOperation({database,tables,caller:{kind:'owner'},operation:'insert',
          source:"globalThis.operations={insert(ctx){ctx.db.execute('INSERT INTO items VALUES (?, ?)',[ctx.requestId,42]);return ctx.db.query('SELECT * FROM items');}}",
          input:{},requestId:'fuse-proof',nowMs:1});
        await runtime.validateAppDatabase({database:accepted.database,tables,schemaSql});
        const hash=value=>createHash('sha256').update(value).digest('hex');
        const cursor={revision:0,digest:hash('initial')};
        const directory=join(app.getPath('userData'),'worker');mkdirSync(directory,{recursive:true});
        const config={directory,tables,schemaSql,cursor,scope:{workspaceId:'workspace',datasetId:'dataset',hostEpoch:'epoch',approvedRevisionHash:hash(schemaSql)}};
        const options={launch:createDesktopAppRuntimeLauncher(utilityProcess,false),entryPath:join(process.resourcesPath,'app-backend-runtime','persistent-child.mjs')};
        const worker=await openPersistentAppBackend(config,options);
        let persistentResult;
        let checkpoint;
        try {
          const operation={expected:cursor,caller:{kind:'owner'},operation:'insert',
            source:"globalThis.operations={insert(ctx){ctx.db.execute('INSERT INTO items VALUES (?, ?)',[ctx.requestId,43]);return ctx.db.query('SELECT * FROM items');}}",
            input:{},requestId:'persistent-fuse-proof',nowMs:1};
          const prepared=await worker.prepare(operation);
          const next=await worker.finalize({proposalId:prepared.proposalId,previousDigest:cursor.digest,revision:1,digest:hash('event'),changesetSha256:prepared.changesetSha256});
          const read=await worker.prepare({...operation,expected:next,readOnly:true,source:"globalThis.operations={insert(ctx){return ctx.db.query('SELECT * FROM items');}}"});
          persistentResult=read.result;
          checkpoint=await worker.snapshot(join(app.getPath('userData'),'checkpoint.sqlite'));
        } finally {await worker.close();}
        const recoveredDirectory=join(app.getPath('userData'),'recovered');mkdirSync(recoveredDirectory);
        const recovered=await openPersistentAppBackend({...config,directory:recoveredDirectory,checkpointPath:checkpoint.path,cursor:checkpoint.cursor},options);
        let recoveredResult;
        try {
          recoveredResult=(await recovered.prepare({expected:checkpoint.cursor,caller:{kind:'owner'},operation:'read',readOnly:true,
            source:"globalThis.operations={read(ctx){return ctx.db.query('SELECT * FROM items');}}",input:{},requestId:'recovered',nowMs:2})).result;
        } finally {await recovered.close();}
        // The CPU budget watch runs on a worker thread and ends the utility process from there.
        const budgetDirectory=join(app.getPath('userData'),'budget');mkdirSync(budgetDirectory);
        const budgeted=await openPersistentAppBackend({...config,directory:budgetDirectory,limits:{cpuBudgetMs:1000}},options);
        let budgetResult;
        try {
          budgetResult=await budgeted.prepare({expected:cursor,caller:{kind:'owner'},operation:'spin',readOnly:true,input:{},requestId:'budget',nowMs:3,
            source:"globalThis.operations={spin(ctx){return ctx.db.query('WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n');}}"})
            .then(()=>'finished',error=>error.code);
        } finally {await budgeted.close();}
        writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({result:accepted.result,changesetBytes:accepted.changeset.byteLength,persistentResult,recoveredResult,budgetResult,electron:process.versions.electron}));
        app.exit(0);
      } catch(error) {writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({error:String(error)}));app.exit(1);}
    });`;
  await build({ stdin: { contents: source, resolveDir: desktopRoot, loader: 'ts' }, outfile: join(appRoot, 'main.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['electron'], logLevel: 'silent' });
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: 'dohc-app-runtime-smoke', version: '1.0.0', type: 'module', main: 'main.mjs' }));
  await require('@electron/asar').createPackage(appRoot, join(resources, 'app.asar'));
  const executable = join(electron, process.platform === 'win32' ? 'electron.exe' : 'electron');
  const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
  await flipFuses(executable, { version: FuseVersion.V1, [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, [FuseV1Options.OnlyLoadAppFromAsar]: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())));
  await new Promise((resolve, reject) => {
    const child = spawn(executable, process.platform === 'linux' && process.getuid() === 0 ? ['--no-sandbox'] : [], { env, stdio: 'ignore', windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', async code => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve();
      else reject(new Error(`Electron runtime smoke failed (${code}, timeout=${timedOut}): ${await readFile(resultPath, 'utf8').catch(() => 'no result')}`));
    });
  });
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.deepEqual(result.result, [{ id: 'fuse-proof', value: 42 }]);
  assert.ok(result.changesetBytes > 0);
  assert.deepEqual(result.persistentResult, [{ id: 'persistent-fuse-proof', value: 43 }]);
  assert.deepEqual(result.recoveredResult, result.persistentResult);
  assert.equal(result.budgetResult, 'worker_budget');
  console.log(`App backend directory smoke passed: Electron ${result.electron}, RunAsNode disabled, snapshot and persistent workers in resources, persistent checkpoint restored, over-budget worker ended.`);
} finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
