import {mkdtempSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it,vi} from "vitest";
import {readOwnerAdmissionConfig,startOwnerAdmission} from "./ownerAdmissionConfig.js";

it("requires a bounded explicit owner share map and every validation budget",() => {
  const root = mkdtempSync(join(tmpdir(),"dohc-owner-admission-")), path = join(root,"config.json");
  const validation = {maxStructVisits: 100,maxValueNodeVisits: 100,maxDecodedPayloadByteVisits: 1000,maxStructClientGroupVisits: 100,
    maxDeleteClientGroupVisits: 100,maxDeleteIntervalVisits: 100,maxIndexOperations: 100};
  const value = {version: 1,shares: [{workspaceId: "workspace",shareId: "share"}],validation,maxEntriesPerDrain: 10,
    maxBytesPerDrain: 10_000,maxDocumentsPerPass: 10,pollIntervalMs: 100,passDeadlineMs: 1000};
  const read = (input: unknown) => {writeFileSync(path,JSON.stringify(input)); return readOwnerAdmissionConfig(path,["workspace"]);};
  expect(read(value).admission.shares).toEqual(new Map([["workspace","share"]]));
  expect(() => readOwnerAdmissionConfig(path,["workspace","other"])).toThrow("workspace is not configured");
  for (const bad of [{...value,shares: []},{...value,shares: [...value.shares,...value.shares]},
    {...value,shares: [{workspaceId: "unknown",shareId: "share"}]},{...value,validation: {...validation,maxIndexOperations: undefined}},
    {...value,validation: {...validation,defaultBudget: 10}},{...value,maxEntriesPerDrain: undefined},
    ...[0,-1,1.5,2_147_483_648].map(pollIntervalMs => ({...value,pollIntervalMs})),{...value,extra: true}]) expect(() => read(bad)).toThrow();
  expect(() => readOwnerAdmissionConfig("relative.json",["workspace"])).toThrow("absolute");
  expect(() => readOwnerAdmissionConfig(join(root,"missing.json"),["workspace"])).toThrow();
  writeFileSync(path," ".repeat(1_048_577)); expect(() => readOwnerAdmissionConfig(path,["workspace"])).toThrow("too large");
});

it("resumes a bounded workspace scan and aborts the active pass on close",async () => {
  vi.useFakeTimers();
  const unavailable = new AbortController(), calls: string[] = [];
  const workspaceDocs = new Map([["a",["a1","a2"]],["b",["b1"]]]);
  const storage = {unavailable: unavailable.signal,createLiveCommittedDeliveryStore: () => ({nextOwnerDocument(workspaceId: string,after: string) {
    const objectId = workspaceDocs.get(workspaceId)!.find(id => id>after);
    return objectId ? {workspaceId,mainVersionId: "main",objectId,lineageClaimId: "a".repeat(64)} : undefined;
  }})};
  let held: AbortSignal | undefined;
  const config = {admission: {shares: new Map([["a","share-a"],["b","share-b"]]),maxEntriesPerDrain: 1,maxBytesPerDrain: 1000,validate: vi.fn()},
    maxDocumentsPerPass: 2,pollIntervalMs: 100,passDeadlineMs: 30_000};
  const runner = startOwnerAdmission({config,storage: storage as never,history: {} as never,onError: vi.fn(),control: {settle: async (doc,signal) => {
    calls.push(doc.objectId);
    if (calls.length>3) {held=signal; await new Promise<void>((_,reject) => signal!.addEventListener("abort",() => reject(signal!.reason),{once: true}));}
    return {} as never;
  }}});
  try {
    await vi.advanceTimersByTimeAsync(0); expect(calls).toEqual(["a1","a2"]);
    await vi.advanceTimersByTimeAsync(100); expect(calls).toEqual(["a1","a2","b1"]);
    await vi.advanceTimersByTimeAsync(100); expect(held?.aborted).toBe(false);
    runner.close(); expect(held?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); expect(calls).toHaveLength(4);
  } finally {runner.close(); vi.useRealTimers();}
});
