import {maximumBindingBytes, nativeSettlementId, prepareHostedSettlements, restorePublicationReservation, settlementRecordDigest, SETTLEMENT_PUSH_MAX_BYTES,
  SETTLEMENT_PUSH_MAX_METADATA_EVENTS} from "../../../services/sync-relay/src/storage/hostedSettlement.js";
import {appendValidatedLiveJournal, assertJournalCheckpointPosition, readReplicaLiveJournal, decodeJournalRow} from "../../../services/sync-relay/src/storage/liveUpdateJournal.js";
import {acrossDeclinedRestores, MAX_DECLINED_GENERATIONS} from "../../../services/sync-relay/src/storage/liveRestoreLifecycleStorage.js";
import {RestoreHistoryBudget} from "../../../services/sync-relay/src/storage/liveAcceptedHistory.js";
import {verifyRestoreCheckpoint} from "../../../services/sync-relay/src/storage/liveRestoreCheckpoint.js";
import {stableJsonStringify} from "../../../services/sync-relay/src/canonicalJson.js";
import {initialAcceptedHistoryDigest} from "../../../services/sync-relay/src/liveAcceptedHistory.js";
import {createLiveMarkdownRegistrationValidator} from "./liveDocumentValidation.js";
import {liveValidation} from "../../../services/sync-relay/src/liveValidation.js";
import {afterAll} from "vitest";
import {createHash} from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import { policy, hash, cleanupLiveDeliveryFixtures } from "./liveCommittedDeliveryTestSupport.js";
import {resolveLiveRestorePoint} from "./liveRestorePoint.js";
import {markdownToYDoc, yDocToMarkdown} from "./import-export.js";
import { createLiveJournalHistoryAuthority } from "../../../services/sync-relay/src/storage/liveJournalHistory.js";
import { beginStopRestore, advanceStopRestoreFence, declineStopRestore, readStopRestore } from "../../../services/sync-relay/src/storage/liveRestoreOperation.js";
import type { StorageContext } from "../../../services/sync-relay/src/storage/context.js";
import type { StopRestoreCutCapture, OwnerCutCapture } from "../../../services/sync-relay/src/storage/liveCommittedDelivery.js";
import type {NativeRestoreCancellationAnswer, NativeRestoreFenceReceipt} from "../../../services/sync-relay/src/liveRestoreFence.js";
import {createServiceHostFeed} from "../../../services/sync-relay/src/serviceHostFeed.js";
import {SERVICE_HOST_ORIGIN_PREFIX} from "../../../services/sync-relay/src/relayLogInputs.js";
import { openSyncRelayStorage } from "../../../services/sync-relay/src/storage.js";
import {parseNativeRestoreProposalReceipt, encodeNativeRestoreProposal, decodeNativeRestoreProposal, nativeSourceAgentDeclaration} from "../../../services/sync-relay/src/liveRestoreProposal.js";
import {initializeLiveRestoreOperationSchema, LIVE_RESTORE_ACTIVE_V1_SQL, LIVE_RESTORE_LIFECYCLES_V1_SQL, LIVE_RESTORE_OPERATIONS_V1_SQL} from "../../../services/sync-relay/src/storage/liveRestoreOperationSchema.js";
import {readServiceActivationRetirement} from "../../../services/sync-relay/src/storage/serviceActivationRetirement.js";
import {fenceAccount, initializeAccountDeletion, purgeAccountRows} from "../../../services/sync-relay/src/storage/accountDeletion.js";
import {validateLiveRestoreProposal} from "./liveRestoreProof.js";
import * as restoreProof from "./liveRestoreProof.js";
import {createLiveMarkdownJournalValidator} from "./liveDocumentValidation.js";
import {LiveRestorePreparation, parseLiveRestoreConfig} from "../../../services/sync-relay/src/liveRestorePreparation.js";
import {cancelStopRestore} from "../../../services/sync-relay/src/liveRestoreDelivery.js";
import {canonicalVersionedAcceptedMetadata} from "../../../services/sync-relay/src/liveAcceptedHistory.js";
import {LiveCommittedDelivery} from "../../../services/sync-relay/src/liveCommittedDelivery.js";
import {OwnerCommittedDelivery} from "../../../services/sync-relay/src/ownerCommittedDelivery.js";
import {OwnerRestoreReview} from "../../../apps/desktop/src/ipc/ownerRestoreContract.js";
import {fixture, bootstrapAck, applicationAck} from "./liveRestoreFixture.integration-helper.js";
import {createReplicaSupervisor} from "../../../services/sync-relay/src/replicaSupervisor.js";
import {closeTestStorages, tempRoot} from "../../../services/sync-relay/src/testing/index.js";

afterEach(cleanupLiveDeliveryFixtures);
const jsonHash = (value: unknown) => hash(Buffer.from(JSON.stringify(value)));
const ownerOriginDigest = ({binding, cut: c}: Pick<OwnerCutCapture, "binding" | "cut">) => jsonHash([binding,
  c.relayDatabaseNamespace, c.sourceMomentId, c.sourceDigest, c.sourceByteLength, c.baselineMomentRelaySequence,
  c.baselineRegisteredAtMs, c.expectedLocalSequence, c.events.map(event => canonicalVersionedAcceptedMetadata(event.metadata))]);
