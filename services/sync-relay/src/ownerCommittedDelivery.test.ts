import {beforeEach, expect, it, vi} from "vitest";
import {isDeepStrictEqual} from "node:util";
import {EngineRequestError, type EngineClient} from "@dohc/workspace-engine-client/daemon";
import {DaemonRefusalError} from "@dohc/workspace-engine-client";
import {OwnerKnownRefusals} from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import type {LiveUpdateHostApplicationAck, LiveUpdateReceipt} from "@dohc/live-session-contract/live-update-admission";
import {OwnerCommittedDelivery} from "./ownerCommittedDelivery";
import {drainOwnerOutbox} from "./ownerOutboxDelivery";

vi.mock("./ownerOutboxDelivery", () => ({drainOwnerOutbox: vi.fn()}));
beforeEach(() => {vi.mocked(drainOwnerOutbox).mockReset();});

const document = {workspaceId: "workspace",mainVersionId: "main",objectId: "object",lineageClaimId: "a".repeat(64)};
const binding = {...document,currentPath: "a.md",selectorPaths: ["a.md"],restoreFenceGeneration: 1};
const receipt = (cursor: number) => ({deliveryId: `delivery-${cursor}`,updateDigest: "b".repeat(64),journalCursor: cursor,acceptingHostEpoch: 1}) as LiveUpdateReceipt;
const ackFor = (value: LiveUpdateReceipt): LiveUpdateHostApplicationAck => ({...value,localYDocSequence: value.journalCursor,applicationReplayed: false});

function fixture({prefix = 0, owners = 1, maxEvents = 10, suffix = 0, adoptionCursor = 0} = {}) {
  let terminal: LiveUpdateReceipt | null = adoptionCursor ? receipt(adoptionCursor) : null, requestId = 0, current = true;
  let nativeTerminal = terminal;
  const journal = Array.from({length: prefix}, (_, index) => receipt(index + 1));
  const ownerEntries = Array.from({length: owners}, (_, index) => receipt(prefix + index + 1));
  const retained = [...ownerEntries], outboxAcks: LiveUpdateReceipt[] = [];
  const durable = new Map<string,LiveUpdateHostApplicationAck>();
  const assertCurrent = () => {if (!current) throw new Error("Owner standing changed.");};
  const capture = () => ({binding,assertCurrent,high: journal.at(-1)?.journalCursor ?? 0});
  const store = {
    existingOwnerDelivery: vi.fn(capture),
    openOwnerDelivery: vi.fn(capture),
    // The tip sequence moves with delivery; the adoption's own sequence never does.
    ownerDeliveryProgress: vi.fn(() => ({terminal,sequence: terminal?.journalCursor ?? 0,adoptionId: "adoption",adoptionSequence: 7,
      adoptionTerminal: adoptionCursor ? receipt(adoptionCursor) : null})),
    nextOwnerApplication: vi.fn((value: ReturnType<typeof capture>) => {
      const next = journal.find(row => row.journalCursor > (terminal?.journalCursor ?? 0) && row.journalCursor <= value.high);
      return next ? {metadata: {accepted: {receipt: next}}} : undefined;
    }),
    acknowledgeOwnerDeliveryApplication: vi.fn((value: ReturnType<typeof capture>, ack: LiveUpdateHostApplicationAck) => {
      const next = store.nextOwnerApplication(value)!;
      expect(ack).toMatchObject(next.metadata.accepted.receipt);
      terminal = next.metadata.accepted.receipt;
    }),
  };
  const storage = {createLiveCommittedDeliveryStore: () => store,
    getShare: () => ({workspaceId: document.workspaceId,shareId: "share",granterUserId: "owner"})};
  const persist = (value: LiveUpdateReceipt) => {
    if (value.journalCursor > (nativeTerminal?.journalCursor ?? 0)) nativeTerminal = value;
    const ack = ackFor(value); durable.set(value.deliveryId,ack); return ack;
  };
  const client = {
    sendRequest: vi.fn<EngineClient["sendRequest"]>(async input => {
      expect(input.method).toBe("liveApplication.register");
      return {id: input.id,result: {registrationId: 1}};
    }),
    sendLiveApplication: vi.fn<EngineClient["sendLiveApplication"]>(async (input,event) =>
      ({id: input.id,result: {status: "applied",ack: {...persist(event.metadata.accepted.receipt)}}})),
    readLiveApplicationAck: vi.fn<EngineClient["readLiveApplicationAck"]>(async (_input,identity) => {
      const ack = durable.get(identity.deliveryId); return ack ? {...ack,applicationReplayed: true} : null;
    }),
  };
  // The first retained entry stands for the adoption's seed: the pass reports
  // it applied once the host's ACK for it checks, or when nothing is queued.
  vi.mocked(drainOwnerOutbox).mockImplementation(async options => {
    let admittedEntries = 0;
    if (!retained.length) options.adoption.applied();
    for (const entry of [...retained]) {
      if (!journal.some(row => row.deliveryId === entry.deliveryId)) journal.push(entry);
      const ack = await options.applyThrough(entry);
      if (!ack) return {admittedEntries,hasMore: true};
      expect(ack).toMatchObject(entry);
      expect(durable.get(entry.deliveryId)).toMatchObject(entry);
      options.adoption.applied();
      retained.shift(); outboxAcks.push(entry); admittedEntries++;
    }
    for (let index = 0; index < suffix; index++) {
      const entry = receipt(prefix + owners + index + 1);
      if (!journal.some(row => row.deliveryId === entry.deliveryId)) journal.push(entry);
    }
    return {admittedEntries,hasMore: false};
  });
  const reconnect = () => new OwnerCommittedDelivery(storage as never,{} as never,{
    client: client as unknown as EngineClient,workspace: "handle",deadlineMs: 1_000,nextRequestId: () => ++requestId,
    host: {mode: "device",hostId: "host",hostEpoch: 1,instanceId: "instance",connectionId: "connection"} as never,
    bounds: {maxBytes: 10_000,maxEvents},
    ownerAdmission: {trustedAccount: (accountId: string) => ({accountId, name: "Owner name"}), shares: new Map([[document.workspaceId,"share"]]),maxEntriesPerDrain: 10,maxBytesPerDrain: 10_000,refusals: new OwnerKnownRefusals(),validate: () => ({} as never)},
  });
  return {consumer: reconnect(),reconnect,client,store,retained,outboxAcks,ownerEntries,persist,nativeTerminal: () => nativeTerminal,
    invalidate: () => {current = false;}};
}

