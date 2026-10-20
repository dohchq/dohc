import {createHash} from "node:crypto";
import {VersionedLiveAdapter} from "@dohc/workspace-engine-client";
import {lstat, readFile, writeFile, unlink} from "node:fs/promises";
import {join} from "node:path";
import {expect, it} from "vitest";
import * as Y from "yjs";
import {createWorkspaceEngineCapture} from "./workspaceEngineCapture";
import {duplicateWorkspaceFile} from "./workspaceDuplicate";
import {createTestScratch} from "./testTemp";
import {waitForPathMoments} from "./waitForPathMoments";
import {requireEngineBinaryOrSkip} from "../testing/engineBinary";
import {createRealDaemonLifecycle,createRealDaemonWorkspaceSessions,REAL_DAEMON_DEADLINE_MS} from "../testing/realDaemonWorkspaceSessions";
const engine = requireEngineBinaryOrSkip();
async function withinDeadline<T>(name: string, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${name}.`)), REAL_DAEMON_DEADLINE_MS);
    })]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
it.skipIf(engine.missing)("Duplicate returns after settlement and placement within its one-file budget, including History-only binary names", async () => {
  const rootPath = await createTestScratch("duplicate-return-timing-");
  const workspaceId = "duplicate-return";
  await writeFile(join(rootPath,"source.md"),"base");
  await writeFile(join(rootPath,"source.png"),Buffer.from([0,255,1,2]));
  const lifecycle = createRealDaemonLifecycle({command:engine.require(),maxRestarts:0});
  await lifecycle.start();
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  const attachmentId = Symbol("duplicate-timing");
  const capture = createWorkspaceEngineCapture({workspaceId,rootPath,attachmentId,rustEngineSessions:sessions,settleDebounceMs:600_000});
  const editor = new Y.Doc();
  const operation = {workspace:{workspaceId,rootPath},assertCurrent(){}};
  const author = {kind:"human",humanId:"person"} as const;
  let completed = false;
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
      const copy=await withinDeadline("Duplicate return", () => duplicateWorkspaceFile(operation,"source.md",author,capture));
      samples.push(performance.now()-started);
      expect(copy.materialized).toBe(true);
      expect(await readFile(join(rootPath,copy.path),"utf8")).toBe(editor.getText("plainText").toString());
    }
    samples.sort((a,b)=>a-b);
    console.log(JSON.stringify({measurement:"Duplicate return",files:1,samples:20,p50_ms:samples[9],p95_ms:samples[18],includes:"source settlement,recordDisk,commit,placement,recovery receipt"}));
    expect(samples[9]).toBeLessThanOrEqual(500);
    expect(samples[18]).toBeLessThanOrEqual(1000);
    const interrupted = await withinDeadline("duplicate before Undo", () => duplicateWorkspaceFile(operation,"source.md",author,capture));
    const receiptPath = join(rootPath,".dohc/duplicate-pending",createHash("sha256").update("source.md").digest("hex")+".json");
    await writeFile(receiptPath,JSON.stringify({workspaceId,source:"source.md",path:interrupted.path,operationId:interrupted.operationId}));
    const recovered = await withinDeadline("recover committed Duplicate", () => duplicateWorkspaceFile(operation,"source.md",author,capture));
    expect(recovered.operationId).toBe(interrupted.operationId);
    expect(recovered.path).toBe(interrupted.path);
    await writeFile(receiptPath,JSON.stringify({workspaceId,source:"source.md",path:interrupted.path,operationId:interrupted.operationId}));
    const undone = await withinDeadline("Undo RPC", () => sessions.run({workspaceId,rootPath,attachmentId}, async binding => {
      const adapter = new VersionedLiveAdapter(binding.client,binding.workspace,{workspaceId});
      return adapter.undoHistoryOperation({workspaceId,operationId:interrupted.operationId,requestId:"undo-receipt-copy",author});
    }));
    expect(undone.notRestored).toEqual([]);
    await withinDeadline("Undo disk placement", () => expect.poll(() => lstat(join(rootPath,interrupted.path)).then(() => true, error => {
      if (error.code === "ENOENT") return false;
      throw error;
    }), {timeout:REAL_DAEMON_DEADLINE_MS}).toBe(false));
    await withinDeadline("read undone receipt under hold", () => capture.changePathsAs(["source.md"],{operation:"duplicate",author,operationId:"dohc-operation:33333333-3333-4333-8333-333333333333"},async held=>{
      expect(await held.readDuplicate(interrupted.operationId, interrupted.path)).toBeNull();
    },()=>[]));
    const repeated = await withinDeadline("Duplicate after Undo", () => duplicateWorkspaceFile(operation,"source.md",author,capture));
    expect(repeated.operationId).not.toBe(interrupted.operationId);
    expect(repeated.materialized).toBe(true);
    expect(await readFile(join(rootPath,repeated.path),"utf8")).toBe(editor.getText("plainText").toString());
    const binary=await withinDeadline("binary duplicate", () => duplicateWorkspaceFile(operation,"source.png",author,capture));
    expect(binary.materialized).toBe(true);
    // Remove disk without a capture pass: only History reserves this name.
    await withinDeadline("History binary name under hold", () => capture.changePathsAs(["source.png"],{operation:"duplicate",author,operationId:"dohc-operation:22222222-2222-4222-8222-222222222222"},async held=>{
      await unlink(join(rootPath,binary.path));
      expect(await held.hasPath(binary.path)).toBe(true);
      expect(await held.hasPath("missing.png")).toBe(false);
    },()=>[]));
    completed = true;
  } finally {
    editor.destroy();capture.beginShutdown();
    const cleanupErrors: unknown[] = [];
    for (const [name, close] of [
      ...(!completed ? [["failed test daemon stop", () => lifecycle.stop()] as const] : []),
      ["capture stop", () => capture.stop()],
      ["sessions close", () => sessions.closeAll()],
      ["lifecycle stop", () => lifecycle.stop()],
    ] as const) {
      try { await withinDeadline(name, close); } catch (error) { cleanupErrors.push(error); }
    }
    if (completed && cleanupErrors.length) throw new AggregateError(cleanupErrors,"Duplicate test cleanup failed.");
  }
},120_000);
