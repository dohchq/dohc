import {describe, expect, it, vi} from "vitest";
import {LiveRestorePreparation, parseLiveRestoreConfig} from "./liveRestorePreparation";

const digest = "a".repeat(64);
const config = parseLiveRestoreConfig({maxBytes: 10_000, maxEvents: 100, aggregateBytes: 160_001,
  workingReserveBytes: 1, maxOperations: 1, validation: {maxStructVisits: 100, maxValueNodeVisits: 100,
    maxDecodedPayloadByteVisits: 100, maxStructClientGroupVisits: 100, maxDeleteClientGroupVisits: 100,
    maxDeleteIntervalVisits: 100, maxIndexOperations: 100}})!;

// Storage receipt validation is covered by its real-proposal tests. These cases
// exercise ordering and recovery when a transport or durable acknowledgement fails.
function fixture(phase: "relay-admitted" | "native-applied" | "settled" | "resumed" | null = null) {
  const settlement = {settlementId: "settlement", materialized: true};
  const resume = {operationId: "operation"};
  const base = {proposalDigest: digest, candidateDigest: "b".repeat(64), nativeSourceManifestDigest: "c".repeat(64),
    preparation: {fence: {operation: {origin: {kind: "owner"}}}, point: {journalCursor: 7}}, admitted: {accepted: {receipt: {journalCursor: 8}}},
    application: null, settlement, resume};
  let current = phase === null ? null : {...base, phase};
  const save = (next: Exclude<typeof phase, null>) => (current = {...base, phase: next});
  const store = {
    readStopRestoreReview: vi.fn((): {proposalDigest: string} | null => ({proposalDigest: digest})),
    readStopRestoreLifecycle: vi.fn(() => current),
    admitStopRestoreProposal: vi.fn(() => save("relay-admitted")),
    admitReviewedStopRestoreProposal: vi.fn(() => save("relay-admitted")),
    acknowledgeStopRestoreReplacement: vi.fn(() => save("native-applied")),
    acknowledgeStopRestoreSettlement: vi.fn(() => save("settled")),
    acknowledgeStopRestoreResume: vi.fn(() => save("resumed")),
  };
  const send = vi.fn(async (_request: unknown, operation: string, _bytes: Uint8Array, _limit: number, _signal?: AbortSignal) => ({
    response: {result: {status: operation}}, bytes: Buffer.from(JSON.stringify(operation === "resume" ? resume : operation === "settle" ? settlement : {applied: true})),
  }));
  const options = {store, lookup: {operationId: "operation", workspaceId: "workspace", ownerUserId: "owner"}, deliveryKind: "owner" as const,
    connection: {client: {sendLiveRestore: send}, workspace: "native-handle", host: {mode: "device" as const, hostId: "host", hostEpoch: 1,
      instanceId: "instance", connectionId: "connection"}, deadlineMs: 1000, nextRequestId: () => 1}};
  const driver = new LiveRestorePreparation(config);
  const run = (expected = digest, signal?: AbortSignal) => driver.complete({...options, signal} as unknown as Parameters<typeof driver.complete>[0], expected);
  const confirm = (expected = digest, signal?: AbortSignal) => driver.confirm({...options, signal} as unknown as Parameters<typeof driver.confirm>[0], expected);
  const review = (signal?: AbortSignal) => driver.review({...options, signal} as unknown as Parameters<typeof driver.review>[0]);
  return {store, send, run, save, options, base, confirm, review};
}