it("holds the local owner entry until native application completes", async () => {
  const f = fixture();
  let markEntered!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => {markEntered = resolve;});
  const held = new Promise<void>(resolve => {release = resolve;});
  f.client.sendLiveApplication.mockImplementationOnce(async (input,event) => {
    markEntered(); await held;
    return {id: input.id,result: {status: "applied",ack: {...f.persist(event.metadata.accepted.receipt)}}};
  });
  const running = f.consumer.drain(document);
  await entered;
  expect(f.outboxAcks).toEqual([]);
  expect(f.retained).toEqual(f.ownerEntries);
  release();
  expect(await running).toMatchObject({kind: "done"});
  expect(f.outboxAcks).toEqual(f.ownerEntries);
  expect(drainOwnerOutbox).toHaveBeenCalledTimes(1);
});

it("returns pending without spinning or clearing an unapplied owner entry", async () => {
  const f = fixture();
  f.client.sendLiveApplication.mockResolvedValueOnce({id: 2,result: {status: "pending",reason: "retry"}});
  expect(await f.consumer.drain(document)).toMatchObject({kind: "pending",continueDrain: false});
  expect(f.client.sendLiveApplication).toHaveBeenCalledTimes(1);
  expect(f.outboxAcks).toEqual([]);
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(f.outboxAcks).toEqual(f.ownerEntries);
});

const declaration = {agentId: "trip-agent-hosted",onBehalfOf: null,depth: 0};