function proposalSourcesFixture(kind: "bootstrap" | "owner", mode: "service" | "device", acceptedNative = false, selectedPoint = false, authorBand = 0,
  beforeFence?: Parameters<typeof readyNativeFence>[4]) {
  const f = readyNativeFence(kind, mode, authorBand || (acceptedNative ? "native" : true), selectedPoint, beforeFence);
  return {...f, ...proposalSources(f, kind, f.lookup, f.receipt, authorBand)};
}
// Records the host's fence of the restore `lookup` names, and the sources its native proposal cites.
function proposalSources(f: Pick<ReturnType<typeof readyNativeFence>, "store" | "raw">, kind: "bootstrap" | "owner",
  lookup: ReturnType<typeof readyNativeFence>["lookup"], fence: NativeRestoreFenceReceipt, authorBand = 0) {
  f.store.acknowledgeStopRestoreFence(lookup, fence);
  const input = {...lookup, maxBytes: authorBand ? 10_000_000 : 1_000_000, maxEvents: authorBand ? 1000 : 10};
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
  const receipt = {fence, point: resolveLiveRestorePoint(f.store.captureStopRestorePoint(input), policy),
    candidateDigest: "a".repeat(64), frozenStateDigest: "b".repeat(64), pointStateDigest: "c".repeat(64),
    finalContentDigest: "d".repeat(64), beforeStateVector: [0], afterStateVector: [0],
    replacementRanges: [{clientId: 999, startClock: 0, endClock: 1}], originEvidenceDigest: kind === "owner" ? String(origin) : jsonHash(origin),
    selectedHistory, acceptedHistory, nativeSources: [], nativeSourceManifestDigest: jsonHash([fence, []])};
  return {input, proposal: receipt};
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

// The agent the fixture's native update attribution names.
const nativeAgent = {agentId: "owner-device", onBehalfOf: "owner", depth: 64};
function pendingSource(binding: NativeRestoreFenceReceipt["operation"]["oldBinding"], bytes: Uint8Array, sequence: number) {
  const updateDigest = hash(bytes), outboxId = `owner-outbox-${hash(Buffer.from(`${binding.workspaceId}\0${JSON.stringify(binding)}\0${binding.lineageClaimId}`))}`;
  const source = {binding, adoptionId: "adoption", nativeSequence: sequence + 9, updateDigest,
    origin: {kind: "nativeUpdate", actorOriginId: "owner-device", actorKind: "agent", onBehalfOf: "owner", chainDepth: 64, recordedAtMs: 100}};
  return {outboxId, outboxSequence: sequence, binding, appendKey: `adopted-local:${jsonHash(source)}`,
    deliveryId: `owner-delivery-${hash(Buffer.from(`${outboxId}\0${sequence}\0${updateDigest}`))}`, updateDigest,
    byteLength: bytes.byteLength, createdAtMs: 100, source, acceptedReceipt: null};
}

function contentProposalFixture(kind: "bootstrap" | "owner" = "owner", mode: "service" | "device" = "device", pending: boolean | "deleted" = false, acceptedNative = false, selectedPoint = false, authorBand = 0,
  beforeFence?: Parameters<typeof readyNativeFence>[4]) {
  return buildContentProposal(proposalSourcesFixture(kind, mode, acceptedNative, selectedPoint, authorBand, beforeFence), pending);
}
function buildContentProposal<F extends Pick<ReturnType<typeof proposalSourcesFixture>, "store" | "input" | "document" | "receipt" | "proposal" | "close"> & {acceptedNative?: AcceptedNative}>(f: F, pending: boolean | "deleted" = false) {
  const point = new Y.Doc({gc: false}), head = new Y.Doc({gc: false});
  try {
    const selected = f.store.captureStopRestorePoint(f.input), accepted = f.store.captureStopRestoreAcceptedCut(f.input);
    Y.applyUpdate(point, selected.checkpoint.bytes);for (const e of selected.events) Y.applyUpdate(point, e.updateBytes);
    Y.applyUpdate(head, accepted.checkpoint.bytes);for (const e of accepted.events) Y.applyUpdate(head, e.updateBytes);
    const nativeSourceBytes: Uint8Array[] = f.acceptedNative ? [f.acceptedNative.bytes] : [];
    if (pending) {
      for (const name of ["pending-one", "pending-two"]) {
        const before = Y.encodeStateVector(head);
        if (pending === "deleted" && name === "pending-two") head.getMap("frontmatter").delete("pending-one");
        else head.getMap("frontmatter").set(name, "retained owner work");
        nativeSourceBytes.push(Y.encodeStateAsUpdate(head, before));
      }
    }
    const nativeSources = nativeSourceBytes.map((bytes, index) => index === 0 && f.acceptedNative ? f.acceptedNative.source : pendingSource(f.receipt.operation.oldBinding, bytes, index + 1));
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
      const parsed = parseNativeRestoreProposalReceipt(JSON.stringify(receipt), f.input).nativeSources[0]!;
      expect(parsed.source.origin).toMatchObject(patch);
      expect(nativeSourceAgentDeclaration(parsed)).toEqual(patch.actorKind === "agent" ? nativeAgent : undefined);
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

it("derives an adopted native update's declaration from its retained attribution and keeps the source wire unchanged", () => {
  const f = proposalSourcesFixture("owner", "device");
  try {
    const binding = f.proposal.fence.operation.oldBinding, updateDigest = "e".repeat(64);
    const outboxId = `owner-outbox-${hash(Buffer.from(`${binding.workspaceId}\0${JSON.stringify(binding)}\0${binding.lineageClaimId}`))}`;
    const origin = (patch: Record<string, unknown> = {}) => ({kind: "nativeUpdate", actorOriginId: "trip-agent-hosted", actorKind: "agent",
      onBehalfOf: "owner", chainDepth: 2, recordedAtMs: 100, ...patch});
    const native = (source: Record<string, unknown>, appendKey = `adopted-local:${jsonHash(source)}`) => ({outboxId, outboxSequence: 1, binding, appendKey,
      deliveryId: `owner-delivery-${hash(Buffer.from(`${outboxId}\0${1}\0${updateDigest}`))}`, updateDigest,
      byteLength: 2, createdAtMs: 100, source, acceptedReceipt: null});
    const parse = (source: Record<string, unknown>, appendKey?: string) => {
      const sources = [native(source, appendKey)];
      return parseNativeRestoreProposalReceipt(JSON.stringify({...f.proposal, nativeSources: sources,
        nativeSourceManifestDigest: jsonHash([f.proposal.fence, sources])}), f.input).nativeSources[0]!;
    };
    const source = (patch?: Record<string, unknown>) => ({binding, adoptionId: "adoption", nativeSequence: 9, updateDigest, origin: origin(patch)});
    // The agent's update keeps its exact source and key, and names the agent its attribution names.
    const agent = source(), parsed = parse(agent);
    expect(JSON.stringify(parsed.source)).toBe(JSON.stringify(agent));
    expect(parsed.appendKey).toBe(`adopted-local:${jsonHash(agent)}`);
    expect(nativeSourceAgentDeclaration(parsed)).toEqual({agentId: "trip-agent-hosted", onBehalfOf: "owner", depth: 2});
    expect(nativeSourceAgentDeclaration(parse(source({onBehalfOf: null, chainDepth: 0}))))
      .toEqual({agentId: "trip-agent-hosted", onBehalfOf: null, depth: 0});
    // A person, an automation, an agent with no actor and absent attribution name none.
    for (const patch of [{actorKind: "human", chainDepth: 0, onBehalfOf: null}, {actorKind: "automation", chainDepth: 1, onBehalfOf: null},
      {actorOriginId: null}, {actorOriginId: null, actorKind: null, chainDepth: null, onBehalfOf: null}]) {
      expect(nativeSourceAgentDeclaration(parse(source(patch)))).toBeUndefined();
    }
    const seed = {binding, adoptionId: "adoption", nativeSequence: 0, updateDigest, origin: {kind: "adoptionSeed"}};
    expect(nativeSourceAgentDeclaration(parse(seed, `owner-adoption:${jsonHash(["adoption", 0, updateDigest])}`))).toBeUndefined();
    // The source names its agent only through the native origin; any other member is refused.
    expect(() => parse({...agent, agentDeclaration: {agentId: "trip-agent-hosted", onBehalfOf: "owner", depth: 2}})).toThrow();
  } finally {f.close();}
});

it.each([{actorOriginId: "other-agent"}, {chainDepth: 63}, {onBehalfOf: null}, {actorKind: "human", chainDepth: 0, onBehalfOf: null}])(
  "refuses an adopted native source whose accepted delivery declared other provenance: %j", patch => {
    const f = contentProposalFixture("owner", "device", false, true);
    try {
      const changed = structuredClone(f.receipt), native = changed.nativeSources[0]!;
      Object.assign(native.source.origin, patch);
      native.appendKey = `adopted-local:${jsonHash(native.source)}`;
      changed.nativeSourceManifestDigest = jsonHash([changed.fence, changed.nativeSources]);
      // The source parses on its own; its accepted copy declared the fixture's agent.
      parseNativeRestoreProposalReceipt(JSON.stringify(changed), f.input);
      expect(() => f.store.captureStopRestoreProposal(f.input, JSON.stringify(changed))).toThrow();
      expect(() => f.store.captureStopRestoreProposal(f.input, JSON.stringify(f.receipt))).not.toThrow();
    } finally {f.close();}
  });

it("authenticates an enrolled owner draft's identity and declaration without a native sequence", () => {
  const f = proposalSourcesFixture("bootstrap", "service");
  try {
    const binding = f.proposal.fence.operation.oldBinding, updateDigest = "e".repeat(64);
    const outboxId = `owner-outbox-${hash(Buffer.from(`${binding.workspaceId}\0${JSON.stringify(binding)}\0${binding.lineageClaimId}`))}`;
    const draft = (origin: Record<string, unknown>, sequence = 1) => ({outboxId, outboxSequence: sequence, binding, appendKey: `editor-draft-${sequence}`,
      deliveryId: `owner-delivery-${hash(Buffer.from(`${outboxId}\0${sequence}\0${updateDigest}`))}`, updateDigest,
      byteLength: 2, createdAtMs: 100, source: {binding, updateDigest, origin}, acceptedReceipt: null});
    const receipt = (sources: unknown[]) => JSON.stringify({...f.proposal, nativeSources: sources, nativeSourceManifestDigest: jsonHash([f.proposal.fence, sources])});
    const agentDeclaration = {agentId: "trip-agent-ü", onBehalfOf: null, depth: 0};
    const parsed = parseNativeRestoreProposalReceipt(receipt([draft({kind: "ownerDraft", agentDeclaration}), draft({kind: "ownerDraft"}, 2)]), f.input);
    expect(parsed.nativeSources.map(source => source.source)).toEqual([
      {binding, updateDigest, origin: {kind: "ownerDraft", agentDeclaration}}, {binding, updateDigest, origin: {kind: "ownerDraft"}}]);
    expect(parsed.nativeSources.map(source => source.appendKey)).toEqual(["editor-draft-1", "editor-draft-2"]);
    for (const origin of [{kind: "ownerDraft", agentDeclaration: null}, {kind: "ownerDraft", agentDeclaration: {...agentDeclaration, depth: 65}},
      {kind: "ownerDraft", nativeSequence: 1}, {kind: "nativeUpdate"}]) {
      expect(() => parseNativeRestoreProposalReceipt(receipt([draft(origin)]), f.input)).toThrow();
    }
    // A draft cannot carry an invented native coordinate, and one queue holds one source kind.
    const invented = {...draft({kind: "ownerDraft"}), source: {binding, updateDigest, nativeSequence: 9, origin: {kind: "ownerDraft"}}};
    expect(() => parseNativeRestoreProposalReceipt(receipt([invented]), f.input)).toThrow();
    const otherBinding = {...draft({kind: "ownerDraft"}), source: {binding: {...binding, currentPath: "docs/other.md"}, updateDigest, origin: {kind: "ownerDraft"}}};
    expect(() => parseNativeRestoreProposalReceipt(receipt([otherBinding]), f.input)).toThrow();
  } finally {f.close();}
});

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

type AcceptedNative = {bytes: Uint8Array; source: Omit<ReturnType<typeof pendingSource>, "acceptedReceipt"> & {acceptedReceipt: ReturnType<ReturnType<typeof fixture>["add"]>}};
// Seed completed prefix delivery without one durable commit per author.
// Keep the band's final admission and application acknowledgement on the real path.
function seedOwnerApplicationPrefix(f: ReturnType<typeof fixture>, terminal: ReturnType<ReturnType<typeof fixture>["add"]>, count: number) {
  const where = "workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND host_id=?";
  const params = [f.document.workspaceId, f.document.mainVersionId, f.document.objectId, f.document.lineageClaimId, f.coordinate.hostId];
  const owner = f.context.db.prepare(`SELECT * FROM sync_relay_live_delivery_owners WHERE relay_database_namespace=? AND ${where}`).get("restore-test", ...params)!;
  const tip = JSON.stringify(terminal), sequence = 9, applicationSequence = count === 1 ? 9 : 2;
  const charge = Buffer.byteLength(JSON.stringify(["restore-test", ...params, owner.origin_json, tip, terminal.journalCursor, sequence, applicationSequence]));
  const reserved = f.context.db.prepare(`SELECT COUNT(*) AS count, SUM(reserved_bytes + accounted_bytes) AS bytes
    FROM sync_relay_live_delivery_reservations WHERE ${where} AND journal_cursor>0 AND journal_cursor<=?`).get(...params, terminal.journalCursor)!;
  expect(reserved.count).toBe(count);
  const refund = Number(reserved.bytes) + Number(owner.accounted_bytes) - charge;
  expect(f.context.db.prepare(`UPDATE sync_relay_live_delivery_owners
    SET tip_receipt_json=?,tip_cursor=?,tip_sequence=?,tip_application_sequence=?,accounted_bytes=? WHERE relay_database_namespace=? AND ${where}`)
    .run(tip, terminal.journalCursor, sequence, applicationSequence, charge, "restore-test", ...params).changes).toBe(1);
  expect(f.context.db.prepare(`DELETE FROM sync_relay_live_delivery_reservations WHERE ${where} AND journal_cursor>0 AND journal_cursor<=?`)
    .run(...params, terminal.journalCursor).changes).toBe(count);
  expect(f.context.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-? WHERE workspace_id=? AND usage_bytes>=?")
    .run(refund, f.document.workspaceId, refund).changes).toBe(1);
}
function readyNativeFence(kind: "bootstrap" | "owner", mode: "service" | "device", events: boolean | "native" | number = false, selectedPoint = false,
  beforeFence?: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture(kind, mode);
  // An owner adopts after the hook, so it adopts any service activation the hook records.
  if (kind === "owner") {beforeFence?.(f); f.adopt();}
  let acceptedNative: AcceptedNative | undefined;
  let seededPredecessor: ReturnType<typeof f.add> | null = null;
  const receipts: ReturnType<typeof f.add>[] = [];
  if (typeof events === "number") {
    const head = new Y.Doc();
    try {
      Y.applyUpdate(head, f.input.baselineBytes);
      const current = f.storage.resolveCurrentLiveDocumentBinding({document: f.document, actor: f.actor});
      if (current.kind !== "current") throw Error(current.kind);
      let priorMetadata: Parameters<typeof appendValidatedLiveJournal>[1]["priorMetadata"] = null;
      // Seed the valid prefix once; the band-crossing frame uses ordinary admission.
      f.context.tx(() => {for (let index = 0; index < events - 1; index++) {
        head.clientID = index + 1;
        const vector = Y.encodeStateVector(head);
        head.getMap("frontmatter").set(`band-${index}`, "named edit");
        const updateBytes = Y.encodeStateAsUpdate(head, vector);
        const row = appendValidatedLiveJournal(f.context, {document: f.document, namespace: "restore-test", host: f.coordinate,
          current, metadata: {deliveryId: `band-${index}`, updateDigest: hash(updateBytes)}, updateBytes,
          receivedAtMs: 30, firstSeen: [{clientId: index + 1, startClock: 0, endClock: 1}], firstSeenDeletes: [],
          authorSnapshot: [{kind: "automation", automationId: `a${index}`, attribution: {actorKind: "automation", depth: 0}}],
          checkpointBytes: null, checkpointDigest: null, priorMetadata});
        priorMetadata = row.metadata;
        receipts.push(row.metadata.accepted.receipt);
      }
        if (kind === "owner" && !selectedPoint && receipts.length) {
          seededPredecessor = receipts.at(-1)!;
          seedOwnerApplicationPrefix(f, seededPredecessor, receipts.length);
          receipts.length = 0;
        }
      });
      {
        const index = events - 1;
        head.clientID = index + 1;
        const vector = Y.encodeStateVector(head);
        head.getMap("frontmatter").set(`band-${index}`, "named edit");
        const capture = f.journalCapture(Y.encodeStateAsUpdate(head, vector), `band-${index}`);
        if (capture.validation.kind !== "accepted") throw Error(capture.validation.kind);
        const result = f.storage.commitLiveUpdateJournal({...capture, validation: {...capture.validation,
          evidence: {...capture.validation.evidence, stateUpdate: Y.encodeStateAsUpdate(head)}},
          trustedAutomation: {automationId: `a${index}`, attribution: {actorKind: "automation", depth: 0}}});
        if (result.result.kind !== "accepted") throw Error(JSON.stringify(result.result));
        receipts.push(result.result.receipt);
        if (index === 959) {
          expect(result.admitted!.metadata.checkpointCoverage).toHaveLength(960);
          expect(result.admitted!.metadata.checkpointCoverage!.some(entry => entry.author.kind === "unattributed")).toBe(false);
        }
      }
    } catch (error) {f.close();throw error;} finally {head.destroy();}
  } else if (events === "native") {
    const current = f.storage.resolveCurrentLiveDocumentBinding({document: f.document, actor: f.actor});
    if (current.kind !== "current") throw Error(current.kind);
    const bytes = f.update("first", "first"), source = pendingSource(current.binding, bytes, 1);
    // The owner's delivery of that update declares the agent its attribution names.
    const capture = f.journalCapture(bytes, source.deliveryId);
    const accountId = capture.expectedAuthority.principalId;
    const committed = f.storage.commitLiveUpdateJournal({...capture, trustedAccount: {accountId, name: accountId},
      metadata: {...capture.metadata, authorContext: {kind: "account", accountId, agent: {
        agentId: nativeAgent.agentId, ...(nativeAgent.onBehalfOf !== null ? {onBehalfOf: nativeAgent.onBehalfOf} : {}), depth: nativeAgent.depth}}}}).result;
    if (committed.kind !== "accepted") throw Error(committed.kind);
    receipts.push(committed.receipt); acceptedNative = {bytes, source: {...source, acceptedReceipt: committed.receipt}};
  } else if (events) receipts.push(f.add("first"));
  if (events && typeof events !== "number") receipts.push(f.add("last"));
  if (selectedPoint) {
    f.intent.restorePointCursor = receipts[0]!.journalCursor;
    f.intent.restorePointReceiptDigest = receipts[0]!.updateDigest;
  }
  if (kind !== "owner") beforeFence?.(f);
  f.fence();
  const capture = f.open();
  if (kind === "bootstrap") {
    const next = f.store.nextStopRestoreCut(capture);
    if (next.kind !== "bootstrap") throw Error(next.kind);
    f.store.acknowledgeStopRestoreBootstrap(capture, bootstrapAck(next.baseline));
  }
  for (const [index, receipt] of receipts.entries()) {
    f.store.acknowledgeStopRestoreApplication(capture, receipts[index - 1] ?? seededPredecessor, applicationAck(receipt, index === 0 && !seededPredecessor ? 9 : 2));
  }
  f.store.completeStopRestoreCut(capture);
  const operation = f.store.pendingStopRestoreFence(f.lookup).operation;
  const receipt: NativeRestoreFenceReceipt = {operation, localHeadSequence: 11, recordedAtMs: 100};
  return {...f, capture, receipt, acceptedNative};
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

it("serves the exact retained restore admission and checkpoint before native application", async () => {
  const f = contentProposalFixture("owner", "device", true);
  try {
    const proposed = f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
    const lifecycle = f.store.admitStopRestoreProposal(f.input, proposed.proposalDigest, policy, 201);
    expect(lifecycle.application).toBeNull();
    const raw = f.raw.prepare("SELECT * FROM sync_relay_live_update_journal ORDER BY journal_cursor DESC LIMIT 1").get()!;
    const decoded = decodeJournalRow(f.context.db, raw);
    const proof = verifyRestoreCheckpoint(f.context.db, decoded);
    const cursor = decoded.admitted.metadata.accepted.receipt.journalCursor;
    const reading = readReplicaLiveJournal(f.context, {workspaceId: "workspace", after: cursor - 1, limit: 1});
    // The page owns its proof even if retained evidence changes after the transaction closes.
    f.context.tx(() => f.context.db.exec("UPDATE sync_relay_live_restore_lifecycles SET admission_json='{}'"));
    const page = await reading;
    expect(page).toEqual({rows: [{admitted: {metadata: decoded.admitted.metadata, updateBytes: Buffer.from(decoded.admitted.updateBytes).toString("base64")},
      relayDatabaseNamespace: decoded.history.namespace, evidenceDigest: decoded.history.evidenceDigest, journalCursor: cursor,
      restore: {operationId: decoded.restoreOperationId, checkpoint: {digest: decoded.checkpoint!.digest, bytes: Buffer.from(decoded.checkpoint!.bytes).toString("base64")}, proof},
      authority: {lineageClaimId: f.document.lineageClaimId, baselineSequence: 1, restoreFenceGeneration: 2}}], nextCursor: cursor, hasMore: false});
    const encoded = JSON.stringify(page);
    for (const secret of ["hostCoordinate", "instanceId", "connectionId", "bearer", "cookie"]) expect(encoded).not.toContain(secret);
    await expect(readReplicaLiveJournal(f.context, {workspaceId: "workspace", after: cursor - 1, limit: 1})).rejects.toThrow();
  } finally {f.close();}
});

it.each([["bootstrap","service"],["bootstrap","device"],["owner","device"]] as const)("admits and resumes one durable restore replacement for %s on %s",(kind,mode)=>{
  const f=contentProposalFixture(kind,mode,kind==="owner");
  try {
    const proposed=f.store.recordStopRestoreProposal(f.input,f.encoded,policy,200),before=f.journalRows();
    // Coverage window statements are cached per database, so the row bound lives in the cost test.
    const prepare=vi.spyOn(f.context.db,"prepare");
    const admitted=f.store.admitStopRestoreProposal(f.input,proposed.proposalDigest,policy,201);
    const provenanceReads=prepare.mock.calls.map(([sql])=>sql).filter(sql=>sql.includes("sync_relay_live_update_struct_provenance") && /^\s*SELECT/i.test(sql));
    expect(provenanceReads.length).toBeGreaterThan(0);
    expect(provenanceReads.every(sql=>/WHERE[\s\S]*journal_cursor\s*(?:[<>=]|IN\b)/i.test(sql) ||
      /WHERE[\s\S]*client_id=\?[\s\S]*start_clock<=\?[\s\S]*start_clock>=/i.test(sql))).toBe(true);
    prepare.mockRestore();
    expect(admitted.phase).toBe("relay-admitted");
    expect(f.raw.prepare("SELECT admission_state FROM sync_relay_live_documents").get()!.admission_state).toBe("closed");
    const row=f.raw.prepare("SELECT * FROM sync_relay_live_update_journal ORDER BY journal_cursor DESC LIMIT 1").get()!;
    expect(row.restore_operation_id).toBe(f.input.operationId);
    expect(row.validation_checkpoint_bytes).toBeInstanceOf(Uint8Array);
    expect(admitted.admitted.firstSeen).toEqual(f.receipt.replacementRanges);
    expect(admitted.admitted.authorSnapshot).toEqual([]);
    expect(admitted.admitted.checkpointCoverage?.filter(entry => entry.author.kind === "unattributed"))
      .toHaveLength(1);
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

const hostedActivationId = `ordinary-activation-${"d".repeat(64)}`;
// Enrolls the fixture document on the service host through `shareId`, which
// another Edit grant covers unless it is the restore's own share, and records
// its completed activation, whose source is the registered baseline. An owner
// fixture adopts it.
function hostRestoredDocument(f: ReturnType<typeof fixture>, shareId: string) {
  if (shareId !== f.intent.shareId) f.write(db => {
    db.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner',?,0)")
      .run(shareId, f.document.workspaceId, JSON.stringify({paths: ["docs"], versionId: null}));
    db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES (?,?,'user','collaborator',NULL,'edit',1,'active',0,NULL,NULL)`).run(`${shareId}-grant`, shareId);
  });
  f.storage.claimWorkspaceIdentity({workspaceId: f.document.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  f.storage.enrollServiceHostDocument({workspaceId: f.document.workspaceId, path: "docs/a.md", shareId, ownerUserId: "owner", nowMs: 30, guard() {}});
  const state = Uint8Array.of(0, 0), {evidence} = f.input;
  const source = {version: 1, relayDatabaseNamespace: "restore-test", ...f.document, currentPath: "docs/a.md", replicationEpoch: "epoch",
    streamIdentity: "stream", committedCursor: 1, baseOriginId: "base", baseOriginSeq: 0, baseRelaySeq: 1, sourceMomentId: "moment-1",
    sourceDigest: evidence.projectedMarkdownSha256, sourceByteLength: evidence.projectedMarkdownByteLength, nativeHeadSequence: 0,
    fullStateDigest: hash(state), fullStateByteLength: state.byteLength};
  const binding = {...f.document, currentPath: "docs/a.md", selectorPaths: ["docs"], restoreFenceGeneration: 1};
  f.write(db => db.prepare(`INSERT INTO sync_relay_service_activations(relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
      source_json,binding_json,state_digest,state_bytes,owner_user_id,share_id,completion_json,accounted_bytes) VALUES ('restore-test',?,?,'main',?,?,?,?,?,?,'owner',?,'{}',1)`)
    .run(hostedActivationId, f.document.workspaceId, f.document.objectId, f.document.lineageClaimId, JSON.stringify(source),
      JSON.stringify(binding), source.fullStateDigest, state, shareId));
}

// Proves: a retirement recorded while a restore is unfinished, by the
// restore's own revocation of the last Edit grant or by Pause, keeps live
// admission fenced. The fence carries one recorded before it to the fenced
// generation, and relay admission names the restore's own journal cursor, the
// key the engine accepts once the restore resumes: completion at that key
// retires the activation once the restore's settlement moment is in the log,
// and at the old generation is refused. No other restore of the document
// begins while it is open.
it.each(["revocation", "pause"] as const)("carries a retirement recorded during a restore to the restored generation: %s", async cause => {
  const f = contentProposalFixture("owner", "service", false, false, false, 0,
    hosted => hostRestoredDocument(hosted, cause === "revocation" ? hosted.intent.shareId : "other"));
  try {
    const retirement = () => readServiceActivationRetirement(f.context, f.document);
    // The revocation records it as the restore begins, before the fence; Pause after the fence.
    const recorded = {relayDatabaseNamespace: "restore-test", activationId: hostedActivationId, ...f.document, path: "docs/a.md", requestedAtMs: cause === "revocation" ? 40 : 60};
    if (cause === "pause") {
      expect(retirement()).toBeNull();
      f.storage.setServiceHostEnrollmentEnabled({workspaceId: f.document.workspaceId, path: "docs/a.md", ownerUserId: "owner", enabled: false, nowMs: 60, guard() {}});
    }
    expect(retirement()).toEqual({...recorded, restoreFenceGeneration: 2, acceptedThrough: 2});
    const proposed = f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
    const admitted = f.store.admitStopRestoreProposal(f.input, proposed.proposalDigest, policy, 201);
    expect(retirement()).toEqual({...recorded, restoreFenceGeneration: 2, acceptedThrough: admitted.admitted.accepted.receipt.journalCursor});
    const application = {fence: admitted.preparation.fence, candidateDigest: admitted.candidateDigest, nativeSourceManifestDigest: admitted.nativeSourceManifestDigest,
      admitted: admitted.admitted, localHeadSequence: admitted.preparation.fence.localHeadSequence + 1,
      hostCoordinate: {hostId: f.input.host.hostId, hostEpoch: f.input.host.hostEpoch, instanceId: f.input.host.instanceId, connectionId: f.input.host.connectionId}, recordedAtMs: 202};
    f.store.acknowledgeStopRestoreReplacement(f.input, application);
    const settlement = {settlementId: "restore-settlement", previousCursor: 0, terminalCursor: admitted.admitted.accepted.receipt.journalCursor,
      applicationCount: 3, localYDocSequence: application.localHeadSequence, momentId: "restore-moment", markdownDigest: admitted.preparation.point.markdownDigest,
      materialized: true, collectionReconcileRequired: false};
    expect(f.store.acknowledgeStopRestoreSettlement(f.input, settlement).phase).toBe("settled");
    expect(f.store.acknowledgeStopRestoreResume(f.input, {relayDatabaseNamespace: admitted.preparation.fence.operation.relayDatabaseNamespace,
      operationId: f.input.operationId, binding: admitted.admitted.accepted.binding, applicationReceipt: admitted.admitted.accepted.receipt,
      settlementId: settlement.settlementId, momentId: settlement.momentId, markdownDigest: settlement.markdownDigest,
      localHeadSequence: application.localHeadSequence, recordedAtMs: 204}).phase).toBe("resumed");
    const {key: carried, boundary} = carriedRetirement({...f, admitted});
    expect(retirement()).toEqual({...recorded, restoreFenceGeneration: carried.restoreFenceGeneration, acceptedThrough: carried.acceptedThrough});
    expect(f.storage.serviceHostDocumentEnabled(f.document)).toBe(false);
    f.write(db => db.prepare("UPDATE sync_relay_share_grants SET status='active',generation=6,revoked_at_ms=NULL WHERE grant_id=?").run(f.intent.grantId));
    expect(() => f.storage.readStopRestorePlan({operationId: "after-retirement", ownerUserId: "owner", document: f.document, shareId: f.intent.shareId,
      grantId: f.intent.grantId, restorePointCursor: 0, restorePointReceiptDigest: f.intent.restorePointReceiptDigest, maxOutputBytes: 1_000_000}))
      .toThrow("Live editing is still stopping.");
    expect(() => beginStopRestore(f.context, {...f.intent, operationId: "after-retirement", expectedFence: 2, expectedGrantGeneration: 6}, 300))
      .toThrow("Live editing is still stopping.");
    expect(retirement()).toEqual({...recorded, restoreFenceGeneration: carried.restoreFenceGeneration, acceptedThrough: carried.acceptedThrough});
    const activations = f.storage.createServiceActivationStore(f.history);
    const complete = (key: typeof carried) => activations.completeRetirement({workspaceId: f.document.workspaceId, key, boundary,
      host: f.input.host, registeredAtMs: 400, nowMs: 400, guard() {}});
    expect(() => complete({...carried, restoreFenceGeneration: 1, acceptedThrough: 2})).toThrow("Service activation retirement is unavailable.");
    expect(complete(carried)).toEqual({status: "pending", reason: "restore"});
    const bytes = f.raw.prepare("SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(carried.acceptedThrough)!.validation_checkpoint_bytes as Uint8Array;
    await pushRestoreSettlement(f.storage, restorePublication({...f, admitted}, bytes, carried.acceptedThrough, "carried-publication"));
    expect(complete(carried)).toEqual({status: "retired", replayed: false});
    expect(retirement()).toBeNull();
  } finally {f.close();}
});

// Proves: a restore declined before its fence leaves the retirement its
// revocation recorded at the pre-restore key, since the generation never
// moved, and the declined restore blocks nothing the retirement does not.
it("keeps a retirement's pre-restore key when its restore is declined", () => {
  const f = fixture("owner", "service");
  try {
    hostRestoredDocument(f, f.intent.shareId);
    f.adopt();
    f.add("before-restore");
    const acceptedThrough = Number(f.raw.prepare("SELECT MAX(journal_cursor) AS cursor FROM sync_relay_live_update_journal").get()!.cursor);
    beginStopRestore(f.context, f.intent, 40);
    const recorded = {relayDatabaseNamespace: "restore-test", activationId: hostedActivationId, ...f.document, path: "docs/a.md",
      restoreFenceGeneration: 1, acceptedThrough, requestedAtMs: 40};
    expect(readServiceActivationRetirement(f.context, f.document)).toEqual(recorded);
    expect(declineStopRestore(f.context, f.lookup, 45).phase).toBe("declined");
    expect(readServiceActivationRetirement(f.context, f.document)).toEqual(recorded);
    expect(f.raw.prepare("SELECT restore_fence_generation,admission_state FROM sync_relay_live_documents").get()).toEqual({restore_fence_generation: 1, admission_state: "open"});
    expect(f.storage.serviceHostDocumentEnabled(f.document)).toBe(false);
    f.write(db => db.prepare("UPDATE sync_relay_share_grants SET status='active',generation=6,revoked_at_ms=NULL WHERE grant_id=?").run(f.intent.grantId));
    expect(() => beginStopRestore(f.context, {...f.intent, operationId: "after-decline", expectedGrantGeneration: 6}, 50))
      .toThrow("Live editing is still stopping.");
  } finally {f.close();}
});

// Proves: the retiring owner's push of the restore's settlement moment, made
// through its feed after settlement and before resume, retries until resume
// moves the owner's applied tip to the restore's row. The retried push then
// lands as retirement output and moves no projection.
it("publishes a restore's settlement moment for a retirement once the restore resumes", async () => {
  const f = admittedRestoreFixture("owner", false, "service", hosted => hostRestoredDocument(hosted, hosted.intent.shareId));
  try {
    const receipt = f.admitted.admitted.accepted.receipt, feed = createServiceHostFeed(f.storage), originId = `${SERVICE_HOST_ORIGIN_PREFIX}native`;
    const call = (method: string, route: string[], body?: BodyInit) => feed(new Request(`https://relay.test/sync/workspace/hosted/${route.join("/")}`,
      {method, ...(body === undefined ? {} : {body})}), {workspaceId: "workspace", route, actor: {userId: "owner"}, guard() {}});
    expect(readServiceActivationRetirement(f.context, f.document)).toMatchObject({activationId: hostedActivationId, restoreFenceGeneration: 2, acceptedThrough: receipt.journalCursor});
    f.store.acknowledgeStopRestoreReplacement(f.input, f.application);
    expect(f.store.acknowledgeStopRestoreSettlement(f.input, f.settlement).phase).toBe("settled");
    const bytes = f.raw.prepare("SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(receipt.journalCursor)!.validation_checkpoint_bytes as Uint8Array;
    const {payload, record} = restorePublication(f, bytes, receipt.journalCursor, "restore-publication");
    for (const sha256 of [payload.payloadBeforeBlobSha256, payload.payloadAfterBlobSha256, record.acceptedStateBlobSha256])
      expect((await call("PUT", ["blobs", sha256], Buffer.from(f.storage.getBlob("workspace", sha256)!))).status).toBe(200);
    const push = () => call("POST", ["log"], JSON.stringify({replicationEpoch: "epoch", streamIdentity: "stream", originId,
      ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 1, payload}]}));
    const projected = () => f.raw.prepare("SELECT * FROM sync_relay_object_moments").all(), before = projected();
    await expect(push()).rejects.toMatchObject({code: "settlement_proof_budget", message: "the retiring owner has not applied this publication yet"});
    expect(f.storage.fetchLogCoordinate({workspaceId: "workspace", originId, originSeq: 0})).toBeNull();
    expect(f.store.acknowledgeStopRestoreResume(f.input, f.resume).phase).toBe("resumed");
    // The file stayed at the restore's path, so the restore changed it there.
    expect(f.store.stopRestoreFinishedAtMovedPath(f.input)).toBe(false);
    const answer = await push();
    expect(answer.status).toBe(200);
    const landed = await answer.json() as Record<string, unknown>;
    expect([landed.inserted, landed.refusals]).toEqual([1, undefined]);
    expect(f.storage.fetchLogCoordinate({workspaceId: "workspace", originId, originSeq: 0})).toMatchObject({settlementAdmission: {status: "accepted"}});
    expect(projected()).toEqual(before);
    expect(readServiceActivationRetirement(f.context, f.document)).toMatchObject({activationId: hostedActivationId, acceptedThrough: receipt.journalCursor});
  } finally {f.close();}
});

type HostedStorage = Parameters<typeof createServiceHostFeed>[0];
// Uploads a restore publication's blobs and pushes its settlement moment through the host's feed, retiring unless `retiring` is false.
async function pushRestoreSettlement(storage: HostedStorage, {payload, record}: Pick<ReturnType<typeof restorePublication>, "payload" | "record">, retiring = true) {
  const feed = createServiceHostFeed(storage), originId = `${SERVICE_HOST_ORIGIN_PREFIX}native`;
  const call = (method: string, route: string[], body?: BodyInit) => feed(new Request(`https://relay.test/sync/workspace/hosted/${route.join("/")}`,
    {method, ...(body === undefined ? {} : {body})}), {workspaceId: "workspace", route, actor: {userId: "owner"}, guard() {}});
  for (const sha256 of [payload.payloadBeforeBlobSha256, payload.payloadAfterBlobSha256, record.acceptedStateBlobSha256])
    expect((await call("PUT", ["blobs", sha256], Buffer.from(storage.getBlob("workspace", sha256)!))).status).toBe(200);
  const answer = await call("POST", ["log"], JSON.stringify({replicationEpoch: "epoch", streamIdentity: "stream", originId,
    ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 1, payload}]}));
  expect(answer.status).toBe(200);
  expect(storage.fetchLogCoordinate({workspaceId: "workspace", originId, originSeq: 0})).toMatchObject({...(retiring ? {relayAdmission: "departed"} : {}),
    settlementAdmission: {status: "accepted"}});
}
// The retirement key a restore's relay admission carried, and the boundary its owner delivery releases at.
function carriedRetirement(f: Pick<ReturnType<typeof admittedRestoreFixture>, "admitted" | "document" | "raw">) {
  const receipt = f.admitted.admitted.accepted.receipt;
  const endpoint = f.raw.prepare("SELECT accepted_event_count,accepted_evidence_digest FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(receipt.journalCursor)!;
  return {key: {objectId: f.document.objectId, lineageClaimId: f.document.lineageClaimId, activationId: hostedActivationId,
    restoreFenceGeneration: 2, acceptedThrough: receipt.journalCursor},
  boundary: {terminalReceipt: receipt, eventCount: Number(endpoint.accepted_event_count), historyEvidenceDigest: String(endpoint.accepted_evidence_digest)}};
}
type Admitted = ReturnType<typeof admittedRestoreFixture>["admitted"];
// Proves and appends a resumed restore's settlement moment, as its host's push would.
async function publishRestore(f: Pick<ReturnType<typeof admittedRestoreFixture>, "document" | "raw" | "storage" | "context">, admitted: Admitted,
  id: string, previous = 0, before?: string, originSeq = 0) {
  const cursor = admitted.admitted.accepted.receipt.journalCursor;
  const bytes = f.raw.prepare("SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(cursor)!.validation_checkpoint_bytes as Uint8Array;
  const published = restorePublication({...f, admitted}, bytes, cursor, id, previous, before, originSeq);
  await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [published.op]});
  expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [published.op]})).toMatchObject({inserted: 1});
  expect(published.op).toMatchObject({settlementAdmission: {status: "accepted"}});
  return published;
}
// The fixture's source moment holds relay sequence 1 with no log row, so the first publication takes the next.
const passSourceMoment = (f: Pick<ReturnType<typeof fixture>, "raw">) =>
  f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','source',0,'test.source','{}',1)").run();
