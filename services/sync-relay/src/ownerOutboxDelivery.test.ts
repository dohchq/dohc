import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { drainOwnerOutbox } from "./ownerOutboxDelivery.js";
import type {LiveUpdateHostApplicationAck, LiveUpdateReceipt} from "@dohc/live-session-contract/live-update-admission";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture(maxEntriesPerDrain = 3, maxBytesPerDrain = 10_000) {
  const base = Buffer.alloc(1_048_576, 17);
  const binding = {workspaceId: "workspace",mainVersionId: "main",objectId: "object",lineageClaimId: sha(base),currentPath: "a.md",selectorPaths: ["a.md"],restoreFenceGeneration: 1};
  const entries = [1,3,7].map(sequence => ({sequence,appendKey: `append-${sequence}`,deliveryId: `delivery-${sequence}`,updateDigest: sha(Buffer.from([sequence])),byteLength: 1,createdAtMs: sequence}));
  const host = {hostId: "host",hostEpoch: 1,instanceId: "instance",connectionId: "connection"};
  const requests: Array<{part: string; bytes: number}> = [], receipts: unknown[] = [];
  const state = {value: "active"};
  const applyThrough = vi.fn(async (receipt: LiveUpdateReceipt): Promise<LiveUpdateHostApplicationAck | null> => ({...receipt,localYDocSequence: receipt.journalCursor,applicationReplayed: true}));
  let requestId = 0;
  const cursor = (snapshot: string, part: string, sequence = 0, offset = 0) => ({snapshot,part,sequence,offset});
  const client = {sendRequest: vi.fn(async (request: {id: number; method: string; params: Record<string, unknown>}) => {
    if (request.method === "liveApplication.ownerOutbox") return {id: request.id,result: {outboxId: "outbox",pendingBytes: entries.length,state: state.value}};
    if (request.method === "liveApplication.acknowledgeOwnerOutbox") {
      const receipt = (request.params.receipts as Array<{deliveryId: string; updateDigest: string}>)[0]!;
      expect(receipt).toMatchObject({deliveryId: entries[0]!.deliveryId,updateDigest: entries[0]!.updateDigest});
      receipts.push(receipt); entries.shift();
      return {id: request.id,result: {acknowledged: 1,pendingBytes: entries.length,oldestEntryAtMs: entries[0]?.createdAtMs ?? null}};
    }
    expect(request.method).toBe("liveApplication.readOwnerOutbox");
    const snapshot = sha(Buffer.from(JSON.stringify(entries)));
    const requested = request.params.cursor as ReturnType<typeof cursor> | undefined;
    if (requested && requested.snapshot !== snapshot) return {id: request.id,result: {kind: "readChanged"}};
    const current = requested ?? cursor(snapshot,"header");
    const firstEntryCursor = entries[0] ? cursor(snapshot,"entryHeader",entries[0].sequence) : null;
    const entry = entries.find(row => row.sequence === current.sequence);
    let bytes: Buffer, following: ReturnType<typeof cursor> | null;
    if (current.part === "header") {
      bytes = Buffer.from(JSON.stringify({outboxId: "outbox",binding,baseUpdateDigest: sha(base),baseByteLength: base.length,state: state.value,pendingBytes: entries.length,pendingEntryCount: entries.length,nextSequence: 8,oldestEntryAtMs: entries[0]?.createdAtMs ?? null,quarantineReason: null,observedBinding: null,firstEntryCursor}));
      following = cursor(snapshot,"base");
    } else if (current.part === "base") {bytes = base; following = firstEntryCursor;}
    else if (current.part === "entryHeader") {bytes = Buffer.from(JSON.stringify(entry)); following = cursor(snapshot,"update",current.sequence);}
    else {bytes = Buffer.from([current.sequence]); const next = entries.find(row => row.sequence > current.sequence); following = next ? cursor(snapshot,"entryHeader",next.sequence) : null;}
    const chunk = bytes.subarray(current.offset,current.offset + 1024);
    requests.push({part: current.part,bytes: chunk.toString("base64").length});
    return {id: request.id,result: {kind: "page",...current,totalBytes: bytes.length,digest: sha(bytes),bytesBase64: chunk.toString("base64"),nextCursor: current.offset + chunk.length < bytes.length ? {...current,offset: current.offset + chunk.length} : following}};
  })};
  const storage = {
    getShare: () => ({workspaceId: "workspace",shareId: "share",granterUserId: "owner"}),
    resolveCurrentLiveDocumentBinding: () => ({kind: "current",host,binding,authority: {}}),
    readLiveUpdateJournalCut: () => ({kind: "cut",cut: {checkpoint: {bytes: new Uint8Array([0,0])},suffix: []}}),
    commitLiveUpdateJournal: vi.fn((input: {metadata: {deliveryId: string; updateDigest: string}}) => ({result: {kind: "accepted",receipt: {deliveryId: input.metadata.deliveryId,updateDigest: input.metadata.updateDigest,journalCursor: receipts.length + 1,acceptingHostEpoch: 1}}})),
  };
  return {requests,receipts,storage,state,applyThrough,run: () => drainOwnerOutbox({client: client as never,storage: storage as never,admission: {shares: new Map([["workspace","share"]]),maxEntriesPerDrain,maxBytesPerDrain,validate: () => ({} as never)},workspace: "handle",host: host as never,registrationId: 1,binding,nextRequestId: () => ++requestId,deadlineMs: 30_000,assertCurrent() {},applyThrough})};
}

