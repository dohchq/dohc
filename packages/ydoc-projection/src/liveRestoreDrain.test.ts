import {createHash} from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import { registered, host, policy, hash, cleanupLiveDeliveryFixtures } from "./liveCommittedDeliveryTestSupport.js";
import {resolveLiveRestorePoint} from "./liveRestorePoint.js";
import {markdownToYDoc, yDocToMarkdown} from "./import-export.js";
import { createLiveJournalHistoryAuthority } from "../../../services/sync-relay/src/storage/liveJournalHistory.js";
import { beginStopRestore, advanceStopRestoreFence, readStopRestore, type StopRestoreIntent } from "../../../services/sync-relay/src/storage/liveRestoreOperation.js";
import type { StorageContext } from "../../../services/sync-relay/src/storage/context.js";
import type { StopRestoreCutCapture, CommittedBootstrap, OwnerCutCapture } from "../../../services/sync-relay/src/storage/liveCommittedDelivery.js";
import type {NativeRestoreFenceReceipt} from "../../../services/sync-relay/src/liveRestoreFence.js";
import { openSyncRelayStorage } from "../../../services/sync-relay/src/storage.js";
import {parseNativeRestoreProposalReceipt, encodeNativeRestoreProposal, decodeNativeRestoreProposal} from "../../../services/sync-relay/src/liveRestoreProposal.js";
import {initializeLiveRestoreOperationSchema} from "../../../services/sync-relay/src/storage/liveRestoreOperationSchema.js";
import {validateLiveRestoreProposal} from "./liveRestoreProof.js";
import {createLiveMarkdownJournalValidator} from "./liveDocumentValidation.js";
import {LiveRestorePreparation, parseLiveRestoreConfig} from "../../../services/sync-relay/src/liveRestorePreparation.js";
import {canonicalAcceptedMetadata} from "../../../services/sync-relay/src/liveAcceptedHistory.js";
import {LiveCommittedDelivery} from "../../../services/sync-relay/src/liveCommittedDelivery.js";
import {OwnerCommittedDelivery} from "../../../services/sync-relay/src/ownerCommittedDelivery.js";

afterEach(cleanupLiveDeliveryFixtures);
const jsonHash = (value: unknown) => hash(Buffer.from(JSON.stringify(value)));
const ownerOriginDigest = ({binding, cut: c}: Pick<OwnerCutCapture, "binding" | "cut">) => jsonHash([binding,
  c.relayDatabaseNamespace, c.sourceMomentId, c.sourceDigest, c.sourceByteLength, c.baselineMomentRelaySequence,
  c.baselineRegisteredAtMs, c.expectedLocalSequence, c.events.map(event => canonicalAcceptedMetadata(event.metadata))]);
function proposalSourcesFixture(kind: "bootstrap" | "owner", mode: "service" | "device") {
  const f = readyNativeFence(kind, mode, true);
  f.store.acknowledgeStopRestoreFence(f.lookup, f.receipt);
  const input = {...f.lookup, maxBytes: 1_000_000, maxEvents: 10};
  const selectedHistory = f.store.captureStopRestorePoint(input).proof;
  const acceptedHistory = f.store.captureStopRestoreAcceptedCut(input).proof;
  let origin: unknown;
  if (kind === "owner") {
    origin = f.store.captureStopRestoreOwnerOrigin(input).evidenceDigest;
  } else {
    const b = f.raw.prepare("SELECT * FROM sync_relay_live_delivery_bootstraps").get()!;
    origin = {bootstrapId: b.bootstrap_id, bootstrapMomentId: b.bootstrap_moment_id,
      baselineMomentRelaySequence: b.baseline_moment_relay_seq, baselineRegisteredAtMs: b.baseline_registered_at_ms,
      baselineDigest: b.baseline_digest, baselineByteLength: b.baseline_byte_length,
      projectedMarkdownDigest: b.projected_markdown_digest, projectedMarkdownByteLength: b.projected_markdown_byte_length};
  }
  // These tests authenticate source receipts only. They do not claim a content-valid native candidate.
  const receipt = {fence: f.receipt, point: resolveLiveRestorePoint(f.store.captureStopRestorePoint(input), policy),
    candidateDigest: "a".repeat(64), frozenStateDigest: "b".repeat(64), pointStateDigest: "c".repeat(64),
    finalContentDigest: "d".repeat(64), beforeStateVector: [0], afterStateVector: [0],
    replacementRanges: [{clientId: 999, startClock: 0, endClock: 1}], originEvidenceDigest: kind === "owner" ? String(origin) : jsonHash(origin),
    selectedHistory, acceptedHistory, nativeSources: [], nativeSourceManifestDigest: jsonHash([f.receipt, []])};
  return {...f, input, proposal: receipt};
}

it.each([["bootstrap", "service"], ["bootstrap", "device"], ["owner", "service"], ["owner", "device"]] as const)(
  "authenticates restore proposal sources for %s on %s without opening admission", (kind, mode) => {
    const f = proposalSourcesFixture(kind, mode);
    try {
      const before = f.journalRows(), captured = f.store.captureStopRestoreProposal(f.input, JSON.stringify(f.proposal));
      expect(captured.receipt.acceptedHistory).toEqual(f.proposal.acceptedHistory);
      expect(captured.selected.target).toBe("selected"); expect(captured.accepted.target).toBe("accepted");
      expect(() => captured.assertCurrent()).not.toThrow();
      expect(f.journalRows()).toEqual(before);
      expect(f.raw.prepare("SELECT admission_state FROM sync_relay_live_documents").get()!.admission_state).toBe("closed");
      expect(f.storage.getShareGrant("grant")?.status).toBe("revoked");
      Object.assign(captured.receipt.acceptedHistory.suffix[0]!.accepted.receipt, {updateDigest: "f".repeat(64)});
      expect(() => captured.assertCurrent()).toThrow();
    } finally {f.close();}
  });

it("refuses restore proposal source substitution, omission, order and operation drift", () => {
  const f = proposalSourcesFixture("owner", "device");
  try {
    const mutations = [
      (r: typeof f.proposal) => {r.acceptedHistory.suffix.pop();},
      (r: typeof f.proposal) => {r.acceptedHistory.suffix.reverse();},
      (r: typeof f.proposal) => {Object.assign(r.acceptedHistory.suffix[0]!.accepted.authority, {principalId: "other"});},
      (r: typeof f.proposal) => {r.originEvidenceDigest = "f".repeat(64);},
      (r: typeof f.proposal) => {Object.assign(r.point, {journalCursor: 1});},
      (r: typeof f.proposal) => {r.fence.operation.hostId = "other";r.nativeSourceManifestDigest = jsonHash([r.fence, []]);},
    ];
    for (const mutate of mutations) {
      const r = structuredClone(f.proposal);mutate(r);
      expect(() => f.store.captureStopRestoreProposal(f.input, JSON.stringify(r))).toThrow();
    }
    const capture = f.store.captureStopRestoreProposal(f.input, JSON.stringify(f.proposal));
    f.raw.prepare("UPDATE sync_relay_live_update_journal SET received_at_ms=received_at_ms+1 WHERE journal_cursor=1").run();
    expect(() => capture.assertCurrent()).toThrow();
  } finally {f.close();}
});

it("bounds restore proposal metadata and refuses corrupt native source manifests", () => {
  const f = proposalSourcesFixture("bootstrap", "service");
  try {
    const json = JSON.stringify(f.proposal);
    expect(() => f.store.captureStopRestoreProposal({...f.input, maxBytes: 1}, json)).toThrow(/bound/);
    expect(() => f.store.captureStopRestoreProposal({...f.input, maxEvents: 1}, json)).toThrow(/bound/);
    expect(() => parseNativeRestoreProposalReceipt(JSON.stringify({...f.proposal, surprise: true}), f.input)).toThrow();
    expect(() => parseNativeRestoreProposalReceipt(JSON.stringify({...f.proposal, nativeSourceManifestDigest: "f".repeat(64)}), f.input)).toThrow();
    expect(() => parseNativeRestoreProposalReceipt(JSON.stringify({...f.proposal, beforeStateVector: [256]}), f.input)).toThrow();
  } finally {f.close();}
});

function pendingSource(binding: NativeRestoreFenceReceipt["operation"]["oldBinding"], bytes: Uint8Array, sequence: number) {
  const updateDigest = hash(bytes), outboxId = `owner-outbox-${hash(Buffer.from(`${binding.workspaceId}\0${JSON.stringify(binding)}\0${binding.lineageClaimId}`))}`;
  const source = {binding, adoptionId: "adoption", nativeSequence: sequence + 9, updateDigest,
    origin: {kind: "nativeUpdate", actorOriginId: "owner-device", actorKind: "agent", onBehalfOf: "owner", chainDepth: 64, recordedAtMs: 100}};
  return {outboxId, outboxSequence: sequence, binding, appendKey: `adopted-local:${jsonHash(source)}`,
    deliveryId: `owner-delivery-${hash(Buffer.from(`${outboxId}\0${sequence}\0${updateDigest}`))}`, updateDigest,
    byteLength: bytes.byteLength, createdAtMs: 100, source, acceptedReceipt: null};
}

function contentProposalFixture(kind: "bootstrap" | "owner" = "owner", mode: "service" | "device" = "device", pending = false) {
  const f = proposalSourcesFixture(kind, mode), point = new Y.Doc({gc: false}), head = new Y.Doc({gc: false});
  try {
    const selected = f.store.captureStopRestorePoint(f.input), accepted = f.store.captureStopRestoreAcceptedCut(f.input);
    Y.applyUpdate(point, selected.checkpoint.bytes);for (const e of selected.events) Y.applyUpdate(point, e.updateBytes);
    Y.applyUpdate(head, accepted.checkpoint.bytes);for (const e of accepted.events) Y.applyUpdate(head, e.updateBytes);
    const nativeSourceBytes: Uint8Array[] = [];
    if (pending) {
      for (const name of ["pending-one", "pending-two"]) {
        const before = Y.encodeStateVector(head);
        head.getMap("frontmatter").set(name, "retained owner work");
        nativeSourceBytes.push(Y.encodeStateAsUpdate(head, before));
      }
    }
    const nativeSources = nativeSourceBytes.map((bytes, index) => pendingSource(f.receipt.operation.oldBinding, bytes, index + 1));
    const frozen = Y.encodeStateAsUpdate(head), pointBytes = Y.encodeStateAsUpdate(point), vector = Y.encodeStateVector(head);
    const used = Y.decodeStateVector(vector);let client = 1;while (used.has(client)) client++;head.clientID = client;
    head.transact(() => {
      const body = head.getXmlFragment("body");body.delete(0, body.length);
      body.insert(0, point.getXmlFragment("body").toArray().map(node => {
        if (!(node instanceof Y.XmlElement || node instanceof Y.XmlText)) throw Error("unexpected fixture body");
        return node.clone();
      }));
      const fields = head.getMap("frontmatter");for (const key of fields.keys()) fields.delete(key);
      for (const [key, value] of point.getMap("frontmatter").entries()) fields.set(key, structuredClone(value));
    });
    const candidate = Y.encodeStateAsUpdate(head, vector);
    const validated = createLiveMarkdownJournalValidator(policy)({document: f.document, currentPath: selected.binding.currentPath,
      checkpoint: frozen, suffix: [], candidate});
    if (validated.kind !== "accepted") throw Error(validated.reason);
    const receipt = {...f.proposal, candidateDigest: hash(candidate), frozenStateDigest: hash(frozen), pointStateDigest: hash(pointBytes),
      beforeStateVector: [...vector], afterStateVector: [...Y.encodeStateVector(head)], replacementRanges: [...validated.evidence.candidate.ranges],
      nativeSources, nativeSourceManifestDigest: jsonHash([f.receipt, nativeSources])};
    const capture = f.store.captureStopRestoreProposal(f.input, JSON.stringify(receipt));
    const bytes = {candidateBytes: candidate, frozenStateBytes: frozen, pointStateBytes: pointBytes, nativeSourceBytes};
    return {...f, receipt, capture, bytes, encoded: encodeNativeRestoreProposal(JSON.stringify(receipt), bytes, f.input)};
  } catch (error) {f.close();throw error;}
  finally {point.destroy();head.destroy();}
}

const preparationConfig = () => parseLiveRestoreConfig({maxBytes: 1_000_000, maxEvents: 10, aggregateBytes: 17_000_000,
  workingReserveBytes: 1_000_000, maxOperations: 1, validation: policy})!;

it.each([["bootstrap", "service"], ["bootstrap", "device"], ["owner", "device"]] as const)(
  "prepares and durably replays a verified %s restore proposal on %s", async (kind, mode) => {
    const f = contentProposalFixture(kind, mode, kind === "owner");
    try {
      const sendLiveRestore = vi.fn(async (_request: unknown, operation: string, bytes: Uint8Array) => {
        expect(operation).toBe("prepare");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        expect(view.getUint32(0, true)).toBe(bytes.byteLength - 4);
        expect(JSON.parse(Buffer.from(bytes.subarray(4)).toString())).toEqual({fence: f.receipt.fence, point: f.receipt.point});
        return {response: {result: {status: "prepared"}}, bytes: Buffer.from(f.encoded)};
      });
      const prepare = new LiveRestorePreparation(preparationConfig());
      const options = {store: f.store, lookup: f.lookup, deliveryKind: kind,
        connection: {client: {sendLiveRestore} as never, workspace: "native-workspace", host: f.lookup.host, deadlineMs: 1000, nextRequestId: () => 1}};
      const outcome = await prepare.prepare(options);
      expect(outcome).toMatchObject({kind: "prepared", candidateDigest: f.receipt.candidateDigest, replayed: false});
      expect(await prepare.prepare(options)).toEqual({...outcome, replayed: true});
      expect(sendLiveRestore).toHaveBeenCalledTimes(1);
      expect(f.raw.prepare("SELECT admission_state FROM sync_relay_live_documents").get()!.admission_state).toBe("closed");
      expect(f.storage.getShareGrant("grant")?.status).toBe("revoked");
    } finally {f.close();}
  });

it("holds restore preparation capacity across transport and releases it after cancellation or proof refusal", async () => {
  const f = contentProposalFixture();
  try {
    const prepare = new LiveRestorePreparation(preparationConfig()), abort = new AbortController();
    let release!: (value: {response: {result: {status: string}}; bytes: Buffer}) => void;
    const pending = new Promise<{response: {result: {status: string}}; bytes: Buffer}>(resolve => {release = resolve;});
    let started!: () => void;
    const reached = new Promise<void>(resolve => {started = resolve;});
    const sendLiveRestore = vi.fn(async () => {started(); return pending;});
    const options = {store: f.store, lookup: f.lookup, deliveryKind: "owner" as const,
      connection: {client: {sendLiveRestore} as never, workspace: "native-workspace", host: f.lookup.host, deadlineMs: 1000, nextRequestId: () => 1}};
    const first = prepare.prepare({...options, signal: abort.signal});
    await reached;
    await expect(prepare.prepare(options)).rejects.toThrow("capacity is full");
    abort.abort(new Error("caller retired"));
    release({response: {result: {status: "prepared"}}, bytes: Buffer.from(f.encoded)});
    await expect(first).rejects.toThrow("caller retired");
    expect(f.store.readStopRestoreProposal(f.input, policy)).toBeNull();
    sendLiveRestore.mockResolvedValueOnce({response: {result: {status: "prepared"}}, bytes: Buffer.from([0])});
    await expect(prepare.prepare(options)).rejects.toThrow();
    expect(f.store.readStopRestoreProposal(f.input, policy)).toBeNull();
    await expect(prepare.prepare(options)).resolves.toMatchObject({kind: "prepared", replayed: false});
  } finally {f.close();}
});

