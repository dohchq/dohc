import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it,vi} from "vitest";
import {OwnerKnownRefusals} from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import {readOwnerAdmissionConfig,startOwnerAdmission} from "./ownerAdmissionConfig.js";

const fixtureRoots: string[] = [];
afterEach(() => {for (const root of fixtureRoots.splice(0)) rmSync(root,{recursive: true,force: true});});

it("requires a bounded explicit owner share map and every validation budget",() => {
  const root = mkdtempSync(join(tmpdir(),"dohc-owner-admission-")), path = join(root,"config.json");
  fixtureRoots.push(root);
  const validation = {maxStructVisits: 100,maxValueNodeVisits: 100,maxDecodedPayloadByteVisits: 1000,maxStructClientGroupVisits: 100,
    maxDeleteClientGroupVisits: 100,maxDeleteIntervalVisits: 100,maxIndexOperations: 100};
  const value = {version: 1,shares: [{workspaceId: "workspace",shareId: "share"}],validation,maxEntriesPerDrain: 10,
    maxBytesPerDrain: 10_000,maxDocumentsPerPass: 10,pollIntervalMs: 100,passDeadlineMs: 1000};
  const read = (input: unknown) => {writeFileSync(path,JSON.stringify(input)); return readOwnerAdmissionConfig(path,["workspace"], accountId => ({accountId, name: "Owner name"}));};
  expect(read(value).admission.shares).toEqual(new Map([["workspace","share"]]));
  expect(() => readOwnerAdmissionConfig(path,["workspace","other"], accountId => ({accountId, name: "Owner name"}))).toThrow("workspace is not configured");
  for (const bad of [{...value,shares: []},{...value,shares: [...value.shares,...value.shares]},
    {...value,shares: [{workspaceId: "unknown",shareId: "share"}]},{...value,validation: {...validation,maxIndexOperations: undefined}},
    {...value,validation: {...validation,defaultBudget: 10}},{...value,maxEntriesPerDrain: undefined},
    ...[0,-1,1.5,2_147_483_648].map(pollIntervalMs => ({...value,pollIntervalMs})),{...value,extra: true}]) expect(() => read(bad)).toThrow();
  expect(() => readOwnerAdmissionConfig("relative.json",["workspace"], accountId => ({accountId, name: "Owner name"}))).toThrow("absolute");
  expect(() => readOwnerAdmissionConfig(join(root,"missing.json"),["workspace"], accountId => ({accountId, name: "Owner name"}))).toThrow();
  writeFileSync(path," ".repeat(1_048_577)); expect(() => readOwnerAdmissionConfig(path,["workspace"], accountId => ({accountId, name: "Owner name"}))).toThrow("too large");
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
  const config = {admission: {trustedAccount: (accountId: string) => ({accountId, name: "Owner name"}), shares: new Map([["a","share-a"],["b","share-b"]]),maxEntriesPerDrain: 1,maxBytesPerDrain: 1000,refusals: new OwnerKnownRefusals(),validate: vi.fn()},
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
    const closed = runner.close(); expect(held?.aborted).toBe(true); await closed;
    await vi.advanceTimersByTimeAsync(1000); expect(calls).toHaveLength(4);
  } finally {await runner.close(); vi.useRealTimers();}
});

it("reports a recurring failure again after a successful pass",async () => {
  vi.useFakeTimers();
  let fails = true;
  const onError = vi.fn(), unavailable = new AbortController();
  const storage = {unavailable: unavailable.signal,createLiveCommittedDeliveryStore: () => ({nextOwnerDocument() {
    return {workspaceId: "a",mainVersionId: "main",objectId: "object",lineageClaimId: "a".repeat(64)};
  }})};
  const runner = startOwnerAdmission({storage: storage as never,history: {} as never,onError,
    config: {admission: {trustedAccount: (accountId: string) => ({accountId, name: "Owner name"}), shares: new Map([["a","share"]]),maxEntriesPerDrain: 1,maxBytesPerDrain: 1000,refusals: new OwnerKnownRefusals(),validate: vi.fn()},maxDocumentsPerPass: 1,pollIntervalMs: 100,passDeadlineMs: 30_000},
    control: {settle: async () => {if (fails) throw new Error("offline"); return {} as never;}},
  });
  try {
    await vi.advanceTimersByTimeAsync(0); expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100); expect(onError).toHaveBeenCalledTimes(1);
    fails = false; await vi.advanceTimersByTimeAsync(100);
    fails = true; await vi.advanceTimersByTimeAsync(100); expect(onError).toHaveBeenCalledTimes(2);
  } finally {await runner.close(); vi.useRealTimers();}
});

