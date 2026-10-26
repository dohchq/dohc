import {createHash} from "node:crypto";
import {VersionedLiveAdapter} from "@dohc/workspace-engine-client";
import {lstat, readFile, writeFile, unlink} from "node:fs/promises";
import {join} from "node:path";
import {expect, it} from "vitest";
import * as Y from "yjs";
import {createWorkspaceEngineCapture} from "./workspaceEngineCapture";
import {duplicateWorkspaceFile} from "./workspaceDuplicate";
import {readLocalStateFrom} from "./workspaceLocalState";
import {createTestScratch} from "./testTemp";
import {waitForPathMoments} from "./waitForPathMoments";
import {requireEngineBinaryOrSkip} from "../testing/engineBinary";
import {createRealDaemonLifecycle,createRealDaemonWorkspaceSessions,REAL_DAEMON_DEADLINE_MS} from "../testing/realDaemonWorkspaceSessions";
const engine = requireEngineBinaryOrSkip();
const TIMING_SAMPLES = 20;
// Each sample has an update, a Duplicate and a History read; setup, recovery and cleanup
// have at most twenty more bounded steps. A named deadline must fail first.
const TEST_TIMEOUT_MS = (3 * TIMING_SAMPLES + 20) * REAL_DAEMON_DEADLINE_MS;
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
it.skipIf(engine.missing)("Duplicate records one copy per operation and measures its full return, including History-only binary names", async () => {
  const rootPath = await createTestScratch("duplicate-return-timing-");
  const workspaceId = "duplicate-return";
  await writeFile(join(rootPath,"source.md"),"base");
  await writeFile(join(rootPath,"source.png"),Buffer.from([0,255,1,2]));
  const lifecycle = createRealDaemonLifecycle({command:engine.require(),maxRestarts:0});
  await withinDeadline("daemon start", () => lifecycle.start());
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  // Writers of `.dohc/local` ask the engine's open, as the desktop's do.
  readLocalStateFrom(sessions);
  const attachmentId = Symbol("duplicate-timing");
  const capture = createWorkspaceEngineCapture({workspaceId,rootPath,attachmentId,rustEngineSessions:sessions,settleDebounceMs:600_000});
  const editor = new Y.Doc();
  const operation = {workspace:{workspaceId,rootPath,attachmentId},assertCurrent(){}};
  const author = {kind:"human",humanId:"person"} as const;
  let completed = false;
  try {
    await withinDeadline("source capture", () => waitForPathMoments(capture,"source.md",1));
    await withinDeadline("binary capture", () => waitForPathMoments(capture,"source.png",1));
    const session = await withinDeadline("source session", () => capture.openYDocSession({path:"source.md",onRemoteUpdate:()=>undefined}));
    Y.applyUpdate(editor,session.initialUpdate);
    const samples:number[]=[];
    for(let n=0;n<TIMING_SAMPLES;n++) {
      const before=Y.encodeStateVector(editor);
      editor.getText("plainText").insert(0,"edit ");
      await withinDeadline("source update", async () => session.applyLocalUpdate(Y.encodeStateAsUpdate(editor,before)));
      const started=performance.now();
      const copy=await withinDeadline("Duplicate return", () => duplicateWorkspaceFile(operation,"source.md",author,capture));
      samples.push(performance.now()-started);
      expect(copy.materialized).toBe(true);
      expect(await readFile(join(rootPath,copy.path),"utf8")).toBe(editor.getText("plainText").toString());
      await withinDeadline("Duplicate History bounds", () => sessions.run({workspaceId,rootPath,attachmentId}, async binding => {
        const adapter = new VersionedLiveAdapter(binding.client,binding.workspace,{workspaceId});
        expect(await adapter.readHistoryOperation({workspaceId,operationId:copy.operationId})).toMatchObject({kind:"file-duplicate",momentCount:1});
        const page = await adapter.readHistoryPage({workspaceId,versionId:"main",operationId:copy.operationId,limit:2});
        expect(page.moments).toHaveLength(1);
        expect(page.moments[0]).toMatchObject({operation:"write",path:copy.path});
      }));
    }
    samples.sort((a,b)=>a-b);
    console.log(JSON.stringify({measurement:"Duplicate return",files:1,samples:TIMING_SAMPLES,p50_ms:samples[9],p95_ms:samples[18],includes:"source settlement,recordDisk,commit,placement,recovery receipt"}));
    const interrupted = await withinDeadline("duplicate before Undo", () => duplicateWorkspaceFile(operation,"source.md",author,capture));
    const receiptPath = join(rootPath,".dohc/local/duplicate-pending",createHash("sha256").update("source.md").digest("hex")+".json");
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
    expect(undone.momentCount).toBe(1);
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
},TEST_TIMEOUT_MS);