it("requires explicit restore preparation limits and snapshots the configured validation policy", () => {
  expect(parseLiveRestoreConfig(undefined)).toBeUndefined();
  const config = preparationConfig();
  expect(() => parseLiveRestoreConfig({...config, aggregateBytes: 1})).toThrow();
  expect(() => parseLiveRestoreConfig({...config, maxBytes: Number.MAX_SAFE_INTEGER})).toThrow();
  expect(() => parseLiveRestoreConfig({...config, workingReserveBytes: 0})).toThrow();
  const mutable = {...config, validation: {...config.validation}};
  const prepare = new LiveRestorePreparation(mutable);
  mutable.validation.maxStructVisits = 1;
  expect(prepare.config.validation.maxStructVisits).toBe(config.validation.maxStructVisits);
});

it.each(["bootstrap", "owner"] as const)("holds %s delivery exclusion until restore preparation finishes", async kind => {
  const f = contentProposalFixture(kind, "device");
  try {
    const release = Promise.withResolvers<{response: {result: {status: string}}; bytes: Buffer}>();
    const started = Promise.withResolvers<void>();
    const sendLiveRestore = vi.fn(async () => {started.resolve(); return release.promise;});
    const connection = {client: {sendLiveRestore} as never, workspace: "native-workspace", host: f.coordinate,
      deadlineMs: 1000, nextRequestId: () => 1, restore: new LiveRestorePreparation(preparationConfig())};
    const make = (restore: LiveRestorePreparation | undefined) => kind === "bootstrap"
      ? new LiveCommittedDelivery(f.storage, f.history, {...connection, restore})
      : new OwnerCommittedDelivery(f.storage, f.history, {...connection, restore,
        bounds: {maxBytes: 1_000_000, maxEvents: 10}, ownerAdmission: {} as never});
    await expect(make(undefined).prepareRestore(f.lookup)).rejects.toThrow("Restore preparation is not configured on this host.");
    const delivery = make(connection.restore), preparing = delivery.prepareRestore(f.lookup);
    await started.promise;
    await expect(delivery.settle(f.document)).rejects.toThrow(/owns this document|holds this document/);
    await expect(delivery.prepareRestore(f.lookup)).rejects.toThrow(/owns this document|holds this document/);
    release.resolve({response: {result: {status: "prepared"}}, bytes: Buffer.from(f.encoded)});
    await expect(preparing).resolves.toMatchObject({kind: "prepared", replayed: false});
    await expect(delivery.prepareRestore(f.lookup)).resolves.toMatchObject({kind: "prepared", replayed: true});
    expect(sendLiveRestore).toHaveBeenCalledTimes(1);
  } finally {f.close();}
});

it("releases preparation capacity when the drain returns pending", async () => {
  const f = fixture("bootstrap", "device");
  try {
    f.fence();
    const sendRequest = vi.fn(async () => ({result: {status: "pending", reason: "Owner is busy."}}));
    const sendLiveRestore = vi.fn();
    const preparation = new LiveRestorePreparation(preparationConfig());
    const options = {store: f.store, lookup: f.lookup, deliveryKind: "bootstrap" as const,
      connection: {client: {sendRequest, sendLiveRestore} as never, workspace: "native-workspace", host: f.coordinate,
        deadlineMs: 1000, nextRequestId: () => 1}};
    for (let i = 0; i < 2; i++) await expect(preparation.prepare(options)).resolves.toEqual({kind: "pending", reason: "Owner is busy."});
    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(sendLiveRestore).not.toHaveBeenCalled();
  } finally {f.close();}
});

it("refuses stale authority after native preparation without recording a proposal", async () => {
  const f = contentProposalFixture();
  try {
    const release = Promise.withResolvers<{response: {result: {status: string}}; bytes: Buffer}>();
    const started = Promise.withResolvers<void>();
    const sendLiveRestore = vi.fn(async () => {started.resolve(); return release.promise;});
    const preparation = new LiveRestorePreparation(preparationConfig());
    const preparing = preparation.prepare({store: f.store, lookup: f.lookup, deliveryKind: "owner",
      connection: {client: {sendLiveRestore} as never, workspace: "native-workspace", host: f.coordinate,
        deadlineMs: 1000, nextRequestId: () => 1}});
    const refused = expect(preparing).rejects.toThrow("Accepted journal history is damaged.");
    await started.promise;
    f.raw.prepare("UPDATE sync_relay_live_update_journal SET received_at_ms=received_at_ms+1 WHERE journal_cursor=1").run();
    release.resolve({response: {result: {status: "prepared"}}, bytes: Buffer.from(f.encoded)});
    await refused;
    expect(f.raw.prepare(`SELECT COUNT(*) AS count FROM ${proposalTable}`).get()!.count).toBe(0);
  } finally {f.close();}
});

it("enforces the aggregate byte reservation before the operation count is full", async () => {
  const f = contentProposalFixture();
  try {
    const preparation = new LiveRestorePreparation({...preparationConfig(), maxOperations: 2});
    const release = Promise.withResolvers<{response: {result: {status: string}}; bytes: Buffer}>();
    const started = Promise.withResolvers<void>();
    const sendLiveRestore = vi.fn(async () => {started.resolve(); return release.promise;});
    const options = {store: f.store, lookup: f.lookup, deliveryKind: "owner" as const,
      connection: {client: {sendLiveRestore} as never, workspace: "native-workspace", host: f.coordinate,
        deadlineMs: 1000, nextRequestId: () => 1}};
    const preparing = preparation.prepare(options);
    await started.promise;
    await expect(preparation.prepare(options)).rejects.toThrow("capacity is full");
    release.resolve({response: {result: {status: "prepared"}}, bytes: Buffer.from(f.encoded)});
    await expect(preparing).resolves.toMatchObject({kind: "prepared", replayed: false});
    await expect(preparation.prepare(options)).resolves.toMatchObject({kind: "prepared", replayed: true});
  } finally {f.close();}
});

it("carries authenticated store targets into real proposal content validation", () => {
  const f = contentProposalFixture();
  try {
    expect(validateLiveRestoreProposal(f.capture, f.bytes, policy, f.input).content.candidateDigest).toBe(hash(f.bytes.candidateBytes));
    expect(() => validateLiveRestoreProposal({...f.capture, selected: f.capture.accepted, accepted: f.capture.selected} as never, f.bytes, policy, f.input)).toThrow();
    expect(f.raw.prepare("SELECT admission_state FROM sync_relay_live_documents").get()!.admission_state).toBe("closed");
  } finally {f.close();}
});

const proposalTable = "sync_relay_live_restore_proposals";
const proposalRows = (f: Pick<ReturnType<typeof contentProposalFixture>,"raw"|"journalRows">) => ({...f.journalRows(),
  proposals: f.raw.prepare(`SELECT * FROM ${proposalTable}`).all(),
  operations: f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(),
  documents: f.raw.prepare("SELECT * FROM sync_relay_live_documents").all()});

it("persists a generated owner rewrite with two retained native updates and refuses missing or changed pending bytes", () => {
  const f = contentProposalFixture("owner", "device", true);
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined, closed = false;
  try {
    const before = proposalRows(f);
    expect(decodeNativeRestoreProposal(f.encoded, f.input).bytes.nativeSourceBytes).toEqual(f.bytes.nativeSourceBytes);
    const altered = f.bytes.nativeSourceBytes.map(bytes => bytes.slice());altered[0]![0] ^= 1;
    for (const nativeSourceBytes of [altered, [f.bytes.nativeSourceBytes[1]!, f.bytes.nativeSourceBytes[0]!]]) {
      const bad = encodeNativeRestoreProposal(JSON.stringify(f.receipt), {...f.bytes, nativeSourceBytes}, f.input);
      expect(() => f.store.recordStopRestoreProposal(f.input, bad, policy, 200)).toThrow();
      expect(proposalRows(f)).toEqual(before);
    }
    const omitted = {...f.receipt, nativeSources: [], nativeSourceManifestDigest: jsonHash([f.receipt.fence, []])};
    const noNative = encodeNativeRestoreProposal(JSON.stringify(omitted), {...f.bytes, nativeSourceBytes: []}, f.input);
    expect(() => f.store.recordStopRestoreProposal(f.input, noNative, policy, 200)).toThrow(/frozen context/);
    expect(proposalRows(f)).toEqual(before);
    const recorded = f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
    expect(recorded.replayed).toBe(false);
    expect(f.store.readStopRestoreProposal(f.input, policy)!.receipt.nativeSources).toEqual(f.receipt.nativeSources);
    f.close();closed = true;
    reopened = openSyncRelayStorage(f.path);
    const store = reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace: "restore-test", reconciled: true}));
    expect(store.readStopRestoreProposal(f.input, policy)!.bytes).toEqual(f.encoded);
    expect(store.recordStopRestoreProposal(f.input, f.encoded, policy, 201)).toEqual({...recorded, replayed: true});
  } finally {if (!closed) f.close();reopened?.close();}
});

it.each([
  {actorKind: "unknown", chainDepth: 0}, {actorKind: "agent", chainDepth: 65},
  {actorKind: "agent", chainDepth: null}, {actorKind: null, chainDepth: 0},
  {actorKind: null, chainDepth: null, onBehalfOf: "owner"},
])("refuses native provenance outside the engine contract: %j", patch => {
  const f = contentProposalFixture("owner", "device", true);
  try {
    const receipt = structuredClone(f.receipt), native = receipt.nativeSources[0]!;
    Object.assign(native.source.origin, patch);
    native.appendKey = `adopted-local:${jsonHash(native.source)}`;
    receipt.nativeSourceManifestDigest = jsonHash([receipt.fence, receipt.nativeSources]);
    expect(() => parseNativeRestoreProposalReceipt(JSON.stringify(receipt), f.input)).toThrow();
    expect(proposalRows(f).proposals).toEqual([]);
  } finally {f.close();}
});

it("accepts native human, agent, automation and absent attribution at their depth boundaries", () => {
  const f = contentProposalFixture("owner", "device", true);
  try {
    for (const patch of [{actorKind: "human", chainDepth: 0, onBehalfOf: null},
      {actorKind: "agent", chainDepth: 64, onBehalfOf: "owner"}, {actorKind: "automation", chainDepth: 1, onBehalfOf: null},
      {actorKind: null, chainDepth: null, onBehalfOf: null}]) {
      const receipt = structuredClone(f.receipt), native = receipt.nativeSources[0]!;
      Object.assign(native.source.origin, patch);native.appendKey = `adopted-local:${jsonHash(native.source)}`;
      receipt.nativeSourceManifestDigest = jsonHash([receipt.fence, receipt.nativeSources]);
      expect(parseNativeRestoreProposalReceipt(JSON.stringify(receipt), f.input).nativeSources[0]!.source.origin).toMatchObject(patch);
    }
  } finally {f.close();}
});

it.each([["bootstrap", "service"], ["bootstrap", "device"], ["owner", "service"], ["owner", "device"]] as const)(
  "persists the generated %s proposal on %s and replays its bytes after relay restart", (kind, mode) => {
    const f = contentProposalFixture(kind, mode);
    let reopened: ReturnType<typeof openSyncRelayStorage> | undefined, closed = false;
    try {
      expect(f.store.readStopRestoreProposal(f.input, policy)).toBeNull();
      const before = proposalRows(f);
      const recorded = f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
      expect(recorded).toEqual({proposalDigest: hash(f.encoded), candidateDigest: hash(f.bytes.candidateBytes), recordedAtMs: 200, replayed: false});
      const after = proposalRows(f), row = after.proposals[0]!;
      expect(after.journal).toEqual(before.journal);
      expect(after.operations).toEqual(before.operations);
      expect(after.documents).toEqual(before.documents);
      expect(after.usage).toBe(Number(before.usage) + Number(row.accounted_bytes));
      expect(row.proposal_bytes).toEqual(f.encoded);
      expect(f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 1_000_000)).toEqual({...recorded, replayed: true});
      expect(proposalRows(f)).toEqual(after);
      const read = f.store.readStopRestoreProposal(f.input, policy)!;
      expect(read).toMatchObject({bytes: f.encoded, receipt: f.receipt, proposalDigest: recorded.proposalDigest, recordedAtMs: 200});
      read.bytes.fill(0);
      expect(f.store.readStopRestoreProposal(f.input, policy)!.bytes).toEqual(f.encoded);
      f.close();closed = true;
      reopened = openSyncRelayStorage(f.path);
      const store = reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace: "restore-test", reconciled: true}));
      expect(store.readStopRestoreProposal(f.input, policy)!.bytes).toEqual(f.encoded);
      expect(store.recordStopRestoreProposal(f.input, f.encoded, policy, 999)).toEqual({...recorded, replayed: true});
      expect((reopened as StorageContext).db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage").get()!.usage_bytes).toBe(after.usage);
    } finally {if (!closed) f.close();reopened?.close();}
  });

it("charges the full framed proposal exactly once and refuses one byte beyond workspace quota", () => {
  const f = contentProposalFixture();
  try {
    const digest = hash(f.encoded), candidate = hash(f.bytes.candidateBytes), at = 200;
    const charge = f.encoded.byteLength + Buffer.byteLength(JSON.stringify(["restore-test", "restore", "workspace", digest, candidate, at, Number.MAX_SAFE_INTEGER, "f".repeat(64)]));
    const before = proposalRows(f);
    f.context.options.workspaceQuotaBytes = Number(before.usage) + charge - 1;
    expect(() => f.store.recordStopRestoreProposal(f.input, f.encoded, policy, at)).toThrow(/quota/);
    expect(proposalRows(f)).toEqual(before);
    f.context.options.workspaceQuotaBytes++;
    f.store.recordStopRestoreProposal(f.input, f.encoded, policy, at);
    expect(f.journalRows().usage).toBe(f.context.options.workspaceQuotaBytes);
    expect(f.raw.prepare(`SELECT accounted_bytes FROM ${proposalTable}`).get()!.accounted_bytes).toBe(charge);
    expect(f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 201).replayed).toBe(true);
    expect(f.journalRows().usage).toBe(f.context.options.workspaceQuotaBytes);
  } finally {f.close();}
});

