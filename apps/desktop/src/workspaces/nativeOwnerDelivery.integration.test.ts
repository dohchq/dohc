import {createHash} from "node:crypto";
import {resolve} from "node:path";
import {afterEach, expect, it, vi} from "vitest";
import {OwnerYDocOutbox} from "@dohc/workspace-engine-client";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
import {OwnerKnownRefusals} from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import type {connectOwnerLiveTransport} from "@dohc/sync-relay/owner-live-transport";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {createNamedLiveFrameSession, type NamedFrameHostSession} from "../../../../services/sync-relay/src/namedLiveFrameSession";
import {deriveLiveAuthorSnapshot} from "../../../../services/sync-relay/src/storage/liveAuthorSnapshot";
import {liveContentAuthors} from "../../../../services/sync-relay/src/storage/liveAuthorWindow";
import type {StorageContext} from "../../../../services/sync-relay/src/storage/context";
import {runNativeOwnerDeliveryPass} from "./nativeOwnerDelivery";
import {parseDesktopOwnerDeliveryConfig} from "./desktopOwnerDelivery";

const transport = vi.hoisted(() => ({connect: vi.fn<typeof connectOwnerLiveTransport>()}));
vi.mock("@dohc/sync-relay/owner-live-transport", () => ({connectOwnerLiveTransport: transport.connect}));
const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
  currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 1};
