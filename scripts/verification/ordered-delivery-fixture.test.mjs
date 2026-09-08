import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPrepareFixture} from './prepare-fixture.mjs';
import {orderedDeliveryArtifact} from './ordered-delivery-fixture.mjs';
test("ordered delivery preparation selects the exact native test executable", () => {
  const root = join(tmpdir(), "ordered-delivery-artifact");
  const valid = {reason:"compiler-artifact", target:{name:"dohc-workspace-engine",kind:["bin"]}, profile:{test:true},
    manifest_path:join(root,"crates/dohc-workspace-engine/Cargo.toml"), executable:join(root,"target/debug/deps/test-executable")};
  assert.equal(orderedDeliveryArtifact([{...valid,profile:{test:false}},valid],root),valid.executable);
  for (const mutation of [{profile:{test:false}},{target:{name:"other",kind:["bin"]}},
    {manifest_path:join(root,"other/Cargo.toml")},{executable:join(root,"target-other/debug/test-executable")}]) {
    assert.throws(()=>orderedDeliveryArtifact([{...valid,...mutation}],root),/did not report/);
  }
});

test("ordered delivery fixture rejects stale source and artifacts and closes preparation on cancellation", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-ordered-fixture-"));
  const put = (path, contents) => {
    mkdirSync(dirname(join(root, path)), {recursive:true});
    writeFileSync(join(root, path), contents);
  };
  try {
    createPrepareFixture(root, new URL("./build.mjs", import.meta.url));
    put("scripts/verification/ordered-delivery-fixture.mjs", readFileSync(new URL("./ordered-delivery-fixture.mjs", import.meta.url)));
    put("vendor/fixture/lib.rs", "original vendor input");
    put("scripts/verification/process.mjs", readFileSync(join(root,"scripts/verification/process.mjs"),"utf8")
      .replace("export async function run(","async function originalRun(") + `
      export async function run(command,args,options) {
        assert.equal(command,'cargo');
        assert.deepEqual(args,['test','--locked','--target-dir',join(repoRoot,'target'),'-p','dohc-workspace-engine',
          '--bin','dohc-workspace-engine','--features','harness','--no-run','--message-format=json-render-diagnostics']);
        const executable=join(repoRoot,'target/debug/deps/test-fixture');
        mkdirSync(dirname(executable),{recursive:true});writeFileSync(executable,'fixture bytes');chmodSync(executable,0o755);
        if(process.env.FIXTURE_FAULT==='source')writeFileSync(join(repoRoot,'vendor/fixture/lib.rs'),'changed during build');
        if(process.env.FIXTURE_FAULT==='cancel')process.emit('SIGTERM');
        return {stdout:JSON.stringify({reason:'compiler-artifact',target:{name:'dohc-workspace-engine',kind:['bin']},
          profile:{test:true},manifest_path:join(repoRoot,'crates/dohc-workspace-engine/Cargo.toml'),executable})};
      }
    `);
    const script = `
      import assert from 'node:assert/strict';
      import cp from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      import {existsSync,writeFileSync,rmSync} from 'node:fs';
      const exec=cp.execFileSync;
      cp.execFileSync=(command,...args)=>command==='rustc'?Buffer.from('fixture rustc'):exec(command,...args);
      syncBuiltinESMExports();
      const {prepareOrderedDeliveryFixture,assertOrderedDeliveryFixture}=await import('./scripts/verification/ordered-delivery-fixture.mjs');
      const receiptPath='.dohc-dev/verification/ordered-delivery-fixture.json';
      const first=await prepareOrderedDeliveryFixture();
      assert.equal(assertOrderedDeliveryFixture(first.path).artifact,first.artifact);
      assert.deepEqual(await prepareOrderedDeliveryFixture(),first);
      assert.throws(()=>assertOrderedDeliveryFixture(first.path+'-foreign'),/missing or differs/);
      writeFileSync(first.path,'tampered executable');
      assert.throws(()=>assertOrderedDeliveryFixture(first.path),/missing or differs/);
      await prepareOrderedDeliveryFixture();
      writeFileSync('vendor/fixture/lib.rs','vendor change after preparation');
      assert.throws(()=>assertOrderedDeliveryFixture(first.path),/missing or differs/);
      for(const fault of ['source','cancel']) {
        rmSync(receiptPath,{force:true});
        process.env.FIXTURE_FAULT=fault;
        const listeners=['SIGINT','SIGTERM'].map(signal=>process.listenerCount(signal));
        await assert.rejects(prepareOrderedDeliveryFixture(),fault==='source'?/inputs changed/:/interrupted by SIGTERM/);
        assert.equal(existsSync(receiptPath),false);
        assert.equal(existsSync(receiptPath+'.lock'),false);
        assert.deepEqual(['SIGINT','SIGTERM'].map(signal=>process.listenerCount(signal)),listeners);
      }
      process.exitCode=0;
    `;
    const result=spawnSync(process.execPath,["--input-type=module","-e",script],{cwd:root,encoding:"utf8",timeout:30_000});
    assert.equal(result.error,undefined,result.stderr);
    assert.equal(result.status,0,result.stderr);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