it.each(["before-insert", "after-insert", "ignored-insert", "ignored-usage", "failed-usage"])(
  "rolls back proposal and quota changes after %s", boundary => {
    const f = contentProposalFixture();
    try {
      const usage = boundary.endsWith("usage"), timing = boundary === "after-insert" ? "AFTER" : "BEFORE";
      const action = boundary.startsWith("ignored") ? "IGNORE" : "ABORT,'injected proposal failure'";
      f.raw.exec(`CREATE TRIGGER reject_proposal ${timing} ${usage ? "UPDATE ON sync_relay_workspace_usage" : `INSERT ON ${proposalTable}`} BEGIN SELECT RAISE(${action}); END`);
      const before = proposalRows(f);
      expect(() => f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200)).toThrow();
      expect(proposalRows(f)).toEqual(before);
      f.raw.exec("DROP TRIGGER reject_proposal");
      expect(f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200).replayed).toBe(false);
    } finally {f.close();}
  });

it.each(["bytes", "proposal digest", "candidate digest", "charge", "recorded time", "same-width recorded time"])(
  "rejects corrupted stored proposal %s on read and replay without mutation", damage => {
    const f = contentProposalFixture();
    try {
      f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
      if (damage === "bytes") {const bad = f.encoded.slice();bad[bad.length - 1] ^= 1;f.raw.prepare(`UPDATE ${proposalTable} SET proposal_bytes=?`).run(bad);}
      if (damage === "proposal digest") f.raw.prepare(`UPDATE ${proposalTable} SET proposal_sha256=?`).run("f".repeat(64));
      if (damage === "candidate digest") f.raw.prepare(`UPDATE ${proposalTable} SET candidate_sha256=?`).run("f".repeat(64));
      if (damage === "charge") f.raw.exec(`UPDATE ${proposalTable} SET accounted_bytes=accounted_bytes-1`);
      if (damage === "recorded time") f.raw.exec(`UPDATE ${proposalTable} SET recorded_at_ms=1000000`);
      if (damage === "same-width recorded time") f.raw.exec(`UPDATE ${proposalTable} SET recorded_at_ms=999`);
      const before = proposalRows(f);
      expect(() => f.store.readStopRestoreProposal(f.input, policy)).toThrow();
      expect(() => f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 201)).toThrow();
      expect(proposalRows(f)).toEqual(before);
    } finally {f.close();}
  });

it("captures restore proposal budgets once before validation and persistence", () => {
  const f = contentProposalFixture();
  try {
    const reads = new Map<string, number>();
    const input = new Proxy(f.input, {get(target, key, receiver) {
      if (key === "maxBytes" || key === "maxEvents") {
        const count = (reads.get(key) ?? 0) + 1;reads.set(key, count);
        if (count > 1) throw new Error("caller budget was reread");
      }
      return Reflect.get(target, key, receiver);
    }});
    expect(f.store.recordStopRestoreProposal(input, f.encoded, policy, 200).replayed).toBe(false);
    expect(reads).toEqual(new Map([["maxBytes", 1], ["maxEvents", 1]]));
  } finally {f.close();}
});

it("refuses a second proposal for the operation and bounded or foreign reads without mutation", () => {
  const f = contentProposalFixture();
  try {
    f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
    const before = proposalRows(f);
    const changed = encodeNativeRestoreProposal(JSON.stringify({...f.receipt, finalContentDigest: "e".repeat(64)}), f.bytes, f.input);
    expect(() => f.store.recordStopRestoreProposal(f.input, changed, policy, 201)).toThrow();
    for (const patch of [{maxBytes: f.encoded.byteLength - 1}, {maxEvents: 1}, {ownerUserId: "foreign"},
      {workspaceId: "foreign"}, {host: {...f.input.host, connectionId: "foreign"}}]) {
      expect(() => f.store.readStopRestoreProposal({...f.input, ...patch}, policy)).toThrow();
      expect(() => f.store.recordStopRestoreProposal({...f.input, ...patch}, f.encoded, policy, 201)).toThrow();
    }
    expect(proposalRows(f)).toEqual(before);
  } finally {f.close();}
});

it("checks stored proposal length before materializing an oversized saved payload on read or replay", () => {
  const f = contentProposalFixture();
  try {
    f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
    f.raw.prepare(`UPDATE ${proposalTable} SET proposal_bytes=zeroblob(?)`).run(f.input.maxBytes + 1);
    const before = proposalRows(f), prepare = vi.spyOn(f.context.db, "prepare");
    expect(() => f.store.readStopRestoreProposal(f.input, policy)).toThrow(/bounds/);
    expect(() => f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 201)).toThrow();
    const proposalReads = prepare.mock.calls.map(([sql]) => sql).filter(sql => sql.includes(`FROM ${proposalTable}`));
    expect(proposalReads).toHaveLength(2);
    expect(proposalReads.every(sql => sql.includes("length(proposal_bytes)"))).toBe(true);
    prepare.mockRestore();
    expect(proposalRows(f)).toEqual(before);
  } finally {vi.restoreAllMocks();f.close();}
});

it("rechecks closed admission inside the proposal write transaction and rolls back late authority drift", () => {
  const f = contentProposalFixture();
  try {
    const before = proposalRows(f), transaction = f.context.tx.bind(f.context);
    vi.spyOn(f.context, "tx").mockImplementationOnce(run => transaction(() => {
      f.context.db.prepare("UPDATE sync_relay_live_documents SET admission_state='open'").run();
      return run();
    }));
    expect(() => f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200)).toThrow();
    expect(proposalRows(f)).toEqual(before);
  } finally {vi.restoreAllMocks();f.close();}
});

it("frames exact byte views, snapshots caller storage, and refuses truncation, invalid UTF-8, trailing data and shared buffers", () => {
  const f = contentProposalFixture();
  try {
    const container = new Uint8Array(f.encoded.length + 2);container.set(f.encoded, 1);
    const view = container.subarray(1, -1), decoded = decodeNativeRestoreProposal(view, {...f.input, maxBytes: view.length});
    expect(decoded.bytes).toEqual(f.bytes);
    expect(decoded.receipt).toEqual(f.receipt);
    container.fill(0);
    expect(decoded.captured).toEqual(f.encoded);
    for (const bad of [f.encoded.subarray(0, 3), f.encoded.subarray(0, f.encoded.length - 1),
      Uint8Array.from([...f.encoded, 0]), new Uint8Array(new SharedArrayBuffer(f.encoded.length))]) {
      expect(() => decodeNativeRestoreProposal(bad, f.input)).toThrow();
    }
    const utf8 = f.encoded.slice();utf8[4] = 255;
    expect(() => decodeNativeRestoreProposal(utf8, f.input)).toThrow();
    const length = f.encoded.slice();new DataView(length.buffer).setUint32(0, 0xffff_ffff, true);
    expect(() => decodeNativeRestoreProposal(length, f.input)).toThrow();
    expect(() => decodeNativeRestoreProposal(f.encoded, {...f.input, maxBytes: f.encoded.length - 1})).toThrow();
    expect(() => encodeNativeRestoreProposal(JSON.stringify(f.receipt), f.bytes, {...f.input, maxBytes: f.encoded.length - 1})).toThrow();
    expect(() => encodeNativeRestoreProposal(JSON.stringify(f.receipt), {...f.bytes, candidateBytes: new Uint8Array(new SharedArrayBuffer(2))}, f.input)).toThrow();
    expect(() => encodeNativeRestoreProposal(JSON.stringify(f.receipt), {...f.bytes, nativeSourceBytes: [Uint8Array.of(0, 0)]}, f.input)).toThrow();
  } finally {f.close();}
});

it.each(["table", "index", "parent"])("rejects damaged proposal schema %s", damage => {
  const f = contentProposalFixture();
  try {
    f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
    if (damage === "table") f.raw.exec(`DROP TABLE ${proposalTable}`);
    if (damage === "index") f.raw.exec(`CREATE INDEX unexpected_proposal ON ${proposalTable}(recorded_at_ms)`);
    if (damage === "parent") {
      f.raw.exec("PRAGMA foreign_keys=OFF");f.raw.exec(`UPDATE ${proposalTable} SET operation_id='missing'`);f.raw.exec("PRAGMA foreign_keys=ON");
    }
    expect(() => initializeLiveRestoreOperationSchema(f.context.db)).toThrow(/damaged/);
  } finally {f.close();}
});

it("workspace deletion removes the proposal and its usage row through existing cascades", () => {
  const f = contentProposalFixture();
  try {
    f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
    f.write(db => {db.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id='workspace'").run();});
    expect(f.raw.prepare(`SELECT * FROM ${proposalTable}`).all()).toEqual([]);
    expect(f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all()).toEqual([]);
    expect(f.raw.prepare("SELECT * FROM sync_relay_workspace_usage").all()).toEqual([]);
  } finally {f.close();}
});

it("authenticates bounded native pending identities and refuses a different adoption or local head", () => {
  const f = proposalSourcesFixture("owner", "device");
  try {
    const binding = f.proposal.fence.operation.oldBinding, updateDigest = "e".repeat(64);
    const outboxId = `owner-outbox-${hash(Buffer.from(`${binding.workspaceId}\0${JSON.stringify(binding)}\0${binding.lineageClaimId}`))}`;
    const source = {binding, adoptionId: "adoption", nativeSequence: 9, updateDigest,
      origin: {kind: "nativeUpdate", actorOriginId: null, actorKind: null, onBehalfOf: null, chainDepth: null, recordedAtMs: 100}};
    const native = {outboxId, outboxSequence: 1, binding, appendKey: `adopted-local:${jsonHash(source)}`,
      deliveryId: `owner-delivery-${hash(Buffer.from(`${outboxId}\0${1}\0${updateDigest}`))}`, updateDigest,
      byteLength: 2, createdAtMs: 100, source, acceptedReceipt: null};
    const receipt = {...f.proposal, nativeSources: [native], nativeSourceManifestDigest: jsonHash([f.proposal.fence, [native]])};
    expect(parseNativeRestoreProposalReceipt(JSON.stringify(receipt), f.input).nativeSources).toHaveLength(1);
    for (const edit of [(s: typeof source) => {s.adoptionId = "other";}, (s: typeof source) => {s.nativeSequence = 12;}]) {
      const changed = structuredClone(receipt);edit(changed.nativeSources[0]!.source);
      changed.nativeSources[0]!.appendKey = `adopted-local:${jsonHash(changed.nativeSources[0]!.source)}`;
      changed.nativeSourceManifestDigest = jsonHash([changed.fence, changed.nativeSources]);
      expect(() => parseNativeRestoreProposalReceipt(JSON.stringify(changed), f.input)).toThrow();
    }
  } finally {f.close();}
});

function fixture(kind: "bootstrap" | "owner" = "bootstrap",mode: "service" | "device" = "device", baselineBytes?: Uint8Array) {
  const coordinate = {...host,mode}, f = registered({host: coordinate, baselineBytes}), context = f.storage as StorageContext;
  const history = createLiveJournalHistoryAuthority({namespace: "restore-test",reconciled: true});
  const store = f.storage.createLiveCommittedDeliveryStore(history), document = f.input.evidence.document;
  const intent: StopRestoreIntent = {deliveryKind: kind,operationId: "restore",ownerUserId: "owner",document,
    shareId: "share",grantId: "grant",expectedGrantGeneration: 4,expectedDependentGrantIds: [],expectedFence: 1,
    restorePointCursor: 0,restorePointReceiptDigest: document.lineageClaimId};
  const lookup = {operationId: "restore",workspaceId: "workspace",ownerUserId: "owner",host: coordinate};
  const add = (id: string) => {const result=f.storage.commitLiveUpdateJournal(f.capture(f.update(id,id),id)).result; if(result.kind!=="accepted")throw Error(result.kind); return result.receipt;};
  const fence = () => {beginStopRestore(context,intent,40); return advanceStopRestoreFence(context,lookup,50);};
  const open = () => {const result=store.openStopRestoreCut(lookup); if(result.kind!=="ready")throw Error(result.kind);return result.capture;};
  const adopt = () => {
    const cut=store.captureOwnerCut({host: coordinate,document,actor: f.actor,adoptionId: "adoption",expectedLocalSequence: 0,maxBytes: 1_000_000,maxEvents: 10});
    store.acknowledgeOwnerAdoption(cut,{adoptionId: "adoption",localYDocSequence: 0,terminalCursor: cut.cut.terminalReceipt?.journalCursor ?? 0,adoptionReplayed: false});
  };
  return {...f,journalCapture:f.capture,coordinate,context,history,store,document,intent,lookup,add,fence,open,adopt};
}
const bootstrapAck=(b: CommittedBootstrap)=>({bootstrapId:b.bootstrapId,bootstrapMomentId:b.bootstrapMomentId,
  baselineDigest:b.baselineDigest,baselineMomentRelaySequence:b.baselineMomentRelaySequence,localYDocSequence:0,bootstrapReplayed:false});
const applicationAck=(receipt: ReturnType<ReturnType<typeof fixture>["add"]>,sequence=1)=>({...receipt,localYDocSequence:sequence,applicationReplayed:false});

it.each(["service","device"] as const)("drains exact original bytes after fencing %s and retires all apply captures",mode=>{
  const f=fixture("bootstrap",mode);
  try {
    const one=f.add("one"), two=f.add("two"), original=f.journalRows().journal;
    const ordinary=f.store.open({host:f.coordinate,document:f.document});
    f.fence();
    expect(()=>f.store.next(ordinary)).toThrow();
    expect(()=>f.store.open({host:f.coordinate,document:f.document})).toThrow();
    const capture=f.open(), stale=f.open();
    expect(()=>f.store.completeStopRestoreCut(capture)).toThrow();
    const first=f.store.nextStopRestoreCut(capture);expect(first.kind).toBe("bootstrap");
    if(first.kind!=="bootstrap")throw Error();
    f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(first.baseline));
    for(const [index,receipt] of [one,two].entries()) {
      const step=f.store.nextStopRestoreCut(capture);expect(step.kind).toBe("next");if(step.kind!=="next")throw Error();
      expect(step.admitted.metadata.accepted.receipt).toEqual(receipt);
      expect(step.admitted.updateBytes).toEqual(original[index]!.update_bytes);
      expect(()=>f.store.acknowledgeStopRestoreApplication(capture,step.predecessor,{...applicationAck(receipt),updateDigest:"f".repeat(64)})).toThrow();
      f.store.acknowledgeStopRestoreApplication(capture,step.predecessor,applicationAck(receipt,index+1));
      f.store.acknowledgeStopRestoreApplication(capture,step.predecessor,applicationAck(receipt,index+1));
    }
    const usage=f.journalRows().usage, completed=f.store.completeStopRestoreCut(capture);
    expect(completed).toMatchObject({kind:"bootstrap",terminal:two,localYDocSequence:2});
    expect(f.store.completeStopRestoreCut(capture)).toEqual(completed);
    expect(f.store.openStopRestoreCut(f.lookup)).toEqual({kind:"complete",receipt:completed});
    expect(()=>f.store.nextStopRestoreCut(stale)).toThrow();
    expect(()=>f.store.acknowledgeStopRestoreApplication(capture,one,applicationAck(two,2))).toThrow();
    expect(f.journalRows().usage).toBe(usage);
    expect(f.journalRows().journal).toEqual(original);
    expect(readStopRestore(f.context,f.lookup)?.phase).toBe("old-cut-applied");
  }finally{f.close();}
});

it.each(["bootstrap","owner"] as const)("requires durable %s acknowledgement even for an empty cut",kind=>{
  const f=fixture(kind);
  try{
    if(kind==="owner")f.adopt();
    f.fence();const capture=f.open();
    if(kind==="bootstrap") {
      expect(()=>f.store.completeStopRestoreCut(capture)).toThrow();
      const step=f.store.nextStopRestoreCut(capture);if(step.kind!=="bootstrap")throw Error();
      f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(step.baseline));
    }
    expect(f.store.completeStopRestoreCut(capture)).toMatchObject({kind,terminal:null,localYDocSequence:0});
  }finally{f.close();}
});