// The host refuses the chosen application calls as settlement-required, and
// every event declares an agent so a retry can be compared whole.
function settlementRequired(f: ReturnType<typeof fixture>, refusals: (call: number) => boolean,
  {materialized = true, failure}: {materialized?: boolean; failure?: Error} = {}) {
  const settled: (LiveUpdateReceipt | null)[] = [];
  const next = f.store.nextOwnerApplication.getMockImplementation()!;
  f.store.nextOwnerApplication.mockImplementation(value => {
    const event = next(value);
    if (!event) return undefined;
    const accepted = {...event.metadata.accepted};
    return {metadata: {accepted, authorSnapshot: [{kind: "agent", agentId: declaration.agentId, depth: declaration.depth}]}};
  });
  f.client.sendRequest.mockImplementation(async input => {
    if (input.method === "liveApplication.register") return {id: input.id,result: {registrationId: 1}};
    expect(input.method).toBe("liveApplication.settle");
    const terminal = (input.params as {terminalReceipt: LiveUpdateReceipt | null}).terminalReceipt;
    settled.push(terminal);
    if (failure) throw failure;
    if (!isDeepStrictEqual(terminal,f.nativeTerminal())) throw new Error("settlement terminal is not current");
    const previous = f.store.ownerDeliveryProgress().adoptionTerminal?.journalCursor ?? 0;
    const empty = (terminal?.journalCursor ?? 0) === previous;
    return {id: input.id,result: {status: "settled",settlement: {settlementId: empty ? null : `settlement-${settled.length}`,previousCursor: previous,
      terminalCursor: terminal?.journalCursor ?? 0,applicationCount: empty ? 0 : 1,localYDocSequence: 1,momentId: "moment-1",
      markdownDigest: "c".repeat(64),materialized,collectionReconcileRequired: false}}};
  });
  const apply = f.client.sendLiveApplication.getMockImplementation()!;
  let calls = 0;
  f.client.sendLiveApplication.mockImplementation(async (input,event) => refusals(++calls)
    ? {id: input.id,result: {status: "pending",reason: "settlement-required"}} : apply(input,event));
  return settled;
}
const offered = (f: ReturnType<typeof fixture>) => f.client.sendLiveApplication.mock.calls.map(([,event]) => event);
const declared = (cursor: number) => ({metadata: {accepted: {receipt: receipt(cursor)},authorSnapshot: [{kind: "agent", agentId: declaration.agentId, depth: declaration.depth}]}});

it("materializes a retained handover before draining or applying its next edit", async () => {
  const f = fixture({prefix: 7, adoptionCursor: 7}), settled = settlementRequired(f, () => false);
  const apply = f.client.sendLiveApplication.getMockImplementation()!;
  f.client.sendLiveApplication.mockImplementation(async (input,event) => {
    expect(settled).toEqual([receipt(7)]);
    return apply(input,event);
  });
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(f.outboxAcks).toEqual([receipt(8)]);
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(settled).toEqual([receipt(7)]);
});

it("keeps a handover's edits queued until its empty settle reaches the file", async () => {
  const f = fixture({prefix: 7, adoptionCursor: 7}), settled = settlementRequired(f, () => false, {materialized: false});
  expect(await f.consumer.drain(document)).toEqual({kind: "pending",reason: "Owner settlement has not reached the file.",continueDrain: false});
  expect(settled).toEqual([receipt(7)]);
  expect(drainOwnerOutbox).not.toHaveBeenCalled();
  expect(f.client.sendLiveApplication).not.toHaveBeenCalled();
  expect(f.outboxAcks).toEqual([]);
});