it("drains small edits when their immutable base exceeds the aggregate drain budget", async () => {
  const run = fixture();
  expect(await run.run()).toEqual({admittedEntries: 3, hasMore: false});
  expect(run.receipts).toHaveLength(3);
  expect(run.requests.filter(row => row.part === "base")).toHaveLength(0);
  expect(run.requests).toHaveLength(9);
  expect(run.requests.reduce((bytes, row) => bytes + row.bytes, 0)).toBeLessThan(10_000);
});

it("retains configured entry and byte limits without acknowledging unread updates", async () => {
  const one = fixture(1);
  expect(await one.run()).toEqual({admittedEntries: 1, hasMore: true});
  expect(one.receipts).toHaveLength(1);
  expect(await one.run()).toEqual({admittedEntries: 1, hasMore: true});
  expect(await one.run()).toEqual({admittedEntries: 1, hasMore: false});
  expect(await one.run()).toEqual({admittedEntries: 0, hasMore: false});
  const bounded = fixture(3, 1);
  await expect(bounded.run()).rejects.toThrow("byte budget exceeded");
  expect(bounded.receipts).toHaveLength(0);
  expect(bounded.storage.commitLiveUpdateJournal).not.toHaveBeenCalled();
});

it("continues a byte-limited pass only after a real admission and native outbox ACK", async () => {
  const measured = fixture(1); await measured.run();
  const bytes = measured.requests.reduce((sum, row) => sum + row.bytes, 0);
  const bounded = fixture(3, bytes);
  expect(await bounded.run()).toEqual({admittedEntries: 1, hasMore: true});
  expect(bounded.receipts).toHaveLength(1);
  expect(await bounded.run()).toEqual({admittedEntries: 1, hasMore: true});
  expect(await bounded.run()).toEqual({admittedEntries: 1, hasMore: false});
});

it("drains a sealed queue with fresh owner standing and leaves quarantine intact", async () => {
  const sealed = fixture(1);
  sealed.state.value = "sealed";
  expect(await sealed.run()).toEqual({admittedEntries: 1,hasMore: true});
  expect(await sealed.run()).toEqual({admittedEntries: 1,hasMore: true});
  expect(await sealed.run()).toEqual({admittedEntries: 1,hasMore: false});
  const quarantined = fixture();
  quarantined.state.value = "quarantined";
  await expect(quarantined.run()).rejects.toThrow("explicit recovery");
  expect(quarantined.storage.commitLiveUpdateJournal).not.toHaveBeenCalled();
  expect(quarantined.applyThrough).not.toHaveBeenCalled();
  expect(quarantined.receipts).toEqual([]);
});

it("retains the exact head while native application is pending or fails", async () => {
  const f = fixture(1);
  f.applyThrough.mockResolvedValueOnce(null);
  expect(await f.run()).toEqual({admittedEntries: 0,hasMore: true});
  expect(f.receipts).toEqual([]);
  f.applyThrough.mockRejectedValueOnce(new Error("native unavailable"));
  await expect(f.run()).rejects.toThrow("native unavailable");
  expect(f.receipts).toEqual([]);
  expect(await f.run()).toEqual({admittedEntries: 1,hasMore: true});
  const attempts = f.storage.commitLiveUpdateJournal.mock.calls.map(([input]) => input);
  expect(attempts[1]).toEqual({...attempts[0],receivedAtMs: expect.any(Number)});
  expect(attempts[2]).toEqual({...attempts[0],receivedAtMs: expect.any(Number)});
});

it("does not acknowledge an admitted update before native application resolves", async () => {
  const f = fixture(1);
  let markEntered!: () => void, apply!: (ack: LiveUpdateHostApplicationAck) => void;
  const entered = new Promise<void>(resolve => {markEntered = resolve;});
  const applied = new Promise<LiveUpdateHostApplicationAck>(resolve => {apply = resolve;});
  let receipt!: LiveUpdateReceipt;
  f.applyThrough.mockImplementationOnce(async value => {receipt = value; markEntered(); return applied;});
  const running = f.run();
  await entered;
  expect(f.storage.commitLiveUpdateJournal).toHaveBeenCalledTimes(1);
  expect(f.receipts).toEqual([]);
  apply({...receipt,localYDocSequence: 1,applicationReplayed: false});
  expect(await running).toEqual({admittedEntries: 1,hasMore: true});
  expect(f.receipts).toEqual([receipt]);
});

it.each([
  {deliveryId: "different-delivery"}, {updateDigest: "f".repeat(64)}, {journalCursor: 99}, {acceptingHostEpoch: 2},
])("retains the local update when native proof has a different identity: %j", async changed => {
  const f = fixture(1);
  f.applyThrough.mockImplementationOnce(async receipt => ({...receipt,localYDocSequence: 1,applicationReplayed: true,...changed}) as LiveUpdateHostApplicationAck);
  await expect(f.run()).rejects.toThrow("ACK identity changed");
  expect(f.receipts).toEqual([]);
});
