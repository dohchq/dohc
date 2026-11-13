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
  documents: [{binding, relayDatabaseNamespace: "namespace"}]};
const config = parseDesktopOwnerDeliveryConfig(configValue);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const update = Uint8Array.of(1,2,3), baseUpdate = Uint8Array.of(0,0);
const agentDeclaration = {agentId: "hosted-agent", onBehalfOf: "principal", depth: 2};
const receipt = {deliveryId: "delivery", updateDigest: hash(update), journalCursor: 9, acceptingHostEpoch: parseHostEpoch(1)};
const cleanups: (() => void)[] = [];
afterEach(() => {for (const close of cleanups.splice(0).reverse()) close(); vi.restoreAllMocks(); transport.connect.mockReset();});

type Entry = NonNullable<Awaited<ReturnType<OwnerYDocOutbox["readHead"]>>["entry"]>;
const head = (entry: Entry | null): Awaited<ReturnType<OwnerYDocOutbox["readHead"]>> => ({outboxId: "outbox", binding, baseUpdate, baseUpdateDigest: hash(baseUpdate),
  state: "active", pendingBytes: entry?.byteLength ?? 0, oldestEntryAtMs: entry ? 0 : null, quarantineReason: null, observedBinding: null, retryDeliveryId: null, entry});

// The relay's real frame session over an in-memory transport. Each accepted submission gets the next journal cursor, from 9.
function serve() {
  const lifetime = new AbortController();
  let server: ReturnType<typeof createNamedLiveFrameSession> | undefined, accepted = 0;
  cleanups.push(() => {lifetime.abort(); server?.close();});
  const submit = vi.fn<NamedFrameHostSession["submit"]>(async input => ({result: "success", ack: {deliveryId: input.deliveryId, updateDigest: input.updateDigest,
    journalCursor: receipt.journalCursor + accepted++, acceptingHostEpoch: receipt.acceptingHostEpoch, localYDocSequence: 4, applicationReplayed: false}}));
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
  const client = {ownerYDocPrepareEnrollment: vi.fn(async () => ({status: "observed", draft: {outboxId: "outbox"}})),
    ownerYDocReadState: vi.fn(async () => ({revision: 1, acceptedCursor: 0, nativeHeadSequence: 1, stateVector: Uint8Array.of(0)})),
    ownerYDocApplyInitialSync: vi.fn(async () => ({revision: 2, acceptedCursor: 0, nativeHeadSequence: 2})),
    ownerYDocIsReceiptApplied: vi.fn(async (_request: unknown, _input: {receipt: unknown}) => true)};
  const pass = (accountId: string) => runNativeOwnerDeliveryPass({client: client as unknown as EngineClient, workspaceHandle: "handle", config,
    refusals: new OwnerKnownRefusals(), document: config.documents[0]!, signal: lifetime.signal, bearer: "session-bearer", accountId,
    assertCurrent() {lifetime.signal.throwIfAborted();}});
  return {submit, client, pass};
}

// Like the engine, acknowledging the head's receipt moves the queue to its next entry.
function outbox(entries: Entry[]) {
  let next = 0;
  vi.spyOn(OwnerYDocOutbox.prototype, "readHead").mockImplementation(async () => head(entries[next] ?? null));
  return vi.spyOn(OwnerYDocOutbox.prototype, "acknowledge").mockImplementation(async () => {
    next++;
    return {acknowledged: 1, pendingBytes: entries.slice(next).reduce((sum, entry) => sum + entry.byteLength, 0), oldestEntryAtMs: null};
  });
}

async function deliver(accountId: string, declared: typeof agentDeclaration | null = agentDeclaration) {
  const {submit, pass} = serve();
  const acknowledge = outbox([{personEdit: true, sequence: 4, appendKey: "edit", deliveryId: receipt.deliveryId, updateDigest: hash(update), update, byteLength: update.length, createdAtMs: 0,
    ...(declared ? {agentDeclaration: declared} : {}), ...{accountId: "forged-outbox-account", authorContext: {kind: "account", accountId: "forged-outbox-account"}}}]);
  expect(await pass(accountId)).toBe("acknowledged");
  expect(acknowledge).toHaveBeenCalledExactlyOnceWith("outbox", [receipt]);
  expect(submit).toHaveBeenCalledOnce();
  return submit.mock.calls[0]![0];
}

// #2337: one pass, one connection, and every waiting edit, each with its own receipt.
it("delivers every waiting edit over one owner connection, each with its own receipt and author", async () => {
  const {submit, client, pass} = serve();
  const entries = Array.from({length: 20}, (_, index): Entry => {
    const bytes = Uint8Array.of(index + 1);
    return {personEdit: true, sequence: index + 4, appendKey: `edit-${index}`, deliveryId: `delivery-${index}`, updateDigest: hash(bytes), update: bytes, byteLength: 1, createdAtMs: 0};
  });
  const acknowledge = outbox(entries);
  expect(await pass("authenticated-owner")).toBe("acknowledged");
  expect(transport.connect).toHaveBeenCalledOnce();
  expect(client.ownerYDocPrepareEnrollment).toHaveBeenCalledOnce();
  expect(client.ownerYDocReadState).toHaveBeenCalledOnce();
  expect(client.ownerYDocApplyInitialSync).toHaveBeenCalledOnce();
  expect(submit.mock.calls.map(([input]) => [input.deliveryId, input.updateDigest, input.authorContext])).toEqual(
    entries.map(entry => [entry.deliveryId, entry.updateDigest, {kind: "account", accountId: "authenticated-owner"}]));
  const receipts = entries.map((entry, index) => ({deliveryId: entry.deliveryId, updateDigest: entry.updateDigest, journalCursor: receipt.journalCursor + index,
    acceptingHostEpoch: receipt.acceptingHostEpoch}));
  expect(client.ownerYDocIsReceiptApplied.mock.calls.map(([, input]) => input.receipt)).toEqual(receipts);
  expect(acknowledge.mock.calls).toEqual(receipts.map(proved => ["outbox", [proved]]));
});

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