// What the restore's published moment moved: the object's moment and its current file.
const projectedMoment = (f: Pick<ReturnType<typeof fixture>, "raw">, momentId: string) => ({
  moment: f.raw.prepare("SELECT path,blob_sha256 FROM sync_relay_object_moments WHERE moment_id=?").get(momentId),
  file: f.raw.prepare("SELECT blob_sha256 FROM sync_relay_current_files WHERE workspace_id='workspace' AND version_id='main' AND path='docs/a.md'").get(),
});
// Shares the restore's Edit grant again at `generation`.
const reshare = (f: Pick<ReturnType<typeof fixture>, "raw">, generation: number) =>
  f.raw.prepare("UPDATE sync_relay_share_grants SET status='active',generation=?,revoked_at_ms=NULL WHERE grant_id='grant'").run(generation);
// Reopens the relay's storage on the fixture's database, as a restart would.
function restartRelay<F extends Pick<ReturnType<typeof fixture>, "storage" | "path" | "raw">>(f: F): F {
  f.storage.close();
  const storage = openSyncRelayStorage(f.path), history = createLiveJournalHistoryAuthority({namespace: "restore-test", reconciled: true});
  return {...f, storage, history, context: storage as StorageContext, store: storage.createLiveCommittedDeliveryStore(history),
    close: () => {f.raw.close(); storage.close();}};
}
// Fences the restore `lookup` names, and declines it with its host's `answer`.
function declineAfterFence(f: Pick<ReturnType<typeof fixture>, "context" | "store" | "raw">, lookup: ReturnType<typeof fixture>["lookup"], at: number,
  answer: "cancelled" | "fenceCancelled") {
  advanceStopRestoreFence(f.context, lookup, at);
  const capture = f.store.openStopRestoreCut(lookup);
  if (capture.kind !== "ready") throw Error(capture.kind);
  f.store.completeStopRestoreCut(capture.capture);
  const operation = f.store.pendingStopRestoreFence(lookup).operation;
  const receipt: NativeRestoreFenceReceipt = {operation, localHeadSequence: operation.appliedSequence, recordedAtMs: at + 1};
  const answers = cancellationAnswers({context: f.context, lookup, raw: f.raw, receipt});
  declineStopRestore(f.context, lookup, at + 2);
  expect(f.store.acknowledgeStopRestoreCancellation(lookup, answers[answer], at + 3).phase).toBe("declined");
}
// Fences, prepares and completes the begun restore `lookup` names.
function completeRestore<F extends Pick<ReturnType<typeof readyNativeFence>, "store" | "raw" | "context" | "document" | "close">>(f: F,
  lookup: ReturnType<typeof fixture>["lookup"], at: number) {
  advanceStopRestoreFence(f.context, lookup, at);
  const capture = f.store.openStopRestoreCut(lookup);
  if (capture.kind !== "ready") throw Error(capture.kind);
  f.store.completeStopRestoreCut(capture.capture);
  const operation = f.store.pendingStopRestoreFence(lookup).operation;
  const fence: NativeRestoreFenceReceipt = {operation, localHeadSequence: operation.appliedSequence, recordedAtMs: at + 1};
  const next = admitRestore(buildContentProposal({...f, ...proposalSources(f, "owner", lookup, fence), receipt: fence}));
  expect(next.complete().phase).toBe("resumed");
  return next;
}

// Proves: a retirement that carries a resumed restore stays pending, with
// nothing changed, until the log holds the restore's settlement moment, so the
// retiring host publishes what the restore wrote before a successor can take
// the document. That holds across a restart. Once the push lands it retires,
// across a restart and a lost response to either the push or the completion.
it("retires an activation that carries a restore only once its settlement moment is in the log", async () => {
  const f = admittedRestoreFixture("owner", false, "service", hosted => hostRestoredDocument(hosted, hosted.intent.shareId));
  const opened: ReturnType<typeof openSyncRelayStorage>[] = [];
  let closed = false;
  try {
    expect(f.complete().phase).toBe("resumed");
    const {key, boundary} = carriedRetirement(f);
    const bytes = f.raw.prepare("SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(key.acceptedThrough)!.validation_checkpoint_bytes as Uint8Array;
    const publication = restorePublication(f, bytes, key.acceptedThrough, "carried-restore-publication");
    const complete = (storage: ReturnType<typeof openSyncRelayStorage>) => storage.createServiceActivationStore(f.history).completeRetirement({
      workspaceId: f.document.workspaceId, key, boundary, host: f.lookup.host, registeredAtMs: 400, nowMs: 400, guard() {}});
    const state = (storage: ReturnType<typeof openSyncRelayStorage>) => ({activations: (storage as StorageContext).db.prepare("SELECT * FROM sync_relay_service_activations").all(),
      owners: (storage as StorageContext).db.prepare("SELECT * FROM sync_relay_live_delivery_owners").all()});
    const restart = () => {
      if (!closed) {f.close(); closed = true;} else opened.at(-1)!.close();
      const storage = openSyncRelayStorage(f.path);
      opened.push(storage);
      return storage;
    };
    const before = state(f.storage);
    expect(complete(f.storage)).toEqual({status: "pending", reason: "restore"});
    expect(state(f.storage)).toEqual(before);
    let storage = restart();
    expect(complete(storage)).toEqual({status: "pending", reason: "restore"});
    expect(state(storage)).toEqual(before);
    // The push lands but its response is lost; the host's retry replays it.
    await pushRestoreSettlement(storage, publication);
    await pushRestoreSettlement(storage, publication);
    storage = restart();
    expect(complete(storage)).toEqual({status: "retired", replayed: false});
    // The completion's response is lost; the retry after a restart replays it.
    storage = restart();
    expect(complete(storage)).toEqual({status: "retired", replayed: true});
    expect(readServiceActivationRetirement(storage as StorageContext, f.document)).toBeNull();
  } finally {if (!closed) f.close(); opened.at(-1)?.close();}
});

// Proves: a retirement that carries a published restore still completes after
// a later restore is fenced and declined. Restore A completes and publishes at
// generation 2 while another Edit grant keeps the activation running. Restore
// B revokes that grant, which opens the retirement at A's row; B's fence moves
// it to generation 3 and B's Decline keeps it there. A's settlement at its own
// generation is the publication the retirement waits for, across a restart.
it("retires after a declined restore that follows a published one", async () => {
  const f = admittedRestoreFixture("owner", false, "service", hosted => hostRestoredDocument(hosted, "other"));
  const opened: ReturnType<typeof openSyncRelayStorage>[] = [];
  let closed = false;
  try {
    expect(f.complete().phase).toBe("resumed");
    expect(readServiceActivationRetirement(f.context, f.document)).toBeNull();
    const restored = f.admitted.admitted.accepted.receipt.journalCursor;
    const bytes = f.raw.prepare("SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(restored)!.validation_checkpoint_bytes as Uint8Array;
    const published = restorePublication(f, bytes, restored, "restore-a-publication");
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [published.op]});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [published.op]})).toMatchObject({inserted: 1});
    expect(published.op).toMatchObject({settlementAdmission: {status: "accepted"}});
    const lookup = {...f.lookup, operationId: "restore-b"};
    beginStopRestore(f.context, {...f.intent, operationId: "restore-b", shareId: "other", grantId: "other-grant", expectedGrantGeneration: 1, expectedFence: 2}, 300);
    expect(readServiceActivationRetirement(f.context, f.document)).toMatchObject({restoreFenceGeneration: 2, acceptedThrough: restored});
    advanceStopRestoreFence(f.context, lookup, 301);
    const capture = f.store.openStopRestoreCut(lookup);
    if (capture.kind !== "ready") throw Error(capture.kind);
    f.store.completeStopRestoreCut(capture.capture);
    const operation = f.store.pendingStopRestoreFence(lookup).operation;
    const receipt: NativeRestoreFenceReceipt = {operation, localHeadSequence: operation.appliedSequence, recordedAtMs: 302};
    const {fenceCancelled} = cancellationAnswers({context: f.context, lookup, raw: f.raw, receipt});
    declineStopRestore(f.context, lookup, 303);
    expect(f.store.acknowledgeStopRestoreCancellation(lookup, fenceCancelled, 304).phase).toBe("declined");
    const carried = carriedRetirement(f), key = {...carried.key, restoreFenceGeneration: 3};
    expect(readServiceActivationRetirement(f.context, f.document)).toMatchObject({restoreFenceGeneration: 3, acceptedThrough: restored});
    const complete = () => {
      if (!closed) {f.close(); closed = true;} else opened.at(-1)!.close();
      const storage = openSyncRelayStorage(f.path);
      opened.push(storage);
      return storage.createServiceActivationStore(f.history).completeRetirement({workspaceId: f.document.workspaceId, key,
        boundary: carried.boundary, host: f.lookup.host, registeredAtMs: 400, nowMs: 400, guard() {}});
    };
    expect(complete()).toEqual({status: "retired", replayed: false});
    expect(complete()).toEqual({status: "retired", replayed: true});
    expect(readServiceActivationRetirement(opened.at(-1) as StorageContext, f.document)).toBeNull();
  } finally {if (!closed) f.close(); opened.at(-1)?.close();}
});

const publicationPending = "The last restore of this file has not reached the server yet. Try again in a moment.";
// Proves: the next restore of a file waits until the resumed restore before
// it is published, since that settlement commits only at the resumed
// restore's generation. Beginning answers pending with nothing changed, also
// after a restart. Once the settlement lands, restore B begins, fences and is
// declined after its fence, and restore C completes on the generation B left
// and publishes its own settlement, which moves the file and its history.
it("waits for a resumed restore's settlement before the next restore begins", async () => {
  const first = admittedRestoreFixture("owner", false);
  let f = first;
  try {
    expect(first.complete().phase).toBe("resumed");
    reshare(f, 6);
    const b = {...f.intent, operationId: "restore-b", expectedFence: 2, expectedGrantGeneration: 6};
    const operations = () => f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(), before = operations();
    expect(() => beginStopRestore(f.context, b, 300)).toThrow(publicationPending);
    expect(operations()).toEqual(before);
    expect(f.storage.getShareGrant("grant")).toMatchObject({status: "active", generation: 6});
    f = restartRelay(first);
    expect(() => beginStopRestore(f.context, b, 300)).toThrow(publicationPending);
    expect(operations()).toEqual(before);
    const a = await publishRestore(f, first.admitted, "restore-a-publication");
    expect(beginStopRestore(f.context, b, 300).previousOperationId).toBe("restore");
    declineAfterFence(f, {...f.lookup, operationId: "restore-b"}, 301, "fenceCancelled");
    reshare(f, 8);
    expect(beginStopRestore(f.context, {...f.intent, operationId: "restore-c", expectedFence: 3, expectedGrantGeneration: 8}, 310).previousOperationId).toBe("restore-b");
    const c = completeRestore(f, {...f.lookup, operationId: "restore-c"}, 311);
    const published = await publishRestore(f, c.admitted, "restore-c-publication", first.admitted.admitted.accepted.receipt.journalCursor, a.markdownDigest, 1);
    expect(projectedMoment(f, "restore-c-publication")).toEqual({moment: {path: "docs/a.md", blob_sha256: published.markdownDigest},
      file: {blob_sha256: published.markdownDigest}});
  } finally {f.close();}
});

// Proves: the fence rechecks that publication, so a restore begun while it
// was there does not fence once it is missing. Nothing changes until it is
// back, and then the fence goes on.
it("holds a restore's fence while its resumed predecessor's settlement is missing", async () => {
  const f = admittedRestoreFixture("owner", false);
  try {
    f.complete();
    await publishRestore(f, f.admitted, "restore-a-publication");
    reshare(f, 6);
    const lookup = {...f.lookup, operationId: "restore-b"};
    beginStopRestore(f.context, {...f.intent, operationId: "restore-b", expectedFence: 2, expectedGrantGeneration: 6}, 300);
    const binding = f.raw.prepare("SELECT * FROM sync_relay_live_settlement_bindings").get()!;
    f.raw.prepare("DELETE FROM sync_relay_live_settlement_bindings").run();
    const state = () => ({documents: f.raw.prepare("SELECT * FROM sync_relay_live_documents").all(),
      operations: f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all()}), before = state();
    expect(() => advanceStopRestoreFence(f.context, lookup, 301)).toThrow(publicationPending);
    expect(state()).toEqual(before);
    f.raw.prepare(`INSERT INTO sync_relay_live_settlement_bindings(${Object.keys(binding).join(",")}) VALUES (${Object.keys(binding).map(() => "?").join(",")})`)
      .run(...Object.values(binding) as (string | number)[]);
    expect(advanceStopRestoreFence(f.context, lookup, 302)).toMatchObject({phase: "fenced", newFence: 3});
  } finally {f.close();}
});

// The restore's checkpoint, as its host's settlement captures it.
const restoredState = (f: Pick<ReturnType<typeof fixture>, "raw">, admitted: Admitted) => f.raw.prepare("SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?")
  .get(admitted.admitted.accepted.receipt.journalCursor)!.validation_checkpoint_bytes as Uint8Array;
// Accepts the owner's edit to `doc` after the restore resumed.
function editAfterRestore(f: Pick<ReturnType<typeof admittedRestoreFixture>, "journalCapture" | "storage">, doc: Y.Doc, deliveryId: string) {
  const captured = f.journalCapture(Y.encodeStateAsUpdate(doc), deliveryId);
  const accepted = f.storage.commitLiveUpdateJournal({...captured, trustedAccount: {accountId: "owner", name: "Owner"},
    metadata: {...captured.metadata, authorContext: {kind: "account", accountId: "owner"}}});
  expect(accepted.result.kind).toBe("accepted");
  return accepted.admitted!.metadata.accepted.receipt.journalCursor;
}
const publicationRepair = "The server could not confirm the latest changes to this file. Ask the server's operator to repair it before restoring again.";

// Proves: a restore's publication its push ran out of proof budget for stays
// mandatory. The push answers retryably and stores nothing, so it is neither
// refused nor replaced by an unattributed moment. After a restart the host's
// retry publishes it through the feed and the next restore begins. Once that
// one is declined, the retirement that carries the restore's row completes.
it("retries a restore's publication its push ran out of proof budget for", async () => {
  const first = admittedRestoreFixture("owner", false, "service", hosted => hostRestoredDocument(hosted, "other"));
  let f = first;
  try {
    expect(first.complete().phase).toBe("resumed");
    const restored = first.admitted.admitted.accepted.receipt.journalCursor;
    const publication = restorePublication(first, restoredState(first, first.admitted), restored, "retried-restore-publication");
    const state = () => ({log: f.raw.prepare("SELECT * FROM sync_relay_log").all(), lifecycles: f.raw.prepare("SELECT * FROM sync_relay_live_restore_lifecycles").all()}), before = state();
    await expect(prepareHostedSettlements(first.context, {workspaceId: "workspace", originId: "proof", ops: [publication.op]}, new RestoreHistoryBudget(1, 65_536)))
      .rejects.toMatchObject({code: "settlement_proof_budget"});
    expect(publication.op).not.toHaveProperty("settlementAdmission");
    expect(state()).toEqual(before);
    f = restartRelay(first);
    await pushRestoreSettlement(f.storage, publication, false);
    // Restore B revokes the activation's other grant, which opens its retirement at A's row.
    expect(beginStopRestore(f.context, {...f.intent, operationId: "restore-b", shareId: "other", grantId: "other-grant", expectedGrantGeneration: 1,
      expectedFence: 2}, 300).previousOperationId).toBe("restore");
    expect(readServiceActivationRetirement(f.context, f.document)).toMatchObject({restoreFenceGeneration: 2, acceptedThrough: restored});
    // The retirement waits for B, which its owner declines after its fence.
    declineAfterFence(f, {...f.lookup, operationId: "restore-b"}, 301, "fenceCancelled");
    const carried = carriedRetirement(f);
    expect(f.storage.createServiceActivationStore(f.history).completeRetirement({workspaceId: f.document.workspaceId,
      key: {...carried.key, restoreFenceGeneration: 3}, boundary: carried.boundary, host: f.lookup.host, registeredAtMs: 400, nowMs: 400,
      guard() {}})).toEqual({status: "retired", replayed: false});
  } finally {f.close();}
});

// Proves: a restore's publication the relay refuses is a contradiction its
// host never retries, so the refusal is stored and the next restore of the
// file says it needs repair instead of asking to try again.
it("reports a refused restore publication as needing repair", async () => {
  const f = admittedRestoreFixture("owner", false);
  try {
    f.complete();
    const restored = f.admitted.admitted.accepted.receipt.journalCursor;
    const publication = restorePublication(f, restoredState(f, f.admitted), restored, "refused-restore-publication", 0, hash(Buffer.from("not the baseline")));
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [publication.op]});
    expect(publication.op).toMatchObject({settlementAdmission: {status: "refused"}});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [publication.op]})).toMatchObject({inserted: 1});
    expect(f.raw.prepare("SELECT refused_terminal_cursor FROM sync_relay_live_restore_lifecycles").get()).toEqual({refused_terminal_cursor: restored});
    reshare(f, 6);
    expect(() => beginStopRestore(f.context, {...f.intent, operationId: "restore-b", expectedFence: 2, expectedGrantGeneration: 6}, 300)).toThrow(publicationRepair);
  } finally {f.close();}
});

// Proves: a proof normalization refuses for capacity gets the same answer on
// every retry, so a single push publishing a restore is refused instead of
// asked to retry, and the device's next op lands behind it. The next restore
// says it needs repair until a later settlement publishes the restore.
it("refuses a restore's publication whose state is over the normalization limits", async () => {
  const f = admittedRestoreFixture("owner", false), normalize = vi.spyOn(liveValidation, "normalizeSettlement");
  try {
    f.complete();
    const restored = f.admitted.admitted.accepted.receipt.journalCursor;
    const publication = restorePublication(f, restoredState(f, f.admitted), restored, "oversized-restore-publication");
    normalize.mockResolvedValueOnce({kind: "refused", reason: "capacity-refused", source: "call"});
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [publication.op]});
    expect(publication.op).toMatchObject({settlementAdmission: {status: "refused"}});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [publication.op]})).toMatchObject({inserted: 1});
    reshare(f, 6);
    const b = {...f.intent, operationId: "restore-b", expectedFence: 2, expectedGrantGeneration: 6};
    expect(() => beginStopRestore(f.context, b, 300)).toThrow(publicationRepair);
    await publishRestore(f, f.admitted, "restore-a-publication", 0, undefined, 1);
    expect(beginStopRestore(f.context, b, 301).previousOperationId).toBe("restore");
  } finally {normalize.mockRestore(); f.close();}
});

// Proves: once a restore's publication is refused, a later settlement whose
// interval spans the restore's row and runs out of proof budget is refused,
// not asked to retry, and the device's next op lands behind it.
it("refuses an exhausted settlement across a restore whose publication was refused", async () => {
  const f = admittedRestoreFixture("owner", false), doc = new Y.Doc({gc: false});
  try {
    f.complete();
    const restored = f.admitted.admitted.accepted.receipt.journalCursor;
    const refused = restorePublication(f, restoredState(f, f.admitted), restored, "refused-restore-publication", 0, hash(Buffer.from("not the baseline")));
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [refused.op]});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [refused.op]})).toMatchObject({inserted: 1});
    Y.applyUpdate(doc, restoredState(f, f.admitted)); doc.getMap("frontmatter").set("after", "continued work");
    const edited = editAfterRestore(f, doc, "after-restore");
    const spanning = restorePublication(f, Y.encodeStateAsUpdate(doc), edited, "spanning-publication", 0, undefined, 1);
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [spanning.op]}, new RestoreHistoryBudget(1, 65_536));
    expect(spanning.op).toMatchObject({settlementAdmission: {status: "refused"}});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [spanning.op]})).toMatchObject({inserted: 1});
    const next = restorePublication(f, Y.encodeStateAsUpdate(doc), edited, "next-publication", 0, undefined, 2);
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [next.op]});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [next.op]})).toMatchObject({inserted: 1});
  } finally {doc.destroy(); f.close();}
});

// Proves: an exhausted restore publication is retried only from where
// admission measures it, the last row at another binding when one follows the
// latest binding. Here the file's first row is set to another selector, or
// another path, as if accepted before the change. Out of budget, a
// publication starting at that row is asked to retry; one starting before it
// is refused, and the device's next op lands behind it.
it.each([["selector", "selector_paths_json", '["docs/a.md"]'], ["rename", "current_path", "docs/old.md"]] as const)(
  "refuses an exhausted restore publication that starts before a %s change", async (_change, column, value) => {
  const f = admittedRestoreFixture("owner", false);
  try {
    f.complete();
    const restored = f.admitted.admitted.accepted.receipt.journalCursor;
    const changed = Number(f.raw.prepare("SELECT MIN(journal_cursor) AS cursor FROM sync_relay_live_update_journal").get()!.cursor);
    f.raw.prepare(`UPDATE sync_relay_live_update_journal SET ${column}=? WHERE journal_cursor=?`).run(value, changed);
    const binding = (cursor: number) => f.raw.prepare("SELECT current_path,selector_paths_json FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(cursor);
    expect(binding(changed)).not.toEqual(binding(restored));
    const fromChange = restorePublication(f, restoredState(f, f.admitted), restored, "from-change-publication", changed);
    await expect(prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [fromChange.op]}, new RestoreHistoryBudget(1, 65_536)))
      .rejects.toMatchObject({code: "settlement_proof_budget"});
    const beforeChange = restorePublication(f, restoredState(f, f.admitted), restored, "before-change-publication");
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [beforeChange.op]}, new RestoreHistoryBudget(1, 65_536));
    expect(beforeChange.op).toMatchObject({settlementAdmission: {status: "refused"}});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [beforeChange.op]})).toMatchObject({inserted: 1});
    const next = {originSeq: 1, opKind: "opaque", payloadJson: "{}", recordedAtMs: 1};
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [next]});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [next]})).toMatchObject({inserted: 1, currentMaxOriginSeq: 1});
  } finally {f.close();}
});