// Proves: a held handover settle applies nothing and asks for no further pass,
// stays held across a new consumer, and finishes once its owner wants the
// settlement, as after consenting to the held write.
it("keeps a handover's edits queued while its empty settle is held, then settles it once its owner wants it", async () => {
  const f = fixture({prefix: 7, adoptionCursor: 7});
  settlementRequired(f, () => false, {failure: new EngineRequestError(7,
    {code: "CONFLICT", message: "markdown-write-held", retry: "no"})});
  expect(await f.consumer.drain(document)).toEqual({kind: "pending",reason: "markdown-write-held",continueDrain: false});
  expect(await f.consumer.settle(document)).toEqual({kind: "pending", reason: "markdown-write-held"});
  const restarted = f.reconnect();
  expect(await restarted.drain(document)).toEqual({kind: "pending",reason: "markdown-write-held",continueDrain: false});
  expect(drainOwnerOutbox).not.toHaveBeenCalled();
  expect(f.client.sendLiveApplication).not.toHaveBeenCalled();
  expect(f.retained).toEqual(f.ownerEntries);
  const settled = settlementRequired(f, () => false);
  expect(await restarted.settleWanted(document)).toMatchObject({terminalCursor: 8, materialized: true});
  expect(settled).toEqual([receipt(7), receipt(8)]);
  expect(f.outboxAcks).toEqual([receipt(8)]);
  expect(f.retained).toEqual([]);
});

it("retries the handover settle after a lost response before draining any edits", async () => {
  const f = fixture({prefix: 7, adoptionCursor: 7});
  settlementRequired(f, () => false, {failure: new Error("response lost")});
  await expect(f.consumer.drain(document)).rejects.toThrow("response lost");
  expect(drainOwnerOutbox).not.toHaveBeenCalled();
  const settled = settlementRequired(f, () => false);
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(settled).toEqual([receipt(7)]);
  expect(f.outboxAcks).toEqual([receipt(8)]);
});

it.each([
  {source: "owner outbox", prefix: 7, owners: 1},
  {source: "collaborator", prefix: 8, owners: 0},
])("resumes a handover after losing the $source application reply and recovery ACK", async ({prefix, owners}) => {
  const f = fixture({prefix, owners, adoptionCursor: 7}), settled = settlementRequired(f, () => false);
  let recoveryLost = false;
  f.client.sendLiveApplication.mockImplementationOnce(async (_input, event) => {
    f.persist(event.metadata.accepted.receipt);
    recoveryLost = true;
    throw new Error("application response lost");
  });
  const readAck = f.client.readLiveApplicationAck.getMockImplementation()!;
  f.client.readLiveApplicationAck.mockImplementation(async (input, identity, signal) => {
    if (recoveryLost) {
      recoveryLost = false;
      throw new Error("recovery ACK unavailable");
    }
    return readAck(input, identity, signal);
  });
  await expect(f.consumer.drain(document)).rejects.toThrow("application response lost");
  expect(settled).toEqual([receipt(7)]);
  expect(f.nativeTerminal()).toEqual(receipt(8));
  expect(f.store.ownerDeliveryProgress().terminal).toEqual(receipt(7));
  expect(f.outboxAcks).toEqual([]);

  // The relay reconnects or restarts with no cached handover settlement.
  const resumed = f.reconnect();
  expect(resumed.adoptionSeedApplied(document)).toBe(false);
  expect(await resumed.drain(document)).toMatchObject({kind: "done", terminalReceipt: receipt(8)});
  expect(f.store.ownerDeliveryProgress().terminal).toEqual(receipt(8));
  expect(drainOwnerOutbox).toHaveBeenCalledTimes(2);
  expect(resumed.adoptionSeedApplied(document)).toBe(true);
  expect(f.outboxAcks).toEqual(f.ownerEntries);
  expect(f.client.sendLiveApplication).toHaveBeenCalledTimes(1);
  expect(settled).toEqual([receipt(7)]);
  expect(await resumed.settle(document)).toMatchObject({terminalCursor: 8});
  expect(settled).toEqual([receipt(7), receipt(8)]);
});

it("does not settle the handover cut while its recovery ACK is unavailable", async () => {
  const f = fixture({prefix: 8, owners: 0, adoptionCursor: 7}), settled = settlementRequired(f, () => false);
  f.persist(receipt(8));
  f.client.readLiveApplicationAck.mockRejectedValueOnce(new Error("recovery ACK unavailable"));
  await expect(f.consumer.drain(document)).rejects.toThrow("recovery ACK unavailable");
  expect(settled).toEqual([]);
  expect(drainOwnerOutbox).not.toHaveBeenCalled();
  expect(f.store.ownerDeliveryProgress().terminal).toEqual(receipt(7));
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done", terminalReceipt: receipt(8)});
});