it("keeps an unadopted owner waiting and refuses a different delivery kind on replay",()=>{
  const f=fixture("owner");
  try{
    f.fence();expect(f.store.openStopRestoreCut(f.lookup)).toEqual({kind:"waiting"});
    expect(()=>beginStopRestore(f.context,{...f.intent,deliveryKind:"bootstrap"},60)).toThrow();
    expect(()=>f.adopt()).toThrow();
    expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_delivery_bootstraps").get()!.n).toBe(0);
  }finally{f.close();}
});

it("uses existing owner progress and never bootstraps over its document",()=>{
  const f=fixture("owner");
  try{
    f.adopt();const one=f.add("one"),two=f.add("two");
    const ordinary=f.store.openOwnerDelivery({host:f.coordinate,document:f.document,actor:f.actor});
    f.store.acknowledgeOwnerDeliveryApplication(ordinary,applicationAck(one,1));
    f.fence();expect(()=>f.store.nextOwnerApplication(ordinary)).toThrow();
    const capture=f.open(),step=f.store.nextStopRestoreCut(capture);expect(step.kind).toBe("next");if(step.kind!=="next")throw Error();
    expect(step.predecessor).toEqual(one);expect(step.admitted.metadata.accepted.receipt).toEqual(two);
    f.store.acknowledgeStopRestoreApplication(capture,one,applicationAck(two,2));
    expect(f.store.completeStopRestoreCut(capture)).toMatchObject({kind:"owner",sourceId:"adoption",terminal:two});
    expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_delivery_bootstraps").get()!.n).toBe(0);
  }finally{f.close();}
});

it("refuses bootstrap initiation when a durable owner origin already exists",()=>{
  const f=fixture();try{f.adopt();expect(()=>f.fence()).toThrow();expect(f.storage.getShareGrant("grant")?.status).toBe("active");}finally{f.close();}
});

it("refuses an existing owner origin with a different share binding before revocation",()=>{
  const f=fixture("owner");try{
    f.adopt();
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('other-share','workspace','owner',?,0)")
      .run(JSON.stringify({paths:["docs/a.md"],versionId:null}));
    f.raw.exec("INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES ('other-grant','other-share','user','other-reader',NULL,'edit',4,'active',0,NULL,NULL)");
    const intent={...f.intent,shareId:"other-share",grantId:"other-grant"};
    const before={usage:f.journalRows().usage,owner:f.raw.prepare("SELECT * FROM sync_relay_live_delivery_owners").all()};
    expect(()=>beginStopRestore(f.context,intent,40)).toThrow();
    expect(f.storage.getShareGrant("other-grant")?.status).toBe("active");
    expect(f.storage.getShareGrant("grant")?.status).toBe("active");
    expect(readStopRestore(f.context,f.lookup)).toBeNull();
    expect(f.raw.prepare("SELECT admission_state,restore_fence_generation FROM sync_relay_live_documents").get()).toEqual({admission_state:"open",restore_fence_generation:1});
    expect({usage:f.journalRows().usage,owner:f.raw.prepare("SELECT * FROM sync_relay_live_delivery_owners").all()}).toEqual(before);
  }finally{f.close();}
});

it.each(["relayDatabaseNamespace","sourceMomentId","sourceDigest","sourceByteLength","baselineMomentRelaySequence","baselineRegisteredAtMs"])("refuses incompatible existing owner %s before revocation",field=>{
  const f=fixture("owner");try{
    f.adopt();const row=f.raw.prepare("SELECT origin_json FROM sync_relay_live_delivery_owners").get()!;
    const origin=JSON.parse(String(row.origin_json));origin[field]=typeof origin[field]==="number"?origin[field]+1:"different";
    f.raw.prepare("UPDATE sync_relay_live_delivery_owners SET origin_json=?").run(JSON.stringify(origin));
    const usage=f.journalRows().usage;
    expect(()=>beginStopRestore(f.context,f.intent,40)).toThrow();
    expect(f.storage.getShareGrant("grant")?.status).toBe("active");
    expect(readStopRestore(f.context,f.lookup)).toBeNull();
    expect(f.journalRows().usage).toBe(usage);
    expect(f.raw.prepare("SELECT admission_state,restore_fence_generation FROM sync_relay_live_documents").get()).toEqual({admission_state:"open",restore_fence_generation:1});
  }finally{f.close();}
});

it.each(["owner","selector","baseline","registration","host","path"])("refuses %s drift before allocating the fence",damage=>{
  const f=fixture();try{
    beginStopRestore(f.context,f.intent,40);
    const sql={owner:"UPDATE sync_relay_workspaces SET owner_user_id='other'",selector:"UPDATE sync_relay_shares SET selector_json='{"+"\"paths\":[\"docs/a.md\"],\"versionId\":null}'",
      baseline:"UPDATE sync_relay_live_documents SET baseline_projected_sha256='"+"f".repeat(64)+"'",registration:"UPDATE sync_relay_live_documents SET registered_at_ms=11",
      host:"UPDATE sync_relay_session_host_control SET configured_host_id='other'",path:"UPDATE sync_relay_live_documents SET current_path='docs/renamed.md'"}[damage]!;
    f.raw.exec(sql);expect(()=>advanceStopRestoreFence(f.context,f.lookup,50)).toThrow();
    expect(f.raw.prepare("SELECT admission_state,restore_fence_generation FROM sync_relay_live_documents").get()).toMatchObject({admission_state:"open",restore_fence_generation:1});
  }finally{f.close();}
});

it.each(["owner","namespace","host","phase"])("rechecks %s for every continuation",damage=>{
  const f=fixture();try{
    f.fence();const capture=f.open();
    if(damage==="owner")f.raw.exec("UPDATE sync_relay_workspaces SET owner_user_id='other'");
    if(damage==="namespace")f.history.markUnreconciled();
    if(damage==="host")f.raw.exec("UPDATE sync_relay_session_host_control SET registered_connection_id='other'");
    if(damage==="phase")f.raw.exec("UPDATE sync_relay_live_documents SET admission_state='open'");
    expect(()=>f.store.nextStopRestoreCut(capture)).toThrow();expect(()=>f.store.completeStopRestoreCut(capture)).toThrow();
  }finally{f.close();}
});

for(const action of ["bootstrap-next","bootstrap-origin-ack","bootstrap-update-ack","bootstrap-complete","owner-next","owner-update-ack","owner-complete"] as const) {
  it.each(["owner","host","baseline","phase"])(`${action} refuses %s drift at its inner authority check`,damage=>{
    const kind=action.startsWith("owner")?"owner":"bootstrap",f=fixture(kind);
    try{
      if(kind==="owner")f.adopt();const terminal=f.add("one");f.fence();const capture=f.open();
      const first=f.store.nextStopRestoreCut(capture);
      if(first.kind==="bootstrap" && action!=="bootstrap-origin-ack")f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(first.baseline));
      if(action.endsWith("complete"))f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(terminal));
      const invoke=()=>{
        if(action.endsWith("next"))return f.store.nextStopRestoreCut(capture);
        if(action==="bootstrap-origin-ack") {if(first.kind!=="bootstrap")throw Error("missing baseline");return f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(first.baseline));}
        if(action.endsWith("update-ack"))return f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(terminal));
        return f.store.completeStopRestoreCut(capture);
      };
      if(damage==="owner")f.raw.exec("UPDATE sync_relay_workspaces SET owner_user_id='other'");
      if(damage==="host")f.raw.exec("UPDATE sync_relay_session_host_control SET registered_connection_id='other'");
      if(damage==="baseline")f.raw.exec("UPDATE sync_relay_live_documents SET baseline_bytes=X'00'");
      if(damage==="phase")f.raw.exec("UPDATE sync_relay_live_documents SET admission_state='open'");
      const usage=f.journalRows().usage;
      expect(invoke).toThrow();
      expect(f.journalRows().usage).toBe(usage);
      expect(f.raw.prepare("SELECT phase FROM sync_relay_live_restore_operations").get()?.phase).toBe("fenced");
    }finally{f.close();}
  });
}

it("rejects forged captures and changed returned bindings",()=>{
  const f=fixture();try{
    f.fence();const capture=f.open(),copy={...capture} as StopRestoreCutCapture;
    expect(()=>f.store.nextStopRestoreCut(copy)).toThrow();
    Object.assign(capture.binding,{currentPath:"other.md"});
    expect(f.store.nextStopRestoreCut(capture)).toMatchObject({kind:"bootstrap",baseline:{binding:{currentPath:"docs/a.md"}}});
  }finally{f.close();}
});

it.each(["bootstrap","owner"] as const)("resumes %s after relay ACK with lost reply and completion reopen",kind=>{
  const f=fixture(kind);let reopened:ReturnType<typeof openSyncRelayStorage>|undefined;let closed=false;
  try{
    if(kind==="owner")f.adopt();
    const terminal=f.add("one");f.fence();const capture=f.open();
    const first=f.store.nextStopRestoreCut(capture);
    if(first.kind==="bootstrap")f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(first.baseline));
    f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(terminal,1));
    f.close();closed=true;
    const connect=()=>{reopened=openSyncRelayStorage(f.path);return reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace:"restore-test",reconciled:true}));};
    let store=connect(),opened=store.openStopRestoreCut(f.lookup);if(opened.kind!=="ready")throw Error(opened.kind);
    expect(store.nextStopRestoreCut(opened.capture)).toMatchObject({kind:"done",terminalReceipt:terminal});
    const completed=store.completeStopRestoreCut(opened.capture);
    reopened!.close();reopened=undefined;
    store=connect();expect(store.openStopRestoreCut(f.lookup)).toEqual({kind:"complete",receipt:completed});
    expect(()=>store.openStopRestoreCut({...f.lookup,ownerUserId:"other"})).toThrow();
  }finally{if(!closed)f.close();reopened?.close();}
});

it("requires the original namespace after a process reopen",()=>{
  const f=fixture();let reopened:ReturnType<typeof openSyncRelayStorage>|undefined;let closed=false;
  try{f.fence();f.close();closed=true;reopened=openSyncRelayStorage(f.path);
    const store=reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace:"foreign",reconciled:true}));
    expect(()=>store.openStopRestoreCut(f.lookup)).toThrow();
  }finally{if(!closed)f.close();reopened?.close();}
});

it.each(["bootstrap","owner"] as const)("finishes precharged %s receipts with exhausted workspace quota",kind=>{
  const f=fixture(kind);try{
    if(kind==="owner")f.adopt();const terminal=f.add("one");f.fence();
    f.raw.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=? WHERE workspace_id='workspace'").run(f.context.options.workspaceQuotaBytes);
    const capture=f.open(),first=f.store.nextStopRestoreCut(capture);
    if(first.kind==="bootstrap")f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(first.baseline));
    f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(terminal,1));
    const before=f.journalRows().usage;f.store.completeStopRestoreCut(capture);expect(f.journalRows().usage).toBe(before);
    const operation = f.store.pendingStopRestoreFence(f.lookup).operation;
    f.store.acknowledgeStopRestoreFence(f.lookup,{operation,localHeadSequence:operation.appliedSequence,recordedAtMs:100});
    expect(f.journalRows().usage).toBe(before);
  }finally{f.close();}
});

it("uses document receipt order across gaps in the global journal cursor",()=>{
  const f=fixture();try{
    const one=f.add("one");f.raw.exec("UPDATE sqlite_sequence SET seq=9 WHERE name='sync_relay_live_update_journal'");const two=f.add("two");
    expect(two.journalCursor).toBe(10);f.fence();const capture=f.open(),first=f.store.nextStopRestoreCut(capture);if(first.kind!=="bootstrap")throw Error();
    f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(first.baseline));
    expect(()=>f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(two,2))).toThrow();
    f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(one,1));
    expect(f.store.nextStopRestoreCut(capture)).toMatchObject({kind:"next",predecessor:one,admitted:{metadata:{accepted:{receipt:two}}}});
    f.store.acknowledgeStopRestoreApplication(capture,one,applicationAck(two,2));expect(f.store.completeStopRestoreCut(capture).terminal).toEqual(two);
  }finally{f.close();}
});

it("rolls back an ignored completion and refuses journal rows beyond the saved cut",()=>{
  const f=fixture();try{
    const terminal=f.add("one");f.fence();const capture=f.open(),first=f.store.nextStopRestoreCut(capture);if(first.kind!=="bootstrap")throw Error();
    f.store.acknowledgeStopRestoreBootstrap(capture,bootstrapAck(first.baseline));f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(terminal));
    f.raw.exec("CREATE TRIGGER ignore_completion BEFORE UPDATE ON sync_relay_live_restore_operations BEGIN SELECT RAISE(IGNORE); END");
    expect(()=>f.store.completeStopRestoreCut(capture)).toThrow();expect(readStopRestore(f.context,f.lookup)?.phase).toBe("fenced");
    f.raw.exec("DROP TRIGGER ignore_completion");
    f.raw.exec("PRAGMA foreign_keys=OFF; UPDATE sync_relay_live_update_journal SET journal_cursor=10; PRAGMA foreign_keys=ON");
    expect(()=>f.store.completeStopRestoreCut(capture)).toThrow();
  }finally{f.close();}
});

