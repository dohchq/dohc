import {nativeSettlementId, prepareHostedSettlements, settlementRecordDigest} from "../../../services/sync-relay/src/storage/hostedSettlement.js";
import {appendValidatedLiveJournal, readReplicaLiveJournal, decodeJournalRow} from "../../../services/sync-relay/src/storage/liveUpdateJournal.js";
import {parseRestoreAdmission, verifyRestoreCheckpoint} from "../../../services/sync-relay/src/storage/liveRestoreCheckpoint.js";
import {stableJsonStringify} from "../../../services/sync-relay/src/canonicalJson.js";
import {initialAcceptedHistoryDigest} from "../../../services/sync-relay/src/liveAcceptedHistory.js";
import {createLiveMarkdownRegistrationValidator} from "./liveDocumentValidation.js";
import {liveValidation} from "../../../services/sync-relay/src/liveValidation.js";
import {afterAll} from "vitest";
import {createHash} from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import { policy, hash, cleanupLiveDeliveryFixtures, restore } from "./liveCommittedDeliveryTestSupport.js";
import {resolveLiveRestorePoint} from "./liveRestorePoint.js";
import {markdownToYDoc, yDocToMarkdown} from "./import-export.js";
import { createLiveJournalHistoryAuthority } from "../../../services/sync-relay/src/storage/liveJournalHistory.js";
import { beginStopRestore, advanceStopRestoreFence, readStopRestore } from "../../../services/sync-relay/src/storage/liveRestoreOperation.js";
import type { StorageContext } from "../../../services/sync-relay/src/storage/context.js";
import type { StopRestoreCutCapture, OwnerCutCapture } from "../../../services/sync-relay/src/storage/liveCommittedDelivery.js";
import type {NativeRestoreFenceReceipt} from "../../../services/sync-relay/src/liveRestoreFence.js";
import { openSyncRelayStorage } from "../../../services/sync-relay/src/storage.js";
import {parseNativeRestoreProposalReceipt, encodeNativeRestoreProposal, decodeNativeRestoreProposal, nativeSourceAgentDeclaration} from "../../../services/sync-relay/src/liveRestoreProposal.js";
import {initializeLiveRestoreOperationSchema} from "../../../services/sync-relay/src/storage/liveRestoreOperationSchema.js";
import {validateLiveRestoreProposal} from "./liveRestoreProof.js";
import * as restoreProof from "./liveRestoreProof.js";
import {createLiveMarkdownJournalValidator} from "./liveDocumentValidation.js";
import {LiveRestorePreparation, parseLiveRestoreConfig} from "../../../services/sync-relay/src/liveRestorePreparation.js";
import {LiveRestoreTooLarge, liveRestoreValidator, runLiveRestoreWork, type LiveRestoreRun, type LiveRestoreValidator} from "../../../services/sync-relay/src/liveRestoreValidation.js";
import {canonicalVersionedAcceptedMetadata} from "../../../services/sync-relay/src/liveAcceptedHistory.js";
import {LiveCommittedDelivery} from "../../../services/sync-relay/src/liveCommittedDelivery.js";
import {OwnerCommittedDelivery} from "../../../services/sync-relay/src/ownerCommittedDelivery.js";
import {OwnerRestoreReview} from "../../../apps/desktop/src/ipc/ownerRestoreContract.js";
import {fixture, bootstrapAck, applicationAck} from "./liveRestoreFixture.integration-helper.js";

afterEach(cleanupLiveDeliveryFixtures);
const jsonHash = (value: unknown) => hash(Buffer.from(JSON.stringify(value)));
const ownerOriginDigest = ({binding, cut: c}: Pick<OwnerCutCapture, "binding" | "cut">) => jsonHash([binding,
  c.relayDatabaseNamespace, c.sourceMomentId, c.sourceDigest, c.sourceByteLength, c.baselineMomentRelaySequence,
  c.baselineRegisteredAtMs, c.expectedLocalSequence, c.events.map(event => canonicalVersionedAcceptedMetadata(event.metadata))]);
