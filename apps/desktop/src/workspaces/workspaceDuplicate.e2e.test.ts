import {readFile, writeFile, unlink} from "node:fs/promises";
import {join} from "node:path";
import {expect, it} from "vitest";
import * as Y from "yjs";
import {createWorkspaceEngineCapture} from "./workspaceEngineCapture";
import {duplicateWorkspaceFile} from "./workspaceDuplicate";
import {createTestScratch} from "./testTemp";
import {waitForPathMoments} from "./waitForPathMoments";
import {requireEngineBinaryOrSkip} from "../testing/engineBinary";
import {createRealDaemonLifecycle,createRealDaemonWorkspaceSessions} from "../testing/realDaemonWorkspaceSessions";
const engine = requireEngineBinaryOrSkip();
it.skipIf(engine.missing)("Duplicate returns after settlement and placement within its one-file budget, including History-only binary names", async () => {
  const rootPath = await createTestScratch("duplicate-return-timing-");
  const workspaceId = "duplicate-return";
  await writeFile(join(rootPath,"source.md"),"base");
  await writeFile(join(rootPath,"source.png"),Buffer.from([0,255,1,2]));
  const lifecycle = createRealDaemonLifecycle({command:engine.require(),maxRestarts:0});
  await lifecycle.start();
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  const capture = createWorkspaceEngineCapture({workspaceId,rootPath,attachmentId:Symbol("duplicate-timing"),rustEngineSessions:sessions,settleDebounceMs:600_000,onError:()=>undefined});
  const editor = new Y.Doc();
  const operation = {workspace:{workspaceId,rootPath},assertCurrent(){}};
  const author = {kind:"human",humanId:"person"} as const;
  try {
    await waitForPathMoments(capture,"source.md",1);
    await waitForPathMoments(capture,"source.png",1);
    const session = await capture.openYDocSession({path:"source.md",onRemoteUpdate:()=>undefined});
    Y.applyUpdate(editor,session.initialUpdate);
    const samples:number[]=[];
    for(let n=0;n<20;n++) {
      const before=Y.encodeStateVector(editor);
      editor.getText("plainText").insert(0,"edit ");
      await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor,before));
      const started=performance.now();
      const copy=await duplicateWorkspaceFile(operation,"source.md",author,capture);
      samples.push(performance.now()-started);
      expect(copy.materialized).toBe(true);
      expect(await readFile(join(rootPath,copy.path),"utf8")).toBe(editor.getText("plainText").toString());
    }
    samples.sort((a,b)=>a-b);
    console.log(JSON.stringify({measurement:"Duplicate return",files:1,samples:20,p50_ms:samples[9],p95_ms:samples[18],includes:"source settlement,recordDisk,commit,placement,recovery receipt"}));
    expect(samples[9]).toBeLessThanOrEqual(500);
    expect(samples[18]).toBeLessThanOrEqual(1000);
    const binary=await duplicateWorkspaceFile(operation,"source.png",author,capture);
    expect(binary.materialized).toBe(true);
    // Remove disk without a capture pass: only History reserves this name.
    await capture.changePathsAs(["source.png"],{operation:"duplicate",author,operationId:"dohc-operation:22222222-2222-4222-8222-222222222222"},async held=>{
      await unlink(join(rootPath,binary.path));
      expect(await held.hasPath(binary.path)).toBe(true);
      expect(await held.hasPath("missing.png")).toBe(false);
    },()=>[]);
  } finally {
    editor.destroy();capture.beginShutdown();await capture.stop().catch(()=>undefined);await sessions.closeAll();await lifecycle.stop();
  }
},120_000);