it("does not record a recovered handover application after owner standing changes", async () => {
  const f = fixture({prefix: 8, owners: 0, adoptionCursor: 7}), settled = settlementRequired(f, () => false);
  const ack = f.persist(receipt(8));
  f.client.readLiveApplicationAck.mockImplementationOnce(async () => {
    f.invalidate();
    return ack;
  });
  await expect(f.consumer.drain(document)).rejects.toThrow("Owner standing changed");
  expect(settled).toEqual([]);
  expect(f.store.acknowledgeOwnerDeliveryApplication).not.toHaveBeenCalled();
  expect(drainOwnerOutbox).not.toHaveBeenCalled();
});

it("settles the applied interval when the host requires it and offers the identical owner event again", async () => {
  const f = fixture({prefix: 1}), settled = settlementRequired(f, call => call === 2);
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(settled).toEqual([receipt(1)]);
  expect(offered(f)).toEqual([declared(1),declared(2),declared(2)]);
  expect(f.outboxAcks).toEqual(f.ownerEntries);
});

it("settles again once a later interval applied and fills the host's coverage", async () => {
  const f = fixture({prefix: 1, owners: 2}), settled = settlementRequired(f, call => call === 2 || call === 4);
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(settled).toEqual([receipt(1),receipt(2)]);
  expect(offered(f)).toEqual([declared(1),declared(2),declared(2),declared(3),declared(3)]);
  expect(f.outboxAcks).toEqual(f.ownerEntries);
});

it("fails a pass whose host still requires settlement after settling everything it applied", async () => {
  const f = fixture({prefix: 1}), settled = settlementRequired(f, call => call >= 2);
  await expect(f.consumer.drain(document)).rejects.toThrow("The host still requires settlement after settling everything it applied.");
  expect(settled).toEqual([receipt(1)]);
  expect(offered(f)).toEqual([declared(1),declared(2),declared(2)]);
  expect(f.outboxAcks).toEqual([]);
  expect(f.retained).toEqual(f.ownerEntries);
});

it("waits for the next wake when the settlement's file write has not landed", async () => {
  const f = fixture({prefix: 1}), settled = settlementRequired(f, call => call === 2, {materialized: false});
  expect(await f.consumer.drain(document)).toEqual({kind: "pending",reason: "Owner settlement has not reached the file.",continueDrain: false});
  expect(settled).toEqual([receipt(1)]);
  expect(offered(f)).toEqual([declared(1),declared(2)]);
  expect(f.retained).toEqual(f.ownerEntries);
});

it("propagates a failed settlement and keeps the owner entry", async () => {
  const failure = new Error("settle failed");
  const f = fixture({prefix: 1}), settled = settlementRequired(f, call => call === 2, {failure});
  await expect(f.consumer.drain(document)).rejects.toBe(failure);
  expect(settled).toEqual([receipt(1)]);
  expect(offered(f)).toEqual([declared(1),declared(2)]);
  expect(f.outboxAcks).toEqual([]);
  expect(f.retained).toEqual(f.ownerEntries);
});

it("resumes a held file settlement without reconnecting or accepting the deliveries again", async () => {
  const f = fixture({prefix: 1, owners: 2});
  const settled = settlementRequired(f, () => false);
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(f.outboxAcks).toEqual([receipt(2), receipt(3)]);
  expect(f.store.acknowledgeOwnerDeliveryApplication.mock.calls.map(([, ack]) => ack.journalCursor)).toEqual([1, 2, 3]);
  f.client.sendRequest.mockRejectedValueOnce(new EngineRequestError(7,
    {code: "CONFLICT", message: "markdown-write-held", retry: "no"}));
  expect(await f.consumer.settle(document)).toEqual({kind: "pending", reason: "markdown-write-held"});
  expect(await f.consumer.settle(document)).toMatchObject({terminalCursor: 3, materialized: true});
  expect(settled).toEqual([receipt(3)]);
  expect(offered(f)).toEqual([declared(1), declared(2), declared(3)]);
  expect(f.store.acknowledgeOwnerDeliveryApplication).toHaveBeenCalledTimes(3);
  expect(f.outboxAcks).toEqual([receipt(2), receipt(3)]);
  expect(f.client.sendRequest.mock.calls.filter(([request]) => request.method === "liveApplication.register")).toHaveLength(1);
});