const frames = {receive: {maxFrameBytes: 4096, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
  maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096};
const configValue = {version: 1, nativeConfigPath: resolve("test", "native.json"), nativeClient: {aggregateBytes: 100_000_000, maxUploads: 2},
  relayUrl: "https://relay.example.test", frames, attemptTimeoutMs: 10_000, retryDelayMs: 1000,
  documents: [{binding, relayDatabaseNamespace: "namespace", shareId: "share"}]};
const config = parseDesktopOwnerDeliveryConfig(configValue);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const update = Uint8Array.of(1,2,3), baseUpdate = Uint8Array.of(0,0);
const agentDeclaration = {agentId: "hosted-agent", onBehalfOf: "principal", depth: 2};
const receipt = {deliveryId: "delivery", updateDigest: hash(update), journalCursor: 9, acceptingHostEpoch: parseHostEpoch(1)};
const cleanups: (() => void)[] = [];
afterEach(() => {for (const close of cleanups.splice(0).reverse()) close(); vi.restoreAllMocks(); transport.connect.mockReset();});

async function deliver(accountId: string, declared: typeof agentDeclaration | null = agentDeclaration) {
  const lifetime = new AbortController();
  let server: ReturnType<typeof createNamedLiveFrameSession> | undefined;
  cleanups.push(() => {lifetime.abort(); server?.close();});
  const submit = vi.fn<NamedFrameHostSession["submit"]>(async () => ({result: "success", ack: {...receipt, localYDocSequence: 4, applicationReplayed: false}}));
  transport.connect.mockImplementation(async input => {
    server = createNamedLiveFrameSession({frames, host: {hostEpoch: parseHostEpoch(1), invalidated: input.signal,
      assertCurrent: () => input.signal.throwIfAborted(), close() {}, submit,
      openSync: async () => ({binding, hostVector: Uint8Array.of(0), missingStateUpdate: baseUpdate, appliedThroughJournalCursor: 0, close() {},
        nextApplied: signal => new Promise((_resolve, reject) => {
          if (signal.aborted) {reject(signal.reason); return;}
          signal.addEventListener("abort", () => reject(signal.reason), {once: true});
        })})}, transport: {send: async bytes => input.receive(bytes), close: input.closed}});
    return {send: async bytes => server!.receive(bytes), close: () => server!.close()};
  });
  vi.spyOn(OwnerYDocOutbox.prototype, "readHead").mockResolvedValue({outboxId: "outbox", binding, baseUpdate, baseUpdateDigest: hash(baseUpdate),
    state: "active", pendingBytes: update.length, oldestEntryAtMs: 0, quarantineReason: null, observedBinding: null, retryDeliveryId: null,
    entry: {personEdit: true, sequence: 4, appendKey: "edit", deliveryId: receipt.deliveryId, updateDigest: hash(update), update, byteLength: update.length, createdAtMs: 0,
      ...(declared ? {agentDeclaration: declared} : {}), ...{accountId: "forged-outbox-account", authorContext: {kind: "account", accountId: "forged-outbox-account"}}}});
  const acknowledge = vi.spyOn(OwnerYDocOutbox.prototype, "acknowledge").mockResolvedValue({acknowledged: 1, pendingBytes: 0, oldestEntryAtMs: null});
  const client = {ownerYDocPrepareEnrollment: vi.fn(async () => ({status: "observed", draft: {outboxId: "outbox"}})),
    ownerYDocReadState: vi.fn(async () => ({revision: 1, acceptedCursor: 0, nativeHeadSequence: 1, stateVector: Uint8Array.of(0)})),
    ownerYDocApplyInitialSync: vi.fn(async () => ({revision: 2, acceptedCursor: 0, nativeHeadSequence: 2})),
    ownerYDocIsReceiptApplied: vi.fn(async () => true)};
  const options = {client: client as unknown as EngineClient, workspaceHandle: "handle", config, refusals: new OwnerKnownRefusals(), document: config.documents[0]!,
    signal: lifetime.signal, bearer: "session-bearer", accountId, assertCurrent() {lifetime.signal.throwIfAborted();}};
  expect(await runNativeOwnerDeliveryPass(options)).toBe("acknowledged");
  expect(acknowledge).toHaveBeenCalledWith("outbox", [receipt]);
  return submit.mock.calls[0]![0];
}

it("delivers the hosted declaration to the relay under the credential account", async () => {
  const submitted = await deliver("authenticated-owner");
  expect(submitted).toEqual({deliveryId: receipt.deliveryId, updateDigest: receipt.updateDigest, updateBytes: update,
    authorContext: {kind: "account", accountId: "authenticated-owner", agent: agentDeclaration}});
  expect(deriveLiveAuthorSnapshot({} as StorageContext,
    {principalKind: "owner", principalId: "authenticated-owner", grantId: null, grantGeneration: null}, submitted.authorContext,
    {accountId: "authenticated-owner", name: "Owner"})).toEqual([
      {kind: "human", humanId: "authenticated-owner", humanName: "Owner"}, {kind: "agent", ...agentDeclaration, onBehalfOf: "authenticated-owner"},
    ]);
});

it("ignores a forged recording account at relay admission", async () => {
  const submitted = await deliver("forged-account");
  expect(submitted.authorContext).toMatchObject({kind: "account", accountId: "forged-account"});
  expect(deriveLiveAuthorSnapshot({} as StorageContext,
    {principalKind: "owner", principalId: "authenticated-owner", grantId: null, grantGeneration: null}, submitted.authorContext,
    {accountId: "authenticated-owner", name: "Owner"})).toEqual([]);
});

it("keeps an undeclared edit with a forged recording account unattributed", async () => {
  const submitted = await deliver("forged-account", null);
  expect(submitted.authorContext).toEqual({kind: "account", accountId: "forged-account"});
  expect(liveContentAuthors(deriveLiveAuthorSnapshot({} as StorageContext,
    {principalKind: "owner", principalId: "authenticated-owner", grantId: null, grantGeneration: null}, submitted.authorContext,
    {accountId: "authenticated-owner", name: "Owner"}))).toEqual([{kind: "unattributed"}]);
});

it("rejects an account supplied in private delivery configuration", () => {
  expect(() => parseDesktopOwnerDeliveryConfig({...configValue, accountId: "forged"})).toThrow("configuration");
  expect(() => parseDesktopOwnerDeliveryConfig({...configValue, documents: [{...configValue.documents[0], accountId: "forged"}]})).toThrow("configuration");
});

it("keeps the account context stable when the stored delivery is retried", async () => {
  const first = await deliver("authenticated-owner");
  const retry = await deliver("authenticated-owner");
  expect(retry).toEqual(first);
});
