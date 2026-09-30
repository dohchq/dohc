import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export function runEarlyCloseDebugFixture(source, closed) {
  const root = mkdtempSync(join(tmpdir(), "dohc-debug-close-"));
  const put = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  try {
    put("package.json", '{"type":"module"}');
    put("apps/desktop/package.json", "{}");
    put("scripts/verification/build.mjs", "export const prepare=async()=>{};export const assertPrepared=()=>({});");
    put("scripts/verification/process.mjs", "import {resolve} from 'node:path';export const repoRoot=resolve(import.meta.dirname,'../..');export const git=()=> 'fixture-head';");
    copyFileSync(source, join(root, "scripts/verification/debug.mjs"));
    copyFileSync(new URL("./close-electron.mjs", import.meta.url), join(root, "scripts/verification/close-electron.mjs"));
    copyFileSync(new URL("./desktop-close-policy.mjs", import.meta.url), join(root, "scripts/verification/desktop-close-policy.mjs"));
    mkdirSync(join(root, "apps/desktop/src"), { recursive: true });
    copyFileSync(new URL("../../apps/desktop/src/shutdownBudgets.ts", import.meta.url), join(root, "apps/desktop/src/shutdownBudgets.ts"));
    put("node_modules/electron/index.js", "module.exports='fixture-electron';");
    put("node_modules/playwright/index.js", `
      const {EventEmitter}=require('node:events');
      const {PassThrough}=require('node:stream');
      const {writeFileSync}=require('node:fs');
      const {join}=require('node:path');
      exports._electron={launch:async ({args})=>{
        const app=new EventEmitter();
        const child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,stdout:new PassThrough(),stderr:new PassThrough()});
        const page=Object.assign(new EventEmitter(),{screenshot:async({path})=>writeFileSync(path,'fixture screenshot')});
        const tracing={start:async()=>{},stop:async({path})=>writeFileSync(path,'fixture trace')};
        writeFileSync(join(args.find(arg=>arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length),'DevToolsActivePort'),'1234');
        app.process=()=>child;
        app.firstWindow=async()=>{
          if(${JSON.stringify(closed)}==='app') app.emit('close');
          else {child.exitCode=0;child.emit('exit',0,null);}
          return page;
        };
        app.windows=()=>[page];app.context=()=>({tracing});app.evaluate=async()=>1234;
        app.close=async()=>{child.exitCode=0;child.emit('exit',0,null);app.emit('close');};
        return app;
      }};
    `);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      globalThis.fetch=async()=>({ok:true,json:async()=>[{type:'page',webSocketDebuggerUrl:'ws://fixture'}]});
      await import('./scripts/verification/debug.mjs');
    `], { cwd: root, encoding: "utf8", timeout: 20_000 });
    const artifacts = join(root, ".agent-artifacts/debug");
    const directory = existsSync(artifacts) ? readdirSync(artifacts)[0] : undefined;
    const files = directory ? readdirSync(join(artifacts, directory)).filter((name) => /\.(jsonl|json|png|zip)$/.test(name)) : [];
    return { ...result, files };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