it("preserves a descending terminal ACK sequence separately from the owner high water across reopen",()=>{
  const f=fixture("owner");let reopened:ReturnType<typeof openSyncRelayStorage>|undefined;let closed=false;
  try{
    f.adopt();const one=f.add("one"),two=f.add("two");
    const ordinary=f.store.openOwnerDelivery({host:f.coordinate,document:f.document,actor:f.actor});
    f.store.acknowledgeOwnerDeliveryApplication(ordinary,applicationAck(one,9));
    f.store.acknowledgeOwnerDeliveryApplication(ordinary,applicationAck(two,2));
    expect(f.store.ownerDeliveryProgress(ordinary).sequence).toBe(9);
    expect(f.raw.prepare("SELECT tip_sequence,tip_application_sequence FROM sync_relay_live_delivery_owners").get()).toEqual({tip_sequence:9,tip_application_sequence:2});
    f.fence();f.close();closed=true;reopened=openSyncRelayStorage(f.path);
    const store=reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace:"restore-test",reconciled:true}));
    const opened=store.openStopRestoreCut(f.lookup);if(opened.kind!=="ready")throw Error(opened.kind);
    expect(store.nextStopRestoreCut(opened.capture)).toMatchObject({kind:"done",terminalReceipt:two});
    expect(store.completeStopRestoreCut(opened.capture)).toMatchObject({terminal:two,localYDocSequence:2});
    expect((reopened as StorageContext).db.prepare("SELECT tip_sequence,tip_application_sequence FROM sync_relay_live_delivery_owners").get()).toEqual({tip_sequence:9,tip_application_sequence:2});
  }finally{if(!closed)f.close();reopened?.close();}
});

it.each(["service","device"] as const)("replays the latest owner restore ACK on %s without changing durable progress or quota",mode=>{
  const f=fixture("owner",mode);let reopened:ReturnType<typeof openSyncRelayStorage>|undefined;let closed=false;
  try{
    f.adopt();const one=f.add("one");
    f.raw.exec("UPDATE sqlite_sequence SET seq=9 WHERE name='sync_relay_live_update_journal'");
    const two=f.add("two");f.fence();const capture=f.open();
    f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(one,9));
    const state=(context:StorageContext)=>({
      owner:context.db.prepare("SELECT * FROM sync_relay_live_delivery_owners").all(),
      usage:context.db.prepare("SELECT * FROM sync_relay_workspace_usage").all(),
      reservations:context.db.prepare("SELECT * FROM sync_relay_live_delivery_reservations").all(),
    });
    const first=state(f.context);
    f.store.acknowledgeStopRestoreApplication(capture,null,{...applicationAck(one,9),applicationReplayed:true});
    expect(state(f.context)).toEqual(first);
    f.store.acknowledgeStopRestoreApplication(capture,one,applicationAck(two,2));
    const terminal=state(f.context);
    f.store.acknowledgeStopRestoreApplication(capture,one,applicationAck(two,2));
    expect(()=>f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(one,9))).toThrow();
    expect(()=>f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(two,2))).toThrow();
    expect(()=>f.store.acknowledgeStopRestoreApplication(capture,{...one,updateDigest:"f".repeat(64)},applicationAck(two,2))).toThrow();
    expect(()=>f.store.acknowledgeStopRestoreApplication(capture,one,applicationAck(two,9))).toThrow();
    expect(state(f.context)).toEqual(terminal);
    f.close();closed=true;reopened=openSyncRelayStorage(f.path);
    const context=reopened as StorageContext;
    const store=reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace:"restore-test",reconciled:true}));
    const opened=store.openStopRestoreCut(f.lookup);if(opened.kind!=="ready")throw Error(opened.kind);
    store.acknowledgeStopRestoreApplication(opened.capture,one,{...applicationAck(two,2),applicationReplayed:true});
    expect(state(context)).toEqual(terminal);
    expect(store.completeStopRestoreCut(opened.capture)).toMatchObject({terminal:two,localYDocSequence:2});
  }finally{if(!closed)f.close();reopened?.close();}
});

it("rolls back owner ACK reservation and quota changes when its progress UPDATE is ignored",()=>{
  const f=fixture("owner");try{
    f.adopt();const terminal=f.add("one");f.fence();const capture=f.open();
    const owner=f.raw.prepare("SELECT * FROM sync_relay_live_delivery_owners").all();
    const reservations=f.raw.prepare("SELECT * FROM sync_relay_live_delivery_reservations").all();
    const usage=f.journalRows().usage;
    f.raw.exec("CREATE TRIGGER ignore_owner_ack BEFORE UPDATE ON sync_relay_live_delivery_owners BEGIN SELECT RAISE(IGNORE); END");
    expect(()=>f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(terminal))).toThrow();
    expect(f.raw.prepare("SELECT * FROM sync_relay_live_delivery_owners").all()).toEqual(owner);
    expect(f.raw.prepare("SELECT * FROM sync_relay_live_delivery_reservations").all()).toEqual(reservations);
    expect(f.journalRows().usage).toBe(usage);
    f.raw.exec("DROP TRIGGER ignore_owner_ack");
    f.store.acknowledgeStopRestoreApplication(capture,null,applicationAck(terminal));
    expect(f.store.completeStopRestoreCut(capture).terminal).toEqual(terminal);
  }finally{f.close();}
});

function readyNativeFence(kind: "bootstrap" | "owner", mode: "service" | "device", events = false) {
  const f = fixture(kind, mode);
  if (kind === "owner") f.adopt();
  const receipts = events ? [f.add("first"), f.add("last")] : [];
  f.fence();
  const capture = f.open();
  if (kind === "bootstrap") {
    const next = f.store.nextStopRestoreCut(capture);
    if (next.kind !== "bootstrap") throw Error(next.kind);
    f.store.acknowledgeStopRestoreBootstrap(capture, bootstrapAck(next.baseline));
  }
  for (const [index, receipt] of receipts.entries()) {
    f.store.acknowledgeStopRestoreApplication(capture, receipts[index - 1] ?? null, applicationAck(receipt, index === 0 ? 9 : 2));
  }
  f.store.completeStopRestoreCut(capture);
  const operation = f.store.pendingStopRestoreFence(f.lookup).operation;
  const receipt: NativeRestoreFenceReceipt = {operation, localHeadSequence: 11, recordedAtMs: 100};
  return {...f, capture, receipt};
}

function ownerOriginProofFixture(mode: "service" | "device" = "device") {
  const f = fixture("owner", mode);
  const point = f.add("point"), adoptedTip = f.add("adopted-tip");
  const original = f.store.captureOwnerCut({host: f.coordinate, document: f.document, actor: f.actor,
    adoptionId: "adoption", expectedLocalSequence: 7, maxBytes: 1_000_000, maxEvents: 10});
  f.store.acknowledgeOwnerAdoption(original, {adoptionId: "adoption", localYDocSequence: 7,
    terminalCursor: adoptedTip.journalCursor, adoptionReplayed: false});
  const later = f.add("after-adoption");
  f.intent.restorePointCursor = point.journalCursor;
  f.intent.restorePointReceiptDigest = point.updateDigest;
  f.fence();
  const drain = f.open();
  f.store.acknowledgeStopRestoreApplication(drain, adoptedTip, applicationAck(later, 8));
  f.store.completeStopRestoreCut(drain);
  const nativeReceipt = {operation: f.store.pendingStopRestoreFence(f.lookup).operation, localHeadSequence: 11, recordedAtMs: 100};
  const input = {...f.lookup, maxBytes: 1_000_000, maxEvents: 10};
  return {...f, original: structuredClone({binding: original.binding, cut: original.cut}), nativeReceipt, input};
}

it.each(["service", "device"] as const)("resolves the selected owner restore point from retained %s bytes, excluding later edits", mode => {
  const f = ownerOriginProofFixture(mode);
  try {
    expect(() => f.store.captureStopRestorePoint(f.input)).toThrow();
    f.store.acknowledgeStopRestoreFence(f.lookup, f.nativeReceipt);
    const before = f.journalRows();
    const capture = f.store.captureStopRestorePoint(f.input);
    expect(capture.binding.selectorPaths).toEqual(["docs"]);
    expect(capture.checkpoint.cursor).toBe(0);
    expect(capture.events).toHaveLength(1);
    const point = resolveLiveRestorePoint(capture, policy);
    const expected = "---\npoint: point\n---\n\nHello";
    expect(point).toEqual({...capture.point, markdownDigest: hash(Buffer.from(expected)), projectionDigest: hash(Buffer.from(expected))});
    expect(point.markdownDigest).not.toBe(hash(Buffer.from(yDocToMarkdown(f.doc))));
    expect(f.journalRows()).toEqual(before);
    expect(() => resolveLiveRestorePoint(capture, {...policy, maxStructVisits: 1})).toThrow(/capacity-refused/);
  } finally {f.close();}
});

it("resolves a baseline restore point after native bootstrap fencing", () => {
  const f = readyNativeFence("bootstrap", "service", true);
  try {
    f.store.acknowledgeStopRestoreFence(f.lookup, f.receipt);
    const capture = f.store.captureStopRestorePoint({...f.lookup, maxBytes: 1_000_000, maxEvents: 10});
    expect(capture.binding.selectorPaths).toEqual(["docs/a.md"]);
    expect(capture.events).toHaveLength(0);
    expect(resolveLiveRestorePoint(capture, policy)).toEqual({journalCursor: 0, receiptDigest: f.intent.restorePointReceiptDigest,
      markdownDigest: hash(Buffer.from("Hello")), projectionDigest: hash(Buffer.from("Hello"))});
  } finally {f.close();}
});

it.each(["service", "device"] as const)("captures the frozen accepted %s cut separately from the chosen restore point", mode => {
  const f = ownerOriginProofFixture(mode);
  try {
    expect(() => f.store.captureStopRestoreAcceptedCut(f.input)).toThrow();
    f.store.acknowledgeStopRestoreFence(f.lookup, f.nativeReceipt);
    const before = f.journalRows();
    const selected = f.store.captureStopRestorePoint(f.input);
    const accepted = f.store.captureStopRestoreAcceptedCut(f.input);
    expect(selected.events).toHaveLength(1);
    expect(accepted.events).toHaveLength(3);
    expect(accepted.point).toEqual({journalCursor: f.nativeReceipt.operation.terminal!.journalCursor,
      receiptDigest: f.nativeReceipt.operation.terminal!.updateDigest});
    expect(accepted.target).toBe("accepted");
    expect(selected.target).toBe("selected");
    expect(() => resolveLiveRestorePoint(accepted as never, policy)).toThrow("selected history");
    const scratch = new Y.Doc({gc: false});
    try {
      Y.applyUpdate(scratch, accepted.checkpoint.bytes);
      for (const event of accepted.events) Y.applyUpdate(scratch, event.updateBytes);
      expect(yDocToMarkdown(scratch)).toBe(yDocToMarkdown(f.doc));
    } finally {scratch.destroy();}
    expect(f.journalRows()).toEqual(before);
    expect(() => f.store.captureStopRestoreAcceptedCut({...f.input, maxEvents: 2})).toThrow(/bounds/);
    accepted.events[0]!.updateBytes[0] ^= 1;
    expect(() => accepted.assertCurrent()).toThrow();
  } finally {f.close();}
});

it("captures the baseline as an empty accepted cut and refuses retired storage standing", () => {
  const f = readyNativeFence("bootstrap", "service");
  try {
    f.store.acknowledgeStopRestoreFence(f.lookup, f.receipt);
    const capture = f.store.captureStopRestoreAcceptedCut({...f.lookup, maxBytes: 1_000_000, maxEvents: 10});
    expect(capture.events).toHaveLength(0);
    expect(capture.point.journalCursor).toBe(0);
    expect(capture.point.receiptDigest).toBe(f.intent.restorePointReceiptDigest);
    expect(() => f.context.tx(() => f.context.db.exec("ROLLBACK"))).toThrow();
    expect(() => capture.assertCurrent()).toThrow();
  } finally {f.close();}
});

it("keeps exact source and canonical projection digests distinct for a restore point", () => {
  const source = "# Hello\n\n", doc = markdownToYDoc(source);
  const projection = yDocToMarkdown(doc), meta = doc.getMap("meta");
  meta.set("dohcMarkdownSource", source);
  meta.set("dohcMarkdownSourceSha256", hash(Buffer.from(source)));
  meta.set("dohcMarkdownSourceProjectionSha256", hash(Buffer.from(projection)));
  const baseline = Y.encodeStateAsUpdate(doc); doc.destroy();
  const f = fixture("bootstrap", "device", baseline);
  try {
    f.fence(); const drain = f.open(), next = f.store.nextStopRestoreCut(drain);
    if (next.kind !== "bootstrap") throw Error(next.kind);
    f.store.acknowledgeStopRestoreBootstrap(drain, bootstrapAck(next.baseline));
    f.store.completeStopRestoreCut(drain);
    const receipt = {operation: f.store.pendingStopRestoreFence(f.lookup).operation, localHeadSequence: 0, recordedAtMs: 100};
    f.store.acknowledgeStopRestoreFence(f.lookup, receipt);
    const point = resolveLiveRestorePoint(f.store.captureStopRestorePoint({...f.lookup, maxBytes: 1_000_000, maxEvents: 10}), policy);
    expect(point.markdownDigest).toBe(hash(Buffer.from(source)));
    expect(point.projectionDigest).toBe(hash(Buffer.from(projection)));
    expect(point.markdownDigest).not.toBe(point.projectionDigest);
  } finally {f.close();}
});

it("does not select a checkpoint after the chosen point", () => {
  const f = ownerOriginProofFixture();
  try {
    f.store.acknowledgeStopRestoreFence(f.lookup, f.nativeReceipt);
    const expected = resolveLiveRestorePoint(f.store.captureStopRestorePoint(f.input), policy);
    const future = Y.encodeStateAsUpdate(f.doc);
    f.raw.prepare("UPDATE sync_relay_live_update_journal SET validation_checkpoint_bytes=?,validation_checkpoint_sha256=? WHERE journal_cursor=(SELECT MAX(journal_cursor) FROM sync_relay_live_update_journal)").run(future, hash(future));
    const capture = f.store.captureStopRestorePoint(f.input);
    expect(capture.checkpoint.cursor).toBe(0);
    expect(resolveLiveRestorePoint(capture, policy)).toEqual(expected);
  } finally {f.close();}
});