// Proves: a refused restore publication's hold is released by the settlement
// that later covers its row from the restore's own row, since the restore
// can no longer publish. The hold, its lifecycle's charge and workspace usage
// then match the stored rows.
it("releases a refused restore publication's hold with the settlement that covers it", async () => {
  const f = admittedRestoreFixture("owner", false), doc = new Y.Doc({gc: false});
  try {
    f.complete();
    const restored = f.admitted.admitted.accepted.receipt.journalCursor;
    const reservation = restorePublicationReservation("restore-test", f.admitted.admitted.accepted.binding);
    const held = () => f.raw.prepare("SELECT publication_reservation_bytes AS bytes,accounted_bytes FROM sync_relay_live_restore_lifecycles").get()!;
    const usage = () => Number(f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()!.usage_bytes);
    const refused = restorePublication(f, restoredState(f, f.admitted), restored, "refused-restore-publication", 0, hash(Buffer.from("not the baseline")));
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [refused.op]});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [refused.op]})).toMatchObject({inserted: 1});
    expect(Number(held().bytes)).toBe(reservation);
    Y.applyUpdate(doc, restoredState(f, f.admitted)); doc.getMap("frontmatter").set("after", "continued work");
    const edited = editAfterRestore(f, doc, "after-restore");
    const restoredMarkdown = String(f.raw.prepare("SELECT markdown_sha256 FROM sync_relay_live_settlement_cuts WHERE journal_cursor=?").get(restored)!.markdown_sha256);
    const covering = restorePublication(f, Y.encodeStateAsUpdate(doc), edited, "covering-publication", restored, restoredMarkdown, 1);
    const before = {held: held(), usage: usage()};
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [covering.op]});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [covering.op]})).toMatchObject({inserted: 1});
    expect(covering.op).toMatchObject({settlementAdmission: {status: "accepted"}});
    const stored = Number(f.raw.prepare("SELECT storage_bytes FROM sync_relay_live_settlement_bindings").get()!.storage_bytes);
    const log = f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "proof", originSeq: 1})!;
    const logged = Buffer.byteLength(log.payloadJson) + Buffer.byteLength(JSON.stringify(log.admittedAuthorSnapshot)) + Buffer.byteLength(JSON.stringify(log.settlementAdmission));
    expect(held()).toEqual({bytes: 0, accounted_bytes: Number(before.held.accounted_bytes) - reservation});
    expect(usage()).toBe(before.usage - reservation + stored + logged);
    expect(f.store.readStopRestoreLifecycle(f.input)!.phase).toBe("resumed");
  } finally {doc.destroy(); f.close();}
});

// Proves: when the newest refused settlement at a resumed restore's
// generation reaches its last row, beginning or fencing the next restore says
// it needs repair, with no later edit and across a restart. A settlement the
// relay refuses and one past the push's proof budget both count.
it.each([["begin", "refused"], ["fence", "refused"], ["begin", "over budget"]] as const)("reports an edit's unsettleable interval after a resumed restore as needing repair: %s, %s",
  async (step, cause) => {
    const first = admittedRestoreFixture("owner", false), doc = new Y.Doc({gc: false});
    let f = first;
    try {
      first.complete();
      const a = await publishRestore(f, first.admitted, "restore-a-publication"), restored = first.admitted.admitted.accepted.receipt.journalCursor;
      reshare(f, 6);
      const intent = {...f.intent, operationId: "restore-b", expectedFence: 2, expectedGrantGeneration: 6}, lookup = {...f.lookup, operationId: "restore-b"};
      if (step === "fence") beginStopRestore(f.context, intent, 300);
      Y.applyUpdate(doc, restoredState(f, first.admitted)); doc.getMap("frontmatter").set("after", "continued work");
      const edited = editAfterRestore(f, doc, "after-restore");
      const edits = restorePublication(f, Y.encodeStateAsUpdate(doc), edited, "edits-publication", restored,
        cause === "refused" ? hash(Buffer.from("not the restore")) : a.markdownDigest, 1);
      await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [edits.op]},
        cause === "refused" ? undefined : new RestoreHistoryBudget(1, 65_536));
      expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [edits.op]})).toMatchObject({inserted: 1});
      expect(edits.op).toMatchObject({settlementAdmission: {status: "refused"}});
      const next = () => step === "begin" ? beginStopRestore(f.context, intent, 301) : advanceStopRestoreFence(f.context, lookup, 301);
      const operations = () => f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(), before = operations();
      expect(next).toThrow(publicationRepair);
      f = restartRelay(first);
      expect(next).toThrow(publicationRepair);
      expect(operations()).toEqual(before);
    } finally {doc.destroy(); f.close();}
  });

// Proves: a refused settlement stops counting once a later one covers its
// row. After a refused publication of restore A, a covering one lands; an
// edit after it then asks to try again, across a restart, and once the
// edit's settlement lands the next restore begins.
it("asks to try again for an edit after a refused publication is covered", async () => {
  const first = admittedRestoreFixture("owner", false), doc = new Y.Doc({gc: false});
  let f = first;
  try {
    first.complete();
    const restored = first.admitted.admitted.accepted.receipt.journalCursor;
    const refused = restorePublication(f, restoredState(f, first.admitted), restored, "refused-restore-publication", 0, hash(Buffer.from("not the baseline")));
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [refused.op]});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [refused.op]})).toMatchObject({inserted: 1});
    const a = await publishRestore(f, first.admitted, "restore-a-publication", 0, undefined, 1);
    Y.applyUpdate(doc, restoredState(f, first.admitted)); doc.getMap("frontmatter").set("after", "continued work");
    const edited = editAfterRestore(f, doc, "after-restore");
    reshare(f, 6);
    const b = {...f.intent, operationId: "restore-b", expectedFence: 2, expectedGrantGeneration: 6};
    expect(() => beginStopRestore(f.context, b, 300)).toThrow(publicationPending);
    f = restartRelay(first);
    expect(() => beginStopRestore(f.context, b, 301)).toThrow(publicationPending);
    const edits = restorePublication(f, Y.encodeStateAsUpdate(doc), edited, "edits-publication", restored, a.markdownDigest, 2);
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [edits.op]});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [edits.op]})).toMatchObject({inserted: 1});
    expect(edits.op).toMatchObject({settlementAdmission: {status: "accepted"}});
    expect(beginStopRestore(f.context, b, 302).previousOperationId).toBe("restore");
  } finally {doc.destroy(); f.close();}
});

// Proves: the next fence waits for every row at the resumed restore's
// generation, not only the restore's own. Edits after restore A are unsettled
// when restore B would fence, so B waits with nothing changed. Once their
// settlement lands, B fences and is declined after its fence, and the edits
// are the file another device reads.
it("waits for edits after a resumed restore before the next restore fences", async () => {
  const f = admittedRestoreFixture("owner", false), doc = new Y.Doc({gc: false});
  try {
    f.complete();
    const a = await publishRestore(f, f.admitted, "restore-a-publication"), restored = f.admitted.admitted.accepted.receipt.journalCursor;
    reshare(f, 6);
    const lookup = {...f.lookup, operationId: "restore-b"};
    beginStopRestore(f.context, {...f.intent, operationId: "restore-b", expectedFence: 2, expectedGrantGeneration: 6}, 300);
    Y.applyUpdate(doc, restoredState(f, f.admitted)); doc.getMap("frontmatter").set("after", "continued work");
    const edited = editAfterRestore(f, doc, "after-restore");
    const state = () => ({documents: f.raw.prepare("SELECT * FROM sync_relay_live_documents").all(),
      operations: f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all()}), before = state();
    expect(() => advanceStopRestoreFence(f.context, lookup, 301)).toThrow(publicationPending);
    expect(state()).toEqual(before);
    const edits = restorePublication(f, Y.encodeStateAsUpdate(doc), edited, "edits-publication", restored, a.markdownDigest, 1);
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [edits.op]});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [edits.op]})).toMatchObject({inserted: 1});
    expect(edits.op).toMatchObject({settlementAdmission: {status: "accepted"}});
    advanceStopRestoreFence(f.context, lookup, 302);
    // The owner's host applies the edit before its cut.
    const capture = f.store.openStopRestoreCut(lookup);
    if (capture.kind !== "ready") throw Error(capture.kind);
    const step = f.store.nextStopRestoreCut(capture.capture);
    if (step.kind !== "next") throw Error(step.kind);
    f.store.acknowledgeStopRestoreApplication(capture.capture, step.predecessor, applicationAck(step.admitted.metadata.accepted.receipt, f.application.localHeadSequence + 1));
    f.store.completeStopRestoreCut(capture.capture);
    const operation = f.store.pendingStopRestoreFence(lookup).operation;
    const answers = cancellationAnswers({context: f.context, lookup, raw: f.raw, receipt: {operation, localHeadSequence: operation.appliedSequence, recordedAtMs: 303}});
    declineStopRestore(f.context, lookup, 304);
    expect(f.store.acknowledgeStopRestoreCancellation(lookup, answers.fenceCancelled, 305).phase).toBe("declined");
    expect(projectedMoment(f, "edits-publication")).toEqual({moment: {path: "docs/a.md", blob_sha256: edits.markdownDigest},
      file: {blob_sha256: edits.markdownDigest}});
  } finally {doc.destroy(); f.close();}
});

// Proves: a restore's settlement proof and its journal row step back across
// two consecutive restores declined after their fences, charging each host
// answer they load to the caller's budget. The traversal finds nothing for a
// cutover or binding that does not match.
it("steps across consecutive restores declined after their fences", async () => {
  const f = admittedRestoreFixture("owner", false);
  try {
    f.complete();
    const a = await publishRestore(f, f.admitted, "restore-a-publication"), restored = f.admitted.admitted.accepted.receipt.journalCursor;
    for (const [index, operationId] of ["restore-b", "restore-c"].entries()) {
      reshare(f, 6 + 2 * index);
      beginStopRestore(f.context, {...f.intent, operationId, expectedFence: 2 + index, expectedGrantGeneration: 6 + 2 * index}, 300 + 10 * index);
      declineAfterFence(f, {...f.lookup, operationId}, 301 + 10 * index, "fenceCancelled");
    }
    reshare(f, 10);
    beginStopRestore(f.context, {...f.intent, operationId: "restore-d", expectedFence: 4, expectedGrantGeneration: 10}, 320);
    const d = completeRestore(f, {...f.lookup, operationId: "restore-d"}, 321), terminal = d.admitted.admitted.accepted.receipt.journalCursor;
    const answers = f.raw.prepare("SELECT length(CAST(acknowledgment_json AS BLOB)) AS bytes FROM sync_relay_live_restore_cancellations WHERE outcome='fence-cancelled'")
      .all().map(row => Number(row.bytes));
    expect(answers).toHaveLength(2);
    const budget = new RestoreHistoryBudget(SETTLEMENT_PUSH_MAX_BYTES, SETTLEMENT_PUSH_MAX_METADATA_EVENTS), proofCharges = vi.spyOn(budget, "chargeBytes");
    const published = restorePublication({...f, admitted: d.admitted}, restoredState(f, d.admitted), terminal, "restore-d-publication", restored, a.markdownDigest, 1);
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [published.op]}, budget);
    expect(published.op).toMatchObject({settlementAdmission: {status: "accepted"}});
    expect(proofCharges.mock.calls.map(([bytes]) => bytes)).toEqual(expect.arrayContaining(answers));
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [published.op]})).toMatchObject({inserted: 1});
    const journalCharges: number[] = [], db = f.context.db;
    assertJournalCheckpointPosition(db, decodeJournalRow(db, db.prepare("SELECT * FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(terminal)!),
      {bytes: Number.MAX_SAFE_INTEGER, chargeBytes: bytes => {journalCharges.push(bytes);}});
    expect(journalCharges).toEqual(expect.arrayContaining(answers));
    const at = (restoreFenceGeneration: number, path = "docs/a.md") => ({...f.admitted.admitted.accepted.binding, currentPath: path, restoreFenceGeneration});
    expect(acrossDeclinedRestores(db, "restore-test", at(4), restored)).toEqual(at(2));
    expect(acrossDeclinedRestores(db, "restore-test", at(4), restored - 1)).toBeNull();
    expect(acrossDeclinedRestores(db, "restore-test", at(4, "docs/b.md"), restored)).toBeNull();
  } finally {f.close();}
});

// Proves: the traversal steps across as many declined generations as native's
// `require_cancelled` does, and finds nothing past them.
it("stops stepping across declined restores past native's generation limit", async () => {
  const f = admittedRestoreFixture("owner", false);
  try {
    f.complete();
    await publishRestore(f, f.admitted, "restore-a-publication");
    const restored = f.admitted.admitted.accepted.receipt.journalCursor, db = f.context.db;
    reshare(f, 6);
    beginStopRestore(f.context, {...f.intent, operationId: "restore-b", expectedFence: 2, expectedGrantGeneration: 6}, 300);
    declineAfterFence(f, {...f.lookup, operationId: "restore-b"}, 301, "fenceCancelled");
    const at = (restoreFenceGeneration: number) => ({...f.admitted.admitted.accepted.binding, restoreFenceGeneration});
    // Copies restore B's Decline to each later generation, through `top`.
    const operation = db.prepare("SELECT * FROM sync_relay_live_restore_operations WHERE operation_id='restore-b'").get()!;
    const cancellation = db.prepare("SELECT * FROM sync_relay_live_restore_cancellations WHERE operation_id='restore-b'").get()!;
    const insert = (table: string, row: Record<string, unknown>) => db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
      .run(...Object.values(row) as (string | number | null)[]);
    let declined = 3;
    const copyThrough = (top: number) => {
      db.exec("BEGIN");
      while (declined < top) {
        declined++;
        const answer = JSON.parse(String(cancellation.acknowledgment_json));
        answer.generation = answer.binding.restoreFenceGeneration = answer.receipt.binding.restoreFenceGeneration = answer.receipt.fence.operation.newFence = declined;
        answer.receipt.fence.operation.oldBinding.restoreFenceGeneration = declined - 1;
        insert("sync_relay_live_restore_operations", {...operation, operation_id: `declined-${declined}`, old_fence: declined - 1, new_fence: declined});
        insert("sync_relay_live_restore_cancellations", {...cancellation, operation_id: `declined-${declined}`, journal_cursor: 1_000_000 + declined, acknowledgment_json: JSON.stringify(answer)});
      }
      db.exec("COMMIT");
    };
    copyThrough(MAX_DECLINED_GENERATIONS + 2);
    expect(acrossDeclinedRestores(db, "restore-test", at(MAX_DECLINED_GENERATIONS + 2), restored)).toEqual(at(2));
    copyThrough(MAX_DECLINED_GENERATIONS + 3);
    expect(acrossDeclinedRestores(db, "restore-test", at(MAX_DECLINED_GENERATIONS + 3), restored)).toBeNull();
  } finally {f.close();}
});

// Proves: admission funds a restore's publication apart from its receipts and
// keeps it through resume. The append that stores the restore's binding
// releases it once: a failed append keeps it, a second covering settlement
// releases nothing, and usage is the stored charges plus what is held. The
// held amount is the moment's log row and the binding, each at its limit.
it("funds a restore's publication at admission and releases it once with its binding", async () => {
  const f = admittedRestoreFixture("owner", false);
  try {
    const binding = f.admitted.admitted.accepted.binding, cursor = f.admitted.admitted.accepted.receipt.journalCursor;
    const reservation = restorePublicationReservation("restore-test", binding);
    // Every field at its limit, escaped as stored: a backslash costs two JSON bytes and a lone surrogate six.
    expect(maximumBindingBytes("restore-test", binding)).toBe(2 + 15 + [binding.workspaceId, binding.mainVersionId, binding.objectId, binding.lineageClaimId,
      "restore-test", binding.restoreFenceGeneration, stableJsonStringify(binding)].reduce<number>((n, value) => n + Buffer.byteLength(JSON.stringify(value)), 0) +
      2 * 16 + (2 + 80) + (2 + 2 * 512) + 3 * (2 + 64) + (2 + 6 * 256) + 16);
    expect(reservation).toBe(262_144 + 131_072 + 119 + maximumBindingBytes("restore-test", binding));
    const held = () => f.raw.prepare("SELECT publication_reservation_bytes AS bytes,accounted_bytes FROM sync_relay_live_restore_lifecycles").get()!;
    const usage = () => Number(f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()!.usage_bytes);
    expect(Number(held().bytes)).toBe(reservation);
    f.complete();
    expect(Number(held().bytes)).toBe(reservation);
    const funded = held();
    const publication = restorePublication(f, restoredState(f, f.admitted), cursor, "funded-publication");
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [publication.op]});
    // Another settlement of the same row, proved before either lands.
    const second = restorePublication(f, restoredState(f, f.admitted), cursor, "second-publication");
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "second", ops: [second.op]});
    expect(second.op).toMatchObject({settlementAdmission: {status: "accepted"}});
    // Proving releases nothing; only the append does.
    const before = {held: funded, usage: usage()};
    expect(held()).toEqual(funded);
    f.raw.exec("CREATE TRIGGER refuse_binding BEFORE INSERT ON sync_relay_live_settlement_bindings BEGIN SELECT RAISE(ABORT,'binding refused'); END");
    expect(() => f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [publication.op]})).toThrow("binding refused");
    expect({held: held(), usage: usage()}).toEqual(before);
    f.raw.exec("DROP TRIGGER refuse_binding");
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [publication.op]})).toMatchObject({inserted: 1});
    const stored = Number(f.raw.prepare("SELECT storage_bytes FROM sync_relay_live_settlement_bindings").get()!.storage_bytes);
    const log = f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "proof", originSeq: 0})!;
    const logged = Buffer.byteLength(log.payloadJson) + Buffer.byteLength(JSON.stringify(log.admittedAuthorSnapshot)) + Buffer.byteLength(JSON.stringify(log.settlementAdmission));
    expect(stored).toBeLessThanOrEqual(maximumBindingBytes("restore-test", binding));
    expect(held()).toEqual({bytes: 0, accounted_bytes: Number(before.held.accounted_bytes) - reservation});
    expect(usage()).toBe(before.usage - reservation + stored + logged);
    const after = usage();
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [publication.op]})).toMatchObject({inserted: 0});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "second", ops: [second.op]})).toMatchObject({inserted: 1});
    expect(second.op).toMatchObject({settlementAdmission: {status: "refused"}});
    const refused = f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "second", originSeq: 0})!;
    expect(held()).toEqual({bytes: 0, accounted_bytes: Number(before.held.accounted_bytes) - reservation});
    expect(f.raw.prepare("SELECT refused_terminal_cursor FROM sync_relay_live_restore_lifecycles").get()).toEqual({refused_terminal_cursor: cursor});
    expect(usage()).toBe(after + Buffer.byteLength(refused.payloadJson) + Buffer.byteLength(JSON.stringify(refused.settlementAdmission)));
    expect(f.store.readStopRestoreLifecycle(f.input)!.phase).toBe("resumed");
  } finally {f.close();}
});

// Proves: a restore publication is bounded by what admission actually holds,
// not by the largest binding its own binding could store. With less held than
// its binding and log row charge, as a reservation computed from a smaller
// binding would be, it is refused before anything is released.
it("refuses a restore publication that would charge more than admission held", async () => {
  const f = admittedRestoreFixture("owner", false);
  try {
    f.complete();
    const reservation = restorePublicationReservation("restore-test", f.admitted.admitted.accepted.binding);
    f.raw.prepare("UPDATE sync_relay_live_restore_lifecycles SET accounted_bytes=accounted_bytes-publication_reservation_bytes+1,publication_reservation_bytes=1").run();
    f.raw.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-? WHERE workspace_id='workspace'").run(reservation - 1);
    const publication = restorePublication(f, restoredState(f, f.admitted), f.admitted.admitted.accepted.receipt.journalCursor, "overcharged-publication");
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [publication.op]});
    expect(publication.op).toMatchObject({settlementAdmission: {status: "accepted"}});
    const held = () => f.raw.prepare("SELECT publication_reservation_bytes,accounted_bytes FROM sync_relay_live_restore_lifecycles").get(), before = held();
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [publication.op]})).toMatchObject({inserted: 1});
    expect(publication.op).toMatchObject({settlementAdmission: {status: "refused"}});
    expect(held()).toEqual(before);
    expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_settlement_bindings").get()).toEqual({n: 0});
  } finally {f.close();}
});