// Proves: an ordinary settle reuses this connection's settlement of the same
// terminal, and one its owner wants, as after consenting to a held write, asks the host again.
it("settles a terminal again when its owner wants it, past the settlement an ordinary settle reuses", async () => {
  const f = fixture({prefix: 1}), settled = settlementRequired(f, () => false);
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(await f.consumer.settle(document)).toMatchObject({terminalCursor: 2, materialized: true});
  expect(await f.consumer.settle(document)).toMatchObject({settlementId: "settlement-1", terminalCursor: 2});
  expect(settled).toEqual([receipt(2)]);
  expect(await f.consumer.settleWanted(document)).toMatchObject({settlementId: "settlement-2", terminalCursor: 2, materialized: true});
  expect(settled).toEqual([receipt(2), receipt(2)]);
});

// Proves: a held settlement of a terminal, or one that has not reached the file, ends
// the reuse of that terminal's earlier settlement, so the next ordinary settle asks the host again.
it.each(["held", "unmaterialized"] as const)("asks the host again once a settlement of a terminal it settled before comes back %s", async outcome => {
  const f = fixture({prefix: 1}), settled = settlementRequired(f, () => false);
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(await f.consumer.settle(document)).toMatchObject({settlementId: "settlement-1", terminalCursor: 2});
  if (outcome === "held") {
    f.client.sendRequest.mockRejectedValueOnce(new EngineRequestError(7,
      {code: "CONFLICT", message: "markdown-write-held", retry: "no"}));
    expect(await f.consumer.settleWanted(document)).toEqual({kind: "pending", reason: "markdown-write-held"});
  } else {
    const settle = f.client.sendRequest.getMockImplementation()!;
    f.client.sendRequest.mockImplementationOnce(async (input, signal) => {
      const reply = await settle(input, signal) as {id: number; result: {status: string; settlement: object}};
      return {...reply, result: {...reply.result, settlement: {...reply.result.settlement, materialized: false}}};
    });
    expect(await f.consumer.settleWanted(document)).toMatchObject({settlementId: "settlement-2", materialized: false});
  }
  expect(await f.consumer.settle(document)).toMatchObject({terminalCursor: 2, materialized: true});
  expect(settled).toHaveLength(outcome === "held" ? 2 : 3);
});

// Proves: a settle its owner wants that fails also ends the reuse, so the
// next ordinary settle asks the host again instead of returning the old settlement.
it("asks the host again after a settle its owner wanted fails", async () => {
  const f = fixture({prefix: 1}), settled = settlementRequired(f, () => false);
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(await f.consumer.settle(document)).toMatchObject({settlementId: "settlement-1", terminalCursor: 2});
  const failure = new Error("queue full");
  f.client.sendRequest.mockRejectedValueOnce(failure);
  await expect(f.consumer.settleWanted(document)).rejects.toBe(failure);
  expect(await f.consumer.settle(document)).toMatchObject({settlementId: "settlement-2", terminalCursor: 2, materialized: true});
  expect(settled).toEqual([receipt(2), receipt(2)]);
});

it("leaves an earlier unresolved file write to backoff without settling", async () => {
  const f = fixture({prefix: 1}), settled = settlementRequired(f, () => false);
  const overloaded = new DaemonRefusalError({code: "OVERLOADED",message: "settlement-materialization-pending",retry: "afterBackoff"}, undefined);
  const apply = f.client.sendLiveApplication.getMockImplementation()!;
  f.client.sendLiveApplication.mockImplementation(async (input,event) => {
    if (event.metadata.accepted.receipt.journalCursor === 2) throw overloaded;
    return apply(input,event);
  });
  await expect(f.consumer.drain(document)).rejects.toBe(overloaded);
  expect(settled).toEqual([]);
  expect(f.outboxAcks).toEqual([]);
  expect(f.retained).toEqual(f.ownerEntries);
});

