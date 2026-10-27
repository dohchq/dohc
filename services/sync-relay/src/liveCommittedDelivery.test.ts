import {expect, it, vi} from "vitest";
import {EngineRequestError, type EngineClient} from "@dohc/workspace-engine-client/daemon";
import {DaemonRefusalError} from "@dohc/workspace-engine-client";
import type {LiveUpdateHostApplicationAck, LiveUpdateReceipt} from "@dohc/live-session-contract/live-update-admission";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {LiveCommittedDelivery} from "./liveCommittedDelivery";

const document = {workspaceId: "workspace",mainVersionId: "main",objectId: "object",lineageClaimId: "a".repeat(64)};
const binding = {...document,currentPath: "a.md",selectorPaths: ["a.md"],restoreFenceGeneration: 1};
const declaration = {agentId: "trip-agent-hosted",onBehalfOf: null,depth: 0};
const receipt = (cursor: number) => ({deliveryId: `delivery-${cursor}`,updateDigest: "b".repeat(64),journalCursor: cursor,acceptingHostEpoch: 1}) as LiveUpdateReceipt;
const declared = (cursor: number) => ({metadata: {accepted: {receipt: receipt(cursor),binding},authorSnapshot: [{kind: "agent", agentId: declaration.agentId, depth: declaration.depth}]}});

// A service host's committed delivery of `events` declared changes. The host
// refuses the chosen application calls as settlement-required.
function fixture(events: number, refusals: (call: number) => boolean,
  {materialized = true, failure, nativeHeadSequence = 1}: {materialized?: boolean; failure?: Error; nativeHeadSequence?: number} = {}) {
  let applied: LiveUpdateReceipt | null = null, requestId = 0, calls = 0;
  const store = {
    open: vi.fn(() => ({baseline: {binding}})),
    openSettlement: vi.fn(() => ({})),
    settlement: vi.fn(() => ({binding,terminalReceipt: applied})),
    close: vi.fn(),
    next: vi.fn(() => {
      const cursor = (applied?.journalCursor ?? 0) + 1;
      return cursor > events ? {kind: "done",terminalReceipt: applied} : {kind: "next",admitted: declared(cursor),predecessor: applied};
    }),
    acknowledge: vi.fn((_drain: unknown, predecessor: LiveUpdateReceipt | null, ack: LiveUpdateHostApplicationAck) => {
      expect(predecessor).toEqual(applied);
      applied = receipt(ack.journalCursor);
    }),
  };
  const settled: (LiveUpdateReceipt | null)[] = [];
  const client = {
    sendRequest: vi.fn<EngineClient["sendRequest"]>(async input => {
      if (input.method === "liveApplication.register") return {id: input.id,result: {registrationId: 7}};
      expect(input.method).toBe("liveApplication.settle");
      const params = input.params as {registrationId: number; terminalReceipt: LiveUpdateReceipt | null};
      expect(params.registrationId).toBe(7);
      settled.push(params.terminalReceipt);
      if (failure) throw failure;
      return {id: input.id,result: {status: "settled",settlement: {settlementId: `settlement-${settled.length}`,previousCursor: 0,
        terminalCursor: params.terminalReceipt?.journalCursor ?? 0,applicationCount: params.terminalReceipt ? 1 : 0,localYDocSequence: nativeHeadSequence,
        momentId: "moment-1",markdownDigest: "c".repeat(64),materialized,collectionReconcileRequired: false}}};
    }),
    sendLiveApplication: vi.fn<EngineClient["sendLiveApplication"]>(async (input,event) => refusals(++calls)
      ? {id: input.id,result: {status: "pending",reason: "settlement-required"}}
      : {id: input.id,result: {status: "applied",ack: {...event.metadata.accepted.receipt,localYDocSequence: calls,applicationReplayed: false}}}),
  };
  const consumer = new LiveCommittedDelivery({createLiveCommittedDeliveryStore: () => store} as never,{} as never,{
    client: client as unknown as EngineClient,workspace: "handle",deadlineMs: 1_000,nextRequestId: () => ++requestId,
    host: {mode: "device",hostId: "host",hostEpoch: parseHostEpoch(1),instanceId: "instance",connectionId: "connection"},
  });
  const offered = () => client.sendLiveApplication.mock.calls.map(([,event]) => event);
  return {consumer,client,store,settled,offered, acceptThrough: (cursor: number) => { events = cursor; }};
}

