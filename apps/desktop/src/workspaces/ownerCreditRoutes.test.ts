import {afterEach, expect, it, vi} from "vitest";
import * as Y from "yjs";
import {OwnerYDocOutbox} from "@dohc/workspace-engine-client";
import {OwnerKnownRefusals} from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import {OwnerYDocFrameDelivery} from "./ownerYDocFrameDelivery";
import type {OwnerYDocDeliveryEnvelope} from "./ownerYDocOutbox";
import {createNamedLiveFrameSession} from "../../../../services/sync-relay/src/namedLiveFrameSession";
import {drainOwnerOutbox} from "../../../../services/sync-relay/src/ownerOutboxDelivery";
import {createLiveJournalHistoryAuthority} from "../../../../services/sync-relay/src/storage/liveJournalHistory";
import {registered, hash, policy, cleanupLiveDeliveryFixtures} from "../../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {createLiveMarkdownJournalValidator} from "../../../../packages/ydoc-projection/src/liveDocumentValidation";
const frames = {receive: {maxFrameBytes: 4096, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
  maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096};
afterEach(() => {vi.restoreAllMocks(); cleanupLiveDeliveryFixtures();});

async function deliver(route: "desktop" | "outbox", f: ReturnType<typeof registered>, bytes: Uint8Array, id: string,
  provenance: Pick<OwnerYDocDeliveryEnvelope, "personEdit" | "agentDeclaration"> = {}) {
  const captured = f.capture(bytes, id), {binding} = captured.metadata;
  const envelope = {outboxId: "outbox", binding, baseUpdate: f.input.baselineBytes, baseUpdateDigest: binding.lineageClaimId,
    sequence: 1, appendKey: id === "seed" ? `owner-adoption:${hash(Buffer.from(JSON.stringify(["adoption", 0, hash(bytes)])))}` : id, deliveryId: id, update: bytes, updateDigest: hash(bytes), ...provenance};
  if (route === "outbox") {
    let pending = bytes.length;
    vi.spyOn(OwnerYDocOutbox.prototype, "readDeliveryHead").mockResolvedValue({...envelope, state: "active", pendingBytes: pending,
      oldestEntryAtMs: 0, quarantineReason: null, observedBinding: null, retryDeliveryId: null, frozenAtRefusedSeed: false, checkpointDigest: null, recoveryCheckpointDigest: null,
      entry: {...envelope, byteLength: pending, createdAtMs: 0}});
    vi.spyOn(OwnerYDocOutbox.prototype, "acknowledge").mockImplementation(async () => {pending = 0; return {acknowledged: 1, pendingBytes: 0, oldestEntryAtMs: null};});
    const validateJournal = createLiveMarkdownJournalValidator(policy);
    const result = await drainOwnerOutbox({storage: f.storage, client: {sendRequest: async () => ({result: {outboxId: "outbox", pendingBytes: pending, state: "active", retryDeliveryId: null}})} as never,
      admission: {trustedAccount: accountId => ({accountId, name: "Relay name"}), shares: new Map([["workspace", "share"]]), maxEntriesPerDrain: 1, maxBytesPerDrain: 10_000,
        refusals: new OwnerKnownRefusals(),
        validate: ({retainStateUpdate: _, ...input}) => validateJournal(input)},
      workspace: "handle", host: captured.host, registrationId: 1, binding, adoption: {adoptionId: "adoption", sequence: 0, applied() {}},
      nextRequestId: () => 1, deadlineMs: 1000, assertCurrent() {}, applyThrough: async receipt => ({...receipt, localYDocSequence: 1, applicationReplayed: false})});
    expect(result).toEqual({admittedEntries: 1, hasMore: false});
  } else {
    const lifetime = new AbortController(); let server: ReturnType<typeof createNamedLiveFrameSession> | undefined;
    const carrier = new OwnerYDocFrameDelivery({relayUrl: "https://relay.test", shareId: "share", frames, attemptTimeoutMs: 1000,
      signal: lifetime.signal, freshBearer: async () => "owner-session", authenticatedAccountId: async () => "owner",
      acceptedState: {readState: async () => ({stateVector: Uint8Array.of(0), journalCursor: 0}), applyInitialSync: async () => "applied",
        applyAcceptedFrame: async () => "applied", isReceiptApplied: async () => true},
      connect: async input => {
        server = createNamedLiveFrameSession({frames, transport: {send: async bytes => input.receive(bytes), close: input.closed},
          host: {hostEpoch: captured.host.hostEpoch, invalidated: input.signal, assertCurrent() {}, close() {},
            submit: async submission => {
              const current = f.capture(submission.updateBytes, submission.deliveryId);
              const result = f.storage.commitLiveUpdateJournal({...current, metadata: {...current.metadata, ...(submission.authorContext ? {authorContext: submission.authorContext} : {})},
                trustedAccount: {accountId: "owner", name: "Relay name"}}).result;
              if (result.kind !== "accepted") return {result: "refused", reason: "provenance-refused"};
              return {result: "success", ack: {...result.receipt, localYDocSequence: 1, applicationReplayed: false}};
            },
            openSync: async () => ({binding, hostVector: Uint8Array.of(0), missingStateUpdate: Uint8Array.of(0, 0), appliedThroughJournalCursor: 0, close() {},
              nextApplied: signal => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}))})}});
        return {send: async bytes => server!.receive(bytes), close: () => server!.close()};
      }});
    try {
      const fresh = await carrier.freshOwnerAuthority(binding);
      if (fresh.kind !== "authority") throw new Error("Missing owner authority");
      expect(await carrier.deliver(fresh.authority, envelope)).toMatchObject({kind: "receipt"});
    } finally {carrier.dispose(); lifetime.abort(); server?.close();}
  }
  return f.journalRows().journal.at(-1)!;
}

it.each(["desktop", "outbox"] as const)("admits a two-client seed on the %s route without owner credit", async route => {
  const f = registered(); f.storage.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace: "credit-routes", reconciled: true}));
  try {
    f.doc.clientID = 100; f.update("first"); f.doc.clientID = 200; f.update("second");
    const row = await deliver(route, f, Y.encodeStateAsUpdate(f.doc), "seed");
    expect(JSON.parse(String(row.author_snapshot_json))).toEqual([]);
    expect(row.author_context_json).toBeNull();
  } finally {f.close();}
});
it.each(["desktop", "outbox"] as const)("credits person typing then admits a rebound agent unattributed on the %s route", async route => {
  const f = registered(); f.storage.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace: "credit-routes", reconciled: true}));
  try {
    const person = await deliver(route, f, f.update("person"), "person", {personEdit: true});
    expect(JSON.parse(String(person.author_snapshot_json))).toEqual([{kind: "human", humanId: "owner", humanName: "Relay name"}]);
    const agent = await deliver(route, f, f.update("agent"), "agent", {agentDeclaration: {agentId: "agent", onBehalfOf: null, depth: 0}});
    expect(JSON.parse(String(agent.author_snapshot_json))).toEqual([]);
    expect(JSON.parse(String(agent.author_context_json))).toEqual({kind: "account", accountId: "owner", agent: {agentId: "agent", depth: 0}});
  } finally {f.close();}
});
