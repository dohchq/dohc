import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createTestScratch } from "./testTemp";
import { hasRetainedLiveDraft } from "./liveDraftRecovery";
import { typingRecoveryFailure, typingRecoveryStateVectorSha256, writeTypingCheckpoint, readTypingCheckpoints, retireTypingCheckpoint, importTypingCheckpoints, flushTypingCheckpoints, flushTypingCheckpointsSync, writeTypingCheckpointSync, registerTypingCheckpoint, type OutageTypingCheckpoint } from "./outageTypingRecovery";
const checkpoint: OutageTypingCheckpoint = {version: 2, checkpointId: "session-checkpoint", workspaceId: "workspace", versionId: "main", objectId: "object", path: "note.md", expectedClaimId: "claim", expectedStateVectorSha256: "a".repeat(64), expectedDiskSha256: "b".repeat(64), text: "typing", updateBase64: "AAA=", admittedBaseBase64: "AAA=", updates: [{requestId: "original", updateBase64: "AAA=", actorOriginId: "person", attribution: {actorKind: "human", onBehalfOf: "person", depth: 0}}]};
vi.mock("node:fs", async original => {
 const actual=await original<typeof import("node:fs")>();
 return {...actual,rmSync:vi.fn(actual.rmSync)};
});
it("logs retirement failure after a committed import without reporting recovery failure", async () => {
 const directory=await createTestScratch("typing-cleanup-failure-");await writeTypingCheckpoint(directory,checkpoint);
 const failure=vi.fn(),refresh=vi.fn();const warning=vi.spyOn(console,"warn").mockImplementation(()=>{});
 const locked=Object.assign(Error("checkpoint is locked"),{code:"EPERM"});
 vi.mocked(rmSync).mockImplementationOnce(()=>{throw locked;});
 try {
  await importTypingCheckpoints(directory,"workspace",async()=>({committed:true,outcome:"replayed",momentId:null}),failure,refresh);
  expect(refresh).toHaveBeenCalledExactlyOnceWith("note.md",checkpoint.checkpointId,{committed:true,outcome:"replayed",momentId:null});
  expect(failure).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledExactlyOnceWith("[desktop] typing recovery checkpoint cleanup failed","note.md",locked);
  expect(await readTypingCheckpoints(directory,"workspace")).toHaveLength(1);
  await importTypingCheckpoints(directory,"workspace",async()=>({committed:true,outcome:"covered",momentId:null}),failure,refresh);
  expect(await readTypingCheckpoints(directory,"workspace")).toEqual([]);expect(failure).not.toHaveBeenCalled();
 } finally {warning.mockRestore();}
});
it("persists originals and admitted base before exit and replaces the same record during outage edits", async () => {
 const directory = await createTestScratch("typing-checkpoint-");
 await writeTypingCheckpoint(directory, checkpoint);
 await writeTypingCheckpoint(directory, {...checkpoint, text: "more typing"});
 const rows = await readTypingCheckpoints(directory, "workspace");
 expect(rows).toHaveLength(1); expect(rows[0]!.checkpoint.text).toBe("more typing");
 expect(rows[0]!.checkpoint.updates).toEqual(checkpoint.updates);
 expect(await hasRetainedLiveDraft(directory, "workspace", "renamed.md", "object")).toBe(true);
});
it.each(["replayed", "covered", "imported"] as const)("retires only the exact committed checkpoint (%s), refreshing recovery status", async outcome => {
 const directory = await createTestScratch("typing-retire-"); await writeTypingCheckpoint(directory, checkpoint);
 const refresh = vi.fn(); const failure = vi.fn();
 await importTypingCheckpoints(directory, "workspace", async input => {expect(input.updates).toEqual(checkpoint.updates); return {committed: true, outcome, momentId: outcome === "imported" ? "moment" : null};}, failure, refresh);
 expect(await readTypingCheckpoints(directory, "workspace")).toEqual([]); expect(refresh).toHaveBeenCalledExactlyOnceWith("note.md", checkpoint.checkpointId, {committed:true,outcome,momentId:outcome === "imported" ? "moment" : null}); expect(failure).not.toHaveBeenCalled();
 expect(await hasRetainedLiveDraft(directory, "workspace", "note.md", "object")).toBe(false);
});
it("keeps a newer checkpoint written while the engine answers an older import", async () => {
 const directory = await createTestScratch("typing-race-"); await writeTypingCheckpoint(directory, checkpoint);
 const row = (await readTypingCheckpoints(directory, "workspace"))[0]!;
 await writeTypingCheckpoint(directory, {...checkpoint, text: "newer typing"}); await retireTypingCheckpoint(row);
 expect((await readTypingCheckpoints(directory, "workspace"))[0]!.checkpoint.text).toBe("newer typing");
});
it("keeps a refused import for retry and reports one failure without failing workspace launch", async () => {
 const directory = await createTestScratch("typing-refused-"); await writeTypingCheckpoint(directory, checkpoint);
 const failure = vi.fn(); const refresh = vi.fn();
 await importTypingCheckpoints(directory, "workspace", async () => {throw Error("capture-recovery-refused:remote-human-author");}, failure, refresh);
 expect(failure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({kind: "import", path: "note.md"})); expect(refresh).not.toHaveBeenCalled();
 expect(await readTypingCheckpoints(directory, "workspace")).toHaveLength(1);
});
it("keeps memory available when the checkpoint write fails and retries the actual condition", async () => {
 const directory = await createTestScratch("typing-failure-"); const blocked = join(directory, "blocked"); await writeFile(blocked, "file");
 const flush = vi.fn(() => writeTypingCheckpoint(blocked, checkpoint)); const unregister = registerTypingCheckpoint("workspace", flush);
 try {await expect(flushTypingCheckpoints("workspace")).rejects.toThrow(); await rm(blocked); await mkdir(blocked); await flushTypingCheckpoints("workspace"); expect(await readTypingCheckpoints(blocked, "workspace")).toHaveLength(1);} finally {unregister();}
});
it("rejects tampered authors and does not send a malformed record to the engine", async () => {
 const directory = await createTestScratch("typing-invalid-"); await writeTypingCheckpoint(directory, checkpoint);
 const row = (await readTypingCheckpoints(directory, "workspace"))[0]!; const raw = JSON.parse(await readFile(row.file, "utf8")); raw.updates[0].attribution.actorKind = "remote-person"; await writeFile(row.file, JSON.stringify(raw));
 await expect(readTypingCheckpoints(directory, "workspace")).rejects.toThrow();
});