it("settles through the last applied change once, then offers the identical declared change again", async () => {
  const f = fixture(2, call => call === 2);
  expect(await f.consumer.drain(document)).toEqual({kind: "done",terminalReceipt: receipt(2)});
  expect(f.settled).toEqual([receipt(1)]);
  expect(f.offered()).toEqual([declared(1),declared(2),declared(2)]);
  expect(f.store.close).toHaveBeenCalledTimes(1);
});

it("settles before the first change when the host requires it with nothing applied", async () => {
  const f = fixture(1, call => call === 1);
  expect(await f.consumer.drain(document)).toEqual({kind: "done",terminalReceipt: receipt(1)});
  expect(f.settled).toEqual([null]);
  expect(f.offered()).toEqual([declared(1),declared(1)]);
});

it("settles again once a later change applied and fills the host's coverage", async () => {
  const f = fixture(3, call => call === 2 || call === 4);
  expect(await f.consumer.drain(document)).toEqual({kind: "done",terminalReceipt: receipt(3)});
  expect(f.settled).toEqual([receipt(1),receipt(2)]);
  expect(f.offered()).toEqual([declared(1),declared(2),declared(2),declared(3),declared(3)]);
});

it("fails a pass whose host still requires settlement after settling everything it applied", async () => {
  const f = fixture(2, call => call >= 2);
  await expect(f.consumer.drain(document)).rejects.toThrow("The host still requires settlement after settling everything it applied.");
  expect(f.settled).toEqual([receipt(1)]);
  expect(f.offered()).toEqual([declared(1),declared(2),declared(2)]);
  expect(f.store.close).toHaveBeenCalledTimes(1);
});

it("waits when the settlement's file write has not landed", async () => {
  const f = fixture(2, call => call === 2, {materialized: false});
  expect(await f.consumer.drain(document)).toEqual({kind: "pending",reason: "settlement-materialization-pending"});
  expect(f.settled).toEqual([receipt(1)]);
  expect(f.offered()).toEqual([declared(1),declared(2)]);
});

it("propagates a failed settlement", async () => {
  const failure = new Error("settle failed");
  const f = fixture(2, call => call === 2, {failure});
  await expect(f.consumer.drain(document)).rejects.toBe(failure);
  expect(f.offered()).toEqual([declared(1),declared(2)]);
  expect(f.store.close).toHaveBeenCalledTimes(1);
});

it("keeps the accepted prefix when author-capacity settlement holds the file save", async () => {
  const failure = new EngineRequestError(1, {code: "CONFLICT",message: "markdown-write-held",retry: "no"});
  const f = fixture(2, call => call === 2, {failure});
  expect(await f.consumer.drain(document)).toEqual({kind: "pending",reason: "markdown-write-held"});
  expect(f.store.acknowledge).toHaveBeenCalledTimes(1);
  expect(f.offered()).toEqual([declared(1),declared(2)]);
  expect(f.settled).toEqual([receipt(1)]);
  expect(f.store.close).toHaveBeenCalledTimes(1);
});

it("returns explicit settlement pending without a covering receipt or another accepted edit", async () => {
  const f = fixture(1, () => false);
  await f.consumer.drain(document);
  f.client.sendRequest.mockRejectedValueOnce(new EngineRequestError(2,
    {code: "CONFLICT",message: "markdown-write-held",retry: "no"}));
  expect(await f.consumer.settle(document)).toEqual({kind: "pending",reason: "markdown-write-held"});
  expect(f.store.acknowledge).toHaveBeenCalledTimes(1);
  expect(f.offered()).toEqual([declared(1)]);
});

