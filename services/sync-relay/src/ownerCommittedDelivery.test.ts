import {beforeEach, expect, it, vi} from "vitest";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
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

function fixture({prefix = 0, owners = 1, maxEvents = 10, suffix = 0} = {}) {
  let terminal: LiveUpdateReceipt | null = null, requestId = 0, current = true;
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
    ownerDeliveryProgress: vi.fn(() => ({terminal,sequence: terminal?.journalCursor ?? 0,adoptionId: "adoption",adoptionSequence: 7})),
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
  const consumer = new OwnerCommittedDelivery(storage as never,{} as never,{
    client: client as unknown as EngineClient,workspace: "handle",deadlineMs: 1_000,nextRequestId: () => ++requestId,
    host: {mode: "device",hostId: "host",hostEpoch: 1,instanceId: "instance",connectionId: "connection"} as never,
    bounds: {maxBytes: 10_000,maxEvents},
    ownerAdmission: {trustedAccount: (accountId: string) => ({accountId, name: "Owner name"}), shares: new Map([[document.workspaceId,"share"]]),maxEntriesPerDrain: 10,maxBytesPerDrain: 10_000,refusals: new OwnerKnownRefusals(),validate: () => ({} as never)},
  });
  return {consumer,client,store,retained,outboxAcks,ownerEntries,persist,invalidate: () => {current = false;}};
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
    return {id: input.id,result: {status: "settled",settlement: {settlementId: `settlement-${settled.length}`,previousCursor: 0,
      terminalCursor: terminal?.journalCursor ?? 0,applicationCount: terminal ? 1 : 0,localYDocSequence: 1,momentId: "moment-1",
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