it("serializes exact retirement with a concurrent checkpoint rewrite", async () => {
 const directory = await createTestScratch("typing-concurrent-"); await writeTypingCheckpoint(directory, checkpoint);
 const row = (await readTypingCheckpoints(directory, "workspace"))[0]!;
 await Promise.all([retireTypingCheckpoint(row), writeTypingCheckpoint(directory, {...checkpoint, text: "new typing"})]);
 expect((await readTypingCheckpoints(directory, "workspace"))[0]!.checkpoint.text).toBe("new typing");
});

it("refreshes only the committed record when another import is refused", async () => {
 const directory = await createTestScratch("typing-partial-");
 await writeTypingCheckpoint(directory, checkpoint);
 await writeTypingCheckpoint(directory, {...checkpoint, objectId: "other", path: "other.md"});
 const failures = new Map<string, string>();
 await importTypingCheckpoints(directory, "workspace", async input => {
  if (input.path === "note.md") throw Error("typed refusal");
  return {committed: true, outcome: "covered", momentId: null};
 }, failure => failures.set(failure.path, failure.detail), path => failures.delete(path));
 expect([...failures.keys()]).toEqual(["note.md"]);
 expect((await readTypingCheckpoints(directory, "workspace")).map(row => row.checkpoint.path)).toEqual(["note.md"]);
});

