import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { drainOwnerOutbox, type OwnerOutboxAdmission } from "./ownerOutboxDelivery.js";
import { serviceOwnerTransport } from "./serviceOwnerTransport.js";
import type {LiveUpdateHostApplicationAck, LiveUpdateReceipt} from "@dohc/live-session-contract/live-update-admission";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// The key native gives a divergent adoption's seed (adoption.rs).
const seedKey = (adoptionId: string, sequence: number) => (updateDigest: string) =>
  `owner-adoption:${sha(Buffer.from(JSON.stringify([adoptionId, sequence, updateDigest])))}`;

// The delivery native gives an outbox's first entry (owner_outbox.rs).
const firstDelivery = (updateDigest: string) => `owner-delivery-${sha(Buffer.from(`outbox\0${1}\0${updateDigest}`))}`;
const serviceHost = {mode: "service", hostId: "host", hostEpoch: 1, instanceId: "instance", connectionId: "connection"};

/** `seedDigest` makes the first entry's delivery the one native gives a seed of that full state. */
function fixture(maxEntriesPerDrain = 3, maxBytesPerDrain = 10_000, agentDeclaration?: object, firstKey?: (updateDigest: string) => string, personEdit = true,
  seedDigest?: string) {
  const base = Buffer.alloc(1_048_576, 17);
  const binding = {workspaceId: "workspace",mainVersionId: "main",objectId: "object",lineageClaimId: sha(base),currentPath: "a.md",selectorPaths: ["a.md"],restoreFenceGeneration: 1};
  const entries = [1,3,7].map(sequence => ({sequence,
    appendKey: sequence === 1 && firstKey ? firstKey(sha(Buffer.from([sequence]))) : `append-${sequence}`,
    deliveryId: sequence === 1 && seedDigest ? firstDelivery(seedDigest) : `delivery-${sequence}`,updateDigest: sha(Buffer.from([sequence])),byteLength: 1,createdAtMs: sequence,
    ...(personEdit ? {personEdit: true} : {}),
    ...(sequence === 1 && agentDeclaration ? {agentDeclaration} : {})}));
  const applied = vi.fn();
  const host = {...serviceHost};
  const requests: Array<{part: string; bytes: number}> = [], receipts: unknown[] = [], order: string[] = [];
  const state = {value: "active"};
  const applyThrough = vi.fn(async (receipt: LiveUpdateReceipt): Promise<LiveUpdateHostApplicationAck | null> => {
    order.push("apply"); return {...receipt,localYDocSequence: receipt.journalCursor,applicationReplayed: true};
  });
  let requestId = 0;
  const cursor = (snapshot: string, part: string, sequence = 0, offset = 0) => ({snapshot,part,sequence,offset});
  // A native service transport sends the same calls under native names.
  const methods: Record<string, string> = {"ydoc.ownerOutbox.acknowledge": "liveApplication.acknowledgeOwnerOutbox", "ydoc.ownerOutbox.readPending": "liveApplication.readOwnerOutbox"};
  // Before a fresh adoption native names no adopted cursor and no outbox.
  const native = {activationId: "adoption", adopted: true};
  const client = {sendLiveOwnerAdoption: vi.fn(async (request: {id: number}) => {native.adopted = true; return {id: request.id, result: {status: "adopted", adoption: {}}};}),
    sendRequest: vi.fn(async (request: {id: number; method: string; params: Record<string, unknown>}) => {
    const method = methods[request.method] ?? request.method;
    if (method === "liveApplication.register") return {id: request.id,result: {registrationId: 1}};
    if (method === "liveApplication.ownerState") return {id: request.id,result: {adoptionId: native.activationId,expectedLocalSequence: 7,
      throughCursor: native.adopted ? 0 : null,outboxId: native.adopted ? "outbox" : null,pendingBytes: entries.length,outboxState: state.value}};
    if (method === "liveApplication.ownerOutbox") return {id: request.id,result: {outboxId: "outbox",pendingBytes: entries.length,state: state.value}};
    if (method === "liveApplication.acknowledgeOwnerOutbox") {
      const receipt = (request.params.receipts as Array<{deliveryId: string; updateDigest: string}>)[0]!;
      expect(receipt).toMatchObject({deliveryId: entries[0]!.deliveryId,updateDigest: entries[0]!.updateDigest});
      order.push("acknowledge"); receipts.push(receipt); entries.shift();
      return {id: request.id,result: {acknowledged: 1,pendingBytes: entries.length,oldestEntryAtMs: entries[0]?.createdAtMs ?? null}};
    }
    expect(method).toBe("liveApplication.readOwnerOutbox");
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
    resolveCurrentLiveDocumentBinding: () => ({kind: "current",host,binding,authority: {principalKind: "owner", principalId: "owner"}}),
    readLiveUpdateJournalCut: () => ({kind: "cut",cut: {checkpoint: {bytes: new Uint8Array([0,0])},suffix: []}}),
    commitLiveUpdateJournal: vi.fn((input: {metadata: {deliveryId: string; updateDigest: string}}) => {
      order.push("commit");
      return {result: {kind: "accepted",receipt: {deliveryId: input.metadata.deliveryId,updateDigest: input.metadata.updateDigest,journalCursor: receipts.length + 1,acceptingHostEpoch: 1}}};
    }),
  };
  const validate = vi.fn<OwnerOutboxAdmission["validate"]>(() => ({} as never));
  const admission: OwnerOutboxAdmission = {trustedAccount: accountId => ({accountId, name: "Owner name"}), shares: new Map([["workspace","share"]]),maxEntriesPerDrain,maxBytesPerDrain,validate};
  /**
   * A native service transport over this native outbox, registered and
   * adopted, `fresh` through its own adoption. Its capture names
   * `activationId` and a full state of `digest`.
   */
  const service = async ({activationId = "adoption", digest = sha(Buffer.from([1])), scope = {}, fresh = false}:
    {activationId?: string; digest?: string; scope?: {binding?: typeof binding; host?: object; storage?: object}; fresh?: boolean} = {}) => {
    native.activationId = activationId; native.adopted = !fresh;
    const transport = serviceOwnerTransport({client: client as never, workspace: "handle", binding: scope.binding ?? binding,
      storage: scope.storage ?? storage, host: (scope.host ?? host) as never, nextRequestId: () => ++requestId, assertCurrent() {},
      capture: async () => ({activationId, sessionId: "session", source: {nativeHeadSequence: 7, fullStateDigest: digest}}) as never});
    const request = {workspace: "handle", deadlineMs: 30_000};
    await transport.client.sendRequest({...request, id: ++requestId, method: "liveApplication.register", params: {binding: scope.binding ?? binding}});
    await transport.client.sendRequest({...request, id: ++requestId, method: "liveApplication.ownerState", params: {registrationId: 1}});
    if (fresh) await transport.client.sendLiveOwnerAdoption({...request, id: ++requestId, registrationId: 1, sessionId: "session"} as never,
      {adoptionId: activationId, expectedLocalSequence: 7, events: [], terminalReceipt: null} as never, {} as never);
    return transport;
  };
  return {requests,receipts,order,binding,storage,state,client,applyThrough,validate,applied,admission,service,
    run: (options: Partial<Parameters<typeof drainOwnerOutbox>[0]> = {}) => drainOwnerOutbox({client: client as never,storage: storage as never,admission,workspace: "handle",host: host as never,registrationId: 1,binding,
      adoption: {adoptionId: "adoption",sequence: 7,applied},nextRequestId: () => ++requestId,deadlineMs: 30_000,assertCurrent() {},applyThrough,...options})};
}

it("proves the adoption's seed applied only from the host's verified ACK, before the queue drops it", async () => {
  const f = fixture(1, 10_000, undefined, seedKey("adoption", 7));
  f.validate.mockReturnValueOnce({kind: "retry", reason: "admission-unavailable", waitForCapacity: async () => {}});
  expect(await f.run()).toEqual({admittedEntries: 0, hasMore: true, retryReady: true});
  f.applyThrough.mockResolvedValueOnce(null);
  expect(await f.run()).toEqual({admittedEntries: 0, hasMore: true});
  f.applyThrough.mockImplementationOnce(async receipt => ({...receipt,localYDocSequence: 1,applicationReplayed: true,deliveryId: "other"}) as LiveUpdateHostApplicationAck);
  await expect(f.run()).rejects.toThrow("ACK identity changed");
  expect(f.applied).not.toHaveBeenCalled();
  f.applied.mockImplementationOnce(() => expect(f.receipts).toEqual([]));
  expect(await f.run()).toEqual({admittedEntries: 1, hasMore: true});
  expect(f.applied).toHaveBeenCalledTimes(1);
  expect(f.receipts).toMatchObject([{deliveryId: "delivery-1"}]);
});

it("proves no seed waits when the head is later work, even while it is pending, or the queue is empty", async () => {
  const later = fixture(1);
  later.validate.mockReturnValueOnce({kind: "retry", reason: "admission-unavailable", waitForCapacity: async () => {}});
  expect(await later.run()).toEqual({admittedEntries: 0, hasMore: true, retryReady: true});
  expect(later.applied).toHaveBeenCalledTimes(1);
  const drained = fixture(3, 10_000, undefined, seedKey("adoption", 7));
  expect(await drained.run()).toEqual({admittedEntries: 3, hasMore: false});
  drained.applied.mockClear();
  expect(await drained.run()).toEqual({admittedEntries: 0, hasMore: false});
  expect(drained.applied).toHaveBeenCalledTimes(1);
});

const seedDigest = sha(Buffer.from([1]));
const seedFixture = (digest = seedDigest) => fixture(1, 10_000, undefined, seedKey("adoption", 7), false, digest);

it("acknowledges a native service seed before applying it, and proves its application only from the ACK", async () => {
  const f = seedFixture(), transport = await f.service();
  f.applyThrough.mockImplementationOnce(async receipt => {
    expect(f.order).toEqual(["commit", "acknowledge"]);
    expect(f.applied).not.toHaveBeenCalled();
    f.order.push("apply");
    return {...receipt, localYDocSequence: 1, applicationReplayed: false};
  });
  expect(await f.run({client: transport.client, seedDelivery: transport.seedDelivery()})).toEqual({admittedEntries: 1, hasMore: true});
  expect(f.order).toEqual(["commit", "acknowledge", "apply"]);
  expect(f.applied).toHaveBeenCalledTimes(1);
});

it("keeps a service seed's application for a later pass, which neither a later head nor an empty queue proves", async () => {
  const f = seedFixture(), transport = await f.service(), options = {client: transport.client, seedDelivery: transport.seedDelivery()};
  f.applyThrough.mockResolvedValueOnce(null);
  expect(await f.run(options)).toEqual({admittedEntries: 1, hasMore: true});
  expect(f.receipts).toMatchObject([{deliveryId: firstDelivery(seedDigest)}]);
  expect(await f.run(options)).toEqual({admittedEntries: 1, hasMore: true});
  expect(await f.run(options)).toEqual({admittedEntries: 1, hasMore: false});
  expect(f.order.slice(2)).toEqual(["commit", "apply", "acknowledge", "commit", "apply", "acknowledge"]);
  expect(await f.run(options)).toEqual({admittedEntries: 0, hasMore: false});
  expect(f.applied).not.toHaveBeenCalled();
});

it("keeps a service seed's application unproved when a later pass drains the queue to empty", async () => {
  const f = fixture(4, 10_000, undefined, seedKey("adoption", 7), false, seedDigest), transport = await f.service();
  const options = {client: transport.client, seedDelivery: transport.seedDelivery()};
  f.applyThrough.mockResolvedValueOnce(null);
  expect(await f.run(options)).toEqual({admittedEntries: 1, hasMore: true});
  expect(await f.run(options)).toEqual({admittedEntries: 2, hasMore: false});
  expect(f.applied).not.toHaveBeenCalled();
});

it("keeps the native service order for the same activation's resumed transport", async () => {
  const f = seedFixture(), first = await f.service(), resumed = await f.service();
  expect(first.seedDelivery()).not.toBe(resumed.seedDelivery());
  await f.run({client: resumed.client, seedDelivery: resumed.seedDelivery()});
  expect(f.order).toEqual(["commit", "acknowledge", "apply"]);
});

it("acknowledges a freshly adopted service seed first, though its adoption named no outbox yet", async () => {
  const f = seedFixture(), transport = await f.service({fresh: true});
  expect(f.client.sendLiveOwnerAdoption).toHaveBeenCalledTimes(1);
  await f.run({client: transport.client, seedDelivery: transport.seedDelivery()});
  expect(f.order).toEqual(["commit", "acknowledge", "apply"]);
});

type DrainOptions = Partial<Parameters<typeof drainOwnerOutbox>[0]>;
it.each<[string, string, (f: ReturnType<typeof seedFixture>) => Promise<DrainOptions>]>([
  ["no capability, as a device host", seedDigest, async () => ({})],
  ["copied public values", seedDigest, async f => ({client: (await f.service()).client, seedDelivery: {activationId: "adoption"}})],
  ["a serialized capability", seedDigest, async f => {
    const t = await f.service(); return {client: t.client, seedDelivery: JSON.parse(JSON.stringify(t.seedDelivery()))};
  }],
  ["a reconstructed capability", seedDigest, async f => {
    const t = await f.service(); return {client: t.client, seedDelivery: Object.freeze({...t.seedDelivery()!})};
  }],
  ["a cloned capability", seedDigest, async f => {
    const t = await f.service(); return {client: t.client, seedDelivery: structuredClone(t.seedDelivery())};
  }],
  ["pending activation access alone", seedDigest, async f => ({client: (await f.service()).client,
    admission: {...f.admission, activation: {activationId: "adoption"}}})],
  ["another activation", seedDigest, async f => {
    const t = await f.service({activationId: "other"}); return {client: t.client, seedDelivery: t.seedDelivery()};
  }],
  ["another seed delivery", "f".repeat(64), async f => {
    const t = await f.service(); return {client: t.client, seedDelivery: t.seedDelivery()};
  }],
  ["another seed digest", "f".repeat(64), async f => {
    const t = await f.service({digest: "f".repeat(64)}); return {client: t.client, seedDelivery: t.seedDelivery()};
  }],
  ["another binding", seedDigest, async f => {
    const t = await f.service({scope: {binding: {...f.binding, restoreFenceGeneration: 2}}}); return {client: t.client, seedDelivery: t.seedDelivery()};
  }],
  ["another host", seedDigest, async f => {
    const t = await f.service({scope: {host: {...serviceHost, connectionId: "other"}}}); return {client: t.client, seedDelivery: t.seedDelivery()};
  }],
  ["another storage", seedDigest, async f => {
    const t = await f.service({scope: {storage: {}}}); return {client: t.client, seedDelivery: t.seedDelivery()};
  }],
  ["another transport", seedDigest, async f => {
    const issuer = await f.service(), other = await f.service(); return {client: other.client, seedDelivery: issuer.seedDelivery()};
  }],
])("applies the seed before acknowledging it with %s", async (_name, digest, options) => {
  const f = seedFixture(digest);
  expect(await f.run(await options(f))).toEqual({admittedEntries: 1, hasMore: true});
  expect(f.order).toEqual(["commit", "apply", "acknowledge"]);
  expect(f.applied).toHaveBeenCalledTimes(1);
});

it.each([["another adoption", seedKey("other", 7)], ["another adopted head", seedKey("adoption", 6)]])(
  "refuses a seed key from %s without delivering it", async (_name, key) => {
    const f = fixture(1, 10_000, undefined, key);
    await expect(f.run()).rejects.toThrow("Owner outbox holds another adoption's seed.");
    expect(f.applied).not.toHaveBeenCalled();
    expect(f.storage.commitLiveUpdateJournal).not.toHaveBeenCalled();
    expect(f.applyThrough).not.toHaveBeenCalled();
  });

it("drains small edits when their immutable base exceeds the aggregate drain budget", async () => {
  const run = fixture();
  expect(await run.run()).toEqual({admittedEntries: 3, hasMore: false});
  expect(run.receipts).toHaveLength(3);
  expect(run.requests.filter(row => row.part === "base")).toHaveLength(0);
  expect(run.requests).toHaveLength(9);
  expect(run.requests.reduce((bytes, row) => bytes + row.bytes, 0)).toBeLessThan(10_000);
});

it("submits the agent each entry declared and none for an entry that declared none", async () => {
  const agentDeclaration = {agentId: "trip-agent-ü",onBehalfOf: "local-person",depth: 2};
  const run = fixture(2, 10_000, agentDeclaration);
  expect(await run.run()).toEqual({admittedEntries: 2, hasMore: true});
  const [first, second] = run.storage.commitLiveUpdateJournal.mock.calls.map(([input]) => (input as {metadata: Record<string, unknown>}).metadata);
  expect(first).toMatchObject({deliveryId: "delivery-1",authorContext: {kind: "account",accountId: "owner",agent: agentDeclaration}});
  expect(first).not.toHaveProperty("agentDeclaration");
  expect(second).toMatchObject({deliveryId: "delivery-3", authorContext: {kind: "account", accountId: "owner"}});
  expect(second).not.toHaveProperty("agentDeclaration");
  expect(second!.authorContext).not.toHaveProperty("agent");
  await expect(fixture(1, 10_000, {agentId: "",onBehalfOf: null,depth: 0}).run()).rejects.toThrow();
});

it.each([undefined, {agentId: "trip-agent", onBehalfOf: null, depth: 0}])("uses authenticated account names and refuses another account's metadata (%j)", async declared => {
  const f = fixture(1, 10_000, declared);
  f.admission.trustedAccount = vi.fn(async accountId => ({accountId, name: "Owner name"}));
  await f.run();
  expect(f.admission.trustedAccount).toHaveBeenCalledWith("owner");
  expect(f.storage.commitLiveUpdateJournal.mock.calls[0]![0]).toMatchObject({trustedAccount: {accountId: "owner", name: "Owner name"},
    metadata: {authorContext: {kind: "account", accountId: "owner", ...(declared ? {agent: {agentId: "trip-agent", depth: 0}} : {})}}});
  const changed = fixture(1, 10_000, declared);
  changed.admission.trustedAccount = () => ({accountId: "another", name: "Another"});
  await expect(changed.run()).rejects.toThrow("Owner account changed.");
  expect(changed.storage.commitLiveUpdateJournal).not.toHaveBeenCalled();
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

it.each(["provenance-refused", "delivery-conflict"])("quarantines a terminal %s without acknowledging or retrying it", async reason => {
  const f = fixture(1);
  f.storage.commitLiveUpdateJournal.mockReturnValue({result: {kind: "refused", reason}} as never);
  const original = f.client.sendRequest.getMockImplementation()!;
  f.client.sendRequest.mockImplementation(async request => {
    if (request.method === "liveApplication.quarantineOwnerOutbox") {
      expect(request.params).toEqual({registrationId: 1, reason});
      f.state.value = "quarantined";
      return {id: request.id, result: {state: "quarantined"}} as never;
    }
    return original(request);
  });
  expect(await f.run()).toEqual({admittedEntries: 0, hasMore: false});
  expect(f.state.value).toBe("quarantined");
  expect(f.receipts).toEqual([]);
  f.storage.commitLiveUpdateJournal.mockClear();
  expect(await f.run()).toEqual({admittedEntries: 0, hasMore: false});
  expect(f.storage.commitLiveUpdateJournal).not.toHaveBeenCalled();
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
  expect(await quarantined.run()).toEqual({admittedEntries: 0, hasMore: false});
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

it("waits for worker capacity without committing or acknowledging and resumes the same head", async () => {
  const f = fixture(1); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => {entered = resolve;});
  const capacity = new Promise<void>(resolve => {release = resolve;});
  f.validate.mockReturnValueOnce({kind: "retry", reason: "admission-unavailable", waitForCapacity: () => {entered(); return capacity;}});
  const first = f.run(); await waiting;
  expect(f.storage.commitLiveUpdateJournal).not.toHaveBeenCalled();
  expect(f.receipts).toEqual([]);
  release(); expect(await first).toEqual({admittedEntries: 0, hasMore: true, retryReady: true});
  expect(await f.run()).toEqual({admittedEntries: 1, hasMore: true});
  expect(f.receipts).toMatchObject([{deliveryId: "delivery-1"}]);
});

it.each(["seed", "automation", "actorless", "Collection adoption", "owner delivery"])("leaves %s entries unattributed", async () => {
  const f = fixture(1, 10_000, undefined, undefined, false);
  await f.run();
  expect(f.storage.commitLiveUpdateJournal.mock.calls[0]![0].metadata).not.toHaveProperty("authorContext");
});
it("does not submit a credited entry during a temporary account lookup failure", async () => {
  const f = fixture(1);
  f.admission.trustedAccount = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue({accountId: "owner", name: "Owner name"});
  expect(await f.run()).toEqual({admittedEntries: 0, hasMore: true});
  expect(f.storage.commitLiveUpdateJournal).not.toHaveBeenCalled();
  await f.run();
  expect(f.storage.commitLiveUpdateJournal.mock.calls[0]![0]).toMatchObject({metadata: {authorContext: {kind: "account", accountId: "owner"}}});
});

it("keeps submitted context when an admitted head retries across a missing account lookup", async () => {
  const f = fixture(1);
  f.applyThrough.mockResolvedValueOnce(null);
  f.admission.trustedAccount = vi.fn().mockResolvedValueOnce({accountId: "owner", name: "Owner name"})
    .mockResolvedValueOnce(undefined).mockResolvedValue({accountId: "owner", name: "Owner name"});
  expect(await f.run()).toEqual({admittedEntries: 0, hasMore: true});
  const first = f.storage.commitLiveUpdateJournal.mock.calls[0]![0].metadata;
  expect(await f.run()).toEqual({admittedEntries: 0, hasMore: true});
  expect(f.storage.commitLiveUpdateJournal).toHaveBeenCalledTimes(1);
  await f.run();
  expect(f.storage.commitLiveUpdateJournal.mock.calls[1]![0].metadata).toEqual(first);
});
