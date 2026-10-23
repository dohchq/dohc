import {LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES} from "@dohc/live-session-contract/live-frame";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
import {afterEach, expect, it, vi} from "vitest";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
import type {OwnerYDocOutbox} from "@dohc/workspace-engine-client";
import {OwnerKnownRefusals} from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import {createNamedLiveFrameSession} from "../../../../services/sync-relay/src/namedLiveFrameSession";
import {runNativeOwnerDeliveryPass} from "./nativeOwnerDelivery";
import {parseDesktopOwnerDeliveryConfig} from "./desktopOwnerDelivery";

// The real carrier and drainer run; only the socket, the relay host and the native outbox read are replaced.
const relay = vi.hoisted(() => ({submit: vi.fn(), connect: vi.fn(), acknowledge: vi.fn(), head: undefined as unknown, closers: [] as (() => void)[]}));
vi.mock("@dohc/sync-relay/owner-live-transport", () => ({connectOwnerLiveTransport: relay.connect}));
vi.mock("@dohc/workspace-engine-client", async original => {
  const actual = await original<typeof import("@dohc/workspace-engine-client")>();
  return {...actual, OwnerYDocOutbox: class extends actual.OwnerYDocOutbox {
    override readHead = async () => relay.head as Awaited<ReturnType<OwnerYDocOutbox["readHead"]>>;
    override acknowledge = relay.acknowledge;
  }};
});

const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64), currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1};
const config = parseDesktopOwnerDeliveryConfig({version: 1, nativeConfigPath: resolve("/native.json"), nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
  relayUrl: "https://relay.example.test", frames: {receive: {maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
    maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096},
  attemptTimeoutMs: 5000, retryDelayMs: 1000, documents: [{binding, relayDatabaseNamespace: "namespace", shareId: "share"}]});
const update = new Uint8Array([1, 2, 3]), updateDigest = createHash("sha256").update(update).digest("hex");
const agentDeclaration = {agentId: "trip-agent-hosted", onBehalfOf: "local", depth: 0};
const receipt = {deliveryId: "delivery", updateDigest, journalCursor: 2, acceptingHostEpoch: parseHostEpoch(1)};

function fixture() {
  relay.head = {outboxId: "outbox", binding, baseUpdate: new Uint8Array([0, 0]), baseUpdateDigest: "b".repeat(64), state: "active", pendingBytes: 3,
    oldestEntryAtMs: 0, quarantineReason: null, observedBinding: null, retryDeliveryId: null,
    entry: {sequence: 1, appendKey: "append", deliveryId: "delivery", update, updateDigest, byteLength: 3, createdAtMs: 0, agentDeclaration}};
  relay.acknowledge.mockResolvedValue({acknowledged: 1, pendingBytes: 0, oldestEntryAtMs: null});
  relay.submit.mockResolvedValue({result: "success", ack: {...receipt, localYDocSequence: 1, applicationReplayed: false}});
  relay.connect.mockImplementation(async input => {
    const server = createNamedLiveFrameSession({frames: config.frames, host: {hostEpoch: parseHostEpoch(1), invalidated: input.signal,
      assertCurrent: () => input.signal.throwIfAborted(), close() {}, submit: relay.submit,
      openSync: async () => ({binding, hostVector: new Uint8Array([0]), missingStateUpdate: new Uint8Array([0, 0]), appliedThroughJournalCursor: 1, close() {},
        nextApplied: (signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("closed")), {once: true}))}),
    }, transport: {send: async bytes => input.receive(bytes), close: input.closed}});
    relay.closers.push(() => server.close());
    return {send: async (bytes: Uint8Array) => server.receive(bytes), close: () => server.close()};
  });
  const client = {ownerYDocPrepareEnrollment: vi.fn(async () => ({status: "observed", draft: {outboxId: "outbox"}})),
    ownerYDocReadState: vi.fn(async () => ({revision: 1, acceptedCursor: 1, nativeHeadSequence: 1, stateVector: Buffer.from([0])})),
    ownerYDocApplyInitialSync: vi.fn(async () => ({revision: 2, acceptedCursor: 1, nativeHeadSequence: 1})),
    ownerYDocIsReceiptApplied: vi.fn(async () => true)};
  return client as typeof client & EngineClient;
}
afterEach(() => {for (const close of relay.closers.splice(0)) close(); vi.clearAllMocks();});

it("submits the queued agent declaration under the owner account from the same credential as the bearer", async () => {
  const client = fixture();
  expect(await runNativeOwnerDeliveryPass({client, workspaceHandle: "handle", config, refusals: new OwnerKnownRefusals(), document: config.documents[0]!,
    signal: new AbortController().signal, bearer: "owner-bearer", accountId: "owner-account", assertCurrent() {}})).toBe("acknowledged");
  expect(relay.connect.mock.calls[0]![0].bearer).toBe("owner-bearer");
  expect(relay.submit).toHaveBeenCalledWith({deliveryId: "delivery", updateDigest, updateBytes: update,
    authorContext: {kind: "account", accountId: "owner-account", agent: agentDeclaration}}, expect.any(AbortSignal));
  expect(relay.acknowledge).toHaveBeenCalledWith("outbox", [receipt]);
});

it("sends neither the bearer nor the account once the credential retires", async () => {
  const client = fixture();
  let retired = false;
  client.ownerYDocReadState.mockImplementationOnce(async () => {retired = true; return {revision: 1, acceptedCursor: 1, nativeHeadSequence: 1, stateVector: Buffer.from([0])};});
  expect(await runNativeOwnerDeliveryPass({client, workspaceHandle: "handle", config, refusals: new OwnerKnownRefusals(), document: config.documents[0]!, signal: new AbortController().signal,
    bearer: "owner-bearer", accountId: "owner-account", assertCurrent() {if (retired) throw new Error("retired");}})).toBe("retry");
  expect(relay.connect).not.toHaveBeenCalled();
  expect(relay.submit).not.toHaveBeenCalled();
});

it("keeps a refusal across recreated passes until its quarantine commits, and never submits it again", async () => {
  const sendRequest = vi.fn<EngineClient["sendRequest"]>()
    .mockRejectedValueOnce(new Error("Engine unavailable.")).mockRejectedValueOnce(new Error("Engine unavailable."))
    .mockImplementation(async request => {
      relay.head = {...relay.head as object, state: "quarantined", quarantineReason: "invalid-update"};
      return {id: request.id, result: {quarantined: true}};
    });
  const client = Object.assign(fixture(), {sendRequest}), refusals = new OwnerKnownRefusals();
  relay.submit.mockResolvedValue({result: "refused", reason: "invalid-update"});
  const pass = () => runNativeOwnerDeliveryPass({client, workspaceHandle: "handle", config, refusals, document: config.documents[0]!,
    signal: new AbortController().signal, bearer: "owner-bearer", accountId: "owner-account", assertCurrent() {}});
  for (let attempt = 0; attempt < 2; attempt++) await expect(pass()).rejects.toThrow();
  expect(await pass()).toBe("retry");
  expect(await pass()).toBe("frozen");
  expect(relay.submit).toHaveBeenCalledOnce();
  const writes = sendRequest.mock.calls.map(([request]) => request);
  expect(writes).toHaveLength(3);
  for (const write of writes) expect(write).toMatchObject({method: "ydoc.ownerOutbox.quarantine", workspace: "handle",
    params: {outboxId: "outbox", reason: "invalid-update", refusal: {deliveryId: "delivery", key: (writes[0]!.params as {refusal: {key: string}}).refusal.key}}});
});