it("resolves from a real 4095-cadence checkpoint and refuses its stale path or fence", () => {
  const f = fixture("bootstrap", "service");
  try {
    const receipts = [f.add("checkpoint")];
    const noop = Y.encodeStateAsUpdate(f.doc, Y.encodeStateVector(f.doc));
    expect([...noop]).toEqual([0, 0]);
    for (let index = 1; index < 4095; index++) {
      const committed = f.storage.commitLiveUpdateJournal(f.capture(noop, `checkpoint-noop-${index}`));
      if (committed.result.kind !== "accepted") throw Error(committed.result.kind);
      receipts.push(committed.result.receipt);
    }
    const cut = f.storage.readLiveUpdateJournalCut({document: f.document});
    expect(cut).toMatchObject({kind: "cut", cut: {highWater: 4095, checkpoint: {cursor: 4095}, suffixCount: 0}});
    if (cut.kind !== "cut") throw Error(cut.kind);
    const checkpoint = Uint8Array.from(cut.cut.checkpoint.bytes);
    const point = f.add("point"), expected = hash(Buffer.from(yDocToMarkdown(f.doc)));
    receipts.push(point, f.add("future"));
    f.intent.restorePointCursor = point.journalCursor;
    f.intent.restorePointReceiptDigest = point.updateDigest;
    f.fence();
    const drain = f.open(), first = f.store.nextStopRestoreCut(drain);
    if (first.kind !== "bootstrap") throw Error(first.kind);
    f.store.acknowledgeStopRestoreBootstrap(drain, bootstrapAck(first.baseline));
    for (const [index, receipt] of receipts.entries()) {
      f.store.acknowledgeStopRestoreApplication(drain, receipts[index - 1] ?? null, applicationAck(receipt, index + 1));
    }
    f.store.completeStopRestoreCut(drain);
    const nativeReceipt = {operation: f.store.pendingStopRestoreFence(f.lookup).operation, localHeadSequence: receipts.length, recordedAtMs: 100};
    f.store.acknowledgeStopRestoreFence(f.lookup, nativeReceipt);
    const input = {...f.lookup, maxBytes: 1_000_000, maxEvents: 10};
    const capture = f.store.captureStopRestorePoint(input);
    expect(capture.checkpoint).toEqual({cursor: 4095, bytes: checkpoint, digest: hash(checkpoint)});
    expect(capture.events.map(event => event.metadata.accepted.receipt)).toEqual([point]);
    expect(resolveLiveRestorePoint(capture, policy)).toEqual({journalCursor: point.journalCursor, receiptDigest: point.updateDigest,
      markdownDigest: expected, projectionDigest: expected});
    expect(expected).not.toBe(hash(Buffer.from(yDocToMarkdown(f.doc))));
    const original = f.raw.prepare("SELECT current_path,restore_fence_generation FROM sync_relay_live_update_journal WHERE journal_cursor=4095").get()!;
    const before = f.journalRows();
    for (const [column, value] of [["current_path", "docs/stale.md"], ["restore_fence_generation", 2]] as const) {
      try {
        f.raw.prepare(`UPDATE sync_relay_live_update_journal SET ${column}=? WHERE journal_cursor=4095`).run(value);
        expect(() => f.store.captureStopRestorePoint(input)).toThrow();
      } finally {
        f.raw.prepare(`UPDATE sync_relay_live_update_journal SET ${column}=? WHERE journal_cursor=4095`).run(original[column]!);
      }
    }
    expect(f.journalRows()).toEqual(before);
    expect(resolveLiveRestorePoint(f.store.captureStopRestorePoint(input), policy)).toEqual(resolveLiveRestorePoint(capture, policy));
  } finally {f.close();}
}, 1_800_000);

it("revalidates both restore proofs inside a write transaction and observes its uncommitted authority", () => {
  const f = ownerOriginProofFixture();
  try {
    f.store.acknowledgeStopRestoreFence(f.lookup, f.nativeReceipt);
    const proofs = [f.store.captureStopRestoreOwnerOrigin(f.input), f.store.captureStopRestorePoint(f.input)];
    const before = f.journalRows();
    expect(() => f.context.tx(() => {for (const proof of proofs) proof.assertCurrent();})).not.toThrow();
    expect(() => f.context.tx(() => {
      f.context.db.exec("UPDATE sync_relay_workspaces SET owner_user_id='other'");
      for (const proof of proofs) expect(() => proof.assertCurrent()).toThrow(/authority/);
      throw Error("rollback proof test");
    })).toThrow("rollback proof test");
    for (const proof of proofs) proof.assertCurrent();
    expect(f.journalRows()).toEqual(before);
  } finally {f.close();}
});

it("retires both captured proofs when relay durability becomes unavailable while SQLite stays open", () => {
  const f = ownerOriginProofFixture();
  try {
    f.store.acknowledgeStopRestoreFence(f.lookup, f.nativeReceipt);
    const proofs = [f.store.captureStopRestoreOwnerOrigin(f.input), f.store.captureStopRestorePoint(f.input)];
    // Losing the transaction before COMMIT makes the real write owner invalidate its standing.
    expect(() => f.context.tx(() => f.context.db.exec("ROLLBACK"))).toThrow();
    expect(f.context.db.prepare("SELECT 1 AS alive").get()).toEqual({alive: 1});
    expect(() => f.context.captureStanding()).toThrow("Relay storage is unavailable");
    for (const proof of proofs) expect(() => proof.assertCurrent()).toThrow("Relay storage is unavailable");
  } finally {f.close();}
});

it.each(["bytes", "authority", "receipt", "bound"])("refuses selected restore point %s drift", damage => {
  const f = ownerOriginProofFixture();
  try {
    f.store.acknowledgeStopRestoreFence(f.lookup, f.nativeReceipt);
    if (damage === "bound") {
      expect(() => f.store.captureStopRestorePoint({...f.input, maxBytes: 1})).toThrow(/bounds/);
      return;
    }
    const capture = f.store.captureStopRestorePoint(f.input);
    if (damage === "bytes") capture.events[0]!.updateBytes[0] ^= 1;
    if (damage === "authority") f.raw.exec("UPDATE sync_relay_live_documents SET admission_state='open'");
    if (damage === "receipt") capture.nativeReceipt.localHeadSequence++;
    expect(() => resolveLiveRestorePoint(capture, policy)).toThrow();
  } finally {f.close();}
});

it.each(["service", "device"] as const)("recovers compact owner origin evidence after %s fencing and relay restart", mode => {
  const f = ownerOriginProofFixture(mode);
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined, closed = false;
  try {
    expect(() => f.store.captureStopRestoreOwnerOrigin(f.input)).toThrow();
    f.store.acknowledgeStopRestoreFence(f.lookup, f.nativeReceipt);
    const before = f.journalRows();
    const captured = f.store.captureStopRestoreOwnerOrigin(f.input);
    expect(captured).toMatchObject({binding: f.original.binding, eventCount: 2, expectedLocalSequence: 7,
      terminalReceipt: f.original.cut.terminalReceipt, evidenceDigest: ownerOriginDigest(f.original)});
    expect(captured.point).toEqual({journalCursor: f.intent.restorePointCursor, receiptDigest: f.intent.restorePointReceiptDigest});
    expect(captured.nativeReceipt).toEqual(f.nativeReceipt);
    expect(() => f.store.acknowledgeOwnerAdoption(captured as never, {})).toThrow();
    const reads = vi.spyOn(f.context.db, "prepare");
    try {
      const bounded = f.store.captureStopRestoreOwnerOrigin({...f.input, maxEvents: 1});
      expect(bounded.evidenceDigest).toBe(captured.evidenceDigest);bounded.assertCurrent();bounded.assertCurrent();
      const journal = reads.mock.calls.map(([sql]) => sql).filter(sql => /FROM sync_relay_live_update_journal/.test(sql));
      expect(journal.length).toBeGreaterThan(0);
      expect(journal.every(sql => /journal_cursor=\?|ORDER BY journal_cursor DESC LIMIT 1/.test(sql))).toBe(true);
    } finally {reads.mockRestore();}
    expect(f.journalRows()).toEqual(before);
    captured.assertCurrent();
    f.close(); closed = true;
    reopened = openSyncRelayStorage(f.path);
    const store = reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace: "restore-test", reconciled: true}));
    const replay = store.captureStopRestoreOwnerOrigin(f.input);
    expect(replay).toMatchObject({binding: f.original.binding, eventCount: captured.eventCount, expectedLocalSequence: captured.expectedLocalSequence,
      evidenceDigest: captured.evidenceDigest, historyEvidenceDigest: captured.historyEvidenceDigest});
    expect(replay.nativeReceipt).toEqual(f.nativeReceipt);
  } finally {if (!closed) f.close(); reopened?.close();}
});

it.each(["bytes", "owner", "workspace", "host", "origin", "endpoint", "reopened"])("refuses an owner restore origin with %s drift without writes", damage => {
  const f = ownerOriginProofFixture();
  try {
    f.store.acknowledgeStopRestoreFence(f.lookup, f.nativeReceipt);
    const input: Parameters<typeof f.store.captureStopRestoreOwnerOrigin>[0] = structuredClone(f.input);
    if (damage === "bytes") input.maxBytes = 1;
    if (damage === "owner") input.ownerUserId = "foreign";
    if (damage === "workspace") input.workspaceId = "foreign";
    if (damage === "host") input.host = {...input.host, connectionId: "foreign"};
    if (damage === "origin") f.raw.exec("UPDATE sync_relay_live_delivery_owners SET origin_json=json_set(origin_json,'$.expectedLocalSequence',8)");
    if (damage === "endpoint") f.raw.prepare("UPDATE sync_relay_live_update_journal SET accepted_evidence_digest=? WHERE journal_cursor=?")
      .run("f".repeat(64), f.original.cut.terminalReceipt!.journalCursor);
    if (damage === "reopened") f.raw.exec("UPDATE sync_relay_live_documents SET admission_state='open'");
    const before = f.journalRows();
    expect(() => f.store.captureStopRestoreOwnerOrigin(input)).toThrow();
    expect(f.journalRows()).toEqual(before);
  } finally {f.close();}
});

it.each(["binding", "receipt", "point", "authority"])("invalidates a captured owner origin after %s changes", damage => {
  const f = ownerOriginProofFixture();
  try {
    f.store.acknowledgeStopRestoreFence(f.lookup, f.nativeReceipt);
    const capture = f.store.captureStopRestoreOwnerOrigin(f.input);
    if (damage === "binding") (capture.binding.selectorPaths as string[]).push("other");
    if (damage === "receipt") capture.nativeReceipt.localHeadSequence++;
    if (damage === "point") capture.point.journalCursor++;
    if (damage === "authority") f.raw.exec("UPDATE sync_relay_live_documents SET admission_state='open'");
    expect(() => capture.assertCurrent()).toThrow();
  } finally {f.close();}
});

it.each(["bootstrap", "owner"] as const)("records a funded native fence for %s and replays it after relay reopen", kind => {
  const f = readyNativeFence(kind, "device", true);
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined, closed = false;
  try {
    expect(f.receipt.operation.appliedSequence).toBe(2);
    const before = f.journalRows().usage;
    const operation = readStopRestore(f.context, f.lookup)!;
    expect(operation.phase).toBe("old-cut-applied");
    expect(operation.nativeReceipt).toBeNull();
    expect(f.store.acknowledgeStopRestoreFence(f.lookup, f.receipt)).toEqual(f.receipt);
    expect(f.journalRows().usage).toBe(before);
    expect(readStopRestore(f.context, f.lookup)).toMatchObject({phase: "native-fenced", nativeReceipt: f.receipt, applied: operation.applied});
    expect(() => f.store.nextStopRestoreCut(f.capture)).toThrow();
    expect(() => f.store.completeStopRestoreCut(f.capture)).toThrow();
    f.store.closeStopRestoreCut(f.capture);
    f.store.closeStopRestoreCut(f.capture);
    expect(() => f.store.nextStopRestoreCut(f.capture)).toThrow();
    if (kind === "owner") expect(f.raw.prepare("SELECT tip_sequence,tip_application_sequence FROM sync_relay_live_delivery_owners").get()).toMatchObject({tip_sequence: 9, tip_application_sequence: 2});
    f.close(); closed = true;
    reopened = openSyncRelayStorage(f.path);
    const store = reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace: "restore-test", reconciled: true}));
    expect(store.pendingStopRestoreFence(f.lookup)).toEqual({operation: f.receipt.operation, receipt: f.receipt});
    expect(store.acknowledgeStopRestoreFence(f.lookup, f.receipt)).toEqual(f.receipt);
    expect(() => store.acknowledgeStopRestoreFence(f.lookup, {...f.receipt, recordedAtMs: 101})).toThrow();
    expect((reopened as StorageContext).db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage").get()!.usage_bytes).toBe(before);
  } finally {if (!closed) f.close(); reopened?.close();}
});

it.each(["service", "device"] as const)("requires the durable empty-cut origin before native completion on %s", mode => {
  const f = readyNativeFence("bootstrap", mode);
  try {
    expect(f.receipt.operation.terminal).toBeNull();
    expect(f.receipt.operation.appliedSequence).toBe(0);
    expect(f.receipt.operation.origin.kind).toBe("bootstrap");
    expect(f.store.acknowledgeStopRestoreFence(f.lookup, f.receipt)).toEqual(f.receipt);
  } finally {f.close();}
});

const corruptNativeReceipts: [string, (receipt: NativeRestoreFenceReceipt) => void][] = [
  ["operation ID", r => {r.operation.operationId = "other";}],
  ["namespace", r => {r.operation.relayDatabaseNamespace = "other";}],
  ["workspace", r => {r.operation.oldBinding = {...r.operation.oldBinding, workspaceId: "other"};}],
  ["version", r => {r.operation.oldBinding = {...r.operation.oldBinding, mainVersionId: "other"};}],
  ["object", r => {r.operation.oldBinding = {...r.operation.oldBinding, objectId: "other"};}],
  ["lineage", r => {r.operation.oldBinding = {...r.operation.oldBinding, lineageClaimId: "f".repeat(64)};}],
  ["path", r => {r.operation.oldBinding = {...r.operation.oldBinding, currentPath: "docs/other.md"};}],
  ["selector", r => {r.operation.oldBinding = {...r.operation.oldBinding, selectorPaths: ["docs/other.md"]};}],
  ["host", r => {r.operation.hostId = "other";}],
  ["fence", r => {r.operation.newFence++;}],
  ["origin kind", r => {r.operation.origin.kind = "owner";}],
  ["origin ID", r => {r.operation.origin.id = "other";}],
  ["terminal", r => {r.operation.terminal = {deliveryId: "other", updateDigest: "f".repeat(64), journalCursor: 1, acceptingHostEpoch: parseHostEpoch(1)};}],
  ["exact sequence", r => {r.operation.appliedSequence = 1;}],
  ["head sequence", r => {r.localHeadSequence = -1;}],
  ["recorded time", r => {r.recordedAtMs = Number.MAX_SAFE_INTEGER + 1;}],
];
it.each(corruptNativeReceipts)("refuses changed native %s without phase, receipt, or quota mutation", (_name, corrupt) => {
  const f = readyNativeFence("bootstrap", "device");
  try {
    const before = f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(), usage = f.journalRows().usage;
    const changed = structuredClone(f.receipt); corrupt(changed);
    expect(() => f.store.acknowledgeStopRestoreFence(f.lookup, changed)).toThrow();
    expect(f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all()).toEqual(before);
    expect(f.journalRows().usage).toBe(usage);
  } finally {f.close();}
});

for (const saved of [false,true]) {
  it.each(["owner","history","connection","host","baseline","admission"])(`rechecks %s before native receipt completion or replay (saved=${saved})`,damage=>{
    const f=readyNativeFence("bootstrap","device");
    try {
      if(saved) f.store.acknowledgeStopRestoreFence(f.lookup,f.receipt);
      if(damage==="owner") f.raw.exec("UPDATE sync_relay_workspaces SET owner_user_id='other'");
      if(damage==="history") f.history.markUnreconciled();
      if(damage==="connection") f.raw.exec("UPDATE sync_relay_session_host_control SET registered_connection_id='other'");
      if(damage==="host") f.raw.exec("UPDATE sync_relay_session_host_control SET configured_host_id='other'");
      if(damage==="baseline") f.raw.exec("UPDATE sync_relay_live_documents SET baseline_bytes=X'00'");
      if(damage==="admission") f.raw.exec("UPDATE sync_relay_live_documents SET admission_state='open'");
      const before=f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(),usage=f.journalRows().usage;
      expect(()=>f.store.pendingStopRestoreFence(f.lookup)).toThrow();
      expect(()=>f.store.acknowledgeStopRestoreFence(f.lookup,f.receipt)).toThrow();
      expect(f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all()).toEqual(before);
      expect(f.journalRows().usage).toBe(usage);
    }finally{f.close();}
  });
}