function proposalSourcesFixture(kind: "bootstrap" | "owner", mode: "service" | "device", acceptedNative = false, selectedPoint = false, authorBand = 0) {
  const f = readyNativeFence(kind, mode, authorBand || (acceptedNative ? "native" : true), selectedPoint);
  f.store.acknowledgeStopRestoreFence(f.lookup, f.receipt);
  const input = {...f.lookup, maxBytes: authorBand ? 10_000_000 : 1_000_000, maxEvents: authorBand ? 1000 : 10};
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

it.each(["journalCursor", "receiptDigest"] as const)("refuses a proposal that substitutes the fenced %s", field => {
  const f = proposalSourcesFixture("bootstrap", "device");
  try {
    expect(() => parseNativeRestoreProposalReceipt(JSON.stringify(f.proposal), f.input)).not.toThrow();
    const receipt = {...f.proposal, point: {...f.proposal.point,
      [field]: field === "journalCursor" ? f.proposal.point.journalCursor + 1 : "f".repeat(64)}};
    expect(() => parseNativeRestoreProposalReceipt(JSON.stringify(receipt), f.input)).toThrow();
  } finally {f.close();}
});

it.each(["journalCursor", "receiptDigest"] as const)("refuses an admission that substitutes the fenced %s", async field => {
  const f = await admittedRestoreFixture();
  try {
    const saved = f.raw.prepare("SELECT admission_json FROM sync_relay_live_restore_lifecycles").get()!;
    const receipt = parseRestoreAdmission(JSON.parse(String(saved.admission_json)));
    expect(() => parseRestoreAdmission(receipt)).not.toThrow();
    if (field === "journalCursor") receipt.preparation.point.journalCursor++;
    else receipt.preparation.point.receiptDigest = "f".repeat(64);
    expect(() => parseRestoreAdmission(receipt)).toThrow();
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

function contentProposalFixture(kind: "bootstrap" | "owner" = "owner", mode: "service" | "device" = "device", pending: boolean | "deleted" = false, acceptedNative = false, selectedPoint = false, authorBand = 0) {
  return buildContentProposal(proposalSourcesFixture(kind, mode, acceptedNative, selectedPoint, authorBand), pending);
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
      const prepare = new LiveRestorePreparation(preparationConfig(), restore);
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
    const prepare = new LiveRestorePreparation(preparationConfig(), restore), abort = new AbortController();
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
    expect(await f.store.readStopRestoreProposal(f.input, restore)).toBeNull();
    sendLiveRestore.mockResolvedValueOnce({response: {result: {status: "prepared"}}, bytes: Buffer.from([0])});
    await expect(prepare.prepare(options)).rejects.toThrow();
    expect(await f.store.readStopRestoreProposal(f.input, restore)).toBeNull();
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
  const prepare = new LiveRestorePreparation(mutable, restore);
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
      deadlineMs: 1000, nextRequestId: () => 1, restore: new LiveRestorePreparation(preparationConfig(), restore)};
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
    const preparation = new LiveRestorePreparation(preparationConfig(), restore);
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
    const preparation = new LiveRestorePreparation(preparationConfig(), restore);
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
    const preparation = new LiveRestorePreparation({...preparationConfig(), maxOperations: 2}, restore);
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

type ContentProposal = ReturnType<typeof contentProposalFixture>;
const restorePaths = ["read", "review", "record", "admission", "reviewed admission"] as const;
/** Records first when `path` needs a stored proposal, then returns the call under test. */
async function restorePath(f: ContentProposal, path: typeof restorePaths[number]) {
  const recorded = path === "record" ? null : await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
  const review = {...f.input, maxOutputBytes: 1_000_000};
  return (validator: LiveRestoreValidator): Promise<unknown> => path === "read" ? f.store.readStopRestoreProposal(f.input, validator)
    : path === "review" ? f.store.readStopRestoreReview(review, validator)
    : path === "record" ? f.store.recordStopRestoreProposal(f.input, f.encoded, validator, 200)
    : path === "admission" ? f.store.admitStopRestoreProposal(f.input, recorded!.proposalDigest, validator, 201)
    : f.store.admitReviewedStopRestoreProposal(review, recorded!.proposalDigest, validator, 201);
}
/** Validates in this process. Asks for each of `digests` first, then runs `change` during the final run. */
const validatingWhile = (change: () => void, digests: readonly string[] = []) => liveRestoreValidator(async work => {
  const digest = digests.find(digest => !work.answers.has(digest));
  if (digest !== undefined) return {kind: "needs-artifact", digest};
  change();
  return runLiveRestoreWork(work, policy);
});
const artifactText = (name: string) => new TextEncoder().encode(`${name} artifact\n`);
const presentArtifact = artifactText("present"), absentArtifact = artifactText("absent");
const answeredArtifacts = [hash(presentArtifact), hash(absentArtifact)];
/** Adds `bytes` to the restored object's artifact history, below its current moment. */
function addArtifact(f: Pick<ContentProposal, "raw" | "document" | "capture">, bytes: Uint8Array, sequence: number) {
  f.raw.prepare("INSERT OR IGNORE INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)").run(hash(bytes), bytes.length, bytes);
  f.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
    VALUES ('workspace',?,?,?,'main',?,?,'text',?,0)`).run(f.document.objectId, sequence, `artifact-${sequence}`, f.capture.selected.binding.currentPath, hash(bytes), bytes.length);
}

it.each(restorePaths)("completes %s while other workspaces write during validation", async path => {
  const f = contentProposalFixture();
  try {
    addArtifact(f, presentArtifact, 0);
    const call = await restorePath(f, path);
    let writes = 0;
    const result = await call(validatingWhile(() => {
      f.raw.prepare("INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES (?, 'other', 0)").run(`other-${++writes}`);
      f.raw.exec("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+1");
    }, answeredArtifacts));
    expect(writes).toBe(1);
    expect(result).not.toBeNull();
    expect(f.raw.prepare("SELECT phase FROM sync_relay_live_restore_operations").get()!.phase).toBe(path.endsWith("admission") ? "relay-admitted" : "native-fenced");
  } finally {f.close();}
});

const evidenceChanges: readonly (readonly [string, () => ContentProposal, (f: ContentProposal) => void])[] = [
  ["operation row", () => contentProposalFixture(),
    f => f.raw.exec("UPDATE sync_relay_live_restore_operations SET native_receipt_json=json_set(native_receipt_json,'$.recordedAtMs',101)")],
  ["first journal row", () => contentProposalFixture(),
    f => f.raw.exec("UPDATE sync_relay_live_update_journal SET received_at_ms=received_at_ms+1 WHERE journal_cursor=1")],
  ["accepted history tip", () => contentProposalFixture(),
    f => f.raw.exec("UPDATE sync_relay_live_update_journal SET received_at_ms=received_at_ms+1 WHERE journal_cursor=(SELECT MAX(journal_cursor) FROM sync_relay_live_update_journal)")],
  ["native source author", () => contentProposalFixture("owner", "device", false, true),
    f => f.raw.prepare("UPDATE sync_relay_live_update_journal SET author_context_json=NULL WHERE delivery_id=?").run(f.acceptedNative!.source.deliveryId)],
  ["source moment", () => contentProposalFixture(),
    f => f.raw.exec("UPDATE sync_relay_object_moments SET moment_id='replaced' WHERE relay_seq=1")],
  ["bootstrap source", () => contentProposalFixture("bootstrap", "device"),
    f => f.raw.exec("UPDATE sync_relay_live_delivery_bootstraps SET projected_markdown_byte_length=projected_markdown_byte_length+1")],
  ["fetched artifact membership", () => contentProposalFixture(),
    f => f.raw.exec("DELETE FROM sync_relay_object_moments WHERE relay_seq=0")],
  ["absent artifact", () => contentProposalFixture(), f => addArtifact(f, absentArtifact, -1)],
];
it.each(restorePaths.flatMap(path => evidenceChanges.map(([name, make, change]) => [path, name, make, change] as const)))(
  "refuses %s when its %s changes during validation", async (path, _name, make, change) => {
    const f = make();
    try {
      addArtifact(f, presentArtifact, 0);
      const call = await restorePath(f, path);
      let changed: ReturnType<typeof proposalRows> | undefined;
      await expect(call(validatingWhile(() => {change(f); changed = proposalRows(f);}, answeredArtifacts)))
        .rejects.toThrow("Relay evidence changed during validation.");
      expect(changed).toBeDefined();
      expect(proposalRows(f)).toEqual(changed);
    } finally {f.close();}
  });

it.each(restorePaths.filter(path => path !== "record"))("refuses %s when its stored proposal is rewritten at the same length during validation", async path => {
  const f = contentProposalFixture();
  try {
    addArtifact(f, presentArtifact, 0);
    const call = await restorePath(f, path);
    let changed: ReturnType<typeof proposalRows> | undefined;
    await expect(call(validatingWhile(() => {
      f.raw.exec(`UPDATE ${proposalTable} SET proposal_bytes=zeroblob(length(proposal_bytes))`); changed = proposalRows(f);
    }, answeredArtifacts))).rejects.toThrow("Relay evidence changed during validation.");
    expect(proposalRows(f)).toEqual(changed);
    f.raw.prepare(`UPDATE ${proposalTable} SET proposal_bytes=?`).run(f.encoded);
    await expect(call(validatingWhile(() => {}, answeredArtifacts))).resolves.not.toBeNull();
  } finally {f.close();}
});

it.each(["removed", "added"] as const)("refuses point completion when an answered artifact is %s during validation", async change => {
  const f = contentProposalFixture();
  try {
    addArtifact(f, presentArtifact, 0);
    const changing = validatingWhile(() => change === "removed" ? f.raw.exec("DELETE FROM sync_relay_object_moments WHERE relay_seq=0")
      : addArtifact(f, absentArtifact, -1), answeredArtifacts);
    await expect(f.store.resolveStopRestorePoint(f.input, changing)).rejects.toThrow("Relay evidence changed during validation.");
    const resolved = await f.store.resolveStopRestorePoint(f.input, validatingWhile(() => {}, answeredArtifacts));
    expect(resolved.point).toEqual(f.receipt.point);
  } finally {f.close();}
});

it("refuses a restore whose validation runs out of heap, keeping its fence and proposal for an explicit retry", async () => {
  const f = contentProposalFixture();
  try {
    const recorded = await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200), before = proposalRows(f);
    const run = vi.fn<LiveRestoreRun>(async () => ({kind: "capacity-refused"})), exhausted = liveRestoreValidator(run);
    await expect(f.store.readStopRestoreProposal(f.input, exhausted)).rejects.toBeInstanceOf(LiveRestoreTooLarge);
    await expect(f.store.admitStopRestoreProposal(f.input, recorded.proposalDigest, exhausted, 201)).rejects.toBeInstanceOf(LiveRestoreTooLarge);
    expect(run).toHaveBeenCalledTimes(2);
    expect(proposalRows(f)).toEqual(before);
    expect(f.raw.prepare("SELECT phase FROM sync_relay_live_restore_operations").get()!.phase).toBe("native-fenced");
    expect((await f.store.admitStopRestoreProposal(f.input, recorded.proposalDigest, restore, 201)).phase).toBe("relay-admitted");
  } finally {f.close();}
});

it.each(["expired", "cancelled"])("cancels review validation when the review is %s, returns no content and releases capacity", async ending => {
  const f = await repeatedReviewFixture();
  try {
    const held = Promise.withResolvers<AbortSignal>();
    let first = true;
    const validator = liveRestoreValidator((work, signal) => {
      if (!first) return Promise.resolve(runLiveRestoreWork(work, policy));
      first = false; held.resolve(signal!);
      // The first validation runs until its signal ends it.
      return new Promise<never>((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), {once: true}));
    });
    const driver = new LiveRestorePreparation({...preparationConfig(), maxEvents: 40}, validator), abort = new AbortController();
    const options = {store: f.store, lookup: f.lookup, deliveryKind: "owner" as const,
      connection: {client: {} as never, workspace: "native-workspace", host: f.lookup.host, deadlineMs: 60_000, nextRequestId: () => 1}};
    if (ending === "expired") vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
    try {
      const review = driver.review({...options, signal: abort.signal});
      const signal = await held.promise;
      if (ending === "expired") vi.advanceTimersByTime(60_000);
      else abort.abort(new Error("disconnected"));
      await expect(review).rejects.toThrow(ending === "expired" ? "Restore review expired." : "disconnected");
      expect(signal.aborted).toBe(true);
    } finally {vi.useRealTimers();}
    // Only one preparation fits, so a second review proves the first released its reservation.
    const lease = await driver.review(options);
    expect(lease.review!.proposalDigest).toBe(f.saved.proposalDigest);
    lease.close();
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

it("persists a generated owner rewrite with two retained native updates and refuses missing or changed pending bytes", async () => {
  const f = contentProposalFixture("owner", "device", true);
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined, closed = false;
  try {
    const before = proposalRows(f);
    expect(decodeNativeRestoreProposal(f.encoded, f.input).bytes.nativeSourceBytes).toEqual(f.bytes.nativeSourceBytes);
    const altered = f.bytes.nativeSourceBytes.map(bytes => bytes.slice());altered[0]![0] ^= 1;
    for (const nativeSourceBytes of [altered, [f.bytes.nativeSourceBytes[1]!, f.bytes.nativeSourceBytes[0]!]]) {
      const bad = encodeNativeRestoreProposal(JSON.stringify(f.receipt), {...f.bytes, nativeSourceBytes}, f.input);
      await expect(f.store.recordStopRestoreProposal(f.input, bad, restore, 200)).rejects.toThrow();
      expect(proposalRows(f)).toEqual(before);
    }
    const omitted = {...f.receipt, nativeSources: [], nativeSourceManifestDigest: jsonHash([f.receipt.fence, []])};
    const noNative = encodeNativeRestoreProposal(JSON.stringify(omitted), {...f.bytes, nativeSourceBytes: []}, f.input);
    await expect(f.store.recordStopRestoreProposal(f.input, noNative, restore, 200)).rejects.toThrow(/frozen context/);
    expect(proposalRows(f)).toEqual(before);
    const recorded = await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
    expect(recorded.replayed).toBe(false);
    expect((await f.store.readStopRestoreProposal(f.input, restore))!.receipt.nativeSources).toEqual(f.receipt.nativeSources);
    f.close();closed = true;
    reopened = openSyncRelayStorage(f.path);
    const store = reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace: "restore-test", reconciled: true}));
    expect((await store.readStopRestoreProposal(f.input, restore))!.bytes).toEqual(f.encoded);
    expect(await store.recordStopRestoreProposal(f.input, f.encoded, restore, 201)).toEqual({...recorded, replayed: true});
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
  "persists the generated %s proposal on %s and replays its bytes after relay restart", async (kind, mode) => {
    const f = contentProposalFixture(kind, mode);
    let reopened: ReturnType<typeof openSyncRelayStorage> | undefined, closed = false;
    try {
      expect(await f.store.readStopRestoreProposal(f.input, restore)).toBeNull();
      const before = proposalRows(f);
      const recorded = await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
      expect(recorded).toEqual({proposalDigest: hash(f.encoded), candidateDigest: hash(f.bytes.candidateBytes), recordedAtMs: 200, replayed: false});
      const after = proposalRows(f), row = after.proposals[0]!;
      expect(after.journal).toEqual(before.journal);
      expect(after.operations).toEqual(before.operations);
      expect(after.documents).toEqual(before.documents);
      expect(after.usage).toBe(Number(before.usage) + Number(row.accounted_bytes));
      expect(row.proposal_bytes).toEqual(f.encoded);
      expect(await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 1_000_000)).toEqual({...recorded, replayed: true});
      expect(proposalRows(f)).toEqual(after);
      const read = (await f.store.readStopRestoreProposal(f.input, restore))!;
      expect(read).toMatchObject({bytes: f.encoded, receipt: f.receipt, proposalDigest: recorded.proposalDigest, recordedAtMs: 200});
      read.bytes.fill(0);
      expect((await f.store.readStopRestoreProposal(f.input, restore))!.bytes).toEqual(f.encoded);
      f.close();closed = true;
      reopened = openSyncRelayStorage(f.path);
      const store = reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace: "restore-test", reconciled: true}));
      expect((await store.readStopRestoreProposal(f.input, restore))!.bytes).toEqual(f.encoded);
      expect(await store.recordStopRestoreProposal(f.input, f.encoded, restore, 999)).toEqual({...recorded, replayed: true});
      expect((reopened as StorageContext).db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage").get()!.usage_bytes).toBe(after.usage);
    } finally {if (!closed) f.close();reopened?.close();}
  });

it("charges the full framed proposal exactly once and refuses one byte beyond workspace quota", async () => {
  const f = contentProposalFixture();
  try {
    const digest = hash(f.encoded), candidate = hash(f.bytes.candidateBytes), at = 200;
    const charge = f.encoded.byteLength + Buffer.byteLength(JSON.stringify(["restore-test", "restore", "workspace", digest, candidate, at, Number.MAX_SAFE_INTEGER, "f".repeat(64)]));
    const before = proposalRows(f);
    f.context.options.workspaceQuotaBytes = Number(before.usage) + charge - 1;
    await expect(f.store.recordStopRestoreProposal(f.input, f.encoded, restore, at)).rejects.toThrow(/quota/);
    expect(proposalRows(f)).toEqual(before);
    f.context.options.workspaceQuotaBytes++;
    await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, at);
    expect(f.journalRows().usage).toBe(f.context.options.workspaceQuotaBytes);
    expect(f.raw.prepare(`SELECT accounted_bytes FROM ${proposalTable}`).get()!.accounted_bytes).toBe(charge);
    expect((await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 201)).replayed).toBe(true);
    expect(f.journalRows().usage).toBe(f.context.options.workspaceQuotaBytes);
  } finally {f.close();}
});

it.each(["before-insert", "after-insert", "ignored-insert", "ignored-usage", "failed-usage"])(
  "rolls back proposal and quota changes after %s", async boundary => {
    const f = contentProposalFixture();
    try {
      const usage = boundary.endsWith("usage"), timing = boundary === "after-insert" ? "AFTER" : "BEFORE";
      const action = boundary.startsWith("ignored") ? "IGNORE" : "ABORT,'injected proposal failure'";
      f.raw.exec(`CREATE TRIGGER reject_proposal ${timing} ${usage ? "UPDATE ON sync_relay_workspace_usage" : `INSERT ON ${proposalTable}`} BEGIN SELECT RAISE(${action}); END`);
      const before = proposalRows(f);
      await expect(f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200)).rejects.toThrow();
      expect(proposalRows(f)).toEqual(before);
      f.raw.exec("DROP TRIGGER reject_proposal");
      expect((await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200)).replayed).toBe(false);
    } finally {f.close();}
  });

it.each(["bytes", "proposal digest", "candidate digest", "charge", "recorded time", "same-width recorded time"])(
  "rejects corrupted stored proposal %s on read and replay without mutation", async damage => {
    const f = contentProposalFixture();
    try {
      await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
      if (damage === "bytes") {const bad = f.encoded.slice();bad[bad.length - 1] ^= 1;f.raw.prepare(`UPDATE ${proposalTable} SET proposal_bytes=?`).run(bad);}
      if (damage === "proposal digest") f.raw.prepare(`UPDATE ${proposalTable} SET proposal_sha256=?`).run("f".repeat(64));
      if (damage === "candidate digest") f.raw.prepare(`UPDATE ${proposalTable} SET candidate_sha256=?`).run("f".repeat(64));
      if (damage === "charge") f.raw.exec(`UPDATE ${proposalTable} SET accounted_bytes=accounted_bytes-1`);
      if (damage === "recorded time") f.raw.exec(`UPDATE ${proposalTable} SET recorded_at_ms=1000000`);
      if (damage === "same-width recorded time") f.raw.exec(`UPDATE ${proposalTable} SET recorded_at_ms=999`);
      const before = proposalRows(f);
      await expect(f.store.readStopRestoreProposal(f.input, restore)).rejects.toThrow();
      await expect(f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 201)).rejects.toThrow();
      expect(proposalRows(f)).toEqual(before);
    } finally {f.close();}
  });

it("captures restore proposal budgets once before validation and persistence", async () => {
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
    expect((await f.store.recordStopRestoreProposal(input, f.encoded, restore, 200)).replayed).toBe(false);
    expect(reads).toEqual(new Map([["maxBytes", 1], ["maxEvents", 1]]));
  } finally {f.close();}
});

it("refuses a second proposal for the operation and bounded or foreign reads without mutation", async () => {
  const f = contentProposalFixture();
  try {
    await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
    const before = proposalRows(f);
    const changed = encodeNativeRestoreProposal(JSON.stringify({...f.receipt, finalContentDigest: "e".repeat(64)}), f.bytes, f.input);
    await expect(f.store.recordStopRestoreProposal(f.input, changed, restore, 201)).rejects.toThrow();
    for (const patch of [{maxBytes: f.encoded.byteLength - 1}, {maxEvents: 1}, {ownerUserId: "foreign"},
      {workspaceId: "foreign"}, {host: {...f.input.host, connectionId: "foreign"}}]) {
      await expect(f.store.readStopRestoreProposal({...f.input, ...patch}, restore)).rejects.toThrow();
      await expect(f.store.recordStopRestoreProposal({...f.input, ...patch}, f.encoded, restore, 201)).rejects.toThrow();
    }
    expect(proposalRows(f)).toEqual(before);
  } finally {f.close();}
});

it("checks stored proposal length before materializing an oversized saved payload on read or replay", async () => {
  const f = contentProposalFixture();
  try {
    await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
    f.raw.prepare(`UPDATE ${proposalTable} SET proposal_bytes=zeroblob(?)`).run(f.input.maxBytes + 1);
    const before = proposalRows(f), prepare = vi.spyOn(f.context.db, "prepare");
    await expect(f.store.readStopRestoreProposal(f.input, restore)).rejects.toThrow(/bounds/);
    await expect(f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 201)).rejects.toThrow();
    const proposalReads = prepare.mock.calls.map(([sql]) => sql).filter(sql => sql.includes(`FROM ${proposalTable}`));
    expect(proposalReads).toHaveLength(2);
    expect(proposalReads.every(sql => sql.includes("length(proposal_bytes)"))).toBe(true);
    prepare.mockRestore();
    expect(proposalRows(f)).toEqual(before);
  } finally {vi.restoreAllMocks();f.close();}
});

it("rechecks closed admission inside the proposal write transaction and rolls back late authority drift", async () => {
  const f = contentProposalFixture();
  try {
    const before = proposalRows(f), transaction = f.context.tx.bind(f.context);
    vi.spyOn(f.context, "tx").mockImplementationOnce(run => transaction(() => {
      f.context.db.prepare("UPDATE sync_relay_live_documents SET admission_state='open'").run();
      return run();
    }));
    await expect(f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200)).rejects.toThrow();
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

it.each(["table", "index", "parent"])("rejects damaged proposal schema %s", async damage => {
  const f = contentProposalFixture();
  try {
    await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
    if (damage === "table") f.raw.exec(`DROP TABLE ${proposalTable}`);
    if (damage === "index") f.raw.exec(`CREATE INDEX unexpected_proposal ON ${proposalTable}(recorded_at_ms)`);
    if (damage === "parent") {
      f.raw.exec("PRAGMA foreign_keys=OFF");f.raw.exec(`UPDATE ${proposalTable} SET operation_id='missing'`);f.raw.exec("PRAGMA foreign_keys=ON");
    }
    expect(() => initializeLiveRestoreOperationSchema(f.context.db)).toThrow(/damaged/);
  } finally {f.close();}
});

it("workspace deletion removes the proposal and its usage row through existing cascades", async () => {
  const f = contentProposalFixture();
  try {
    await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
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
function readyNativeFence(kind: "bootstrap" | "owner", mode: "service" | "device", events: boolean | "native" | number = false, selectedPoint = false) {
  const f = fixture(kind, mode);
  if (kind === "owner") f.adopt();
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
    expect(f.receipt.operation.point).toEqual({journalCursor:operation.intent.restorePointCursor,receiptDigest:operation.intent.restorePointReceiptDigest});
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
  ["selected cursor", r => {r.operation.point.journalCursor++;}],
  ["selected receipt", r => {r.operation.point.receiptDigest = "f".repeat(64);}],
  ["old receipt without selected point", r => {delete (r.operation as Partial<typeof r.operation>).point;}],
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
    const proposed = await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
    const lifecycle = await f.store.admitStopRestoreProposal(f.input, proposed.proposalDigest, restore, 201);
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

it.each([["bootstrap","service"],["bootstrap","device"],["owner","device"]] as const)("admits and resumes one durable restore replacement for %s on %s",async (kind,mode)=>{
  const f=contentProposalFixture(kind,mode,kind==="owner");
  try {
    const proposed=await f.store.recordStopRestoreProposal(f.input,f.encoded,restore,200),before=f.journalRows();
    // Coverage window statements are cached per database, so the row bound lives in the cost test.
    const prepare=vi.spyOn(f.context.db,"prepare");
    const admitted=await f.store.admitStopRestoreProposal(f.input,proposed.proposalDigest,restore,201);
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
    expect(await f.store.admitStopRestoreProposal(f.input,proposed.proposalDigest,restore,205)).toEqual(admitted);
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
    expect(await f.store.admitStopRestoreProposal(f.input,proposed.proposalDigest,restore,210)).toEqual(resumed);
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

it("starts a fresh restore author window at the 960-identity checkpoint band", async () => {
  const f = contentProposalFixture("owner", "device", false, false, false, 960);
  try {
    const accepted = f.store.captureStopRestoreAcceptedCut(f.input);
    expect(accepted.checkpoint.cursor).toBe(960);
    expect(accepted.events).toEqual([]);
    const proposed = await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
    const admitted = await f.store.admitStopRestoreProposal(f.input, proposed.proposalDigest, restore, 201);
    expect(admitted.admitted.authorSnapshot).toEqual([]);
    expect(admitted.admitted.checkpointCoverage?.map(entry => entry.author)).toEqual([{kind: "unattributed"}]);
  } finally {f.close();}
});

async function admittedRestoreFixture(kind:"owner"|"bootstrap"="owner",pending: boolean | "deleted"=true) {
  const f=contentProposalFixture(kind,"device",pending),proposal=await f.store.recordStopRestoreProposal(f.input,f.encoded,restore,200);
  const admitted=await f.store.admitStopRestoreProposal(f.input,proposal.proposalDigest,restore,201);
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
  const f = await admittedRestoreFixture("owner", "deleted");
  try {
    f.complete();
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
      const saved = await f.store.recordStopRestoreProposal(input, second.encoded, restore, at + 3);
      if (round === rounds) return {...second, first: f, saved, reviewInput: {...input, maxOutputBytes: 1_000_000}};
      const admitted = await f.store.admitStopRestoreProposal(input, saved.proposalDigest, restore, at + 4);
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
    }
  } catch (error) {f.close(); throw error;}
}

it("parses the complete leased storage review through the desktop owner restore contract", async () => {
  const f = await repeatedReviewFixture(2);
  try {
    const before = lifecycleRows(f), driver = new LiveRestorePreparation({...preparationConfig(), maxEvents: 40}, restore);
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

it("reads the selected accepted edit time and author from authenticated storage into the desktop review", async () => {
  const f = contentProposalFixture("owner", "device", false, false, true);
  try {
    await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
    const input = {...f.input, maxOutputBytes: 1_000_000}, before = lifecycleRows(f);
    const review = OwnerRestoreReview.parse(await f.store.readStopRestoreReview(input, restore));
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
      await expect(f.store.readStopRestoreReview(input, restore)).rejects.toThrow();
      f.raw.prepare("UPDATE sync_relay_live_update_journal SET received_at_ms=?,principal_id=? WHERE journal_cursor=?")
        .run(saved.received_at_ms, saved.principal_id, f.intent.restorePointCursor);
      expect(OwnerRestoreReview.parse(await f.store.readStopRestoreReview(input, restore))).toEqual(review);
    }
  } finally {f.close();}
});

it.each(["complete", "missing-event", "missing-proposal", "wrong-proposal", "budget", "changed-after-review", "cancelled-after-review"])("confirms only an authenticated complete host restore review: %s", async state => {
  const f = await repeatedReviewFixture();
  try {
    const driver = new LiveRestorePreparation({...preparationConfig(), maxEvents: state === "budget" ? 3 : 40}, restore);
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
    const before = lifecycleRows(f), review = (await f.store.readStopRestoreReview(f.reviewInput, restore))!;
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
    const before = lifecycleRows(f), review = (await f.store.readStopRestoreReview(f.reviewInput, restore))!;
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
      await expect(f.store.readStopRestoreReview(input, restore)).rejects.toThrow();
      expect(lifecycleRows(f)).toEqual(before);
    } finally {f.close();}
  });

it("enforces complete serialized review output bytes and reports current native sources separately", async () => {
  const f = contentProposalFixture("owner", "device", true);
  try {
    await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
    const input = {...f.input, maxOutputBytes: 1_000_000};
    const review = (await f.store.readStopRestoreReview(input, restore))!;
    const outputBytes = Buffer.byteLength(JSON.stringify(review));
    expect(await f.store.readStopRestoreReview({...input, maxOutputBytes: outputBytes}, restore)).toEqual(review);
    await expect(f.store.readStopRestoreReview({...input, maxOutputBytes: outputBytes - 1}, restore)).rejects.toThrow("output budget");
    expect(review.nativeSources).toHaveLength(2);
    expect(review.nativeSources.every(source => source.occurrences[0]!.context === "current-fence")).toBe(true);
  } finally {f.close();}
});

it("associates an acknowledged native source with its single accepted delivery in the complete review", async () => {
  const f = contentProposalFixture("owner", "device", false, true);
  try {
    await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
    const review = (await f.store.readStopRestoreReview({...f.input, maxOutputBytes: 1_000_000}, restore))!;
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
    try {await expect(f.store.readStopRestoreReview({...f.reviewInput, maxBytes: 100_000}, restore)).rejects.toThrow("byte bounds");}
    finally {spy.mockRestore();}
  } finally {f.close();}
});

it.each(["none","all deleted","one deleted","manifest changed"])("keeps pending source attribution complete after restore: %s",async damage=>{
  const f=await admittedRestoreFixture(),doc=new Y.Doc({gc:false});
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
it("allows ordinary admission from a restored checkpoint with no pending source rows",async ()=>{
  const f=await admittedRestoreFixture("bootstrap",false),doc=new Y.Doc({gc:false});
  try{
    f.complete();Y.applyUpdate(doc,f.raw.prepare("SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE restore_operation_id=?").get(f.input.operationId)!.validation_checkpoint_bytes as Uint8Array);
    doc.getMap("frontmatter").set("after","restored");expect(f.storage.commitLiveUpdateJournal(f.journalCapture(Y.encodeStateAsUpdate(doc),"ordinary")).result.kind).toBe("accepted");
  }finally{doc.destroy();f.close();}
});
it.each(["application","settlement","resume"])("refuses changed %s evidence without advancing the restore or quota",async stage=>{
  const f=await admittedRestoreFixture();
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
it("funds all restore receipts before admission and keeps the journal unchanged on quota refusal",async ()=>{
  const f=contentProposalFixture();
  try{
    const proposal=await f.store.recordStopRestoreProposal(f.input,f.encoded,restore,200),before=lifecycleRows(f),original=f.context.options.workspaceQuotaBytes;
    f.context.options.workspaceQuotaBytes=Number(before.usage)+1;
    await expect(f.store.admitStopRestoreProposal(f.input,proposal.proposalDigest,restore,201)).rejects.toThrow(/quota/);expect(lifecycleRows(f)).toEqual(before);
    f.context.options.workspaceQuotaBytes=original;
    const admitted=await f.store.admitStopRestoreProposal(f.input,proposal.proposalDigest,restore,201);
    expect(admitted.phase).toBe("relay-admitted");
    expect(Number(f.raw.prepare("SELECT receipt_reservation_bytes FROM sync_relay_live_restore_lifecycles").get()!.receipt_reservation_bytes)).toBeGreaterThan(0);
  }finally{f.close();}
});
it.each(["admission","source","usage"])("rolls back the replacement journal and all metadata after ignored %s write",async boundary=>{
  const f=contentProposalFixture("owner","device",true);
  try{
    const proposal=await f.store.recordStopRestoreProposal(f.input,f.encoded,restore,200),table=boundary==="admission"?"sync_relay_live_restore_lifecycles":boundary==="source"?"sync_relay_live_restore_source_ranges":"sync_relay_workspace_usage";
    f.raw.exec(`CREATE TRIGGER ignore_restore BEFORE ${boundary==="usage"?"UPDATE":"INSERT"} ON ${table} BEGIN SELECT RAISE(IGNORE); END`);
    const before=lifecycleRows(f);
    await expect(f.store.admitStopRestoreProposal(f.input,proposal.proposalDigest,restore,201)).rejects.toThrow();expect(lifecycleRows(f)).toEqual(before);
  }finally{f.close();}
});
it.each(["application","settlement","resume"])("recovers the exact restore after relay restart before %s acknowledgement",async stage=>{
  const f=await admittedRestoreFixture();let reopened:ReturnType<typeof openSyncRelayStorage>|undefined,closed=false;
  try{
    if(stage!=="application")f.store.acknowledgeStopRestoreReplacement(f.input,f.application);
    if(stage==="resume")f.store.acknowledgeStopRestoreSettlement(f.input,f.settlement);
    f.close();closed=true;reopened=openSyncRelayStorage(f.path);
    const store=reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace:"restore-test",reconciled:true}));
    expect(f.complete(store).phase).toBe("resumed");expect(store.readStopRestoreLifecycle(f.input)!.resume).toEqual(f.resume);
  }finally{if(!closed)f.close();reopened?.close();}
});
it("retains original owner binding and operation history across a second stop",async ()=>{
  const f=await admittedRestoreFixture();
  try{
    f.complete();f.raw.exec("UPDATE sync_relay_share_grants SET status='active',generation=6,revoked_at_ms=NULL WHERE grant_id='grant'");
    const second={...f.intent,operationId:"second-restore",expectedFence:2,expectedGrantGeneration:6};
    const begun=beginStopRestore(f.context,second,300);expect(begun.previousOperationId).toBe(f.input.operationId);
    const lookup={...f.lookup,operationId:second.operationId};advanceStopRestoreFence(f.context,lookup,301);
    const before=lifecycleRows(f);
    expect((await f.store.admitStopRestoreProposal(f.input,f.proposal.proposalDigest,restore,302)).resume).toEqual(f.resume);
    expect(f.store.acknowledgeStopRestoreResume(f.input,f.resume).resume).toEqual(f.resume);expect(lifecycleRows(f)).toEqual(before);
    expect(f.raw.prepare("SELECT admission_state,restore_fence_generation FROM sync_relay_live_documents").get()).toMatchObject({admission_state:"closed",restore_fence_generation:3});
  }finally{f.close();}
});
it("workspace deletion cascades through admitted restore history",async ()=>{
  const f=await admittedRestoreFixture();
  try{
    f.complete();f.raw.exec("DELETE FROM sync_relay_workspaces WHERE workspace_id='workspace'");
    for(const table of ["sync_relay_live_restore_lifecycles","sync_relay_live_restore_source_ranges","sync_relay_live_restore_operations","sync_relay_live_update_journal"])
      expect(f.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0);
  }finally{f.close();}
});

it("hashes copied restore state before entering the SQLite writer",async ()=>{
  const f=contentProposalFixture("owner","device",true),prototype=Object.getPrototypeOf(createHash("sha256"));
  const update=prototype.update,tx=f.context.tx.bind(f.context);let writing=false;const hashed:Uint8Array[]=[];
  // The writer may hash stored evidence to compare it, never the state it admits.
  const hashSpy=vi.spyOn(prototype,"update").mockImplementation(function(this:unknown,...args:unknown[]){
    if(writing && args[0] instanceof Uint8Array)hashed.push(new Uint8Array(args[0]));
    return Reflect.apply(update,this,args);
  });
  const txSpy=vi.spyOn(f.context,"tx").mockImplementation(run=>tx(()=>{writing=true;try{return run();}finally{writing=false;}}));
  try{
    const proposal=await f.store.recordStopRestoreProposal(f.input,f.encoded,restore,200);
    expect((await f.store.admitStopRestoreProposal(f.input,proposal.proposalDigest,restore,201)).phase).toBe("relay-admitted");
    const admitted=f.raw.prepare("SELECT update_bytes,validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE restore_operation_id=?").get(f.input.operationId)!;
    for(const copied of [admitted.update_bytes,admitted.validation_checkpoint_bytes] as Uint8Array[])
      expect(hashed.some(bytes=>Buffer.compare(bytes,copied)===0)).toBe(false);
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

it("precharges retained restore evidence before materializing an oversized admission",async ()=>{
  const f=await admittedRestoreFixture();
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
it("rolls back admission one byte below its funded read budget and can retry to completion",async ()=>{
  const f=contentProposalFixture("owner","device",true),tx=f.context.tx.bind(f.context);
  try {
    const proposal=await f.store.recordStopRestoreProposal(f.input,f.encoded,restore,200),before=lifecycleRows(f);
    let required=0;
    const dryRun=vi.spyOn(f.context,"tx").mockImplementation(run=>tx(()=>{
      run();required=retainedLifecyclePayloadBytes(f.context.db,f.input.operationId);throw Error("measured rollback");
    }));
    try{await expect(f.store.admitStopRestoreProposal(f.input,proposal.proposalDigest,restore,201)).rejects.toThrow("measured rollback");}finally{dryRun.mockRestore();}
    expect(lifecycleRows(f)).toEqual(before);expect(required).toBeGreaterThan(f.encoded.length);
    let reachedAdmission=false;
    const observe=vi.spyOn(f.context,"tx").mockImplementation(run=>tx(()=>{try{return run();}catch(error){
      reachedAdmission=f.context.db.prepare("SELECT 1 FROM sync_relay_live_restore_lifecycles WHERE operation_id=?").get(f.input.operationId)!==undefined;throw error;
    }}));
    try{await expect(f.store.admitStopRestoreProposal({...f.input,maxBytes:required-1},proposal.proposalDigest,restore,201)).rejects.toThrow();}finally{observe.mockRestore();}
    expect(reachedAdmission).toBe(true);expect(lifecycleRows(f)).toEqual(before);
    const admitted=await f.store.admitStopRestoreProposal({...f.input,maxBytes:required},proposal.proposalDigest,restore,201);
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
it("charges operation payloads once when reading a resumed lifecycle at its exact byte budget",async ()=>{
  const f=await admittedRestoreFixture();try{
    f.complete();const required=retainedLifecyclePayloadBytes(f.context.db,f.input.operationId);
    expect(f.store.readStopRestoreLifecycle({...f.input,maxBytes:required})!.phase).toBe("resumed");
    expect(()=>f.store.readStopRestoreLifecycle({...f.input,maxBytes:required-1})).toThrow();
  }finally{f.close();}
});
it.each(["application","settlement","resume"])("keeps %s recoverable when configured evidence capacity is reduced",async stage=>{
  const f=await admittedRestoreFixture();try{
    if(stage!=="application")f.store.acknowledgeStopRestoreReplacement(f.input,f.application);
    if(stage==="resume")f.store.acknowledgeStopRestoreSettlement(f.input,f.settlement);
    const before=lifecycleRows(f),input={...f.input,maxBytes:retainedLifecyclePayloadBytes(f.context.db,f.input.operationId)-1};
    const call=(input:typeof f.input)=>stage==="application"?f.store.acknowledgeStopRestoreReplacement(input,f.application):
      stage==="settlement"?f.store.acknowledgeStopRestoreSettlement(input,f.settlement):f.store.acknowledgeStopRestoreResume(input,f.resume);
    expect(()=>call(input)).toThrow();expect(lifecycleRows(f)).toEqual(before);expect(()=>call(f.input)).not.toThrow();
    expect(f.complete().phase).toBe("resumed");
  }finally{f.close();}
});
it.each(["application","settlement","resume"])("rolls back %s if its retained budget becomes unreadable before commit",async stage=>{
  const f=await admittedRestoreFixture();try{
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
it.each(["proposal","admission"])("rejects a same-length source rewrite by another connection before %s writer entry",async stage=>{
  const f=contentProposalFixture("owner","device",true),tx=f.context.tx.bind(f.context);let changed:ReturnType<typeof lifecycleRows>|undefined;
  try {
    const proposal=stage==="admission"?await f.store.recordStopRestoreProposal(f.input,f.encoded,restore,200):null;
    const spy=vi.spyOn(f.context,"tx").mockImplementation(run=>{
      const row=f.raw.prepare("SELECT journal_cursor,update_bytes FROM sync_relay_live_update_journal ORDER BY journal_cursor LIMIT 1").get()!;
      const bytes=new Uint8Array(row.update_bytes as Uint8Array);bytes[bytes.length-1]^=1;
      f.raw.prepare("UPDATE sync_relay_live_update_journal SET update_bytes=? WHERE journal_cursor=?").run(bytes,row.journal_cursor);changed=lifecycleRows(f);
      return tx(run);
    });
    try{await expect(stage==="proposal"?f.store.recordStopRestoreProposal(f.input,f.encoded,restore,200):f.store.admitStopRestoreProposal(f.input,proposal!.proposalDigest,restore,201)).rejects.toThrow(/changed during validation/);}finally{spy.mockRestore();}
    expect(changed).toBeDefined();expect(lifecycleRows(f)).toEqual(changed);
  }finally{f.close();}
});
// Proposal writers may re-read and hash this restore's bounded evidence to prove it unchanged, and compare the stored proposal in SQL; ACKs read none.
it("keeps restore writers to one stored-proposal comparison and lifecycle ACKs free of journal blob reads, byte comparisons and byte hashes",async ()=>{
  const f=contentProposalFixture("owner","device",true),tx=f.context.tx.bind(f.context),prepare=f.context.db.prepare.bind(f.context.db),compare=Buffer.compare;
  const prototype=Object.getPrototypeOf(createHash("sha256")),update=prototype.update;let writing=false,acknowledging=false,compared=0;
  const txSpy=vi.spyOn(f.context,"tx").mockImplementation(run=>tx(()=>{writing=true;try{return run();}finally{writing=false;}}));
  const sqlSpy=vi.spyOn(f.context.db,"prepare").mockImplementation(sql=>{
    if(writing && acknowledging && /SELECT\s+\*\s+FROM sync_relay_live_update_journal\b/i.test(sql))throw Error("journal blobs in writer");
    if(writing && /SELECT\s+proposal_bytes=\? AS proposal_matches\b/.test(sql))compared++;
    else if(writing && /SELECT\s+proposal_bytes\b/i.test(sql))throw Error("proposal bytes in writer");
    return prepare(sql);
  });
  const compareSpy=vi.spyOn(Buffer,"compare").mockImplementation((a,b)=>{if(writing && acknowledging)throw Error("byte comparison in writer");return compare(a,b);});
  const hashSpy=vi.spyOn(prototype,"update").mockImplementation(function(this:unknown,...args:unknown[]){if(writing&&acknowledging&&typeof args[0]!=="string")throw Error("byte hash in writer");return Reflect.apply(update,this,args);});
  try {
    const proposal=await f.store.recordStopRestoreProposal(f.input,f.encoded,restore,200);
    expect((await f.store.recordStopRestoreProposal(f.input,f.encoded,restore,200)).replayed).toBe(true);
    const admitted=await f.store.admitStopRestoreProposal(f.input,proposal.proposalDigest,restore,201);acknowledging=true;
    expect(compared).toBe(1);
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


function restorePublication(f: Awaited<ReturnType<typeof admittedRestoreFixture>>, bytes: Uint8Array,
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
  const f = await admittedRestoreFixture(), doc = new Y.Doc({gc: false});
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
  const f = await admittedRestoreFixture();
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
  const f = await admittedRestoreFixture(), doc = new Y.Doc({gc: false});
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
