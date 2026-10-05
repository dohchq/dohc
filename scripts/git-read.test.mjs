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
          cp.execFileSync=(file,args)=>{
            assert.equal(file,'git');
            if(args[0]===command && (++attempts===1 || persistent)) {
              throw Object.assign(new Error('Command failed'), {status:128,stderr:Buffer.from('warning: unable to access config: Permission denied\\nfatal: configuration failure '+attempts)});
            }
            if(args[0]==='ls-files'||args[0]==='diff') return 'package.json\\0';
            if(args[0]==='status')return '';
            if(args[0]==='rev-list')return '1';
            return 'a'.repeat(40);
          };
          syncBuiltinESMExports();
          const {git}=await import(${JSON.stringify(new URL('./verification/process.mjs',import.meta.url).href)});
          const {sourceFingerprint}=await import(${JSON.stringify(new URL('./verification/build.mjs',import.meta.url).href)});
          const {changedFiles}=await import(${JSON.stringify(new URL('./verification/verify.mjs',import.meta.url).href)});
          const {readTreeState,classifyTreeProvenance}=await import(${JSON.stringify(new URL('../tools/rust-engine-program/tree-provenance.mjs',import.meta.url).href)});
          const action=()=>operation==='fingerprint'?sourceFingerprint('desktop',${JSON.stringify(root)}):operation==='changed-files'?changedFiles('base',false,${JSON.stringify(root)}):readTreeState(cmd=>git(cmd.split(' ').slice(1)),()=>true);
          if(persistent) {
            assert.throws(action,error=>{
              assert.match(error.message,/fatal: configuration failure 3/);
              assert.match(String(error.stderr),/Permission denied/);
              return true;
            });
            assert.equal(attempts,3);
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