it("hashes state vectors in the engine's canonical client order", () => {
  const ascending = new Uint8Array([2, 1, 3, 2, 4]);
  const descending = new Uint8Array([2, 2, 4, 1, 3]);
  const engineDigest = createHash("sha256").update(ascending).digest("hex");
  expect(typingRecoveryStateVectorSha256(descending)).toBe(engineDigest);
  expect(typingRecoveryStateVectorSha256(ascending)).toBe(engineDigest);
});

it("leaves live-session checkpoints to their replay owner during a rebind",async()=>{
 const directory=await createTestScratch("typing-owned-");await writeTypingCheckpoint(directory,checkpoint);
 const importer=vi.fn(async()=>({committed:true as const,outcome:"imported" as const,momentId:"false-moment"}));const failure=vi.fn(),refresh=vi.fn();
 const unregister=registerTypingCheckpoint("workspace",async()=>{},()=>true,{checkpointId:checkpoint.checkpointId,path:"note.md"});
 try {await importTypingCheckpoints(directory,"workspace",importer,failure,refresh);expect(importer).not.toHaveBeenCalled();expect(refresh).not.toHaveBeenCalled();expect(await readTypingCheckpoints(directory,"workspace")).toHaveLength(1);}finally{unregister();}
 await importTypingCheckpoints(directory,"workspace",importer,failure,refresh);expect(importer).toHaveBeenCalledOnce();
});
it("a later session never overwrites typing whose import was refused",async()=>{
 const directory=await createTestScratch("typing-retained-");await writeTypingCheckpoint(directory,checkpoint);
 await importTypingCheckpoints(directory,"workspace",async()=>{throw Error("capture-recovery-refused:remote-human-author");},()=>{},()=>{});
 await writeTypingCheckpoint(directory,{...checkpoint,checkpointId:"next-session",text:"later typing"});
 expect((await readTypingCheckpoints(directory,"workspace")).map(r=>r.checkpoint.text).sort()).toEqual(["later typing","typing"]);
});
it("waits for every checkpoint even after one fails",async()=>{
 let release!:()=>void;const held=new Promise<void>(done=>{release=done;});let finished=false;
 const a=registerTypingCheckpoint("a",async()=>{throw Error("disk full");});const b=registerTypingCheckpoint("b",async()=>{await held;finished=true;});
 try {let answered=false;const flush=flushTypingCheckpoints().catch(()=>{answered=true;});await Promise.resolve();expect(answered).toBe(false);release();await flush;expect(finished).toBe(true);}finally{a();b();}
});
it("keeps the final synchronous OS-end copy when an older async rewrite finishes",async()=>{
 const directory=await createTestScratch("typing-os-end-");await writeTypingCheckpoint(directory,checkpoint);
 const older=writeTypingCheckpoint(directory,{...checkpoint,text:"debounced"});
 const unregister=registerTypingCheckpoint("workspace",async()=>{},()=>true,undefined,()=>writeTypingCheckpointSync(directory,{...checkpoint,text:"final OS typing"}));
 try {flushTypingCheckpointsSync();await older;expect((await readTypingCheckpoints(directory,"workspace"))[0]!.checkpoint.text).toBe("final OS typing");}finally{unregister();}
});

it("imports a crash-left checkpoint while a new session owns the same open file", async () => {
 const directory=await createTestScratch("typing-crash-reopen-"); await writeTypingCheckpoint(directory, checkpoint);
 const unregister=registerTypingCheckpoint("workspace",async()=>{},()=>true,{checkpointId:"new-process-session",path:checkpoint.path});
 const importer=vi.fn(async()=>({committed:true as const,outcome:"replayed" as const,momentId:null}));
 try {await importTypingCheckpoints(directory,"workspace",importer,vi.fn(),vi.fn());expect(importer).toHaveBeenCalledOnce();expect(await readTypingCheckpoints(directory,"workspace")).toEqual([]);}finally{unregister();}
});
it("distinguishes malformed attribution from a remote human",()=>{
 expect(typingRecoveryFailure("import","note.md",Error("invalid-author"))).toMatchObject({reason:"invalid-author",retryable:false});
 expect(typingRecoveryFailure("import","note.md",Error("remote-human-author"))).toMatchObject({reason:"author-refused",retryable:false});
});