type Settle = Parameters<typeof startOwnerAdmission>[0]["control"]["settle"];
function deferred() {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise,resolve};}
function admissionFixture(settle: Settle,onError = vi.fn()) {
  const unavailable = new AbortController();
  const nextOwnerDocument = vi.fn((_workspaceId: string,after: string) => after === "first"
    ? {workspaceId: "a",mainVersionId: "main",objectId: "second",lineageClaimId: "a".repeat(64)}
    : {workspaceId: "a",mainVersionId: "main",objectId: "first",lineageClaimId: "a".repeat(64)});
  const runner = startOwnerAdmission({
    storage: {unavailable: unavailable.signal,createLiveCommittedDeliveryStore: () => ({nextOwnerDocument})} as never,
    history: {} as never,onError,control: {settle},
    config: {admission: {trustedAccount: (accountId: string) => ({accountId, name: "Owner name"}), shares: new Map([["a","share"]]),maxEntriesPerDrain: 1,maxBytesPerDrain: 1000,refusals: new OwnerKnownRefusals(),validate: vi.fn()},
      maxDocumentsPerPass: 2,pollIntervalMs: 100,passDeadlineMs: 30_000},
  });
  return {runner,unavailable,nextOwnerDocument};
}

it.each(["close","storage"] as const)("waits for uncancellable settlement after %s and joins concurrent closes",async mode => {
  vi.useFakeTimers();
  const settlement = deferred();
  let activeSignal: AbortSignal | undefined;
  const settle = vi.fn<Settle>(async (_document,signal) => {activeSignal = signal; await settlement.promise; return {} as never;});
  const {runner,unavailable,nextOwnerDocument} = admissionFixture(settle);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).toHaveBeenCalledTimes(1);
    if (mode === "storage") unavailable.abort();
    const firstClose = Promise.resolve(runner.close()), secondClose = Promise.resolve(runner.close());
    let closed = 0;
    void firstClose.then(() => closed++); void secondClose.then(() => closed++);
    expect(activeSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(closed).toBe(0);
    expect(nextOwnerDocument).toHaveBeenCalledTimes(1);
    settlement.resolve();
    await Promise.all([firstClose,secondClose]);
    expect(closed).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(settle).toHaveBeenCalledTimes(1);
  } finally {settlement.resolve(); await runner.close(); vi.useRealTimers();}
});

it("keeps the pass occupied after its deadline until actual settlement",async () => {
  vi.useFakeTimers();
  const deadline = new AbortController(), settlement = deferred();
  const timeout = vi.spyOn(AbortSignal,"timeout").mockReturnValue(deadline.signal);
  let activeSignal: AbortSignal | undefined;
  const settle = vi.fn<Settle>(async (_document,signal) => {activeSignal = signal; await settlement.promise; return {} as never;});
  const {runner,nextOwnerDocument} = admissionFixture(settle);
  try {
    await vi.advanceTimersByTimeAsync(0);
    deadline.abort(new Error("deadline"));
    expect(activeSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(nextOwnerDocument).toHaveBeenCalledTimes(1);
    settlement.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).toHaveBeenCalledTimes(1);
  } finally {settlement.resolve(); await runner.close(); timeout.mockRestore(); vi.useRealTimers();}
});

it("advances past a failed document and keeps polling when the error reporter throws",async () => {
  vi.useFakeTimers();
  const onError = vi.fn(() => {throw new Error("logger failed");});
  const settle = vi.fn<Settle>(async () => {throw new Error("offline");});
  const {runner} = admissionFixture(settle,onError);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(settle.mock.calls[0]?.[0].objectId).toBe("first");
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(settle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(settle.mock.calls[1]?.[0].objectId).toBe("second");
    expect(onError).toHaveBeenCalledTimes(1);
  } finally {await runner.close(); vi.useRealTimers();}
});

it("cancels an idle poll on close",async () => {
  vi.useFakeTimers();
  const settle = vi.fn(async () => ({} as never));
  const {runner} = admissionFixture(settle);
  try {
    expect(settle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).toHaveBeenCalledTimes(2);
    await runner.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(settle).toHaveBeenCalledTimes(2);
  } finally {await runner.close(); vi.useRealTimers();}
});
