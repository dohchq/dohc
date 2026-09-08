import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { drainOwnerOutbox } from "./ownerOutboxDelivery.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture(maxEntriesPerDrain = 3, maxBytesPerDrain = 10_000) {
  const base = Buffer.alloc(1_048_576, 17);
  const binding = {workspaceId: "workspace",mainVersionId: "main",objectId: "object",lineageClaimId: sha(base),currentPath: "a.md",selectorPaths: ["a.md"],restoreFenceGeneration: 1};
  const entries = [1,3,7].map(sequence => ({sequence,appendKey: `append-${sequence}`,deliveryId: `delivery-${sequence}`,updateDigest: sha(Buffer.from([sequence])),byteLength: 1,createdAtMs: sequence}));
  const host = {hostId: "host",hostEpoch: 1,instanceId: "instance",connectionId: "connection"};
  const requests: Array<{part: string; bytes: number}> = [], receipts: unknown[] = [];
  let requestId = 0;
  const cursor = (snapshot: string, part: string, sequence = 0, offset = 0) => ({snapshot,part,sequence,offset});
  const client = {sendRequest: vi.fn(async (request: {id: number; method: string; params: Record<string, unknown>}) => {
    if (request.method === "liveApplication.ownerOutbox") return {id: request.id,result: {outboxId: "outbox",pendingBytes: entries.length,state: "active"}};
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
      bytes = Buffer.from(JSON.stringify({outboxId: "outbox",binding,baseUpdateDigest: sha(base),baseByteLength: base.length,state: "active",pendingBytes: entries.length,pendingEntryCount: entries.length,nextSequence: 8,oldestEntryAtMs: entries[0]?.createdAtMs ?? null,quarantineReason: null,observedBinding: null,firstEntryCursor}));
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
  return {requests,receipts,storage,run: () => drainOwnerOutbox({client: client as never,storage: storage as never,admission: {shares: new Map([["workspace","share"]]),maxEntriesPerDrain,maxBytesPerDrain,validate: () => ({} as never)},workspace: "handle",host: host as never,registrationId: 1,binding,nextRequestId: () => ++requestId,deadlineMs: 30_000,assertCurrent() {}})};
}

it("drains small edits when their immutable base exceeds the aggregate drain budget", async () => {
  const run = fixture();
  await run.run();
  expect(run.receipts).toHaveLength(3);
  expect(run.requests.filter(row => row.part === "base")).toHaveLength(0);
  expect(run.requests).toHaveLength(9);
  expect(run.requests.reduce((bytes, row) => bytes + row.bytes, 0)).toBeLessThan(10_000);
});

it("retains configured entry and byte limits without acknowledging unread updates", async () => {
  const one = fixture(1); await one.run(); expect(one.receipts).toHaveLength(1);
  const bounded = fixture(3, 1);
  await expect(bounded.run()).rejects.toThrow("byte budget exceeded");
  expect(bounded.receipts).toHaveLength(0);
  expect(bounded.storage.commitLiveUpdateJournal).not.toHaveBeenCalled();
});
