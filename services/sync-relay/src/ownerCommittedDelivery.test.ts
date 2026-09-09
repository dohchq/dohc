import {beforeEach, expect, it, vi} from "vitest";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
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
    ownerDeliveryProgress: vi.fn(() => ({terminal,sequence: terminal?.journalCursor ?? 0,adoptionId: "adoption"})),
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
  vi.mocked(drainOwnerOutbox).mockImplementation(async options => {
    let admittedEntries = 0;
    for (const entry of [...retained]) {
      if (!journal.some(row => row.deliveryId === entry.deliveryId)) journal.push(entry);
      const ack = await options.applyThrough(entry);
      if (!ack) return {admittedEntries,hasMore: true};
      expect(ack).toMatchObject(entry);
      expect(durable.get(entry.deliveryId)).toMatchObject(entry);
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
    ownerAdmission: {shares: new Map([[document.workspaceId,"share"]]),maxEntriesPerDrain: 10,maxBytesPerDrain: 10_000,validate: () => ({} as never)},
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