it.each([["bootstrap","service"],["bootstrap","device"],["owner","device"]] as const)("admits and resumes one durable restore replacement for %s on %s",(kind,mode)=>{
  const f=contentProposalFixture(kind,mode,kind==="owner");
  try {
    const proposed=f.store.recordStopRestoreProposal(f.input,f.encoded,policy,200),before=f.journalRows();
    const prepare=vi.spyOn(f.context.db,"prepare");
    const admitted=f.store.admitStopRestoreProposal(f.input,proposed.proposalDigest,policy,201);
    const provenanceReads=prepare.mock.calls.map(([sql])=>sql).filter(sql=>sql.includes("sync_relay_live_update_struct_provenance") && /^\s*SELECT/i.test(sql));
    expect(provenanceReads.length).toBeGreaterThan(0);
    expect(provenanceReads.every(sql=>/WHERE[\s\S]*journal_cursor\s*(?:[<>=]|IN\b)/i.test(sql))).toBe(true);
    prepare.mockRestore();
    expect(admitted.phase).toBe("relay-admitted");
    expect(f.raw.prepare("SELECT admission_state FROM sync_relay_live_documents").get()!.admission_state).toBe("closed");
    const row=f.raw.prepare("SELECT * FROM sync_relay_live_update_journal ORDER BY journal_cursor DESC LIMIT 1").get()!;
    expect(row.restore_operation_id).toBe(f.input.operationId);
    expect(row.validation_checkpoint_bytes).toBeInstanceOf(Uint8Array);
    expect(admitted.admitted.firstSeen).toEqual(f.receipt.replacementRanges);
    expect(f.store.admitStopRestoreProposal(f.input,proposed.proposalDigest,policy,205)).toEqual(admitted);
    const application={fence:admitted.preparation.fence,candidateDigest:admitted.candidateDigest,nativeSourceManifestDigest:admitted.nativeSourceManifestDigest,
      admitted:admitted.admitted,localHeadSequence:admitted.preparation.fence.localHeadSequence+1,
      hostCoordinate:{hostId:f.input.host.hostId,hostEpoch:f.input.host.hostEpoch,instanceId:f.input.host.instanceId,connectionId:f.input.host.connectionId},recordedAtMs:202};
    const applied=f.store.acknowledgeStopRestoreReplacement(f.input,application);expect(applied.phase).toBe("native-applied");
    const settlement={settlementId:"restore-settlement",previousCursor:0,terminalCursor:admitted.admitted.accepted.receipt.journalCursor,
      applicationCount:3,localYDocSequence:application.localHeadSequence,momentId:"restore-moment",markdownDigest:admitted.preparation.point.markdownDigest,materialized:false,collectionReconcileRequired:false};
    expect(f.store.acknowledgeStopRestoreSettlement(f.input,settlement).phase).toBe("native-applied");
    expect(f.raw.prepare("SELECT admission_state FROM sync_relay_live_documents").get()!.admission_state).toBe("closed");
    const settled=f.store.acknowledgeStopRestoreSettlement(f.input,{...settlement,materialized:true});expect(settled.phase).toBe("settled");
    const resume={relayDatabaseNamespace:admitted.preparation.fence.operation.relayDatabaseNamespace,operationId:f.input.operationId,
      binding:admitted.admitted.accepted.binding,applicationReceipt:admitted.admitted.accepted.receipt,settlementId:settlement.settlementId,
      momentId:settlement.momentId,markdownDigest:settlement.markdownDigest,localHeadSequence:application.localHeadSequence,recordedAtMs:204};
    const resumed=f.store.acknowledgeStopRestoreResume(f.input,resume);expect(resumed.phase).toBe("resumed");
    expect(f.raw.prepare("SELECT admission_state FROM sync_relay_live_documents").get()!.admission_state).toBe("open");
    const after=f.journalRows();
    expect(f.store.acknowledgeStopRestoreResume(f.input,resume)).toEqual(resumed);
    expect(f.store.acknowledgeStopRestoreReplacement(f.input,application)).toEqual(resumed);
    expect(f.store.admitStopRestoreProposal(f.input,proposed.proposalDigest,policy,210)).toEqual(resumed);
    expect(f.journalRows()).toEqual(after);
    const read=f.storage.readLiveUpdateJournalCut({document:f.document});expect(read.kind).toBe("cut");
    if (kind==="owner") {
      const owner=f.store.openOwnerDelivery({host:f.input.host,document:f.document,actor:{kind:"owner",userId:"owner",shareId:"share"}});
      expect(f.store.ownerDeliveryProgress(owner).terminal).toEqual(resume.applicationReceipt);
    } else {
      const drain=f.store.open({host:f.input.host,document:f.document});
      expect(drain.baseline.binding).toEqual(resume.binding);f.store.close(drain);
    }
    expect(before).not.toEqual(after);
  }finally{f.close();}
});

function admittedRestoreFixture(kind:"owner"|"bootstrap"="owner",pending=true) {
  const f=contentProposalFixture(kind,"device",pending),proposal=f.store.recordStopRestoreProposal(f.input,f.encoded,policy,200);
  const admitted=f.store.admitStopRestoreProposal(f.input,proposal.proposalDigest,policy,201);
  const application={fence:admitted.preparation.fence,candidateDigest:admitted.candidateDigest,nativeSourceManifestDigest:admitted.nativeSourceManifestDigest,
    admitted:admitted.admitted,localHeadSequence:admitted.preparation.fence.localHeadSequence+1,
    hostCoordinate:{hostId:f.input.host.hostId,hostEpoch:f.input.host.hostEpoch,instanceId:f.input.host.instanceId,connectionId:f.input.host.connectionId},recordedAtMs:202};
  const settlement={settlementId:"restore-settlement",previousCursor:0,terminalCursor:admitted.admitted.accepted.receipt.journalCursor,
    applicationCount:3,localYDocSequence:application.localHeadSequence,momentId:"restore-moment",markdownDigest:admitted.preparation.point.markdownDigest,materialized:true,collectionReconcileRequired:false};
  const resume={relayDatabaseNamespace:admitted.preparation.fence.operation.relayDatabaseNamespace,operationId:f.input.operationId,binding:admitted.admitted.accepted.binding,
    applicationReceipt:admitted.admitted.accepted.receipt,settlementId:settlement.settlementId,momentId:settlement.momentId,markdownDigest:settlement.markdownDigest,
    localHeadSequence:application.localHeadSequence,recordedAtMs:204};
  const complete=(store=f.store)=>{store.acknowledgeStopRestoreReplacement(f.input,application);store.acknowledgeStopRestoreSettlement(f.input,settlement);return store.acknowledgeStopRestoreResume(f.input,resume);};
  return {...f,proposal,admitted,application,settlement,resume,complete};
}
const lifecycleRows=(f:Pick<ReturnType<typeof contentProposalFixture>,"raw"|"journalRows">)=>({...proposalRows(f),
  lifecycle:f.raw.prepare("SELECT * FROM sync_relay_live_restore_lifecycles").all(),sources:f.raw.prepare("SELECT * FROM sync_relay_live_restore_source_ranges").all(),
  operations:f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(),owners:f.raw.prepare("SELECT * FROM sync_relay_live_delivery_owners").all(),
  edges:f.raw.prepare("SELECT * FROM sync_relay_live_delivery_edges").all()});

it.each(["none","all deleted","one deleted","manifest changed"])("keeps pending source attribution complete after restore: %s",damage=>{
  const f=admittedRestoreFixture(),doc=new Y.Doc({gc:false});
  try{
    f.complete();
    const checkpoint=f.raw.prepare("SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE restore_operation_id=?").get(f.input.operationId)!;
    Y.applyUpdate(doc,checkpoint.validation_checkpoint_bytes as Uint8Array);doc.getMap("frontmatter").set("later","ordinary work");
    const candidate=Y.encodeStateAsUpdate(doc),capture=f.journalCapture(candidate,"after-restore");
    expect(f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_restore_source_ranges").get()!.count).toBe(2);
    if(damage==="all deleted")f.raw.exec("DELETE FROM sync_relay_live_restore_source_ranges");
    if(damage==="one deleted")f.raw.exec("DELETE FROM sync_relay_live_restore_source_ranges WHERE source_ordinal=0");
    if(damage==="manifest changed")f.raw.exec("UPDATE sync_relay_live_restore_source_ranges SET source_sha256='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'");
    const before=lifecycleRows(f);
    if(damage!=="none"){
      expect(()=>f.storage.commitLiveUpdateJournal(capture)).toThrow();expect(lifecycleRows(f)).toEqual(before);
    }else{
      const result=f.storage.commitLiveUpdateJournal(capture);expect(result.result.kind).toBe("accepted");
      const firstSeen=result.admitted!.metadata.firstSeen;
      expect(firstSeen.length).toBe(1);expect(firstSeen[0]!.clientId).toBe(doc.clientID);
      expect(firstSeen[0]!.endClock-firstSeen[0]!.startClock).toBe(1);
    }
  }finally{doc.destroy();f.close();}
});
it("allows ordinary admission from a restored checkpoint with no pending source rows",()=>{
  const f=admittedRestoreFixture("bootstrap",false),doc=new Y.Doc({gc:false});
  try{
    f.complete();Y.applyUpdate(doc,f.raw.prepare("SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE restore_operation_id=?").get(f.input.operationId)!.validation_checkpoint_bytes as Uint8Array);
    doc.getMap("frontmatter").set("after","restored");expect(f.storage.commitLiveUpdateJournal(f.journalCapture(Y.encodeStateAsUpdate(doc),"ordinary")).result.kind).toBe("accepted");
  }finally{doc.destroy();f.close();}
});
it.each(["application","settlement","resume"])("refuses changed %s evidence without advancing the restore or quota",stage=>{
  const f=admittedRestoreFixture();
  try{
    if(stage!=="application")f.store.acknowledgeStopRestoreReplacement(f.input,f.application);
    if(stage==="resume")f.store.acknowledgeStopRestoreSettlement(f.input,f.settlement);
    const before=lifecycleRows(f);
    const call=()=>stage==="application"?f.store.acknowledgeStopRestoreReplacement(f.input,{...f.application,localHeadSequence:f.application.localHeadSequence+1}):
      stage==="settlement"?f.store.acknowledgeStopRestoreSettlement(f.input,{...f.settlement,terminalCursor:f.settlement.terminalCursor+1}):
      f.store.acknowledgeStopRestoreResume(f.input,{...f.resume,momentId:"foreign"});
    expect(call).toThrow();expect(lifecycleRows(f)).toEqual(before);
  }finally{f.close();}
});
it("funds all restore receipts before admission and keeps the journal unchanged on quota refusal",()=>{
  const f=contentProposalFixture();
  try{
    const proposal=f.store.recordStopRestoreProposal(f.input,f.encoded,policy,200),before=lifecycleRows(f),original=f.context.options.workspaceQuotaBytes;
    f.context.options.workspaceQuotaBytes=Number(before.usage)+1;
    expect(()=>f.store.admitStopRestoreProposal(f.input,proposal.proposalDigest,policy,201)).toThrow(/quota/);expect(lifecycleRows(f)).toEqual(before);
    f.context.options.workspaceQuotaBytes=original;
    const admitted=f.store.admitStopRestoreProposal(f.input,proposal.proposalDigest,policy,201);
    expect(admitted.phase).toBe("relay-admitted");
    expect(Number(f.raw.prepare("SELECT receipt_reservation_bytes FROM sync_relay_live_restore_lifecycles").get()!.receipt_reservation_bytes)).toBeGreaterThan(0);
  }finally{f.close();}
});
it.each(["admission","source","usage"])("rolls back the replacement journal and all metadata after ignored %s write",boundary=>{
  const f=contentProposalFixture("owner","device",true);
  try{
    const proposal=f.store.recordStopRestoreProposal(f.input,f.encoded,policy,200),table=boundary==="admission"?"sync_relay_live_restore_lifecycles":boundary==="source"?"sync_relay_live_restore_source_ranges":"sync_relay_workspace_usage";
    f.raw.exec(`CREATE TRIGGER ignore_restore BEFORE ${boundary==="usage"?"UPDATE":"INSERT"} ON ${table} BEGIN SELECT RAISE(IGNORE); END`);
    const before=lifecycleRows(f);
    expect(()=>f.store.admitStopRestoreProposal(f.input,proposal.proposalDigest,policy,201)).toThrow();expect(lifecycleRows(f)).toEqual(before);
  }finally{f.close();}
});
it.each(["application","settlement","resume"])("recovers the exact restore after relay restart before %s acknowledgement",stage=>{
  const f=admittedRestoreFixture();let reopened:ReturnType<typeof openSyncRelayStorage>|undefined,closed=false;
  try{
    if(stage!=="application")f.store.acknowledgeStopRestoreReplacement(f.input,f.application);
    if(stage==="resume")f.store.acknowledgeStopRestoreSettlement(f.input,f.settlement);
    f.close();closed=true;reopened=openSyncRelayStorage(f.path);
    const store=reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace:"restore-test",reconciled:true}));
    expect(f.complete(store).phase).toBe("resumed");expect(store.readStopRestoreLifecycle(f.input)!.resume).toEqual(f.resume);
  }finally{if(!closed)f.close();reopened?.close();}
});
it("retains original owner binding and operation history across a second stop",()=>{
  const f=admittedRestoreFixture();
  try{
    f.complete();f.raw.exec("UPDATE sync_relay_share_grants SET status='active',generation=6,revoked_at_ms=NULL WHERE grant_id='grant'");
    const second={...f.intent,operationId:"second-restore",expectedFence:2,expectedGrantGeneration:6};
    const begun=beginStopRestore(f.context,second,300);expect(begun.previousOperationId).toBe(f.input.operationId);
    const lookup={...f.lookup,operationId:second.operationId};advanceStopRestoreFence(f.context,lookup,301);
    const before=lifecycleRows(f);
    expect(f.store.admitStopRestoreProposal(f.input,f.proposal.proposalDigest,policy,302).resume).toEqual(f.resume);
    expect(f.store.acknowledgeStopRestoreResume(f.input,f.resume).resume).toEqual(f.resume);expect(lifecycleRows(f)).toEqual(before);
    expect(f.raw.prepare("SELECT admission_state,restore_fence_generation FROM sync_relay_live_documents").get()).toMatchObject({admission_state:"closed",restore_fence_generation:3});
  }finally{f.close();}
});
it("workspace deletion cascades through admitted restore history",()=>{
  const f=admittedRestoreFixture();
  try{
    f.complete();f.raw.exec("DELETE FROM sync_relay_workspaces WHERE workspace_id='workspace'");
    for(const table of ["sync_relay_live_restore_lifecycles","sync_relay_live_restore_source_ranges","sync_relay_live_restore_operations","sync_relay_live_update_journal"])
      expect(f.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0);
  }finally{f.close();}
});

