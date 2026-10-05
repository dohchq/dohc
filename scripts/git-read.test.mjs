import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const operation of ["head", "status", "reflog", "fingerprint", "changed-files"]) {
  for (const persistent of [false, true]) {
    test(operation + (persistent ? " retains the last git failure" : " recovers after a transient git failure"), () => {
      const root = mkdtempSync(join(tmpdir(), "dohc-git-read-test-"));
      try {
        writeFileSync(join(root, "package.json"), "{}");
        const script = `
          import assert from 'node:assert/strict';
          import cp from 'node:child_process';
          import {syncBuiltinESMExports} from 'node:module';
          let attempts=0;
          const operation=${JSON.stringify(operation)};
          const persistent=${persistent};
          const command=operation==='head'?'rev-parse':operation==='status'?'status':operation==='reflog'?'reflog':operation==='fingerprint'?'ls-files':'diff';
          cp.spawnSync=(file,args)=>{
            assert.equal(file,'git');
            if(args[0]===command && (++attempts===1 || persistent)) {
              return {status:128,stderr:Buffer.from('warning: unable to access config: Permission denied\\nfatal: configuration failure '+attempts)};
            }
            const stdout = args[0]==='ls-files'||args[0]==='diff' ? 'package.json\\0'
              : args[0]==='status' ? '' : args[0]==='rev-list' ? '1' : 'a'.repeat(40);
            return {status:0,stdout,stderr:''};
          };
          syncBuiltinESMExports();
          const {git}=await import(${JSON.stringify(new URL('./verification/process.mjs',import.meta.url).href)});
          const {sourceFingerprint}=await import(${JSON.stringify(new URL('./verification/build.mjs',import.meta.url).href)});
          const {changedFiles}=await import(${JSON.stringify(new URL('./verification/verify.mjs',import.meta.url).href)});
          const {readTreeState,classifyTreeProvenance}=await import(${JSON.stringify(new URL('../tools/rust-engine-program/tree-provenance.mjs',import.meta.url).href)});
          const action=()=>operation==='fingerprint'?sourceFingerprint('desktop',${JSON.stringify(root)}):operation==='changed-files'?changedFiles('base',false,${JSON.stringify(root)}):readTreeState(cmd=>git(cmd.split(' ').slice(1)),()=>true);
          if(persistent) {
            assert.throws(action,error=>{
              assert.match(error.message,/fatal: configuration failure 4/);
              assert.match(String(error.stderr),/Permission denied/);
              return true;
            });
            assert.equal(attempts,4);
          } else {
            const result=action();
            assert.equal(attempts,2);
            if(operation==='fingerprint')assert.match(result,/^[a-f0-9]{64}$/);
            else if(operation==='changed-files')assert.deepEqual(result,['package.json']);
            else assert.equal(classifyTreeProvenance([{step:'start',state:result},{step:'finish',state:result}]).status,'PASS');
          }
        `;
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {encoding:"utf8",timeout:30_000});
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
      } finally { rmSync(root, {recursive:true,force:true}); }
    });
  }
}

test("git reads follow the bounded backoff schedule and log successful stderr", () => {
  for (const failures of [0, 1, 2, 3, 4]) {
    const script = `
      import assert from 'node:assert/strict';
      import cp from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      let attempts = 0;
      const waits = [];
      Atomics.wait = (_array, _index, _value, milliseconds) => { waits.push(milliseconds); };
      const result = () => ++attempts <= ${failures}
        ? {status:128, stdout:'untrusted output', stderr:'failed attempt ' + attempts}
        : {status:0, stdout:'checkout-head', stderr:${JSON.stringify(failures === 0 || failures === 3 ? "warning: successful git read\n" : "")}};
      cp.execFileSync = () => {
        const value = result();
        if (value.status !== 0) throw Object.assign(new Error('git failed'), value);
        return value.stdout;
      };
      cp.spawnSync = result;
      syncBuiltinESMExports();
      const {readGit} = await import(${JSON.stringify(new URL('../tools/rust-engine-program/git-read.mjs', import.meta.url).href)});
      if (${failures} === 4) assert.throws(() => readGit(['rev-parse','HEAD']), /failed after 4 attempts.*\\nfailed attempt 4/);
      else assert.equal(readGit(['rev-parse','HEAD']), 'checkout-head');
      assert.equal(attempts, Math.min(${failures} + 1, 4));
      assert.deepEqual(waits, [100,300,900].slice(0, Math.min(${failures}, 3)));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {encoding:"utf8",timeout:30_000});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, failures === 0 || failures === 3 ? "warning: successful git read\n" : "");
  }
});