it("retains a failed native application and retries its original receipt", async () => {
  const f = fixture();
  f.client.sendLiveApplication.mockRejectedValueOnce(new Error("native unavailable"));
  await expect(f.consumer.drain(document)).rejects.toThrow("native unavailable");
  expect(f.outboxAcks).toEqual([]);
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(f.client.sendLiveApplication.mock.calls.map(([,event]) => event.metadata.accepted.receipt)).toEqual([f.ownerEntries[0],f.ownerEntries[0]]);
});

it("recovers a lost application response from matching durable native evidence", async () => {
  const f = fixture();
  f.client.sendLiveApplication.mockImplementationOnce(async (_input,event) => {
    f.persist(event.metadata.accepted.receipt);
    throw new Error("response lost");
  });
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(f.client.sendLiveApplication).toHaveBeenCalledTimes(1);
  expect(f.store.acknowledgeOwnerDeliveryApplication).toHaveBeenCalledTimes(1);
  expect(f.outboxAcks).toEqual(f.ownerEntries);
});

it("shares the native event budget across each owner entry and the accepted suffix", async () => {
  const f = fixture({prefix: 1,owners: 2,maxEvents: 2,suffix: 1});
  expect(await f.consumer.drain(document)).toMatchObject({kind: "pending",continueDrain: true});
  expect(f.client.sendLiveApplication).toHaveBeenCalledTimes(2);
  expect(f.outboxAcks).toEqual([f.ownerEntries[0]]);
  expect(f.retained).toEqual([f.ownerEntries[1]]);
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(f.client.sendLiveApplication).toHaveBeenCalledTimes(4);
  expect(f.outboxAcks).toEqual(f.ownerEntries);
  expect(drainOwnerOutbox).toHaveBeenCalledTimes(2);
});

it("requires retained proof even when relay delivery progress already passed the owner entry", async () => {
  const f = fixture();
  f.client.readLiveApplicationAck.mockResolvedValueOnce(null);
  expect(await f.consumer.drain(document)).toMatchObject({kind: "pending"});
  expect(f.outboxAcks).toEqual([]);
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(f.client.sendLiveApplication).toHaveBeenCalledTimes(1);
  expect(f.outboxAcks).toEqual(f.ownerEntries);
});

it("does not recover or acknowledge after owner standing changes during application", async () => {
  const f = fixture();
  f.client.sendLiveApplication.mockImplementationOnce(async (_input,event) => {
    f.persist(event.metadata.accepted.receipt); f.invalidate(); throw new Error("response lost");
  });
  await expect(f.consumer.drain(document)).rejects.toThrow("Owner standing changed");
  expect(f.client.readLiveApplicationAck).not.toHaveBeenCalled();
  expect(f.outboxAcks).toEqual([]);
});

it("preserves the application error when reading its recovery ACK also fails", async () => {
  const f = fixture(), applicationError = new Error("application response lost");
  f.client.sendLiveApplication.mockRejectedValueOnce(applicationError);
  f.client.readLiveApplicationAck.mockRejectedValueOnce(new Error("recovery ACK unavailable"));
  await expect(f.consumer.drain(document)).rejects.toBe(applicationError);
  expect(f.client.readLiveApplicationAck).toHaveBeenCalledTimes(1);
  expect(f.outboxAcks).toEqual([]);
  expect(f.retained).toEqual(f.ownerEntries);
});

it("checks owner standing before returning an earlier application error", async () => {
  const f = fixture();
  f.client.sendLiveApplication.mockRejectedValueOnce(new Error("application response lost"));
  f.client.readLiveApplicationAck.mockImplementationOnce(async () => {
    f.invalidate(); throw new Error("recovery ACK unavailable");
  });
  await expect(f.consumer.drain(document)).rejects.toThrow("Owner standing changed");
  expect(f.outboxAcks).toEqual([]);
  expect(f.retained).toEqual(f.ownerEntries);
});