it("hashes copied restore state before entering the SQLite writer",()=>{
  const f=contentProposalFixture("owner","device",true),prototype=Object.getPrototypeOf(createHash("sha256"));
  const update=prototype.update,tx=f.context.tx.bind(f.context);let writing=false;
  const hashSpy=vi.spyOn(prototype,"update").mockImplementation(function(this:unknown,...args:unknown[]){
    if(writing && typeof args[0]!=="string")throw Error("copied state hash inside writer");
    return Reflect.apply(update,this,args);
  });
  const txSpy=vi.spyOn(f.context,"tx").mockImplementation(run=>tx(()=>{writing=true;try{return run();}finally{writing=false;}}));
  try{
    const proposal=f.store.recordStopRestoreProposal(f.input,f.encoded,policy,200);
    expect(f.store.admitStopRestoreProposal(f.input,proposal.proposalDigest,policy,201).phase).toBe("relay-admitted");
  }finally{hashSpy.mockRestore();txSpy.mockRestore();f.close();}
});
it("finds existing owner delivery only after authorization and refuses damaged origin",()=>{
  const f=fixture("owner");
  try{
    const input={host:f.coordinate,document:f.document,actor:f.actor};
    expect(f.store.existingOwnerDelivery(input)).toBeNull();
    expect(()=>f.store.existingOwnerDelivery({...input,actor:{...f.actor,userId:"foreign"}})).toThrow();
    f.adopt();const capture=f.store.existingOwnerDelivery(input);expect(capture).not.toBeNull();
    expect(f.store.ownerDeliveryProgress(capture!).adoptionId).toBe("adoption");
    f.raw.exec("UPDATE sync_relay_live_delivery_owners SET origin_json=json_set(origin_json,'$.bindingDigest','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')");
    expect(()=>f.store.existingOwnerDelivery(input)).toThrow();
  }finally{f.close();}
});

it("precharges retained restore evidence before materializing an oversized admission",()=>{
  const f=admittedRestoreFixture();
  try{
    f.raw.prepare("UPDATE sync_relay_live_restore_lifecycles SET admission_json=?").run(JSON.stringify({payload:"x".repeat(f.input.maxBytes)}));
    const before=lifecycleRows(f),spy=vi.spyOn(f.context.db,"prepare");
    expect(()=>f.store.readStopRestoreLifecycle(f.input)).toThrow();
    const queries=spy.mock.calls.map(([sql])=>sql);spy.mockRestore();
    expect(queries.some(sql=>sql.includes("SELECT l.admission_json,l.admission_sha256"))).toBe(false);
    expect(lifecycleRows(f)).toEqual(before);
  }finally{f.close();}
});

function retainedLifecyclePayloadBytes(db:StorageContext["db"],operationId:string):number {
  const op=db.prepare("SELECT * FROM sync_relay_live_restore_operations WHERE operation_id=?").get(operationId)!;
  const lifecycle=db.prepare("SELECT * FROM sync_relay_live_restore_lifecycles WHERE operation_id=?").get(operationId)!;
  const journal=db.prepare("SELECT * FROM sync_relay_live_update_journal WHERE restore_operation_id=?").get(operationId)!;
  return [op.intent_json,op.basis_json,op.terminal_json,op.applied_json,op.native_receipt_json,lifecycle.admission_json,
    lifecycle.application_json,lifecycle.pending_settlement_json,lifecycle.settlement_json,lifecycle.resume_json]
    .reduce<number>((sum,value)=>sum+(value===null?0:Buffer.byteLength(String(value))),0)+
    (journal.update_bytes as Uint8Array).byteLength+(journal.validation_checkpoint_bytes as Uint8Array).byteLength+
    Number(journal.accepted_metadata_bytes)+Number(lifecycle.receipt_reservation_bytes);
}
it("rolls back admission one byte below its funded read budget and can retry to completion",()=>{
  const f=contentProposalFixture("owner","device",true),tx=f.context.tx.bind(f.context);
  try {
    const proposal=f.store.recordStopRestoreProposal(f.input,f.encoded,policy,200),before=lifecycleRows(f);
    let required=0;
    const dryRun=vi.spyOn(f.context,"tx").mockImplementation(run=>tx(()=>{
      run();required=retainedLifecyclePayloadBytes(f.context.db,f.input.operationId);throw Error("measured rollback");
    }));
    try{expect(()=>f.store.admitStopRestoreProposal(f.input,proposal.proposalDigest,policy,201)).toThrow("measured rollback");}finally{dryRun.mockRestore();}
    expect(lifecycleRows(f)).toEqual(before);expect(required).toBeGreaterThan(f.encoded.length);
    let reachedAdmission=false;
    const observe=vi.spyOn(f.context,"tx").mockImplementation(run=>tx(()=>{try{return run();}catch(error){
      reachedAdmission=f.context.db.prepare("SELECT 1 FROM sync_relay_live_restore_lifecycles WHERE operation_id=?").get(f.input.operationId)!==undefined;throw error;
    }}));
    try{expect(()=>f.store.admitStopRestoreProposal({...f.input,maxBytes:required-1},proposal.proposalDigest,policy,201)).toThrow();}finally{observe.mockRestore();}
    expect(reachedAdmission).toBe(true);expect(lifecycleRows(f)).toEqual(before);
    const admitted=f.store.admitStopRestoreProposal({...f.input,maxBytes:required},proposal.proposalDigest,policy,201);
    expect(admitted.phase).toBe("relay-admitted");
    const application={fence:admitted.preparation.fence,candidateDigest:admitted.candidateDigest,nativeSourceManifestDigest:admitted.nativeSourceManifestDigest,
      admitted:admitted.admitted,localHeadSequence:admitted.preparation.fence.localHeadSequence+1,
      hostCoordinate:{hostId:f.input.host.hostId,hostEpoch:f.input.host.hostEpoch,instanceId:f.input.host.instanceId,connectionId:f.input.host.connectionId},recordedAtMs:202};
    const settlement={settlementId:"budget-settlement",previousCursor:0,terminalCursor:admitted.admitted.accepted.receipt.journalCursor,applicationCount:3,
      localYDocSequence:application.localHeadSequence,momentId:"budget-moment",markdownDigest:admitted.preparation.point.markdownDigest,materialized:true,collectionReconcileRequired:false};
    const resume={relayDatabaseNamespace:admitted.preparation.fence.operation.relayDatabaseNamespace,operationId:f.input.operationId,binding:admitted.admitted.accepted.binding,
      applicationReceipt:admitted.admitted.accepted.receipt,settlementId:settlement.settlementId,momentId:settlement.momentId,markdownDigest:settlement.markdownDigest,
      localHeadSequence:application.localHeadSequence,recordedAtMs:204};
    const budget={...f.input,maxBytes:required};
    f.store.acknowledgeStopRestoreReplacement(budget,application);f.store.acknowledgeStopRestoreSettlement(budget,settlement);
    expect(f.store.acknowledgeStopRestoreResume(budget,resume).phase).toBe("resumed");
  }finally{f.close();}
});
it("charges operation payloads once when reading a resumed lifecycle at its exact byte budget",()=>{
  const f=admittedRestoreFixture();try{
    f.complete();const required=retainedLifecyclePayloadBytes(f.context.db,f.input.operationId);
    expect(f.store.readStopRestoreLifecycle({...f.input,maxBytes:required})!.phase).toBe("resumed");
    expect(()=>f.store.readStopRestoreLifecycle({...f.input,maxBytes:required-1})).toThrow();
  }finally{f.close();}
});
it.each(["application","settlement","resume"])("keeps %s recoverable when configured evidence capacity is reduced",stage=>{
  const f=admittedRestoreFixture();try{
    if(stage!=="application")f.store.acknowledgeStopRestoreReplacement(f.input,f.application);
    if(stage==="resume")f.store.acknowledgeStopRestoreSettlement(f.input,f.settlement);
    const before=lifecycleRows(f),input={...f.input,maxBytes:retainedLifecyclePayloadBytes(f.context.db,f.input.operationId)-1};
    const call=(input:typeof f.input)=>stage==="application"?f.store.acknowledgeStopRestoreReplacement(input,f.application):
      stage==="settlement"?f.store.acknowledgeStopRestoreSettlement(input,f.settlement):f.store.acknowledgeStopRestoreResume(input,f.resume);
    expect(()=>call(input)).toThrow();expect(lifecycleRows(f)).toEqual(before);expect(()=>call(f.input)).not.toThrow();
    expect(f.complete().phase).toBe("resumed");
  }finally{f.close();}
});
it.each(["application","settlement","resume"])("rolls back %s if its retained budget becomes unreadable before commit",stage=>{
  const f=admittedRestoreFixture();try{
    if(stage!=="application")f.store.acknowledgeStopRestoreReplacement(f.input,f.application);
    if(stage==="resume")f.store.acknowledgeStopRestoreSettlement(f.input,f.settlement);
    const column=stage==="application"?"application_json":stage==="settlement"?"settlement_json":"resume_json";
    f.raw.exec(`CREATE TRIGGER shrink_restore_budget AFTER UPDATE OF ${column} ON sync_relay_live_restore_lifecycles BEGIN UPDATE sync_relay_live_restore_lifecycles SET max_evidence_bytes=1; END`);
    const before=lifecycleRows(f);
    expect(()=>stage==="application"?f.store.acknowledgeStopRestoreReplacement(f.input,f.application):
      stage==="settlement"?f.store.acknowledgeStopRestoreSettlement(f.input,f.settlement):f.store.acknowledgeStopRestoreResume(f.input,f.resume)).toThrow();
    expect(lifecycleRows(f)).toEqual(before);f.raw.exec("DROP TRIGGER shrink_restore_budget");expect(f.complete().phase).toBe("resumed");
  }finally{f.close();}
});
it.each(["proposal","admission"])("rejects a same-length source rewrite by another connection before %s writer entry",stage=>{
  const f=contentProposalFixture("owner","device",true),tx=f.context.tx.bind(f.context);let changed:ReturnType<typeof lifecycleRows>|undefined;
  try {
    const proposal=stage==="admission"?f.store.recordStopRestoreProposal(f.input,f.encoded,policy,200):null;
    const spy=vi.spyOn(f.context,"tx").mockImplementation(run=>{
      const row=f.raw.prepare("SELECT journal_cursor,update_bytes FROM sync_relay_live_update_journal ORDER BY journal_cursor LIMIT 1").get()!;
      const bytes=new Uint8Array(row.update_bytes as Uint8Array);bytes[bytes.length-1]^=1;
      f.raw.prepare("UPDATE sync_relay_live_update_journal SET update_bytes=? WHERE journal_cursor=?").run(bytes,row.journal_cursor);changed=lifecycleRows(f);
      return tx(run);
    });
    try{expect(()=>stage==="proposal"?f.store.recordStopRestoreProposal(f.input,f.encoded,policy,200):f.store.admitStopRestoreProposal(f.input,proposal!.proposalDigest,policy,201)).toThrow(/changed during validation/);}finally{spy.mockRestore();}
    expect(changed).toBeDefined();expect(lifecycleRows(f)).toEqual(changed);
  }finally{f.close();}
});
it("keeps admission and all lifecycle ACKs free of journal blob reads, byte comparisons and byte hashes in the writer",()=>{
  const f=contentProposalFixture("owner","device",true),tx=f.context.tx.bind(f.context),prepare=f.context.db.prepare.bind(f.context.db),compare=Buffer.compare;
  const prototype=Object.getPrototypeOf(createHash("sha256")),update=prototype.update;let writing=false;
  const txSpy=vi.spyOn(f.context,"tx").mockImplementation(run=>tx(()=>{writing=true;try{return run();}finally{writing=false;}}));
  const sqlSpy=vi.spyOn(f.context.db,"prepare").mockImplementation(sql=>{
    if(writing && /SELECT\s+\*\s+FROM sync_relay_live_update_journal\b/i.test(sql))throw Error("journal blobs in writer");
    if(writing && /SELECT\s+proposal_bytes\b/i.test(sql))throw Error("proposal bytes in writer");
    return prepare(sql);
  });
  const compareSpy=vi.spyOn(Buffer,"compare").mockImplementation((a,b)=>{if(writing)throw Error("byte comparison in writer");return compare(a,b);});
  const hashSpy=vi.spyOn(prototype,"update").mockImplementation(function(this:unknown,...args:unknown[]){if(writing&&typeof args[0]!=="string")throw Error("byte hash in writer");return Reflect.apply(update,this,args);});
  try {
    const proposal=f.store.recordStopRestoreProposal(f.input,f.encoded,policy,200);
    expect(f.store.recordStopRestoreProposal(f.input,f.encoded,policy,200).replayed).toBe(true);
    const admitted=f.store.admitStopRestoreProposal(f.input,proposal.proposalDigest,policy,201);
    const application={fence:admitted.preparation.fence,candidateDigest:admitted.candidateDigest,nativeSourceManifestDigest:admitted.nativeSourceManifestDigest,admitted:admitted.admitted,
      localHeadSequence:admitted.preparation.fence.localHeadSequence+1,hostCoordinate:{hostId:f.input.host.hostId,hostEpoch:f.input.host.hostEpoch,instanceId:"\\".repeat(1024),connectionId:"\\".repeat(1024)},recordedAtMs:202};
    const settlement={settlementId:"\\".repeat(512),previousCursor:0,terminalCursor:admitted.admitted.accepted.receipt.journalCursor,applicationCount:3,localYDocSequence:application.localHeadSequence,
      momentId:"\\".repeat(512),markdownDigest:admitted.preparation.point.markdownDigest,materialized:true,collectionReconcileRequired:false};
    const resume={relayDatabaseNamespace:admitted.preparation.fence.operation.relayDatabaseNamespace,operationId:f.input.operationId,binding:admitted.admitted.accepted.binding,
      applicationReceipt:admitted.admitted.accepted.receipt,settlementId:settlement.settlementId,momentId:settlement.momentId,markdownDigest:settlement.markdownDigest,localHeadSequence:application.localHeadSequence,recordedAtMs:204};
    f.store.acknowledgeStopRestoreReplacement(f.input,application);f.store.acknowledgeStopRestoreSettlement(f.input,{...settlement,materialized:false});
    f.store.acknowledgeStopRestoreSettlement(f.input,settlement);expect(f.store.acknowledgeStopRestoreResume(f.input,resume).phase).toBe("resumed");
  }finally{hashSpy.mockRestore();compareSpy.mockRestore();sqlSpy.mockRestore();txSpy.mockRestore();f.close();}
});