describe("owner restore review boundary", () => {
  it("rederives complete review before durable admission", async () => {
    const f = fixture();
    await expect(f.review()).resolves.toEqual({proposalDigest: digest});
    expect(f.store.admitStopRestoreProposal).not.toHaveBeenCalled();
    await expect(f.confirm()).resolves.toHaveProperty("kind", "resumed");
    expect(f.store.readStopRestoreReview).toHaveBeenCalledTimes(1);
    expect(f.store.admitReviewedStopRestoreProposal).toHaveBeenCalledTimes(1);
    expect(f.store.admitStopRestoreProposal).not.toHaveBeenCalled();
  });

  it.each(["refused", "cancelled"])("stops confirmation when review admission is %s", async damage => {
    const f = fixture(), abort = new AbortController();
    if (damage === "refused") f.store.admitReviewedStopRestoreProposal.mockImplementation(() => {throw Error("review refused");});
    if (damage === "cancelled") abort.abort(Error("cancelled"));
    await expect(f.confirm(digest, abort.signal)).rejects.toThrow();
    expect(f.store.admitStopRestoreProposal).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("retries an admitted confirmation without reopening the pre-admission review", async () => {
    const f = fixture("native-applied");
    f.store.readStopRestoreReview.mockImplementation(() => {throw Error("proposal is no longer readable before admission");});
    await expect(f.confirm()).resolves.toHaveProperty("kind", "resumed");
    expect(f.store.readStopRestoreReview).not.toHaveBeenCalled();
    expect(f.store.admitReviewedStopRestoreProposal).not.toHaveBeenCalled();
    await expect(f.confirm("d".repeat(64))).rejects.toThrow("retained proposal");
  });

  it("shares the host reservation with native completion until it closes", async () => {
    const f = fixture("relay-admitted");
    let release!: () => void;
    const pending = new Promise<void>(resolve => {release = resolve;});
    f.send.mockImplementationOnce(async () => {await pending;return {response: {result: {status: "apply"}}, bytes: Buffer.from("{}")};});
    const active = f.confirm();
    await expect(f.review()).rejects.toThrow("capacity is full");
    await expect(f.confirm()).rejects.toThrow("capacity is full");
    release();
    await active;
  });
});

describe("private restore continuation", () => {
  it.each([
    [null, ["apply", "settle", "resume"]],
    ["relay-admitted", ["apply", "settle", "resume"]],
    ["native-applied", ["settle", "resume"]],
    ["settled", ["resume"]],
    ["resumed", []],
  ] as const)("continues from durable %s without repeating recorded phases", async (phase, operations) => {
    const f = fixture(phase);
    await expect(f.run()).resolves.toEqual({kind: "resumed", proposalDigest: digest, receipt: f.base.resume});
    expect(f.send.mock.calls.map(call => call[1])).toEqual(operations);
    expect(f.store.admitStopRestoreProposal).toHaveBeenCalledTimes(phase === null ? 1 : 0);
    for (const [, operation, bytes, limit] of f.send.mock.calls) {
      const header = JSON.parse(Buffer.from(bytes).subarray(4).toString());
      expect(Buffer.from(bytes).readUInt32LE()).toBe(bytes.byteLength - 4);
      expect(header).toMatchObject({...f.base.preparation, candidateDigest: f.base.candidateDigest,
        nativeSourceManifestDigest: f.base.nativeSourceManifestDigest, admitted: f.base.admitted});
      expect(header.settlementId).toBe(operation === "resume" ? "settlement" : undefined);
      expect(limit).toBe(config.maxBytes);
    }
  });

  it("refuses a changed proposal digest before sending", async () => {
    const f = fixture("relay-admitted");
    await expect(f.run("d".repeat(64))).rejects.toThrow("retained proposal");
    expect(f.send).not.toHaveBeenCalled();
    expect(f.store.admitStopRestoreProposal).not.toHaveBeenCalled();
  });

  it("keeps native application success recoverable when relay acknowledgement fails", async () => {
    const f = fixture("relay-admitted");
    f.store.acknowledgeStopRestoreReplacement.mockImplementationOnce(() => {throw new Error("writer failed");});
    await expect(f.run()).rejects.toThrow("writer failed");
    expect(f.send.mock.calls.map(call => call[1])).toEqual(["apply"]);
    await expect(f.run()).resolves.toHaveProperty("kind", "resumed");
    expect(f.send.mock.calls.map(call => call[1])).toEqual(["apply", "apply", "settle", "resume"]);
  });

  it("does not resume until materialization is acknowledged", async () => {
    const f = fixture("native-applied");
    f.store.acknowledgeStopRestoreSettlement.mockImplementationOnce(() => f.save("native-applied"));
    await expect(f.run()).resolves.toHaveProperty("kind", "pending");
    expect(f.send.mock.calls.map(call => call[1])).toEqual(["settle"]);
    expect(f.store.acknowledgeStopRestoreResume).not.toHaveBeenCalled();
    await expect(f.run()).resolves.toHaveProperty("kind", "resumed");
    expect(f.send.mock.calls.map(call => call[1])).toEqual(["settle", "settle", "resume"]);
  });

  it("holds capacity until an interrupted native call finishes and records no late acknowledgement", async () => {
    const f = fixture("relay-admitted"), abort = new AbortController();
    let release!: () => void;
    const pending = new Promise<void>(resolve => {release = resolve;});
    f.send.mockImplementationOnce(async () => {await pending; return {response: {result: {status: "applied"}}, bytes: Buffer.from("{}")};});
    const first = f.run(digest, abort.signal);
    abort.abort(new Error("cancelled"));
    await expect(f.run()).rejects.toThrow("capacity is full");
    release();
    await expect(first).rejects.toThrow("cancelled");
    expect(f.store.acknowledgeStopRestoreReplacement).not.toHaveBeenCalled();
    await expect(f.run()).resolves.toHaveProperty("kind", "resumed");
  });

  it("snapshots the caller's host and lookup before awaiting native output", async () => {
    const f = fixture("relay-admitted");
    f.send.mockImplementationOnce(async () => {
      f.options.lookup.operationId = "mutated";
      f.options.connection.host.connectionId = "mutated";
      return {response: {result: {status: "applied"}}, bytes: Buffer.from("{}")};
    });
    await f.run();
    expect(f.store.acknowledgeStopRestoreReplacement).toHaveBeenCalledWith(expect.objectContaining({operationId: "operation",
      host: expect.objectContaining({connectionId: "connection"})}), {});
  });
});