it("holds seed readiness until a pass proves it for the recorded adoption, then keeps it while later work is pending", async () => {
  const f = fixture({owners: 2});
  expect(f.consumer.adoptionSeedApplied(document)).toBe(false);
  // The seed's application is still pending on the host.
  f.client.sendLiveApplication.mockResolvedValueOnce({id: 2,result: {status: "pending",reason: "retry"}});
  expect(await f.consumer.drain(document)).toMatchObject({kind: "pending"});
  expect(f.consumer.adoptionSeedApplied(document)).toBe(false);
  // The pass names the adoption the relay recorded, not the delivery tip.
  expect(vi.mocked(drainOwnerOutbox).mock.calls[0]![0].adoption).toMatchObject({adoptionId: "adoption", sequence: 7});
  // The seed applies; the private entry behind it is still pending.
  let calls = 0;
  const apply = f.client.sendLiveApplication.getMockImplementation()!;
  f.client.sendLiveApplication.mockImplementation(async (input,event) => ++calls === 2
    ? {id: input.id,result: {status: "pending",reason: "retry"}} : apply(input,event));
  expect(await f.consumer.drain(document)).toMatchObject({kind: "pending"});
  expect(f.consumer.adoptionSeedApplied(document)).toBe(true);
  expect(f.outboxAcks).toEqual([f.ownerEntries[0]]);
});

it("rederives seed readiness on a new consumer and refuses a pass whose recorded adoption changed", async () => {
  const first = fixture();
  expect(await first.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(first.consumer.adoptionSeedApplied(document)).toBe(true);
  // A reconnect builds a new consumer, which knows nothing until its own pass.
  const second = fixture();
  expect(second.consumer.adoptionSeedApplied(document)).toBe(false);
  const progress = second.store.ownerDeliveryProgress.getMockImplementation()!;
  second.store.ownerDeliveryProgress.mockImplementationOnce(progress)
    .mockImplementationOnce(() => ({...progress(), adoptionId: "replaced"}));
  await expect(second.consumer.drain(document)).rejects.toThrow("Owner adoption changed.");
  expect(second.consumer.adoptionSeedApplied(document)).toBe(false);
  expect(await second.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(second.consumer.adoptionSeedApplied(document)).toBe(true);
});

it("schedules another owner pass after worker capacity returns even without prior progress", async () => {
  const f = fixture();
  vi.mocked(drainOwnerOutbox).mockResolvedValueOnce({admittedEntries: 0, hasMore: true, retryReady: true});
  expect(await f.consumer.drain(document)).toMatchObject({kind: "pending", continueDrain: true});
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done", continueDrain: false});
});

it("continues applying incoming accepted edits while the retained owner outbox is quarantined", async () => {
  const f = fixture({prefix: 1, owners: 1});
  const actual = await vi.importActual<typeof import("./ownerOutboxDelivery")>("./ownerOutboxDelivery");
  vi.mocked(drainOwnerOutbox).mockImplementation(actual.drainOwnerOutbox);
  const original = f.client.sendRequest.getMockImplementation()!;
  f.client.sendRequest.mockImplementation(async input => input.method === "liveApplication.ownerOutbox"
    ? {id: input.id, result: {outboxId: "outbox", pendingBytes: 1, state: "quarantined", retryDeliveryId: null}}
    : original(input));
  expect(await f.consumer.drain(document)).toMatchObject({kind: "done"});
  expect(f.client.sendLiveApplication).toHaveBeenCalledTimes(1);
  expect(f.client.sendLiveApplication.mock.calls[0]![1].metadata.accepted.receipt).toEqual(receipt(1));
  expect(f.outboxAcks).toEqual([]);
  expect(f.retained).toEqual(f.ownerEntries);
  expect(f.consumer.adoptionSeedApplied(document)).toBe(true);
});