// Proves: deleting the owner's account removes a restore's held publication
// with its rows and workspace, and leaves another workspace's usage alone.
it("removes a restore's held publication with its owner's account", () => {
  const f = admittedRestoreFixture("owner", false);
  try {
    f.complete();
    expect(Number(f.raw.prepare("SELECT publication_reservation_bytes FROM sync_relay_live_restore_lifecycles").get()!.publication_reservation_bytes)).toBeGreaterThan(0);
    const others = () => f.raw.prepare("SELECT * FROM sync_relay_workspace_usage WHERE workspace_id<>'workspace' ORDER BY workspace_id").all(), before = others();
    initializeAccountDeletion(f.context, "fence-key");
    const deletion = fenceAccount(f.context, "fence-key", "owner", "owner@dohc.test");
    purgeAccountRows(f.context, "owner", "owner@dohc.test", deletion.manifest!);
    const count = (table: string) => Number(f.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
    expect(["sync_relay_live_restore_lifecycles", "sync_relay_live_restore_operations", "sync_relay_workspaces"].map(count)).toEqual([0, 0, 0]);
    expect(f.raw.prepare("SELECT 1 FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()).toBeUndefined();
    expect(others()).toEqual(before);
    expect(f.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {f.close();}
});

// Proves: the fence moves an open retirement to the fenced generation only
// when its accepted-through is the fence's cutover. Any other value is damage,
// and the fence changes nothing.
it("refuses the fence when an open retirement's accepted-through is not its cutover", () => {
  const f = fixture("owner", "service");
  try {
    hostRestoredDocument(f, f.intent.shareId);
    f.adopt();
    f.add("before-restore");
    beginStopRestore(f.context, f.intent, 40);
    const cutover = readServiceActivationRetirement(f.context, f.document)!.acceptedThrough;
    const accepted = (cursor: number) => f.write(db => db.prepare("UPDATE sync_relay_service_activations SET retire_accepted_cursor=?").run(cursor));
    const state = () => ({documents: f.rows().documents, operations: f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all()});
    accepted(cutover - 1);
    const before = state();
    expect(() => advanceStopRestoreFence(f.context, f.lookup, 50)).toThrow("Service activation retirement is damaged.");
    expect(state()).toEqual(before);
    accepted(cutover);
    expect(advanceStopRestoreFence(f.context, f.lookup, 50).cutoverCursor).toBe(cutover);
    expect(readServiceActivationRetirement(f.context, f.document)).toMatchObject({restoreFenceGeneration: 2, acceptedThrough: cutover});
  } finally {f.close();}
});

// The two answers a fenced restore's host may give to a cancellation.
function cancellationAnswers(f: Pick<ReturnType<typeof readyNativeFence>, "context" | "lookup" | "raw" | "receipt">) {
  const cutover = readStopRestore(f.context, f.lookup)!.cutoverCursor!;
  const fence = f.receipt.operation, binding = {...fence.oldBinding, restoreFenceGeneration: fence.newFence};
  const row = f.raw.prepare("SELECT accepted_event_count,accepted_evidence_digest FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(cutover)!;
  const cancelled: NativeRestoreCancellationAnswer = {status: "cancelled", hostId: fence.hostId, generation: fence.newFence - 1, binding: fence.oldBinding};
  const fenceCancelled: NativeRestoreCancellationAnswer & {status: "fenceCancelled"} = {status: "fenceCancelled", hostId: fence.hostId,
    generation: fence.newFence, binding, receipt: {fence: f.receipt, binding, endpoint: {terminalReceipt: fence.terminal,
      eventCount: Number(row.accepted_event_count), historyEvidenceDigest: String(row.accepted_evidence_digest)}, recordedAtMs: 160}};
  return {cutover, cancelled, fenceCancelled};
}
// A restore fenced on the service host that adopted the document's
// activation, whose revocation opened a retirement, with the native fence
// saved when `native`.
function serviceFence(native: boolean) {
  const f = readyNativeFence("owner", "service", true, false, hosted => hostRestoredDocument(hosted, hosted.intent.shareId));
  try {
    if (native) f.store.acknowledgeStopRestoreFence(f.lookup, f.receipt);
    const answers = cancellationAnswers(f);
    const key = (restoreFenceGeneration: number) => ({objectId: f.document.objectId, lineageClaimId: f.document.lineageClaimId,
      activationId: hostedActivationId, restoreFenceGeneration, acceptedThrough: answers.cutover});
    return {...f, ...answers, key};
  } catch (error) {f.close(); throw error;}
}
// The same restore, declined after its fence.
function declinedFence(native: boolean) {
  const f = serviceFence(native);
  try {
    expect(declineStopRestore(f.context, f.lookup, 150).phase).toBe(native ? "native-fenced" : "old-cut-applied");
    return f;
  } catch (error) {f.close(); throw error;}
}
type DeclinedFence = ReturnType<typeof declinedFence>;
// Completes at the retiring owner's release: what it applied, through the key's accepted row.
const completeRetirementAt = (f: Pick<DeclinedFence, "storage" | "history" | "document" | "lookup">, key: ReturnType<DeclinedFence["key"]>) => {
  const db = (f.storage as StorageContext).db, owner = db.prepare("SELECT tip_receipt_json FROM sync_relay_live_delivery_owners").get()!;
  const endpoint = db.prepare("SELECT accepted_event_count,accepted_evidence_digest FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(key.acceptedThrough)!;
  return f.storage.createServiceActivationStore(f.history).completeRetirement({workspaceId: f.document.workspaceId, key,
    boundary: {terminalReceipt: JSON.parse(String(owner.tip_receipt_json)), eventCount: Number(endpoint.accepted_event_count),
      historyEvidenceDigest: String(endpoint.accepted_evidence_digest)}, host: f.lookup.host, registeredAtMs: 400, nowMs: 400, guard() {}});
};
const documentState = (f: Pick<DeclinedFence, "raw">) => f.raw.prepare("SELECT restore_fence_generation,admission_state FROM sync_relay_live_documents").get();

// Proves: when the fencing host answers that no native fence committed, the
// Decline ends the restore with no fence. The document and its open
// retirement go back to the old generation in the same write, access and
// admission stay stopped, and the retirement completes at its old key only.
it("ends a declined restore at the old generation when its host never fenced it", () => {
  const f = declinedFence(false);
  try {
    expect(f.store.pendingStopRestoreCancellation(f.lookup)).toEqual({operationId: "restore", objectId: f.document.objectId,
      lineageClaimId: f.document.lineageClaimId, hostId: f.receipt.operation.hostId, newFence: 2});
    const declined = f.store.acknowledgeStopRestoreCancellation(f.lookup, f.cancelled, 170);
    expect(declined).toMatchObject({phase: "declined", newFence: null, cutoverCursor: null, applied: null, nativeReceipt: null, declinedAtMs: 170});
    expect(documentState(f)).toEqual({restore_fence_generation: 1, admission_state: "closed"});
    expect(readServiceActivationRetirement(f.context, f.document)).toMatchObject({restoreFenceGeneration: 1, acceptedThrough: f.cutover, requestedAtMs: 40});
    expect(f.raw.prepare("SELECT outcome,journal_cursor FROM sync_relay_live_restore_cancellations").all()).toEqual([{outcome: "cancelled", journal_cursor: null}]);
    expect(f.store.pendingStopRestoreCancellation(f.lookup)).toBeNull();
    // A lost reply replays; a different answer is refused.
    const after = f.rows();
    expect(f.store.acknowledgeStopRestoreCancellation(f.lookup, f.cancelled, 180)).toEqual(declined);
    expect(() => f.store.acknowledgeStopRestoreCancellation(f.lookup, f.fenceCancelled, 180)).toThrow();
    expect(f.rows()).toEqual(after);
    expect(f.storage.getShareGrant("grant")).toMatchObject({status: "revoked"});
    expect(() => completeRetirementAt(f, f.key(2))).toThrow("Service activation retirement is unavailable.");
    expect(completeRetirementAt(f, f.key(1))).toEqual({status: "retired", replayed: false});
  } finally {f.close();}
});

// Proves: when the fencing host answers with its terminal receipt, the
// Decline ends the restore at the fenced generation, whether or not the relay
// saved the native fence's reply. The receipt takes its own journal cursor,
// served to replicas as a control entry, and survives a restart; the
// retirement stays at the fenced generation with its accepted-through
// unchanged, completes there, and the old key is refused.
it.each([false, true])("ends a declined restore at the fenced generation with its host's receipt, native fence saved=%s", async native => {
  const f = declinedFence(native);
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined, closed = false;
  try {
    const sequence = () => Number(f.raw.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_relay_live_update_journal'").get()!.seq);
    const control = sequence() + 1, operation = readStopRestore(f.context, f.lookup)!;
    const declined = f.store.acknowledgeStopRestoreCancellation(f.lookup, f.fenceCancelled, 170);
    expect(declined).toEqual({...operation, phase: "declined", declinedAtMs: 170, nativeReceipt: f.receipt});
    expect(documentState(f)).toEqual({restore_fence_generation: 2, admission_state: "closed"});
    expect(readServiceActivationRetirement(f.context, f.document)).toMatchObject({restoreFenceGeneration: 2, acceptedThrough: f.cutover, requestedAtMs: 40});
    expect(f.raw.prepare("SELECT outcome,journal_cursor FROM sync_relay_live_restore_cancellations").all()).toEqual([{outcome: "fence-cancelled", journal_cursor: control}]);
    expect(sequence()).toBe(control);
    expect(await readReplicaLiveJournal(f.context, {workspaceId: "workspace", after: f.cutover, limit: 10}))
      .toEqual({rows: [{relayDatabaseNamespace: "restore-test", journalCursor: control, cancellation: f.fenceCancelled.receipt}], nextCursor: control, hasMore: false});
    const operations = () => f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(), after = operations();
    f.close(); closed = true;
    reopened = openSyncRelayStorage(f.path);
    const history = createLiveJournalHistoryAuthority({namespace: "restore-test", reconciled: true});
    const store = reopened.createLiveCommittedDeliveryStore(history);
    expect(store.pendingStopRestoreCancellation(f.lookup)).toBeNull();
    expect(store.acknowledgeStopRestoreCancellation(f.lookup, f.fenceCancelled, 180)).toEqual(declined);
    expect(() => store.acknowledgeStopRestoreCancellation(f.lookup, f.cancelled, 180)).toThrow();
    expect(() => store.acknowledgeStopRestoreFence(f.lookup, f.receipt)).toThrow();
    expect((reopened as StorageContext).db.prepare("SELECT * FROM sync_relay_live_restore_operations").all()).toEqual(after);
    const reopenedFixture = {storage: reopened, history, document: f.document, lookup: f.lookup};
    expect(() => completeRetirementAt(reopenedFixture, f.key(1))).toThrow("Service activation retirement is unavailable.");
    expect(completeRetirementAt(reopenedFixture, f.key(2))).toEqual({status: "retired", replayed: false});
  } finally {if (!closed) f.close(); reopened?.close();}
});

// Proves: a Decline's evidence is journal history its operation cannot
// delete, and deleting the owner's account still removes both, with the
// workspace's other rows, in one deferred purge.
it("removes a declined restore's cancellation with its owner's account", () => {
  const f = declinedFence(true);
  try {
    f.store.acknowledgeStopRestoreCancellation(f.lookup, f.fenceCancelled, 170);
    const count = (table: string) => Number(f.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
    expect(() => f.write(db => db.prepare("DELETE FROM sync_relay_live_restore_operations").run())).toThrow(/FOREIGN KEY/);
    expect(count("sync_relay_live_restore_cancellations")).toBe(1);
    initializeAccountDeletion(f.context, "fence-key");
    const deletion = fenceAccount(f.context, "fence-key", "owner", "owner@dohc.test");
    purgeAccountRows(f.context, "owner", "owner@dohc.test", deletion.manifest!);
    expect([count("sync_relay_live_restore_cancellations"), count("sync_relay_live_restore_operations"), count("sync_relay_workspaces")]).toEqual([0, 0, 0]);
    expect(f.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {f.close();}
});

// Proves: a fenced restore's cancellation entry moves the workspace journal
// frontier with no later update, so an active replica refreshes and saves its
// current view at the cancellation's cursor.
it("refreshes a replica to a fenced restore's cancellation entry", async () => {
  const f = declinedFence(true);
  const pull = vi.fn(async () => {});
  const text = "notes", sha256 = createHash("sha256").update(text).digest("hex");
  let supervisor: ReturnType<typeof createReplicaSupervisor> | undefined;
  try {
    f.write(db => db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES ('viewer-grant','share','user','viewer',NULL,'view',1,'active',0,NULL,NULL)`).run());
    const frontier = () => f.storage.readReplicaStanding("workspace")!.journalCursor;
    expect(frontier()).toBe(f.cutover);
    supervisor = createReplicaSupervisor({storage: f.storage, storeRoot: await tempRoot("restore-cancellation"),
      startChild: async input => ({pull, close: async () => {}, currentView: async () => ({workspaceId: input.lease.workspaceId, revision: 0, logCursor: 0,
        journalCursor: frontier(), files: [{versionId: "main", objectId: "notes", path: "docs/notes.txt", contentKind: "text" as const, sha256,
          byteLength: text.length, lineageClaimId: null, restoreGeneration: null}], texts: [{sha256, text}], delta: false, removed: [], moved: false,
        nextCursor: null, refusedFiles: []})})});
    await supervisor.activate("workspace");
    expect(pull).toHaveBeenCalledTimes(1);
    const control = Number(f.raw.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_relay_live_update_journal'").get()!.seq) + 1;
    f.store.acknowledgeStopRestoreCancellation(f.lookup, f.fenceCancelled, 170);
    expect(frontier()).toBe(control);
    await expect.poll(() => pull.mock.calls.length).toBe(2);
    await supervisor.settled("workspace");
    expect(f.storage.readReplicaCurrentView("workspace")?.journalCursor).toBe(control);
    expect(f.raw.prepare("SELECT journal_cursor FROM sync_relay_replica_cuts WHERE workspace_id='workspace'").get()).toEqual({journal_cursor: control});
  } finally {await supervisor?.close(); f.close(); await closeTestStorages();}
});

// Proves: a cancellation answer that does not prove this restore's end is
// refused and changes nothing, and an answer with no binding, a replay after
// a later restore, is not recorded. Once the relay saved the native fence's
// reply, `cancelled` contradicts it and the fence receipt must match it.
it.each([false, true])("refuses a missing or altered cancellation proof, native fence saved=%s", native => {
  const f = declinedFence(native);
  try {
    const before = f.rows(), cancellations = () => f.raw.prepare("SELECT * FROM sync_relay_live_restore_cancellations").all(), requested = cancellations();
    const receipt = f.fenceCancelled.receipt;
    const altered: NativeRestoreCancellationAnswer[] = [
      ...native ? [f.cancelled, {...f.fenceCancelled, receipt: {...receipt, fence: {...receipt.fence, recordedAtMs: 101}}}] : [],
      {...f.cancelled, hostId: "other-host"},
      {...f.cancelled, generation: 2},
      {...f.cancelled, binding: {...f.receipt.operation.oldBinding, currentPath: "docs/other.md"}},
      {...f.fenceCancelled, hostId: "other-host"},
      {...f.fenceCancelled, receipt: {...receipt, fence: {...receipt.fence, operation: {...receipt.fence.operation, appliedSequence: 1}}}},
      {...f.fenceCancelled, receipt: {...receipt, endpoint: {...receipt.endpoint, eventCount: receipt.endpoint.eventCount + 1}}},
      {...f.fenceCancelled, receipt: {...receipt, endpoint: {...receipt.endpoint, historyEvidenceDigest: "f".repeat(64)}}},
    ];
    for (const answer of altered) expect(() => f.store.acknowledgeStopRestoreCancellation(f.lookup, answer, 170)).toThrow();
    expect(() => f.store.acknowledgeStopRestoreCancellation(f.lookup, {...f.cancelled, binding: null}, 170)).toThrow();
    expect(f.rows()).toEqual(before);
    expect(cancellations()).toEqual(requested);
    expect(f.store.pendingStopRestoreCancellation(f.lookup)).not.toBeNull();
  } finally {f.close();}
});

// A restore whose host ended its committed fence when the owner declined it,
// or answered `cancelled` that no native fence committed, with its Edit grant
// shared again at generation 6, and the relay restarted when `restart`.
// `next` is a second restore of the same file.
function declinedAtFence(restart: boolean, answer: "cancelled" | "fenceCancelled" = "fenceCancelled") {
  const f = readyNativeFence("owner", "device", true);
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined;
  const generation = answer === "cancelled" ? 1 : 2;
  try {
    if (answer === "fenceCancelled") f.store.acknowledgeStopRestoreFence(f.lookup, f.receipt);
    const answers = cancellationAnswers(f);
    declineStopRestore(f.context, f.lookup, 150);
    expect(f.store.acknowledgeStopRestoreCancellation(f.lookup, answers[answer], 170).phase).toBe("declined");
    expect(documentState(f)).toEqual({restore_fence_generation: generation, admission_state: "closed"});
    f.write(db => db.prepare("UPDATE sync_relay_share_grants SET status='active',generation=6,revoked_at_ms=NULL WHERE grant_id='grant'").run());
    let storage = f.storage, history = f.history;
    if (restart) {
      f.storage.close();
      storage = reopened = openSyncRelayStorage(f.path);
      history = createLiveJournalHistoryAuthority({namespace: "restore-test", reconciled: true});
    }
    const context = storage as StorageContext;
    const g = {...f, storage, history, context, store: storage.createLiveCommittedDeliveryStore(history),
      write: (sql: string, ...values: string[]) => context.tx(() => context.db.prepare(sql).run(...values)),
      close: () => {if (reopened) {f.raw.close(); reopened.close();} else f.close();}};
    const next = {...f.intent, operationId: "restore-b", expectedFence: generation, expectedGrantGeneration: 6};
    const plan = () => storage.readStopRestorePlan({operationId: next.operationId, ownerUserId: "owner", document: f.document, shareId: next.shareId,
      grantId: next.grantId, restorePointCursor: 0, restorePointReceiptDigest: next.restorePointReceiptDigest, maxOutputBytes: 1_000_000});
    return {...g, next, nextLookup: {...f.lookup, operationId: next.operationId}, plan};
  } catch (error) {if (reopened) {f.raw.close(); reopened.close();} else f.close(); throw error;}
}

// Proves: a restore declined after its fence leaves the document closed at the
// fenced generation, and a host's `cancelled` answer leaves it closed at the
// old one. The next restore of the file goes on from there: it is offered,
// begins on the closed document with the restore whose fence the generation
// follows as its predecessor, fences, and completes, reopening live editing.
// Its settlement steps across the declined restore, where no event was
// accepted, and publishes the restored file and its history. The same holds
// when the relay restarts between the Decline and the next restore.
it.each([["fenceCancelled", false], ["fenceCancelled", true], ["cancelled", false], ["cancelled", true]] as const)(
  "completes and publishes a restore that follows one declined with %s, restart=%s", async (answer, restart) => {
    const f = declinedAtFence(restart, answer), generation = answer === "cancelled" ? 1 : 2;
    try {
      expect(f.plan().intent).toMatchObject({expectedFence: generation, deliveryKind: "owner"});
      expect(beginStopRestore(f.context, f.next, 180).previousOperationId).toBe(answer === "cancelled" ? null : "restore");
      const next = completeRestore(f, f.nextLookup, 190);
      expect(next.admitted.preparation.fence.operation.newFence).toBe(generation + 1);
      expect(documentState(f)).toEqual({restore_fence_generation: generation + 1, admission_state: "open"});
      passSourceMoment(f);
      const published = await publishRestore(f, next.admitted, "restore-b-publication");
      expect(projectedMoment(f, "restore-b-publication")).toEqual({moment: {path: "docs/a.md", blob_sha256: published.markdownDigest},
        file: {blob_sha256: published.markdownDigest}});
    } finally {f.close();}
  });

// Proves: a host's `cancelled` answer, which puts the generation back and
// leaves admission closed, lets the next restore begin from that state after
// a resumed restore and after one declined after its fence. The restore whose
// fence the generation follows stays the predecessor; the cancelled one is no
// step in the chain. The next restore completes and publishes, also across a
// restart.
it.each([["resumed", false], ["resumed", true], ["declined", false], ["declined", true]] as const)(
  "completes a restore after a cancelled one that followed a %s restore, restart=%s", async (predecessor, restart) => {
    const resumed = predecessor === "resumed";
    let f: ReturnType<typeof declinedAtFence> | ReturnType<typeof admittedRestoreFixture> = resumed ? admittedRestoreFixture("owner", false) : declinedAtFence(false);
    try {
      let previous = 0, before: string | undefined;
      if ("complete" in f) {
        expect(f.complete().phase).toBe("resumed");
        const a = await publishRestore(f, f.admitted, "restore-a-publication");
        previous = f.admitted.admitted.accepted.receipt.journalCursor; before = a.markdownDigest;
      }
      reshare(f, 6);
      const cancelled = {...f.intent, operationId: "restore-x", expectedFence: 2, expectedGrantGeneration: 6};
      expect(beginStopRestore(f.context, cancelled, 300).previousOperationId).toBe("restore");
      declineAfterFence(f, {...f.lookup, operationId: "restore-x"}, 301, "cancelled");
      expect(documentState(f)).toEqual({restore_fence_generation: 2, admission_state: "closed"});
      if (restart) f = restartRelay(f);
      reshare(f, 8);
      expect(beginStopRestore(f.context, {...f.intent, operationId: "restore-y", expectedFence: 2, expectedGrantGeneration: 8}, 310).previousOperationId).toBe("restore");
      const next = completeRestore(f, {...f.lookup, operationId: "restore-y"}, 311);
      expect(documentState(f)).toEqual({restore_fence_generation: 3, admission_state: "open"});
      if (!resumed) passSourceMoment(f);
      const published = await publishRestore(f, next.admitted, "restore-y-publication", previous, before, resumed ? 1 : 0);
      expect(projectedMoment(f, "restore-y-publication")).toEqual({moment: {path: "docs/a.md", blob_sha256: published.markdownDigest},
        file: {blob_sha256: published.markdownDigest}});
    } finally {f.close();}
  });

// Proves: the next restore follows a declined one only from the generation
// and lineage its host's recorded answer ended at. A document moved to
// another generation, or an answer naming another lineage, refuses both the
// offer and the start, with nothing changed. Undoing the damage lets it begin.
it.each([false, true])("refuses a restore after a Decline at another fence or lineage, restart=%s", restart => {
  const f = declinedAtFence(restart);
  try {
    const lineage = f.document.lineageClaimId, other = "e".repeat(64);
    const operations = () => f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(), before = operations();
    const damage: [() => void, () => void, number][] = [
      [() => f.write("UPDATE sync_relay_live_documents SET restore_fence_generation=3"), () => f.write("UPDATE sync_relay_live_documents SET restore_fence_generation=2"), 3],
      [() => f.write("UPDATE sync_relay_live_restore_cancellations SET acknowledgment_json=replace(acknowledgment_json,?,?)", lineage, other),
        () => f.write("UPDATE sync_relay_live_restore_cancellations SET acknowledgment_json=replace(acknowledgment_json,?,?)", other, lineage), 2],
    ];
    for (const [apply, undo, expectedFence] of damage) {
      apply();
      expect(() => f.plan()).toThrow("Live restore operation conflicts with current authority.");
      expect(() => beginStopRestore(f.context, {...f.next, expectedFence}, 180)).toThrow("Live restore operation conflicts with current authority.");
      expect(operations()).toEqual(before);
      expect(f.storage.getShareGrant("grant")).toMatchObject({status: "active", generation: 6});
      undo();
    }
    expect(beginStopRestore(f.context, f.next, 180).previousOperationId).toBe("restore");
  } finally {f.close();}
});

// Moves the restored file to another path and lets another object take its old one.
const departFrozenPath = (f: Pick<ReturnType<typeof fixture>, "write" | "document">) => f.write(db => {
  const copy = db.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
    SELECT workspace_id,?,?,?,version_id,?,blob_sha256,content_kind,byte_length,? FROM sync_relay_object_moments WHERE object_id=? ORDER BY relay_seq DESC LIMIT 1`);
  copy.run(f.document.objectId, 10, "renamed", "docs/renamed.md", 10, f.document.objectId);
  copy.run("reusing", 11, "reusing", "docs/a.md", 11, f.document.objectId);
});
const cancellingConnection = (f: Pick<ReturnType<typeof fixture>, "coordinate">, reply: () => Promise<unknown>) => {
  const sendRequest = vi.fn(async (request: {method: string}) => {
    expect(request.method).toBe("liveApplication.cancelRestoreFence");
    return {result: await reply()};
  });
  return {sendRequest, connection: {client: {sendRequest, sendLiveRestore: vi.fn()} as never, workspace: "native-workspace", host: f.coordinate,
    deadlineMs: 1000, nextRequestId: () => 1}};
};
const lostReply = async () => {throw new Error("The reply was lost.");};

// Proves: a file renamed after the fence, before admission, ends the restore
// through its fencing host's cancellation. The request is recorded under the
// writer admission takes, survives a restart and a lost reply, and a replay
// does not ask the host again. The retirement completes at the generation the
// host proved, the old one is refused, and the renamed file and the object
// now at its old path are left as they are.
it.each([false, true])("ends a restore through its host's cancellation when its file is renamed, native fence saved=%s", async native => {
  const f = serviceFence(native);
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined, closed = false;
  try {
    departFrozenPath(f);
    const moments = f.raw.prepare("SELECT * FROM sync_relay_object_moments ORDER BY relay_seq").all();
    let reply: () => Promise<unknown> = lostReply;
    const {sendRequest, connection} = cancellingConnection(f, () => reply());
    const preparation = new LiveRestorePreparation(preparationConfig());
    const options = (store: typeof f.store) => ({store, lookup: f.lookup, deliveryKind: "bootstrap" as const, connection});
    await expect(preparation.prepare(options(f.store))).rejects.toThrow("The reply was lost.");
    expect(f.raw.prepare("SELECT outcome FROM sync_relay_live_restore_cancellations").all()).toEqual([{outcome: null}]);
    expect(readStopRestore(f.context, f.lookup)?.phase).toBe(native ? "native-fenced" : "old-cut-applied");
    f.close(); closed = true;
    reopened = openSyncRelayStorage(f.path);
    const history = createLiveJournalHistoryAuthority({namespace: "restore-test", reconciled: true});
    const store = reopened.createLiveCommittedDeliveryStore(history);
    reply = async () => f.fenceCancelled;
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(preparation.prepare(options(store))).resolves.toEqual({kind: "pending", reason: "The restore was declined."});
    }
    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(readStopRestore(reopened as StorageContext, f.lookup)).toMatchObject({phase: "declined", nativeReceipt: f.receipt});
    const db = (reopened as StorageContext).db;
    expect(db.prepare("SELECT outcome FROM sync_relay_live_restore_cancellations").all()).toEqual([{outcome: "fence-cancelled"}]);
    expect(db.prepare("SELECT * FROM sync_relay_object_moments ORDER BY relay_seq").all()).toEqual(moments);
    expect(reopened.objectIdAtPathInVersion({workspaceId: "workspace", versionId: "main", path: "docs/a.md"})).toBe("reusing");
    const reopenedFixture = {storage: reopened, history, document: f.document, lookup: f.lookup};
    expect(() => completeRetirementAt(reopenedFixture, f.key(1))).toThrow("Service activation retirement is unavailable.");
    expect(completeRetirementAt(reopenedFixture, f.key(2))).toEqual({status: "retired", replayed: false});
  } finally {if (!closed) f.close(); reopened?.close();}
});

// Proves: a Decline is refused only when its host's answer does not prove the
// restore's end. A storage failure, or the host losing its standing while its
// reply is outstanding, leaves the Decline pending with nothing recorded and
// its cause in the relay log, and the next attempt with the same answer
// finishes it.
it.each(["proof", "storage", "standing"] as const)("keeps a Decline retryable unless its proof is rejected: %s", async failure => {
  const f = declinedFence(true);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const connectionId = String(f.raw.prepare("SELECT registered_connection_id FROM sync_relay_session_host_control").get()!.registered_connection_id);
    const forged = {...f.fenceCancelled, receipt: {...f.fenceCancelled.receipt, endpoint: {...f.fenceCancelled.receipt.endpoint, historyEvidenceDigest: "f".repeat(64)}}};
    let reply: () => Promise<unknown> = async () => f.fenceCancelled;
    if (failure === "proof") reply = async () => forged;
    if (failure === "storage") f.write(db => db.exec(`CREATE TEMP TRIGGER fail_cancellation BEFORE UPDATE ON sync_relay_live_restore_cancellations
      BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`));
    if (failure === "standing") reply = async () => {
      f.write(db => db.prepare("UPDATE sync_relay_session_host_control SET registered_connection_id='replaced'").run());
      return f.fenceCancelled;
    };
    const {connection} = cancellingConnection(f, () => reply());
    const cancel = () => cancelStopRestore({store: f.store, lookup: f.lookup, connection});
    const before = f.rows(), cancellations = () => f.raw.prepare("SELECT * FROM sync_relay_live_restore_cancellations").all(), requested = cancellations();
    if (failure === "proof") {
      await expect(cancel()).resolves.toEqual({kind: "refused", reason: "The host's cancellation answer does not prove this restore ended."});
      expect(log).not.toHaveBeenCalled();
    } else {
      await expect(cancel()).resolves.toEqual({kind: "pending", reason: "The host's cancellation answer was not recorded."});
      expect(log).toHaveBeenCalledWith("[sync-relay] restore cancellation not recorded:",
        expect.objectContaining({message: failure === "storage" ? "database or disk is full" : "Committed delivery stale-session."}));
    }
    expect(f.rows()).toEqual(before);
    expect(cancellations()).toEqual(requested);
    if (failure === "storage") f.write(db => db.exec("DROP TRIGGER fail_cancellation"));
    if (failure === "standing") f.write(db => db.prepare("UPDATE sync_relay_session_host_control SET registered_connection_id=?").run(connectionId));
    reply = async () => f.fenceCancelled;
    await expect(cancel()).resolves.toEqual({kind: "declined"});
    expect(readStopRestore(f.context, f.lookup)?.phase).toBe("declined");
  } finally {log.mockRestore(); f.close();}
});

// Proves: a rename while the host prepares, or after the proposal is saved,
// ends the restore instead of saving or returning the proposal, and
// admission inside its own transaction refuses a departed path.
it.each(["preparing", "saved"] as const)("ends a restore whose file is renamed after native preparation: %s", async when => {
  const f = contentProposalFixture("bootstrap", "service");
  try {
    const {sendRequest, connection} = cancellingConnection(f, lostReply);
    const sendLiveRestore = vi.fn(async () => {
      if (when === "preparing") departFrozenPath(f);
      return {response: {result: {status: "prepared"}}, bytes: Buffer.from(f.encoded)};
    });
    const options = {store: f.store, lookup: f.lookup, deliveryKind: "bootstrap" as const,
      connection: {...connection, client: {sendRequest, sendLiveRestore} as never}};
    if (when === "saved") {
      const proposed = f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
      departFrozenPath(f);
      const before = proposalRows(f);
      expect(() => f.store.admitStopRestoreProposal(f.input, proposed.proposalDigest, policy, 201)).toThrow();
      expect(proposalRows(f)).toEqual(before);
    }
    await expect(new LiveRestorePreparation(preparationConfig()).prepare(options)).rejects.toThrow("The reply was lost.");
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(f.raw.prepare(`SELECT COUNT(*) AS count FROM ${proposalTable}`).get()!.count).toBe(when === "saved" ? 1 : 0);
    expect(f.raw.prepare("SELECT outcome FROM sync_relay_live_restore_cancellations").all()).toEqual([{outcome: null}]);
    expect(readStopRestore(f.context, f.lookup)?.phase).toBe("native-fenced");
  } finally {f.close();}
});

// Proves: when the host answers the cancellation a rename during preparation
// asked for, preparation reports the restore declined at the generation the
// host proved, and saves no proposal.
it("declines a restore whose file is renamed while its host prepares, with its host's answer", async () => {
  const f = contentProposalFixture("bootstrap", "service"), fence = f.receipt.fence;
  try {
    const {fenceCancelled} = cancellationAnswers({...f, receipt: fence});
    const {sendRequest, connection} = cancellingConnection(f, async () => fenceCancelled);
    const sendLiveRestore = vi.fn(async () => {
      departFrozenPath(f);
      return {response: {result: {status: "prepared"}}, bytes: Buffer.from(f.encoded)};
    });
    const options = {store: f.store, lookup: f.lookup, deliveryKind: "bootstrap" as const,
      connection: {...connection, client: {sendRequest, sendLiveRestore} as never}};
    await expect(new LiveRestorePreparation(preparationConfig()).prepare(options)).resolves.toEqual({kind: "pending", reason: "The restore was declined."});
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(f.raw.prepare(`SELECT COUNT(*) AS count FROM ${proposalTable}`).get()!.count).toBe(0);
    expect(readStopRestore(f.context, f.lookup)).toMatchObject({phase: "declined", nativeReceipt: fence});
    expect(f.raw.prepare("SELECT outcome FROM sync_relay_live_restore_cancellations").all()).toEqual([{outcome: "fence-cancelled"}]);
    expect(documentState(f)).toEqual({restore_fence_generation: 2, admission_state: "closed"});
  } finally {f.close();}
});

// Proves: completion checks the frozen path before admission. A file renamed
// after its proposal was saved ends the restore through its host's
// cancellation, and nothing is admitted or sent to the host to apply.
it("declines at completion a saved restore whose file is renamed", async () => {
  const f = contentProposalFixture("bootstrap", "service"), fence = f.receipt.fence;
  try {
    const proposed = f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
    departFrozenPath(f);
    const {fenceCancelled} = cancellationAnswers({...f, receipt: fence});
    const {sendRequest, connection} = cancellingConnection(f, async () => fenceCancelled);
    const sendLiveRestore = vi.fn();
    const options = {store: f.store, lookup: f.lookup, deliveryKind: "bootstrap" as const,
      connection: {...connection, client: {sendRequest, sendLiveRestore} as never}};
    await expect(new LiveRestorePreparation(preparationConfig()).complete(options, proposed.proposalDigest)).rejects.toThrow("The restore was declined.");
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendLiveRestore).not.toHaveBeenCalled();
    expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_restore_lifecycles").get()!.n).toBe(0);
    expect(readStopRestore(f.context, f.lookup)).toMatchObject({phase: "declined", nativeReceipt: fence});
  } finally {f.close();}
});

// Proves: a deleted file has left its frozen path. Before the fence the
// restore is declined at once; after it, the fencing host is asked to cancel.
it.each(["before", "after"] as const)("ends a restore whose file is deleted %s its fence", when => {
  const f = when === "before" ? fixture("bootstrap", "service") : serviceFence(true);
  try {
    if (when === "before") beginStopRestore(f.context, f.intent, 40);
    f.write(db => db.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
      VALUES ('workspace',?,10,'deleted','main',NULL,NULL,NULL,NULL,10)`).run(f.document.objectId));
    if (when === "before") {
      expect(advanceStopRestoreFence(f.context, f.lookup, 50)).toMatchObject({phase: "declined", newFence: null});
      expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_restore_cancellations").get()!.n).toBe(0);
    } else {
      expect(f.store.continueStopRestore(f.lookup, 60)).toBe("cancel");
      expect(f.raw.prepare("SELECT outcome FROM sync_relay_live_restore_cancellations").all()).toEqual([{outcome: null}]);
      expect(readStopRestore(f.context, f.lookup)?.phase).toBe("native-fenced");
    }
  } finally {f.close();}
});

// Proves: a file that leaves its frozen path before the fence ends the
// restore at its old generation, with no host to ask.
it("declines a restore whose file is renamed before its fence", () => {
  const f = fixture("bootstrap", "device");
  try {
    beginStopRestore(f.context, f.intent, 40);
    departFrozenPath(f);
    expect(advanceStopRestoreFence(f.context, f.lookup, 50)).toMatchObject({phase: "declined", newFence: null, declinedAtMs: 50});
    expect(documentState(f)).toMatchObject({restore_fence_generation: 1});
    expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_restore_cancellations").get()!.n).toBe(0);
  } finally {f.close();}
});

// Proves: once relay admission takes a restore, a rename no longer ends it.
// Its host finishes it across a restart at the frozen path, generation and
// binding. The renamed file and the object now at the old path keep their
// moments, the live document keeps the path it registered at, and its open
// retirement still settles the frozen path. The restore's settlement moment
// lands as retirement output at the frozen path and projects nowhere. The
// retirement then completes at the restore's own key, with the owner
// delivery's boundary at the restore's accepted row. A successor needs fresh
// authority for the renamed path.
it("finishes an admitted restore at its frozen path after its file is renamed", async () => {
  const f = admittedRestoreFixture("owner", false, "service", hosted => hostRestoredDocument(hosted, hosted.intent.shareId));
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined, closed = false;
  try {
    const frozen = f.admitted.admitted.accepted.binding, receipt = f.admitted.admitted.accepted.receipt;
    expect(frozen).toMatchObject({currentPath: "docs/a.md", restoreFenceGeneration: 2});
    departFrozenPath(f);
    const moments = f.raw.prepare("SELECT * FROM sync_relay_object_moments ORDER BY relay_seq").all();
    expect(f.store.acknowledgeStopRestoreReplacement(f.input, f.application).phase).toBe("native-applied");
    const {key, boundary} = carriedRetirement(f);
    const bytes = f.raw.prepare("SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(receipt.journalCursor)!.validation_checkpoint_bytes as Uint8Array;
    const publication = restorePublication(f, bytes, receipt.journalCursor, "renamed-restore-publication");
    f.close(); closed = true;
    reopened = openSyncRelayStorage(f.path);
    const history = createLiveJournalHistoryAuthority({namespace: "restore-test", reconciled: true});
    const store = reopened.createLiveCommittedDeliveryStore(history), db = (reopened as StorageContext).db;
    expect(store.acknowledgeStopRestoreSettlement(f.input, f.settlement).phase).toBe("settled");
    const resumed = store.acknowledgeStopRestoreResume(f.input, f.resume);
    expect(resumed).toMatchObject({phase: "resumed", resume: {binding: frozen}});
    expect(store.readStopRestoreLifecycle(f.input)).toEqual(resumed);
    expect(store.stopRestoreFinishedAtMovedPath(f.input)).toBe(true);
    expect(db.prepare("SELECT * FROM sync_relay_object_moments ORDER BY relay_seq").all()).toEqual(moments);
    expect(reopened.objectIdAtPathInVersion({workspaceId: "workspace", versionId: "main", path: "docs/renamed.md"})).toBe(f.document.objectId);
    expect(reopened.objectIdAtPathInVersion({workspaceId: "workspace", versionId: "main", path: "docs/a.md"})).toBe("reusing");
    expect(db.prepare("SELECT current_path,restore_fence_generation,admission_state FROM sync_relay_live_documents").get())
      .toEqual({current_path: "docs/a.md", restore_fence_generation: 2, admission_state: "open"});
    expect(reopened.readServiceHostFeedScope("workspace")?.settling.get(f.document.objectId)).toMatchObject({path: "docs/a.md", restoreFenceGeneration: 2,
      acceptedThrough: receipt.journalCursor});
    const owner = db.prepare("SELECT tip_receipt_json FROM sync_relay_live_delivery_owners").get()!;
    expect(JSON.parse(String(owner.tip_receipt_json))).toEqual(receipt);
    const complete = () => reopened!.createServiceActivationStore(history).completeRetirement({workspaceId: f.document.workspaceId, key, boundary,
      host: f.lookup.host, registeredAtMs: 400, nowMs: 400, guard() {}});
    expect(complete()).toEqual({status: "pending", reason: "restore"});
    await pushRestoreSettlement(reopened, publication);
    expect(db.prepare("SELECT * FROM sync_relay_object_moments ORDER BY relay_seq").all()).toEqual(moments);
    expect(complete()).toEqual({status: "retired", replayed: false});
    db.prepare("UPDATE sync_relay_share_grants SET status='active',generation=6,revoked_at_ms=NULL WHERE grant_id=?").run(f.intent.grantId);
    expect(reopened.resolveCurrentLiveDocumentBinding({document: f.document, actor: f.actor})).toEqual({kind: "refused", reason: "stale-document"});
  } finally {if (!closed) f.close(); reopened?.close();}
});

// A real identity rotation raises the log floor to the log's tip, past the restore's baseline.
const rotateIdentity = (f: Pick<ReturnType<typeof fixture>, "write" | "storage">) => {
  f.write(db => db.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','rotation-test',0,'test.rotation','{}',300)").run());
  expect(f.storage.rotateWorkspaceIdentity({workspaceId: "workspace", ownerUserId: "owner", replicationEpoch: "next-epoch",
    streamIdentity: "next-stream", rotatedAtMs: 300})).toBe("rotated");
};
const admittedRows = (f: Pick<ReturnType<typeof contentProposalFixture>, "raw" | "journalRows">) => ({...lifecycleRows(f),
  documents: f.raw.prepare("SELECT restore_fence_generation,admission_state FROM sync_relay_live_documents").all()});

// Proves: a workspace identity rotation after admission supersedes the
// restore. No acknowledgment advances its lifecycle, completion sends the host
// nothing, and admission stays closed.
it.each(["bootstrap", "owner"] as const)("stops an admitted %s restore after a workspace identity rotation", async kind => {
  const f = admittedRestoreFixture(kind, false, "service");
  try {
    rotateIdentity(f);
    const before = admittedRows(f);
    expect(() => f.store.acknowledgeStopRestoreReplacement(f.input, f.application)).toThrow();
    const sendLiveRestore = vi.fn();
    const options = {store: f.store, lookup: f.lookup, deliveryKind: kind,
      connection: {client: {sendLiveRestore} as never, workspace: "native-workspace", host: f.lookup.host, deadlineMs: 1000, nextRequestId: () => 1}};
    await expect(new LiveRestorePreparation(preparationConfig()).complete(options, f.proposal.proposalDigest)).rejects.toThrow();
    expect(sendLiveRestore).not.toHaveBeenCalled();
    expect(admittedRows(f)).toEqual(before);
    expect(documentState(f)).toEqual({restore_fence_generation: 2, admission_state: "closed"});
  } finally {f.close();}
});

// Proves: a rotation while the host's reply is outstanding refuses that
// reply. The lifecycle stays where it was, and the resume reply cannot
// reopen admission.
it.each(["apply", "settle", "resume"] as const)("refuses a native %s reply that arrives after a workspace identity rotation", async stage => {
  const f = admittedRestoreFixture("owner", false, "service");
  try {
    if (stage !== "apply") f.store.acknowledgeStopRestoreReplacement(f.input, f.application);
    if (stage === "resume") f.store.acknowledgeStopRestoreSettlement(f.input, f.settlement);
    const phase = f.store.readStopRestoreLifecycle(f.input)!.phase, reply = {apply: f.application, settle: f.settlement, resume: f.resume}[stage];
    let before: ReturnType<typeof admittedRows> | undefined;
    const sendLiveRestore = vi.fn(async (_request: unknown, operation: string) => {
      expect(operation).toBe(stage);
      rotateIdentity(f);
      before = admittedRows(f);
      return {response: {result: {status: operation}}, bytes: Buffer.from(JSON.stringify(reply))};
    });
    const options = {store: f.store, lookup: f.lookup, deliveryKind: "owner" as const,
      connection: {client: {sendLiveRestore} as never, workspace: "native-workspace", host: f.lookup.host, deadlineMs: 1000, nextRequestId: () => 1}};
    await expect(new LiveRestorePreparation(preparationConfig()).complete(options, f.proposal.proposalDigest)).rejects.toThrow();
    expect(sendLiveRestore).toHaveBeenCalledTimes(1);
    expect(admittedRows(f)).toEqual(before);
    expect(f.store.readStopRestoreLifecycle(f.input)!.phase).toBe(phase);
    expect(documentState(f)).toEqual({restore_fence_generation: 2, admission_state: "closed"});
  } finally {f.close();}
});

// Proves: neither a raised log floor nor invalid moment evidence at the
// frozen path is read as a rename. A floor at or past the restore's baseline
// refuses the restore's continuation outright; altered evidence at the same
// path lets it continue. Neither records a cancellation.
it.each(["floor", "evidence"] as const)("does not read a %s change as a rename", cause => {
  const f = serviceFence(true);
  try {
    if (cause === "floor") f.write(db => db.prepare("UPDATE sync_relay_workspaces SET epoch_log_floor=5 WHERE workspace_id='workspace'").run());
    else f.moment(f.input, 10, {moment_id: "altered", blob_sha256: "0".repeat(64), byte_length: 1});
    const before = f.rows(), operations = () => f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(), saved = operations();
    const continuation = () => f.store.continueStopRestore(f.lookup, 60);
    if (cause === "floor") expect(continuation).toThrow();
    else expect(continuation()).toBe("continue");
    expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_restore_cancellations").get()!.n).toBe(0);
    expect(f.rows()).toEqual(before);
    expect(operations()).toEqual(saved);
  } finally {f.close();}
});

// Proves: a Decline's evidence comes out of the restore's own reservation,
// so Decline and its host's answer still record with the workspace's quota
// exhausted, and usage does not move. The restore funds its largest Decline
// as it begins, beside its own largest evidence.
it("charges a Decline's evidence to the restore's reservation with the quota exhausted", () => {
  const f = serviceFence(true);
  try {
    f.write(db => db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=? WHERE workspace_id='workspace'").run(f.context.options.workspaceQuotaBytes));
    const usage = () => Number(f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()!.usage_bytes);
    const reserved = () => Number(f.raw.prepare("SELECT accounted_bytes FROM sync_relay_live_restore_operations").get()!.accounted_bytes);
    const charged = () => Number(f.raw.prepare("SELECT accounted_bytes FROM sync_relay_live_restore_cancellations").get()!.accounted_bytes);
    const total = reserved();
    expect(declineStopRestore(f.context, f.lookup, 150).phase).toBe("native-fenced");
    const requested = charged();
    expect(requested).toBeGreaterThan(0);
    expect(reserved() + requested).toBe(total);
    expect(f.store.acknowledgeStopRestoreCancellation(f.lookup, f.fenceCancelled, 170).phase).toBe("declined");
    expect(charged()).toBeGreaterThan(requested);
    expect(reserved() + charged()).toBe(total);
    expect(usage()).toBe(f.context.options.workspaceQuotaBytes);
  } finally {f.close();}
});

// Proves: with the longest identifiers in its fence evidence and in its
// host's answer, a declined restore's remaining charge still covers the
// evidence its operation row stores.
it("keeps a declined restore's evidence funded with near-limit identifiers", () => {
  const f = fixture("owner", "device"), longest = "\\".repeat(512);
  try {
    const cut = f.store.captureOwnerCut({host: f.coordinate, document: f.document, actor: f.actor, adoptionId: longest,
      expectedLocalSequence: 0, maxBytes: 1_000_000, maxEvents: 10});
    f.store.acknowledgeOwnerAdoption(cut, {adoptionId: longest, localYDocSequence: 0, terminalCursor: 0, adoptionReplayed: false});
    const terminal = f.add(longest);
    f.fence();
    const capture = f.open();
    f.store.acknowledgeStopRestoreApplication(capture, null, applicationAck(terminal, 9));
    f.store.completeStopRestoreCut(capture);
    const receipt: NativeRestoreFenceReceipt = {operation: f.store.pendingStopRestoreFence(f.lookup).operation, localHeadSequence: 11, recordedAtMs: 100};
    f.store.acknowledgeStopRestoreFence(f.lookup, receipt);
    expect(declineStopRestore(f.context, f.lookup, 150).phase).toBe("native-fenced");
    const {fenceCancelled} = cancellationAnswers({...f, receipt});
    expect(f.store.acknowledgeStopRestoreCancellation(f.lookup, fenceCancelled, 170).phase).toBe("declined");
    const row = f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").get()!;
    expect(JSON.parse(String(row.applied_json))).toMatchObject({sourceId: longest, terminal: {deliveryId: longest}});
    const stored = Buffer.byteLength(JSON.stringify([row.operation_id, row.relay_database_namespace, row.previous_operation_id,
      row.workspace_id, row.main_version_id, row.object_id, row.lineage_claim_id, row.intent_json, row.basis_json, row.terminal_json,
      row.applied_json, row.native_receipt_json, row.phase, row.old_fence, row.new_fence, row.cutover_cursor, row.revoked_generation,
      row.invalidated_at_ms, row.fenced_at_ms, row.declined_at_ms]));
    expect(Number(row.accounted_bytes)).toBeGreaterThanOrEqual(stored);
  } finally {f.close();}
});

// Proves: Decline and relay admission each take the restore under the same
// writer, so exactly one wins. Once Decline is recorded, a late native fence,
// preparation step, admission or application cannot revive the restore.
it.each(["decline", "admission"] as const)("lets exactly one of Decline and admission take a fenced restore: %s first", first => {
  const f = contentProposalFixture("bootstrap", "service");
  try {
    const proposed = f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
    const admit = () => f.store.admitStopRestoreProposal(f.input, proposed.proposalDigest, policy, 201);
    if (first === "admission") {
      expect(admit().phase).toBe("relay-admitted");
      const after = f.rows();
      expect(() => declineStopRestore(f.context, f.lookup, 202)).toThrow("The restore is already being applied, so it can no longer be declined.");
      expect(f.rows()).toEqual(after);
      expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_restore_cancellations").get()!.n).toBe(0);
      return;
    }
    expect(declineStopRestore(f.context, f.lookup, 202).phase).toBe("native-fenced");
    const after = f.journalRows();
    expect(admit).toThrow();
    expect(() => f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 203)).toThrow();
    expect(() => f.store.captureStopRestorePoint(f.input)).toThrow();
    expect(() => f.store.acknowledgeStopRestoreFence(f.lookup, f.receipt.fence)).toThrow();
    expect(() => f.store.pendingStopRestoreFence(f.lookup)).toThrow();
    expect(f.journalRows()).toEqual(after);
    expect(readStopRestore(f.context, f.lookup)?.phase).toBe("native-fenced");
  } finally {f.close();}
});

// Proves: admission checks the restored checkpoint within the limits its
// publication normalizes under, here lowered to the struct visits that
// checkpoint needs. At that limit the restore is admitted; one below it,
// admission stores nothing and the restore can still be declined.
it.each(["at", "over"] as const)("admits a restore only if its checkpoint normalizes within the publication limits: %s", limit => {
  const f = contentProposalFixture("owner", "device");
  const normalizes = (input: Parameters<typeof liveValidation.settlementFits>[0], maxStructVisits: number) =>
    createLiveMarkdownRegistrationValidator({...policy, maxStructVisits})(input);
  // The fewest struct visits the checkpoint normalizes within.
  const needed = (input: Parameters<typeof liveValidation.settlementFits>[0]) => {
    let low = 1, high = policy.maxStructVisits;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (normalizes(input, middle).kind === "accepted") high = middle; else low = middle + 1;
    }
    return low;
  };
  const fits = vi.spyOn(liveValidation, "settlementFits").mockImplementation(input => {
    const result = normalizes(input, needed(input) - (limit === "over" ? 1 : 0));
    return result.kind === "accepted" || result.reason !== "capacity-refused";
  });
  try {
    const proposed = f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200), before = lifecycleRows(f);
    const admit = () => f.store.admitStopRestoreProposal(f.input, proposed.proposalDigest, policy, 201);
    if (limit === "at") {
      expect(admit().phase).toBe("relay-admitted");
      const checkpoint = f.raw.prepare("SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE restore_operation_id IS NOT NULL").get()!;
      expect(fits.mock.calls.map(([input]) => Buffer.from(input.checkpoint))).toEqual([Buffer.from(checkpoint.validation_checkpoint_bytes as Uint8Array)]);
      return;
    }
    let refusal: unknown;
    try {admit();} catch (error) {refusal = error;}
    expect(refusal).toMatchObject({code: "payload_too_large",
      message: "The server can't confirm this restore: the restored file is too large for it to check. Decline this restore."});
    expect(lifecycleRows(f)).toEqual(before);
    expect(declineStopRestore(f.context, f.lookup, 202).phase).toBe("native-fenced");
  } finally {fits.mockRestore(); f.close();}
});

// Proves: admission refuses a restore whose publication one push could not
// prove, here with that proof's event limit lowered to none. It stores
// nothing, and the restore can still be declined.
it("refuses a restore whose publication proof would pass a push's budget", () => {
  const f = contentProposalFixture("owner", "device"), charge = RestoreHistoryBudget.prototype.chargeEvents;
  let measured = false;
  // Only the publication proof admission measures starts at a push's event limit.
  const lowered = vi.spyOn(RestoreHistoryBudget.prototype, "chargeEvents").mockImplementation(function (this: RestoreHistoryBudget, value: number) {
    if (this.events === SETTLEMENT_PUSH_MAX_METADATA_EVENTS) {this.events = 0; measured = true;}
    charge.call(this, value);
  });
  try {
    const proposed = f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200), before = lifecycleRows(f);
    let refusal: unknown;
    try {f.store.admitStopRestoreProposal(f.input, proposed.proposalDigest, policy, 201);} catch (error) {refusal = error;}
    expect(refusal).toMatchObject({code: "payload_too_large",
      message: "The server can't confirm this restore: too many changes to this file haven't been confirmed yet. Decline this restore."});
    expect(measured).toBe(true);
    expect(lifecycleRows(f)).toEqual(before);
    expect(declineStopRestore(f.context, f.lookup, 202).phase).toBe("native-fenced");
  } finally {lowered.mockRestore(); f.close();}
});

// Proves: a store from before the declined phase opens with every restore
// row, lifecycle, proposal, source range and journal reference as it was,
// though foreign keys stay on while its tables move.
it("migrates a store from before the declined phase without changing its restore rows", () => {
  const f = admittedRestoreFixture("owner", true);
  try {
    f.complete();
    // One connection throughout, as the relay has: another one may read a table through its old layout.
    const db = f.context.db;
    const rows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all();
    const snapshot = () => ({operations: rows("sync_relay_live_restore_operations"), proposals: rows(proposalTable),
      lifecycles: rows("sync_relay_live_restore_lifecycles"), sources: rows("sync_relay_live_restore_source_ranges"),
      journal: db.prepare("SELECT journal_cursor,restore_operation_id FROM sync_relay_live_update_journal ORDER BY journal_cursor").all()});
    // The earlier build held no publication reservation.
    db.exec("UPDATE sync_relay_live_restore_lifecycles SET accounted_bytes=accounted_bytes-publication_reservation_bytes,publication_reservation_bytes=0");
    const before = snapshot();
    expect(before.lifecycles).toHaveLength(1);
    expect(before.sources.length).toBeGreaterThan(0);
    expect(before.journal.some(row => row.restore_operation_id === "restore")).toBe(true);
    layOutEarlierRestoreStore(db, [["sync_relay_live_restore_operations", LIVE_RESTORE_OPERATIONS_V1_SQL, ["declined_at_ms"]],
      ["sync_relay_live_restore_lifecycles", LIVE_RESTORE_LIFECYCLES_V1_SQL, ["publication_reservation_bytes", "refused_terminal_cursor"]]],
    [LIVE_RESTORE_ACTIVE_V1_SQL], ["live-restore-declined-v1", "live-restore-publication-v1"]);
    // The relay migrates inside its schema transaction, with foreign keys on.
    db.exec("BEGIN IMMEDIATE"); initializeLiveRestoreOperationSchema(db); db.exec("COMMIT");
    expect(snapshot()).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sync_relay_migrations WHERE migration_id IN ('live-restore-declined-v1','live-restore-publication-v1')").get()).toEqual({n: 2});
    expect(() => initializeLiveRestoreOperationSchema(db)).not.toThrow();
  } finally {f.close();}
});

// Proves: a store from before publication funding opens with every lifecycle
// and source range as it was, holding no publication and no refusal, and its
// restores still read.
it("migrates a store from before publication funding without changing its restore rows", () => {
  const f = admittedRestoreFixture("owner", true);
  try {
    f.complete();
    const db = f.context.db;
    const rows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all();
    db.exec("UPDATE sync_relay_live_restore_lifecycles SET accounted_bytes=accounted_bytes-publication_reservation_bytes,publication_reservation_bytes=0");
    const snapshot = () => ({lifecycles: rows("sync_relay_live_restore_lifecycles"), sources: rows("sync_relay_live_restore_source_ranges")}), before = snapshot();
    expect(before.sources.length).toBeGreaterThan(0);
    layOutEarlierRestoreStore(db, [["sync_relay_live_restore_lifecycles", LIVE_RESTORE_LIFECYCLES_V1_SQL, ["publication_reservation_bytes", "refused_terminal_cursor"]]],
      [], ["live-restore-publication-v1"]);
    expect(db.prepare("SELECT name FROM pragma_table_info('sync_relay_live_restore_lifecycles') WHERE name IN ('publication_reservation_bytes','refused_terminal_cursor')").all()).toEqual([]);
    db.exec("BEGIN IMMEDIATE"); initializeLiveRestoreOperationSchema(db); db.exec("COMMIT");
    expect(snapshot()).toEqual(before);
    expect(before.lifecycles).toMatchObject([{publication_reservation_bytes: 0, refused_terminal_cursor: 0}]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.store.readStopRestoreLifecycle(f.input)!.phase).toBe("resumed");
    expect(() => initializeLiveRestoreOperationSchema(db)).not.toThrow();
  } finally {f.close();}
});

// Lays restore tables out as an earlier build left them, each without its
// later columns, and forgets the migrations that added them.
function layOutEarlierRestoreStore(db: StorageContext["db"], tables: [table: string, sql: string, later: string[]][], indexes: string[], migrations: string[]) {
  db.exec("PRAGMA foreign_keys=OFF"); db.exec("PRAGMA legacy_alter_table=ON"); db.exec("BEGIN");
  for (const [table, sql, later] of tables) {
    const columns = db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all().map(row => String(row.name)).filter(name => !later.includes(name)).join(",");
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_later; ${sql}; INSERT INTO ${table}(${columns}) SELECT ${columns} FROM ${table}_later; DROP TABLE ${table}_later`);
  }
  for (const sql of indexes) db.exec(sql);
  for (const migration of migrations) db.prepare("DELETE FROM sync_relay_migrations WHERE migration_id=?").run(migration);
  db.exec("COMMIT"); db.exec("PRAGMA legacy_alter_table=OFF"); db.exec("PRAGMA foreign_keys=ON");
}

// Proves: deleting the account of the collaborator a restore stopped, after the
// restore begins, purges the revoked grant without stranding the restore. It
// still fences and resumes.
it("finishes a restore after the stopped collaborator's account is deleted", () => {
  const f = contentProposalFixture("bootstrap", "service", false, false, false, 0, hosted => {
    beginStopRestore(hosted.context, hosted.intent, 40);
    initializeAccountDeletion(hosted.context, "fence-key");
    const deletion = fenceAccount(hosted.context, "fence-key", "reader", "reader@dohc.test");
    purgeAccountRows(hosted.context, "reader", "reader@dohc.test", deletion.manifest!);
    expect(hosted.storage.getShareGrant("grant")).toBeNull();
  });
  try {
    const proposed = f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
    const admitted = f.store.admitStopRestoreProposal(f.input, proposed.proposalDigest, policy, 201);
    const application = {fence: admitted.preparation.fence, candidateDigest: admitted.candidateDigest, nativeSourceManifestDigest: admitted.nativeSourceManifestDigest,
      admitted: admitted.admitted, localHeadSequence: admitted.preparation.fence.localHeadSequence + 1,
      hostCoordinate: {hostId: f.input.host.hostId, hostEpoch: f.input.host.hostEpoch, instanceId: f.input.host.instanceId, connectionId: f.input.host.connectionId}, recordedAtMs: 202};
    f.store.acknowledgeStopRestoreReplacement(f.input, application);
    const settlement = {settlementId: "restore-settlement", previousCursor: 0, terminalCursor: admitted.admitted.accepted.receipt.journalCursor,
      applicationCount: 3, localYDocSequence: application.localHeadSequence, momentId: "restore-moment", markdownDigest: admitted.preparation.point.markdownDigest,
      materialized: true, collectionReconcileRequired: false};
    f.store.acknowledgeStopRestoreSettlement(f.input, settlement);
    expect(f.store.acknowledgeStopRestoreResume(f.input, {relayDatabaseNamespace: admitted.preparation.fence.operation.relayDatabaseNamespace,
      operationId: f.input.operationId, binding: admitted.admitted.accepted.binding, applicationReceipt: admitted.admitted.accepted.receipt,
      settlementId: settlement.settlementId, momentId: settlement.momentId, markdownDigest: settlement.markdownDigest,
      localHeadSequence: application.localHeadSequence, recordedAtMs: 204}).phase).toBe("resumed");
  } finally {f.close();}
});

it("starts a fresh restore author window at the 960-identity checkpoint band", () => {
  const f = contentProposalFixture("owner", "device", false, false, false, 960);
  try {
    const accepted = f.store.captureStopRestoreAcceptedCut(f.input);
    expect(accepted.checkpoint.cursor).toBe(960);
    expect(accepted.events).toEqual([]);
    const proposed = f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
    const admitted = f.store.admitStopRestoreProposal(f.input, proposed.proposalDigest, policy, 201);
    expect(admitted.admitted.authorSnapshot).toEqual([]);
    expect(admitted.admitted.checkpointCoverage?.map(entry => entry.author)).toEqual([{kind: "unattributed"}]);
  } finally {f.close();}
});

function admittedRestoreFixture(kind:"owner"|"bootstrap"="owner",pending: boolean | "deleted"=true,mode:"service"|"device"="device",beforeFence?:Parameters<typeof readyNativeFence>[4]) {
  return admitRestore(contentProposalFixture(kind,mode,pending,false,false,0,beforeFence));
}
// Records and admits a built restore proposal, with the native receipts that complete it.
function admitRestore<F extends Pick<ReturnType<typeof contentProposalFixture>,"store"|"input"|"encoded">>(f: F) {
  const proposal=f.store.recordStopRestoreProposal(f.input,f.encoded,policy,200);
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

async function repeatedReviewFixture(rounds = 1) {
  const f = admittedRestoreFixture("owner", "deleted");
  try {
    f.complete();
    // Each restore begins once the one before it is published.
    let published = await publishRestore(f, f.admitted, "review-publication-0"), previous = f.admitted.admitted.accepted.receipt.journalCursor;
    for (let round = 1; ; round++) {
      const at = 200 + 100 * round, grantGeneration = 4 + 2 * round;
      f.raw.prepare("UPDATE sync_relay_share_grants SET status='active',generation=?,revoked_at_ms=NULL WHERE grant_id='grant'").run(grantGeneration);
      const intent = {...f.intent, operationId: round === 1 ? "review-second" : `review-${round + 1}`, expectedFence: 1 + round, expectedGrantGeneration: grantGeneration};
      beginStopRestore(f.context, intent, at);
      const lookup = {...f.lookup, operationId: intent.operationId};
      advanceStopRestoreFence(f.context, lookup, at + 1);
      const opened = f.store.openStopRestoreCut(lookup);
      if (opened.kind !== "ready") throw Error(opened.kind);
      expect(f.store.nextStopRestoreCut(opened.capture).kind).toBe("done");
      f.store.completeStopRestoreCut(opened.capture);
      const receipt = {operation: f.store.pendingStopRestoreFence(lookup).operation, localHeadSequence: 2 + 10 * round, recordedAtMs: at + 2};
      f.store.acknowledgeStopRestoreFence(lookup, receipt);
      const input = {...lookup, maxBytes: 1_000_000, maxEvents: 40};
      const proposal = {...f.receipt, fence: receipt, point: resolveLiveRestorePoint(f.store.captureStopRestorePoint(input), policy),
        selectedHistory: f.store.captureStopRestorePoint(input).proof, acceptedHistory: f.store.captureStopRestoreAcceptedCut(input).proof,
        originEvidenceDigest: f.store.captureStopRestoreOwnerOrigin(input).evidenceDigest,
        nativeSources: [], nativeSourceManifestDigest: jsonHash([receipt, []])};
      const second = buildContentProposal({...f, input, lookup, receipt, proposal});
      const saved = f.store.recordStopRestoreProposal(input, second.encoded, policy, at + 3);
      if (round === rounds) return {...second, first: f, saved, reviewInput: {...input, maxOutputBytes: 1_000_000}};
      const admitted = f.store.admitStopRestoreProposal(input, saved.proposalDigest, policy, at + 4);
      const application = {...f.application, fence: admitted.preparation.fence, candidateDigest: admitted.candidateDigest,
        nativeSourceManifestDigest: admitted.nativeSourceManifestDigest, admitted: admitted.admitted,
        localHeadSequence: receipt.localHeadSequence + 1, recordedAtMs: at + 5};
      f.store.acknowledgeStopRestoreReplacement(input, application);
      const settlement = {...f.settlement, settlementId: `settlement-${round}`, momentId: `moment-${round}`,
        terminalCursor: admitted.admitted.accepted.receipt.journalCursor, localYDocSequence: application.localHeadSequence,
        markdownDigest: admitted.preparation.point.markdownDigest};
      f.store.acknowledgeStopRestoreSettlement(input, settlement);
      f.store.acknowledgeStopRestoreResume(input, {...f.resume, operationId: input.operationId, binding: admitted.admitted.accepted.binding,
        applicationReceipt: admitted.admitted.accepted.receipt, settlementId: settlement.settlementId, momentId: settlement.momentId,
        markdownDigest: settlement.markdownDigest, localHeadSequence: application.localHeadSequence, recordedAtMs: at + 7});
      published = await publishRestore(f, admitted, `review-publication-${round}`, previous, published.markdownDigest, round);
      previous = admitted.admitted.accepted.receipt.journalCursor;
    }
  } catch (error) {f.close(); throw error;}
}

it("parses the complete leased storage review through the desktop owner restore contract", async () => {
  const f = await repeatedReviewFixture(2);
  try {
    const before = lifecycleRows(f), driver = new LiveRestorePreparation({...preparationConfig(), maxEvents: 40});
    const sendLiveRestore = vi.fn(async () => {throw Error("review must not write to the host");});
    const lease = await driver.review({store: f.store, lookup: f.lookup, deliveryKind: "owner",
      connection: {client: {sendLiveRestore} as never, workspace: "native-workspace", host: f.lookup.host, deadlineMs: 1000, nextRequestId: () => 1}});
    try {
      const parsed = OwnerRestoreReview.parse(JSON.parse(JSON.stringify(lease.review)));
      expect(parsed.operationId).toBe(f.input.operationId);
      expect(parsed.selectedPointReceivedAtMs).toBeNull();
      expect(parsed.acceptedEvents).toEqual(lease.review!.acceptedEvents);
      expect(parsed.priorRestoreCuts).toEqual(lease.review!.priorRestoreCuts);
      expect(parsed.priorRestoreCuts).toHaveLength(2);
      expect(parsed.nativeSources).toEqual(lease.review!.nativeSources);
      expect(parsed.nativeSources).toHaveLength(2);
      const {candidateDigest, ...content} = lease.review!.content;
      expect(parsed.candidateDigest).toBe(candidateDigest);
      expect(parsed.content).toEqual(content);
      expect(parsed.content.restoredMarkdownDigest).toBe(f.receipt.point.markdownDigest);
      expect(lifecycleRows(f)).toEqual(before);
      expect(sendLiveRestore).not.toHaveBeenCalled();
    } finally {lease.close();}
    expect(lease.invalidated.aborted).toBe(true);
  } finally {f.close();}
});

it("reads the selected accepted edit time and author from authenticated storage into the desktop review", () => {
  const f = contentProposalFixture("owner", "device", false, false, true);
  try {
    f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
    const input = {...f.input, maxOutputBytes: 1_000_000}, before = lifecycleRows(f);
    const review = OwnerRestoreReview.parse(f.store.readStopRestoreReview(input, policy));
    const selected = f.raw.prepare(`SELECT received_at_ms,principal_kind,principal_id,grant_id,grant_generation
      FROM sync_relay_live_update_journal WHERE journal_cursor=?`).get(f.intent.restorePointCursor)!;
    expect(review.point).toMatchObject({journalCursor: f.intent.restorePointCursor, receiptDigest: f.intent.restorePointReceiptDigest});
    expect(review.point.journalCursor).toBe(1);
    expect(review.selectedPointReceivedAtMs).toBe(selected.received_at_ms);
    expect(review.selectedPointReceivedAtMs).toBe(30);
    // The selected point's author is the authority the relay accepted that exact delivery from.
    expect(review.selectedPointAuthority).toEqual({principalKind: selected.principal_kind, principalId: selected.principal_id,
      grantId: selected.grant_id, grantGeneration: selected.grant_generation});
    expect(review.recordedAtMs).toBe(200);
    expect(review.acceptedEvents.map(event => event.metadata.accepted.receipt.journalCursor)).toEqual([2]);
    expect(lifecycleRows(f)).toEqual(before);
    for (const damage of ["UPDATE sync_relay_live_update_journal SET received_at_ms=received_at_ms+1 WHERE journal_cursor=?",
      "UPDATE sync_relay_live_update_journal SET principal_id='another-principal' WHERE journal_cursor=?"]) {
      const saved = f.raw.prepare("SELECT received_at_ms,principal_id FROM sync_relay_live_update_journal WHERE journal_cursor=?")
        .get(f.intent.restorePointCursor)!;
      f.raw.prepare(damage).run(f.intent.restorePointCursor);
      expect(() => f.store.readStopRestoreReview(input, policy)).toThrow();
      f.raw.prepare("UPDATE sync_relay_live_update_journal SET received_at_ms=?,principal_id=? WHERE journal_cursor=?")
        .run(saved.received_at_ms, saved.principal_id, f.intent.restorePointCursor);
      expect(OwnerRestoreReview.parse(f.store.readStopRestoreReview(input, policy))).toEqual(review);
    }
  } finally {f.close();}
});

it.each(["complete", "missing-event", "missing-proposal", "wrong-proposal", "budget", "changed-after-review", "cancelled-after-review"])("confirms only an authenticated complete host restore review: %s", async state => {
  const f = await repeatedReviewFixture();
  try {
    const driver = new LiveRestorePreparation({...preparationConfig(), maxEvents: state === "budget" ? 3 : 40});
    const sendLiveRestore = vi.fn(async () => {throw Error("simulated transport loss after admission");});
    const options = {store: f.store, lookup: f.lookup, deliveryKind: "owner" as const,
      connection: {client: {sendLiveRestore} as never, workspace: "native-workspace", host: f.lookup.host, deadlineMs: 1000, nextRequestId: () => 1}};
    if (state !== "budget") {
      const before = lifecycleRows(f), lease = await driver.review(options);
      try {
        expect(lease.review!.acceptedEvents).toHaveLength(3);
        expect(lease.review!.nativeSources).toHaveLength(2);
        expect(lifecycleRows(f)).toEqual(before);
      } finally {lease.close();}
    }
    if (state === "missing-event") f.raw.exec("DELETE FROM sync_relay_live_update_journal WHERE journal_cursor=1");
    if (state === "missing-proposal") f.raw.exec("DELETE FROM sync_relay_live_restore_proposals WHERE operation_id='review-second'");
    const abort = new AbortController();
    if (state === "changed-after-review" || state === "cancelled-after-review") {
      const read = f.store.readStopRestoreLifecycle.bind(f.store);
      let reads = 0;
      vi.spyOn(f.store, "readStopRestoreLifecycle").mockImplementation((...args) => {
        const lifecycle = read(...args);
        // The driver first checks recovery; admission checks again after preparing the review.
        if (++reads === 2) {
          if (state === "changed-after-review") f.raw.exec("DELETE FROM sync_relay_live_update_journal WHERE journal_cursor=1");
          else abort.abort(Error("confirmation cancelled"));
        }
        return lifecycle;
      });
    }
    const before = lifecycleRows(f);
    const expected = state === "wrong-proposal" ? "f".repeat(64) : f.saved.proposalDigest;
    if (state === "complete") {
      const validation = vi.spyOn(restoreProof, "validateLiveRestoreProposal");
      await expect(driver.confirm(options, expected)).rejects.toThrow("simulated transport loss after admission");
      expect(validation).toHaveBeenCalledTimes(1);
      validation.mockRestore();
      expect(f.store.readStopRestoreLifecycle(f.input)?.phase).toBe("relay-admitted");
      expect(sendLiveRestore).toHaveBeenCalledTimes(1);
    } else {
      await expect(driver.confirm({...options, signal: abort.signal}, expected)).rejects.toThrow();
      if (state === "changed-after-review") {
        expect(f.store.readStopRestoreLifecycle(f.input)).toBeNull();
        expect(lifecycleRows(f).lifecycle).toEqual(before.lifecycle);
        expect(lifecycleRows(f).operations).toEqual(before.operations);
      } else expect(lifecycleRows(f)).toEqual(before);
      expect(sendLiveRestore).not.toHaveBeenCalled();
    }
  } finally {f.close();}
});

it("returns a complete private review across a restore checkpoint, including already-deleted native work", async () => {
  const f = await repeatedReviewFixture();
  try {
    expect(f.receipt.acceptedHistory.suffix).toHaveLength(0);
    expect(f.receipt.acceptedHistory.checkpoint.eventCount).toBe(3);
    expect(Y.decodeUpdate(f.first.bytes.nativeSourceBytes[1]!).structs).toHaveLength(0);
    expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_restore_source_ranges WHERE source_ordinal=1").get()!.n).toBe(0);
    const before = lifecycleRows(f), review = f.store.readStopRestoreReview(f.reviewInput, policy)!;
    expect(review.proposalDigest).toBe(f.saved.proposalDigest);
    expect(review.acceptedEvents.map(event => event.metadata.accepted.receipt.journalCursor)).toEqual([1, 2, 3]);
    expect(review.priorRestoreCuts).toEqual([{operationId: "restore", proposalDigest: f.first.proposal.proposalDigest,
      restoreJournalCursor: 3, selectedEventCount: f.first.receipt.selectedHistory.eventCount,
      acceptedEventCount: f.first.receipt.acceptedHistory.eventCount,
      selectedTerminal: f.first.receipt.selectedHistory.terminal, frozenTerminal: f.first.receipt.acceptedHistory.terminal}]);
    expect(review.nativeSources).toHaveLength(2);
    expect(review.nativeSources.map(source => source.acceptedRelation)).toEqual(["not-relay-accepted", "not-relay-accepted"]);
    expect(review.nativeSources[1]!.source.deliveryId).toBe(f.first.receipt.nativeSources[1]!.deliveryId);
    for (const source of review.nativeSources) expect(source.occurrences).toEqual([{
      operationId: "restore", proposalDigest: f.first.proposal.proposalDigest, context: "prior-restore", acceptedReceipt: null,
    }]);
    expect(review.content.frozenMarkdownDigest).toBe(hash(Buffer.from(review.content.frozenMarkdown)));
    expect(review.content.restoredMarkdownDigest).toBe(f.receipt.point.markdownDigest);
    expect(lifecycleRows(f)).toEqual(before);
  } finally {f.close();}
});

it("retains overlapping authenticated prior restore cuts without duplicating accepted events or deletion-only sources", async () => {
  const f = await repeatedReviewFixture(2);
  try {
    const before = lifecycleRows(f), review = f.store.readStopRestoreReview(f.reviewInput, policy)!;
    expect(review.acceptedEvents.map(event => event.metadata.accepted.receipt.journalCursor)).toEqual([1, 2, 3, 4]);
    expect(review.priorRestoreCuts.map(cut => ({operationId: cut.operationId, selected: cut.selectedTerminal?.journalCursor ?? 0,
      frozen: cut.frozenTerminal?.journalCursor ?? 0, restored: cut.restoreJournalCursor,
      selectedEvents: cut.selectedEventCount, acceptedEvents: cut.acceptedEventCount}))).toEqual([
      {operationId: "restore", selected: 0, frozen: 2, restored: 3, selectedEvents: 0, acceptedEvents: 2},
      {operationId: "review-second", selected: 0, frozen: 3, restored: 4, selectedEvents: 0, acceptedEvents: 3},
    ]);
    expect(review.nativeSources).toHaveLength(2);
    expect(review.nativeSources[1]!.source.deliveryId).toBe(f.first.receipt.nativeSources[1]!.deliveryId);
    expect(Y.decodeUpdate(f.first.bytes.nativeSourceBytes[1]!).structs).toHaveLength(0);
    expect(lifecycleRows(f)).toEqual(before);
  } finally {f.close();}
});

it.each(["owner", "workspace", "host", "events", "bytes", "output", "metadata", "missing-event", "historical-proposal", "restore-marker"])(
  "refuses the complete restore review for %s without admitting a replacement", async damage => {
    const f = await repeatedReviewFixture();
    try {
      const input = structuredClone(f.reviewInput);
      if (damage === "owner") input.ownerUserId = "foreign";
      if (damage === "workspace") input.workspaceId = "foreign";
      if (damage === "host") Object.assign(input.host, {connectionId: "foreign"});
      if (damage === "events") input.maxEvents = 3;
      if (damage === "bytes") input.maxBytes = 1;
      if (damage === "output") input.maxOutputBytes = 1;
      if (damage === "metadata") f.raw.exec("UPDATE sync_relay_live_update_journal SET received_at_ms=received_at_ms+1 WHERE journal_cursor=1");
      if (damage === "missing-event") f.raw.exec("DELETE FROM sync_relay_live_update_journal WHERE journal_cursor=1");
      if (damage === "historical-proposal") f.raw.exec("UPDATE sync_relay_live_restore_proposals SET proposal_bytes=zeroblob(length(proposal_bytes)) WHERE operation_id='restore'");
      if (damage === "restore-marker") f.raw.exec("UPDATE sync_relay_live_update_journal SET restore_operation_id=NULL WHERE journal_cursor=3");
      const before = lifecycleRows(f);
      expect(() => f.store.readStopRestoreReview(input, policy)).toThrow();
      expect(lifecycleRows(f)).toEqual(before);
    } finally {f.close();}
  });

it("enforces complete serialized review output bytes and reports current native sources separately", () => {
  const f = contentProposalFixture("owner", "device", true);
  try {
    f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
    const input = {...f.input, maxOutputBytes: 1_000_000};
    const review = f.store.readStopRestoreReview(input, policy)!;
    const outputBytes = Buffer.byteLength(JSON.stringify(review));
    expect(f.store.readStopRestoreReview({...input, maxOutputBytes: outputBytes}, policy)).toEqual(review);
    expect(() => f.store.readStopRestoreReview({...input, maxOutputBytes: outputBytes - 1}, policy)).toThrow("output budget");
    expect(review.nativeSources).toHaveLength(2);
    expect(review.nativeSources.every(source => source.occurrences[0]!.context === "current-fence")).toBe(true);
  } finally {f.close();}
});

it("associates an acknowledged native source with its single accepted delivery in the complete review", () => {
  const f = contentProposalFixture("owner", "device", false, true);
  try {
    f.store.recordStopRestoreProposal(f.input, f.encoded, policy, 200);
    const review = f.store.readStopRestoreReview({...f.input, maxOutputBytes: 1_000_000}, policy)!;
    const source = f.acceptedNative!.source;
    expect(review.acceptedEvents.filter(event => event.metadata.accepted.receipt.deliveryId === source.deliveryId)).toHaveLength(1);
    expect(review.nativeSources).toHaveLength(1);
    expect(review.nativeSources[0]).toMatchObject({acceptedRelation: "after-selected", acceptedReceipt: source.acceptedReceipt,
      occurrences: [{context: "current-fence", acceptedReceipt: source.acceptedReceipt}]});
  } finally {f.close();}
});

it.each(["metadata", "provenance"])("preflights actual historical %s before materializing an oversized review row", async damage => {
  const f = await repeatedReviewFixture();
  try {
    if (damage === "metadata") f.raw.prepare("UPDATE sync_relay_live_update_journal SET selector_paths_json=? WHERE journal_cursor=1")
      .run(JSON.stringify(["x".repeat(200_000)]));
    else f.raw.exec(`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<20000)
      INSERT INTO sync_relay_live_update_struct_provenance(workspace_id,main_version_id,object_id,lineage_claim_id,client_id,start_clock,end_clock,journal_cursor)
      SELECT workspace_id,main_version_id,object_id,lineage_claim_id,8000000000000000+value,0,1,journal_cursor FROM sync_relay_live_update_journal,n WHERE journal_cursor=1`);
    const prepare = f.context.db.prepare.bind(f.context.db);
    const spy = vi.spyOn(f.context.db, "prepare").mockImplementation(sql => {
      if (sql.startsWith("SELECT journal_cursor,relay_database_namespace,")) throw Error("materialized review row before preflight");
      return prepare(sql);
    });
    try {expect(() => f.store.readStopRestoreReview({...f.reviewInput, maxBytes: 100_000}, policy)).toThrow("byte bounds");}
    finally {spy.mockRestore();}
  } finally {f.close();}
});

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
it("retains original owner binding and operation history across a second stop",async()=>{
  const f=admittedRestoreFixture();
  try{
    f.complete();await publishRestore(f,f.admitted,"restore-publication");f.raw.exec("UPDATE sync_relay_share_grants SET status='active',generation=6,revoked_at_ms=NULL WHERE grant_id='grant'");
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


function restorePublication(f: Pick<ReturnType<typeof admittedRestoreFixture>, "document" | "raw" | "admitted" | "storage">, bytes: Uint8Array,
  terminal: number, id: string, previous = 0, before = String(f.raw.prepare("SELECT baseline_projected_sha256 FROM sync_relay_live_documents").get()!.baseline_projected_sha256), originSeq = 0) {
  const document = f.document, row = f.raw.prepare("SELECT * FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(terminal)!;
  const binding = {...f.admitted.admitted.accepted.binding};
  const normalized = createLiveMarkdownRegistrationValidator(policy)({document, currentPath: binding.currentPath, checkpoint: bytes});
  if (normalized.kind !== "accepted") throw Error(normalized.reason);
  const markdown = Buffer.from(normalized.evidence.projectedMarkdown), markdownDigest = hash(markdown), stateDigest = hash(bytes);
  for (const [sha256, content] of [[stateDigest, bytes], [markdownDigest, markdown]] as const)
    f.storage.putBlob({workspaceId: document.workspaceId, sha256, content, createdAtMs: 1});
  const prior = previous === 0 ? null : f.raw.prepare("SELECT * FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(previous)!;
  const namespace = String(row.relay_database_namespace), key = [namespace, document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId];
  const acceptedEventCount = Number(row.accepted_event_count) - Number(prior?.accepted_event_count ?? 0);
  const record = {settlementId: "", relayDatabaseNamespace: namespace, binding,
    hostCoordinate: {hostId: "host", hostEpoch: 1, instanceId: "instance", connectionId: "connection"}, previousCursor: previous, terminalCursor: terminal,
    previousYdocSequence: 0, localYdocSequence: 1, applicationCount: acceptedEventCount, nativeIntervalDigest: hash(Buffer.from(`native-interval-${id}`)), acceptedEventCount,
    acceptedIntervalDigest: jsonHash(["live-settlement-accepted-interval-v1", key,
      [Number(prior?.accepted_event_count ?? 0), previous, prior?.accepted_evidence_digest ?? initialAcceptedHistoryDigest(namespace, document)],
      [Number(row.accepted_event_count), terminal, row.accepted_evidence_digest]]),
    momentId: id, markdownDigest, sourceStateVectorDigest: hash(Buffer.from(`state-vector-${id}`)), acceptedStateBlobSha256: stateDigest, recordedAtMs: 1, restoreOperationId: null};
  record.settlementId = nativeSettlementId(record);
  const payload = {momentId: id, objectId: document.objectId, versionId: "main", path: binding.currentPath, operation: "write",
    payloadBeforePath: binding.currentPath, payloadAfterPath: binding.currentPath, payloadBeforeContentKind: "text", payloadAfterContentKind: "text",
    payloadBeforeBlobSha256: before, payloadAfterBlobSha256: markdownDigest, payloadAfterByteLength: markdown.byteLength, recordedAtMs: 1,
    settlementReference: {formatVersion: 1, recordDigest: settlementRecordDigest(record), record}};
  return {record, payload, markdownDigest, op: {originSeq, opKind: "moment.append", payloadJson: stableJsonStringify(payload), recordedAtMs: 1}};
}

it("publishes hosted settlement at a verified closed restore fence and chains the next ordinary settlement", async () => {
  const f = admittedRestoreFixture(), doc = new Y.Doc({gc: false});
  try {
    const restoreCursor = f.admitted.admitted.accepted.receipt.journalCursor;
    const bytes = f.raw.prepare("SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(restoreCursor)!.validation_checkpoint_bytes as Uint8Array;
    const first = restorePublication(f, bytes, restoreCursor, "published-restore");
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [first.op]});
    expect(first.op).toMatchObject({settlementAdmission: {status: "accepted"}});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [first.op]})).toMatchObject({inserted: 1});
    expect(first.op).toMatchObject({settlementAdmission: {status: "accepted"}});
    expect(f.raw.prepare("SELECT admission_state FROM sync_relay_live_documents").get()!.admission_state).toBe("closed");
    expect(f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "proof", originSeq: 0})!.admittedAuthorSnapshot).toEqual([{kind: "unattributed"}]);
    f.complete();
    Y.applyUpdate(doc, bytes); doc.getMap("frontmatter").set("after", "continued work");
    const captured = f.journalCapture(Y.encodeStateAsUpdate(doc), "post-restore");
    const accepted = f.storage.commitLiveUpdateJournal({...captured, trustedAccount: {accountId: "owner", name: "Owner"},
      metadata: {...captured.metadata, authorContext: {kind: "account", accountId: "owner"}}});
    expect(accepted.result.kind).toBe("accepted");
    const second = restorePublication(f, Y.encodeStateAsUpdate(doc), accepted.admitted!.metadata.accepted.receipt.journalCursor,
      "published-next", restoreCursor, first.markdownDigest, 1);
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [second.op]});
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [second.op]}).settlementRefusals).toBeUndefined();
    expect(f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "proof", originSeq: 1})!.admittedAuthorSnapshot)
      .toEqual([{kind: "human", humanId: "owner", humanName: "Owner"}]);
  } finally {doc.destroy(); f.close();}
});

it.each(["old-fence", "copied-fence", "changed-admission"])("consumes invalid hosted restore proof: %s", async damage => {
  const f = admittedRestoreFixture();
  try {
    const terminal = f.admitted.admitted.accepted.receipt.journalCursor;
    const bytes = f.raw.prepare("SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(terminal)!.validation_checkpoint_bytes as Uint8Array;
    const publication = restorePublication(f, bytes, terminal, "bad-restore");
    if (damage !== "changed-admission") {
      publication.record.binding.restoreFenceGeneration = damage === "old-fence" ? publication.record.binding.restoreFenceGeneration - 1 : publication.record.binding.restoreFenceGeneration + 1;
      publication.payload.settlementReference.recordDigest = hash(Buffer.from(stableJsonStringify(publication.record)));
      publication.op.payloadJson = stableJsonStringify(publication.payload);
    }
    await prepareHostedSettlements(f.context, {workspaceId: "workspace", originId: "proof", ops: [publication.op]});
    if (damage === "changed-admission") f.raw.prepare("UPDATE sync_relay_live_restore_lifecycles SET admission_sha256=?").run("a".repeat(64));
    expect(f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [publication.op]}).settlementRefusals).toHaveLength(1);
    expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_settlement_bindings").get()!.n).toBe(0);
  } finally {f.close();}
});
afterAll(async () => {await liveValidation.close();});

it.each(["accepted-base", "forged-before", "skipped-cut", "changed-base-admission", "damaged-base-cut"])("restarts hosted chain from authenticated recovered binding base: %s", async variant => {
  const f = admittedRestoreFixture(), doc = new Y.Doc({gc: false});
  try {
    const restoreCursor = f.admitted.admitted.accepted.receipt.journalCursor;
    const bytes = f.raw.prepare("SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(restoreCursor)!.validation_checkpoint_bytes as Uint8Array;
    const base = restorePublication(f, bytes, restoreCursor, "unpublished-recovery-base");
    f.complete();
    Y.applyUpdate(doc, bytes); doc.getMap("frontmatter").set("after", "recovered work");
    const firstCapture = f.journalCapture(Y.encodeStateAsUpdate(doc), "recovered-first");
    const first = f.storage.commitLiveUpdateJournal({...firstCapture, trustedAccount: {accountId:"owner",name:"Owner"},
      metadata:{...firstCapture.metadata,authorContext:{kind:"account",accountId:"owner"}}});
    expect(first.result.kind).toBe("accepted");
    let previous = restoreCursor, before = base.markdownDigest, terminal = first.admitted!.metadata.accepted.receipt.journalCursor;
    if (variant === "forged-before") before = "a".repeat(64);
    if (variant === "skipped-cut") {
      const skipped = restorePublication(f, Y.encodeStateAsUpdate(doc), terminal, "skipped", restoreCursor, before);
      previous = terminal; before = skipped.markdownDigest;
      doc.getMap("frontmatter").set("second", "cannot skip accepted work");
      const captured = f.journalCapture(Y.encodeStateAsUpdate(doc), "recovered-second");
      const accepted = f.storage.commitLiveUpdateJournal({...captured, trustedAccount:{accountId:"owner",name:"Owner"},
        metadata:{...captured.metadata,authorContext:{kind:"account",accountId:"owner"}}});
      expect(accepted.result.kind).toBe("accepted"); terminal = accepted.admitted!.metadata.accepted.receipt.journalCursor;
    }
    const publication = restorePublication(f, Y.encodeStateAsUpdate(doc), terminal, "recovered-publication", previous, before);
    if (variant === "damaged-base-cut") f.raw.prepare("DELETE FROM sync_relay_live_settlement_cuts WHERE journal_cursor=?").run(restoreCursor);
    await prepareHostedSettlements(f.context,{workspaceId:"workspace",originId:"proof",ops:[publication.op]});
    if (variant === "changed-base-admission") f.raw.prepare("UPDATE sync_relay_live_restore_lifecycles SET admission_sha256=?").run("a".repeat(64));
    const result = f.storage.appendLogBatch({workspaceId:"workspace",originId:"proof",ops:[publication.op]});
    if (variant === "accepted-base") {
      expect(result.settlementRefusals).toBeUndefined();
      expect(f.storage.fetchLogCoordinate({workspaceId:"workspace",originId:"proof",originSeq:0})!.admittedAuthorSnapshot)
        .toEqual([{kind:"human",humanId:"owner",humanName:"Owner"}]);
    } else expect(result.settlementRefusals).toHaveLength(1);
  } finally {doc.destroy();f.close();}
});