it("leaves an earlier unresolved file write to backoff without settling", async () => {
  const f = fixture(2, () => false);
  const overloaded = new DaemonRefusalError({code: "OVERLOADED",message: "settlement-materialization-pending",retry: "afterBackoff"}, undefined);
  const apply = f.client.sendLiveApplication.getMockImplementation()!;
  f.client.sendLiveApplication.mockImplementation(async (input,event) => {
    if (event.metadata.accepted.receipt.journalCursor === 2) throw overloaded;
    return apply(input,event);
  });
  await expect(f.consumer.drain(document)).rejects.toBe(overloaded);
  expect(f.settled).toEqual([]);
  expect(f.store.acknowledge).toHaveBeenCalledTimes(1);
});

it("resumes a held settlement without another delivery or registration", async () => {
  const f = fixture(2, () => false);
  await f.consumer.drain(document);
  f.client.sendRequest.mockRejectedValueOnce(new EngineRequestError(20,
    {code: "CONFLICT", message: "markdown-write-held", retry: "no"}));
  expect(await f.consumer.settle(document)).toEqual({kind: "pending", reason: "markdown-write-held"});
  const accepted = f.offered();
  expect(await f.consumer.settle(document)).toMatchObject({previousCursor: 0, terminalCursor: 2, materialized: true});
  expect(f.offered()).toEqual(accepted);
  expect(f.store.acknowledge.mock.calls.map(([, , ack]) => ack.journalCursor)).toEqual([1, 2]);
  expect(f.client.sendRequest.mock.calls.filter(([request]) => request.method === "liveApplication.register")).toHaveLength(1);
});

it("covers an older held terminal with the latest accepted prefix and the private native tail", async () => {
  const f = fixture(1, () => false, {nativeHeadSequence: 7});
  await f.consumer.drain(document);
  f.client.sendRequest.mockRejectedValueOnce(new EngineRequestError(20,
    {code: "CONFLICT", message: "markdown-write-held", retry: "no"}));
  expect(await f.consumer.settle(document)).toEqual({kind: "pending", reason: "markdown-write-held"});
  f.acceptThrough(3);
  await f.consumer.drain(document);
  expect(f.store.acknowledge.mock.calls.map(([, , ack]) => ack.journalCursor)).toEqual([1, 2, 3]);
  const applicationCount = f.client.sendLiveApplication.mock.calls.length;
  expect(await f.consumer.settle(document)).toMatchObject({previousCursor: 0, terminalCursor: 3,
    localYDocSequence: 7, materialized: true});
  expect(f.settled).toEqual([receipt(3)]);
  expect(f.client.sendLiveApplication).toHaveBeenCalledTimes(applicationCount);
  expect(f.offered()).toEqual([declared(1), declared(2), declared(3)]);
  // Native owns the private tail. The relay supplies only its accepted terminal.
  expect(f.client.sendRequest.mock.lastCall?.[0].params).toEqual({registrationId: 7, terminalReceipt: receipt(3)});
  expect(f.client.sendRequest.mock.calls.filter(([request]) => request.method === "liveApplication.register")).toHaveLength(1);
});

it("refuses a stale covering receipt rather than completing a newer accepted terminal", async () => {
  const f = fixture(3, () => false);
  await f.consumer.drain(document);
  f.client.sendRequest.mockResolvedValueOnce({id: 20, result: {status: "settled", settlement: {
    settlementId: "stale", previousCursor: 0, terminalCursor: 2, applicationCount: 2, localYDocSequence: 2,
    momentId: "old-moment", markdownDigest: "c".repeat(64), materialized: true, collectionReconcileRequired: false,
  }}});
  await expect(f.consumer.settle(document)).rejects.toThrow("Native settlement coverage mismatch.");
  expect(f.store.acknowledge).toHaveBeenCalledTimes(3);
  expect(f.offered()).toEqual([declared(1), declared(2), declared(3)]);
  expect(await f.consumer.settle(document)).toMatchObject({terminalCursor: 3});
});
