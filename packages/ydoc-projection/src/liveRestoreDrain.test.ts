import { createHash } from "node:crypto";
import { parseLiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import {
  maximumBindingBytes,
  nativeSettlementId,
  prepareHostedSettlements,
  restorePublicationReservation,
  settlementRecordDigest,
} from "../../../services/sync-relay/src/storage/hostedSettlement.js";
import {
  appendValidatedLiveJournal,
  readReplicaLiveJournal,
} from "../../../services/sync-relay/src/storage/liveUpdateJournal.js";

import { stableJsonStringify } from "../../../services/sync-relay/src/canonicalJson.js";
import { initialAcceptedHistoryDigest } from "../../../services/sync-relay/src/liveAcceptedHistory.js";
import { createLiveMarkdownRegistrationValidator } from "./liveDocumentValidation.js";
import { liveValidation } from "../../../services/sync-relay/src/liveValidation.js";
import { afterAll } from "vitest";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { WORKER_LIVE_VALIDATION_POLICY } from "./liveValidationPolicy.js";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";

import {
  policy,
  hash,
  cleanupLiveDeliveryFixtures,
  restore,
} from "./liveCommittedDeliveryTestSupport.js";
import { resolveLiveRestorePoint } from "./liveRestorePoint.js";
import { yDocToMarkdown } from "./import-export.js";
import { createLiveJournalHistoryAuthority } from "../../../services/sync-relay/src/storage/liveJournalHistory.js";
import {
  beginStopRestore,
  advanceStopRestoreFence,
  declineStopRestore,
  readStopRestore,
} from "../../../services/sync-relay/src/storage/liveRestoreOperation.js";
import type { StorageContext } from "../../../services/sync-relay/src/storage/context.js";

import type {
  NativeRestoreCancellationAnswer,
  NativeRestoreFenceReceipt,
} from "../../../services/sync-relay/src/liveRestoreFence.js";
import { createServiceHostFeed } from "../../../services/sync-relay/src/serviceHostFeed.js";
import { SERVICE_HOST_ORIGIN_PREFIX } from "../../../services/sync-relay/src/relayLogInputs.js";
import { openSyncRelayStorage } from "../../../services/sync-relay/src/storage.js";
import {
  parseNativeRestoreProposalReceipt,
  encodeNativeRestoreProposal,
  decodeNativeRestoreProposal,
} from "../../../services/sync-relay/src/liveRestoreProposal.js";
import {
  initializeLiveRestoreOperationSchema,
  LIVE_RESTORE_ACTIVE_V1_SQL,
  LIVE_RESTORE_LIFECYCLES_V1_SQL,
  LIVE_RESTORE_OPERATIONS_V1_SQL,
} from "../../../services/sync-relay/src/storage/liveRestoreOperationSchema.js";
import { readServiceActivationRetirement } from "../../../services/sync-relay/src/storage/serviceActivationRetirement.js";

import { createLiveMarkdownJournalValidator } from "./liveDocumentValidation.js";
import {
  LiveRestorePreparation,
  parseLiveRestoreConfig,
} from "../../../services/sync-relay/src/liveRestorePreparation.js";

import {
  liveRestoreValidator,
  runLiveRestoreWork,
  type LiveRestoreValidator,
} from "../../../services/sync-relay/src/liveRestoreValidation.js";

import { fixture, bootstrapAck, applicationAck } from "./liveRestoreFixture.integration-helper.js";

afterEach(cleanupLiveDeliveryFixtures);
const normalizeSettlement = createLiveMarkdownRegistrationValidator(WORKER_LIVE_VALIDATION_POLICY);
beforeEach(() => {
  vi.spyOn(liveValidation, "normalizeSettlement").mockImplementation(async (input) =>
    normalizeSettlement(input),
  );
});
const jsonHash = (value: unknown) => hash(Buffer.from(JSON.stringify(value)));
function proposalSourcesFixture(
  kind: "bootstrap" | "owner",
  mode: "service" | "device",
  acceptedNative = false,
  selectedPoint = false,
  authorBand = 0,
  beforeFence?: Parameters<typeof readyNativeFence>[4],
) {
  const f = readyNativeFence(
    kind,
    mode,
    authorBand || (acceptedNative ? "native" : true),
    selectedPoint,
    beforeFence,
  );
  return { ...f, ...proposalSources(f, kind, f.lookup, f.receipt, authorBand) };
}
function proposalSources(
  f: Pick<ReturnType<typeof readyNativeFence>, "store" | "raw">,
  kind: "bootstrap" | "owner",
  lookup: ReturnType<typeof readyNativeFence>["lookup"],
  fence: NativeRestoreFenceReceipt,
  authorBand = 0,
) {
  f.store.acknowledgeStopRestoreFence(lookup, fence);
  const input = {
    ...lookup,
    maxBytes: authorBand ? 10_000_000 : 1_000_000,
    maxEvents: authorBand ? 1000 : 10,
  };
  const selectedHistory = f.store.captureStopRestorePoint(input).proof;
  const acceptedHistory = f.store.captureStopRestoreAcceptedCut(input).proof;
  let origin: unknown;
  if (kind === "owner") {
    origin = f.store.captureStopRestoreOwnerOrigin(input).evidenceDigest;
  } else {
    const b = f.raw.prepare("SELECT * FROM sync_relay_live_delivery_bootstraps").get()!;
    origin = {
      bootstrapId: b.bootstrap_id,
      bootstrapMomentId: b.bootstrap_moment_id,
      baselineMomentRelaySequence: b.baseline_moment_relay_seq,
      baselineRegisteredAtMs: b.baseline_registered_at_ms,
      baselineDigest: b.baseline_digest,
      baselineByteLength: b.baseline_byte_length,
      projectedMarkdownDigest: b.projected_markdown_digest,
      projectedMarkdownByteLength: b.projected_markdown_byte_length,
    };
  }
  const receipt = {
    fence,
    point: resolveLiveRestorePoint(f.store.captureStopRestorePoint(input), policy),
    candidateDigest: "a".repeat(64),
    frozenStateDigest: "b".repeat(64),
    pointStateDigest: "c".repeat(64),
    finalContentDigest: "d".repeat(64),
    beforeStateVector: [0],
    afterStateVector: [0],
    replacementRanges: [{ clientId: 999, startClock: 0, endClock: 1 }],
    originEvidenceDigest: kind === "owner" ? String(origin) : jsonHash(origin),
    selectedHistory,
    acceptedHistory,
    nativeSources: [],
    nativeSourceManifestDigest: jsonHash([fence, []]),
  };
  return { input, proposal: receipt };
}

it("refuses restore proposal source substitution, omission, order and operation drift", () => {
  const f = proposalSourcesFixture("owner", "device");
  try {
    const mutations = [
      (r: typeof f.proposal) => {
        r.acceptedHistory.suffix.pop();
      },
      (r: typeof f.proposal) => {
        r.acceptedHistory.suffix.reverse();
      },
      (r: typeof f.proposal) => {
        Object.assign(r.acceptedHistory.suffix[0]!.accepted.authority, { principalId: "other" });
      },
      (r: typeof f.proposal) => {
        r.originEvidenceDigest = "f".repeat(64);
      },
      (r: typeof f.proposal) => {
        Object.assign(r.point, { journalCursor: 1 });
      },
      (r: typeof f.proposal) => {
        r.fence.operation.hostId = "other";
        r.nativeSourceManifestDigest = jsonHash([r.fence, []]);
      },
    ];
    for (const mutate of mutations) {
      const r = structuredClone(f.proposal);
      mutate(r);
      expect(() => f.store.captureStopRestoreProposal(f.input, JSON.stringify(r))).toThrow();
    }
    const capture = f.store.captureStopRestoreProposal(f.input, JSON.stringify(f.proposal));
    f.raw
      .prepare(
        "UPDATE sync_relay_live_update_journal SET received_at_ms=received_at_ms+1 WHERE journal_cursor=1",
      )
      .run();
    expect(() => capture.assertCurrent()).toThrow();
  } finally {
    f.close();
  }
});

const nativeAgent = { agentId: "owner-device", onBehalfOf: "owner", depth: 64 };
function pendingSource(
  binding: NativeRestoreFenceReceipt["operation"]["oldBinding"],
  bytes: Uint8Array,
  sequence: number,
) {
  const updateDigest = hash(bytes),
    outboxId = `owner-outbox-${hash(Buffer.from(`${binding.workspaceId}\0${JSON.stringify(binding)}\0${binding.lineageClaimId}`))}`;
  const source = {
    binding,
    adoptionId: "adoption",
    nativeSequence: sequence + 9,
    updateDigest,
    origin: {
      kind: "nativeUpdate",
      actorOriginId: "owner-device",
      actorKind: "agent",
      onBehalfOf: "owner",
      chainDepth: 64,
      recordedAtMs: 100,
    },
  };
  return {
    outboxId,
    outboxSequence: sequence,
    binding,
    appendKey: `adopted-local:${jsonHash(source)}`,
    deliveryId: `owner-delivery-${hash(Buffer.from(`${outboxId}\0${sequence}\0${updateDigest}`))}`,
    updateDigest,
    byteLength: bytes.byteLength,
    createdAtMs: 100,
    source,
    acceptedReceipt: null,
  };
}

function contentProposalFixture(
  kind: "bootstrap" | "owner" = "owner",
  mode: "service" | "device" = "device",
  pending: boolean | "deleted" = false,
  acceptedNative = false,
  selectedPoint = false,
  authorBand = 0,
  beforeFence?: Parameters<typeof readyNativeFence>[4],
) {
  return buildContentProposal(
    proposalSourcesFixture(kind, mode, acceptedNative, selectedPoint, authorBand, beforeFence),
    pending,
  );
}
function buildContentProposal<
  F extends Pick<
    ReturnType<typeof proposalSourcesFixture>,
    "store" | "input" | "document" | "receipt" | "proposal" | "close"
  > & { acceptedNative?: AcceptedNative },
>(f: F, pending: boolean | "deleted" = false) {
  const point = new Y.Doc({ gc: false }),
    head = new Y.Doc({ gc: false });
  try {
    const selected = f.store.captureStopRestorePoint(f.input),
      accepted = f.store.captureStopRestoreAcceptedCut(f.input);
    Y.applyUpdate(point, selected.checkpoint.bytes);
    for (const e of selected.events) Y.applyUpdate(point, e.updateBytes);
    Y.applyUpdate(head, accepted.checkpoint.bytes);
    for (const e of accepted.events) Y.applyUpdate(head, e.updateBytes);
    const nativeSourceBytes: Uint8Array[] = f.acceptedNative ? [f.acceptedNative.bytes] : [];
    if (pending) {
      for (const name of ["pending-one", "pending-two"]) {
        const before = Y.encodeStateVector(head);
        if (pending === "deleted" && name === "pending-two")
          head.getMap("frontmatter").delete("pending-one");
        else head.getMap("frontmatter").set(name, "retained owner work");
        nativeSourceBytes.push(Y.encodeStateAsUpdate(head, before));
      }
    }
    const nativeSources = nativeSourceBytes.map((bytes, index) =>
      index === 0 && f.acceptedNative
        ? f.acceptedNative.source
        : pendingSource(f.receipt.operation.oldBinding, bytes, index + 1),
    );
    const frozen = Y.encodeStateAsUpdate(head),
      pointBytes = Y.encodeStateAsUpdate(point),
      vector = Y.encodeStateVector(head);
    const used = Y.decodeStateVector(vector);
    let client = 1;
    while (used.has(client)) client++;
    head.clientID = client;
    head.transact(() => {
      const body = head.getXmlFragment("body");
      body.delete(0, body.length);
      body.insert(
        0,
        point
          .getXmlFragment("body")
          .toArray()
          .map((node) => {
            if (!(node instanceof Y.XmlElement || node instanceof Y.XmlText))
              throw Error("unexpected fixture body");
            return node.clone();
          }),
      );
      const fields = head.getMap("frontmatter");
      for (const key of fields.keys()) fields.delete(key);
      for (const [key, value] of point.getMap("frontmatter").entries())
        fields.set(key, structuredClone(value));
    });
    const candidate = Y.encodeStateAsUpdate(head, vector);
    const validated = createLiveMarkdownJournalValidator(policy)({
      document: f.document,
      currentPath: selected.binding.currentPath,
      checkpoint: frozen,
      suffix: [],
      candidate,
    });
    if (validated.kind !== "accepted") throw Error(validated.reason);
    const receipt = {
      ...f.proposal,
      candidateDigest: hash(candidate),
      frozenStateDigest: hash(frozen),
      pointStateDigest: hash(pointBytes),
      beforeStateVector: [...vector],
      afterStateVector: [...Y.encodeStateVector(head)],
      replacementRanges: [...validated.evidence.candidate.ranges],
      nativeSources,
      nativeSourceManifestDigest: jsonHash([f.receipt, nativeSources]),
    };
    const capture = f.store.captureStopRestoreProposal(f.input, JSON.stringify(receipt));
    const bytes = {
      candidateBytes: candidate,
      frozenStateBytes: frozen,
      pointStateBytes: pointBytes,
      nativeSourceBytes,
    };
    return {
      ...f,
      receipt,
      capture,
      bytes,
      encoded: encodeNativeRestoreProposal(JSON.stringify(receipt), bytes, f.input),
    };
  } catch (error) {
    f.close();
    throw error;
  } finally {
    point.destroy();
    head.destroy();
  }
}

const preparationConfig = () =>
  parseLiveRestoreConfig({
    maxBytes: 1_000_000,
    maxEvents: 10,
    aggregateBytes: 17_000_000,
    workingReserveBytes: 1_000_000,
    maxOperations: 1,
    validation: policy,
  })!;

it("holds restore preparation capacity across transport and releases it after cancellation or proof refusal", async () => {
  const f = contentProposalFixture();
  try {
    const prepare = new LiveRestorePreparation(preparationConfig(), restore),
      abort = new AbortController();
    let release!: (value: { response: { result: { status: string } }; bytes: Buffer }) => void;
    const pending = new Promise<{ response: { result: { status: string } }; bytes: Buffer }>(
      (resolve) => {
        release = resolve;
      },
    );
    let started!: () => void;
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sendLiveRestore = vi.fn(async () => {
      started();
      return pending;
    });
    const options = {
      store: f.store,
      lookup: f.lookup,
      deliveryKind: "owner" as const,
      connection: {
        client: { sendLiveRestore } as never,
        workspace: "native-workspace",
        host: f.lookup.host,
        deadlineMs: 1000,
        nextRequestId: () => 1,
      },
    };
    const first = prepare.prepare({ ...options, signal: abort.signal });
    await reached;
    await expect(prepare.prepare(options)).rejects.toThrow("capacity is full");
    abort.abort(new Error("caller retired"));
    release({ response: { result: { status: "prepared" } }, bytes: Buffer.from(f.encoded) });
    await expect(first).rejects.toThrow("caller retired");
    expect(await f.store.readStopRestoreProposal(f.input, restore)).toBeNull();
    sendLiveRestore.mockResolvedValueOnce({
      response: { result: { status: "prepared" } },
      bytes: Buffer.from([0]),
    });
    await expect(prepare.prepare(options)).rejects.toThrow();
    expect(await f.store.readStopRestoreProposal(f.input, restore)).toBeNull();
    await expect(prepare.prepare(options)).resolves.toMatchObject({
      kind: "prepared",
      replayed: false,
    });
  } finally {
    f.close();
  }
});

type ContentProposal = ReturnType<typeof contentProposalFixture>;
/** Validates in this process. Asks for each of `digests` first, then runs `change` during the final run. */
const validatingWhile = (change: () => void, digests: readonly string[] = []) =>
  liveRestoreValidator(async (work) => {
    const digest = digests.find((digest) => !work.answers.has(digest));
    if (digest !== undefined) return { kind: "needs-artifact", digest };
    change();
    return runLiveRestoreWork(work, policy);
  });
const artifactText = (name: string) => new TextEncoder().encode(`${name} artifact\n`);
const presentArtifact = artifactText("present"),
  absentArtifact = artifactText("absent");
const answeredArtifacts = [hash(presentArtifact), hash(absentArtifact)];
/** Adds `bytes` to the restored object's artifact history, below its current moment. */
function addArtifact(
  f: Pick<ContentProposal, "raw" | "document" | "capture">,
  bytes: Uint8Array,
  sequence: number,
) {
  f.raw
    .prepare(
      "INSERT OR IGNORE INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)",
    )
    .run(hash(bytes), bytes.length, bytes);
  f.raw
    .prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
    VALUES ('workspace',?,?,?,'main',?,?,'text',?,0)`)
    .run(
      f.document.objectId,
      sequence,
      `artifact-${sequence}`,
      f.capture.selected.binding.currentPath,
      hash(bytes),
      bytes.length,
    );
}

const evidenceChanges: readonly (readonly [
  string,
  () => ContentProposal,
  (f: ContentProposal) => void,
])[] = [
  [
    "operation row",
    () => contentProposalFixture(),
    (f) =>
      f.raw.exec(
        "UPDATE sync_relay_live_restore_operations SET native_receipt_json=json_set(native_receipt_json,'$.recordedAtMs',101)",
      ),
  ],
  [
    "fetched artifact membership",
    () => contentProposalFixture(),
    (f) => f.raw.exec("DELETE FROM sync_relay_object_moments WHERE relay_seq=0"),
  ],
];
it.each(evidenceChanges)(
  "refuses admission when its %s changes during validation",
  async (_name, make, change) => {
    const f = make();
    try {
      addArtifact(f, presentArtifact, 0);
      const recorded = await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
      const call = (validator: LiveRestoreValidator) =>
        f.store.admitStopRestoreProposal(f.input, recorded.proposalDigest, validator, 201);
      let changed: ReturnType<typeof proposalRows> | undefined;
      await expect(
        call(
          validatingWhile(() => {
            change(f);
            changed = proposalRows(f);
          }, answeredArtifacts),
        ),
      ).rejects.toThrow("Relay evidence changed during validation.");
      expect(changed).toBeDefined();
      expect(proposalRows(f)).toEqual(changed);
    } finally {
      f.close();
    }
  },
);

const proposalTable = "sync_relay_live_restore_proposals";
const proposalRows = (
  f: Pick<ReturnType<typeof contentProposalFixture>, "raw" | "journalRows">,
) => ({
  ...f.journalRows(),
  proposals: f.raw.prepare(`SELECT * FROM ${proposalTable}`).all(),
  operations: f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(),
  documents: f.raw.prepare("SELECT * FROM sync_relay_live_documents").all(),
});

it("persists a generated owner rewrite with two retained native updates and refuses missing or changed pending bytes", async () => {
  const f = contentProposalFixture("owner", "device", true);
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined,
    closed = false;
  try {
    const before = proposalRows(f);
    expect(decodeNativeRestoreProposal(f.encoded, f.input).bytes.nativeSourceBytes).toEqual(
      f.bytes.nativeSourceBytes,
    );
    const altered = f.bytes.nativeSourceBytes.map((bytes) => bytes.slice());
    altered[0]![0] ^= 1;
    for (const nativeSourceBytes of [
      altered,
      [f.bytes.nativeSourceBytes[1]!, f.bytes.nativeSourceBytes[0]!],
    ]) {
      const bad = encodeNativeRestoreProposal(
        JSON.stringify(f.receipt),
        { ...f.bytes, nativeSourceBytes },
        f.input,
      );
      await expect(f.store.recordStopRestoreProposal(f.input, bad, restore, 200)).rejects.toThrow();
      expect(proposalRows(f)).toEqual(before);
    }
    const omitted = {
      ...f.receipt,
      nativeSources: [],
      nativeSourceManifestDigest: jsonHash([f.receipt.fence, []]),
    };
    const noNative = encodeNativeRestoreProposal(
      JSON.stringify(omitted),
      { ...f.bytes, nativeSourceBytes: [] },
      f.input,
    );
    await expect(
      f.store.recordStopRestoreProposal(f.input, noNative, restore, 200),
    ).rejects.toThrow(/frozen context/);
    expect(proposalRows(f)).toEqual(before);
    const recorded = await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
    expect(recorded.replayed).toBe(false);
    expect(
      (await f.store.readStopRestoreProposal(f.input, restore))!.receipt.nativeSources,
    ).toEqual(f.receipt.nativeSources);
    f.close();
    closed = true;
    reopened = openSyncRelayStorage(f.path);
    const store = reopened.createLiveCommittedDeliveryStore(
      createLiveJournalHistoryAuthority({ namespace: "restore-test", reconciled: true }),
    );
    expect((await store.readStopRestoreProposal(f.input, restore))!.bytes).toEqual(f.encoded);
    expect(await store.recordStopRestoreProposal(f.input, f.encoded, restore, 201)).toEqual({
      ...recorded,
      replayed: true,
    });
  } finally {
    if (!closed) f.close();
    reopened?.close();
  }
});

it("frames exact byte views, snapshots caller storage, and refuses truncation, invalid UTF-8, trailing data and shared buffers", () => {
  const f = contentProposalFixture();
  try {
    const container = new Uint8Array(f.encoded.length + 2);
    container.set(f.encoded, 1);
    const view = container.subarray(1, -1),
      decoded = decodeNativeRestoreProposal(view, { ...f.input, maxBytes: view.length });
    expect(decoded.bytes).toEqual(f.bytes);
    expect(decoded.receipt).toEqual(f.receipt);
    container.fill(0);
    expect(decoded.captured).toEqual(f.encoded);
    for (const bad of [
      f.encoded.subarray(0, 3),
      f.encoded.subarray(0, f.encoded.length - 1),
      Uint8Array.from([...f.encoded, 0]),
      new Uint8Array(new SharedArrayBuffer(f.encoded.length)),
    ]) {
      expect(() => decodeNativeRestoreProposal(bad, f.input)).toThrow();
    }
    const utf8 = f.encoded.slice();
    utf8[4] = 255;
    expect(() => decodeNativeRestoreProposal(utf8, f.input)).toThrow();
    const length = f.encoded.slice();
    new DataView(length.buffer).setUint32(0, 0xffff_ffff, true);
    expect(() => decodeNativeRestoreProposal(length, f.input)).toThrow();
    expect(() =>
      decodeNativeRestoreProposal(f.encoded, { ...f.input, maxBytes: f.encoded.length - 1 }),
    ).toThrow();
    expect(() =>
      encodeNativeRestoreProposal(JSON.stringify(f.receipt), f.bytes, {
        ...f.input,
        maxBytes: f.encoded.length - 1,
      }),
    ).toThrow();
    expect(() =>
      encodeNativeRestoreProposal(
        JSON.stringify(f.receipt),
        { ...f.bytes, candidateBytes: new Uint8Array(new SharedArrayBuffer(2)) },
        f.input,
      ),
    ).toThrow();
    expect(() =>
      encodeNativeRestoreProposal(
        JSON.stringify(f.receipt),
        { ...f.bytes, nativeSourceBytes: [Uint8Array.of(0, 0)] },
        f.input,
      ),
    ).toThrow();
  } finally {
    f.close();
  }
});
it.each([
  { actorOriginId: "other-agent" },
  { chainDepth: 63 },
  { onBehalfOf: null },
  { actorKind: "human", chainDepth: 0, onBehalfOf: null },
])(
  "refuses an adopted native source whose accepted delivery declared other provenance: %j",
  (patch) => {
    const f = contentProposalFixture("owner", "device", false, true);
    try {
      const changed = structuredClone(f.receipt),
        native = changed.nativeSources[0]!;
      Object.assign(native.source.origin, patch);
      native.appendKey = `adopted-local:${jsonHash(native.source)}`;
      changed.nativeSourceManifestDigest = jsonHash([changed.fence, changed.nativeSources]);
      // The source parses on its own; its accepted copy declared the fixture's agent.
      parseNativeRestoreProposalReceipt(JSON.stringify(changed), f.input);
      expect(() => f.store.captureStopRestoreProposal(f.input, JSON.stringify(changed))).toThrow();
      expect(() =>
        f.store.captureStopRestoreProposal(f.input, JSON.stringify(f.receipt)),
      ).not.toThrow();
    } finally {
      f.close();
    }
  },
);

it("authenticates an enrolled owner draft's identity and declaration without a native sequence", () => {
  const f = proposalSourcesFixture("bootstrap", "service");
  try {
    const binding = f.proposal.fence.operation.oldBinding,
      updateDigest = "e".repeat(64);
    const outboxId = `owner-outbox-${hash(Buffer.from(`${binding.workspaceId}\0${JSON.stringify(binding)}\0${binding.lineageClaimId}`))}`;
    const draft = (origin: Record<string, unknown>, sequence = 1) => ({
      outboxId,
      outboxSequence: sequence,
      binding,
      appendKey: `editor-draft-${sequence}`,
      deliveryId: `owner-delivery-${hash(Buffer.from(`${outboxId}\0${sequence}\0${updateDigest}`))}`,
      updateDigest,
      byteLength: 2,
      createdAtMs: 100,
      source: { binding, updateDigest, origin },
      acceptedReceipt: null,
    });
    const receipt = (sources: unknown[]) =>
      JSON.stringify({
        ...f.proposal,
        nativeSources: sources,
        nativeSourceManifestDigest: jsonHash([f.proposal.fence, sources]),
      });
    const agentDeclaration = { agentId: "trip-agent-ü", onBehalfOf: null, depth: 0 };
    const parsed = parseNativeRestoreProposalReceipt(
      receipt([draft({ kind: "ownerDraft", agentDeclaration }), draft({ kind: "ownerDraft" }, 2)]),
      f.input,
    );
    expect(parsed.nativeSources.map((source) => source.source)).toEqual([
      { binding, updateDigest, origin: { kind: "ownerDraft", agentDeclaration } },
      { binding, updateDigest, origin: { kind: "ownerDraft" } },
    ]);
    expect(parsed.nativeSources.map((source) => source.appendKey)).toEqual([
      "editor-draft-1",
      "editor-draft-2",
    ]);
    for (const origin of [
      { kind: "ownerDraft", agentDeclaration: null },
      { kind: "ownerDraft", agentDeclaration: { ...agentDeclaration, depth: 65 } },
      { kind: "ownerDraft", nativeSequence: 1 },
      { kind: "nativeUpdate" },
    ]) {
      expect(() => parseNativeRestoreProposalReceipt(receipt([draft(origin)]), f.input)).toThrow();
    }
    // A draft cannot carry an invented native coordinate, and one queue holds one source kind.
    const invented = {
      ...draft({ kind: "ownerDraft" }),
      source: { binding, updateDigest, nativeSequence: 9, origin: { kind: "ownerDraft" } },
    };
    expect(() => parseNativeRestoreProposalReceipt(receipt([invented]), f.input)).toThrow();
    const otherBinding = {
      ...draft({ kind: "ownerDraft" }),
      source: {
        binding: { ...binding, currentPath: "docs/other.md" },
        updateDigest,
        origin: { kind: "ownerDraft" },
      },
    };
    expect(() => parseNativeRestoreProposalReceipt(receipt([otherBinding]), f.input)).toThrow();
  } finally {
    f.close();
  }
});

it.each(["device"] as const)(
  "drains exact original bytes after fencing %s and retires all apply captures",
  (mode) => {
    const f = fixture("bootstrap", mode);
    try {
      const one = f.add("one"),
        two = f.add("two"),
        original = f.journalRows().journal;
      const ordinary = f.store.open({ host: f.coordinate, document: f.document });
      f.fence();
      expect(() => f.store.next(ordinary)).toThrow();
      expect(() => f.store.open({ host: f.coordinate, document: f.document })).toThrow();
      const capture = f.open(),
        stale = f.open();
      expect(() => f.store.completeStopRestoreCut(capture)).toThrow();
      const first = f.store.nextStopRestoreCut(capture);
      expect(first.kind).toBe("bootstrap");
      if (first.kind !== "bootstrap") throw Error();
      f.store.acknowledgeStopRestoreBootstrap(capture, bootstrapAck(first.baseline));
      for (const [index, receipt] of [one, two].entries()) {
        const step = f.store.nextStopRestoreCut(capture);
        expect(step.kind).toBe("next");
        if (step.kind !== "next") throw Error();
        expect(step.admitted.metadata.accepted.receipt).toEqual(receipt);
        expect(step.admitted.updateBytes).toEqual(original[index]!.update_bytes);
        expect(() =>
          f.store.acknowledgeStopRestoreApplication(capture, step.predecessor, {
            ...applicationAck(receipt),
            updateDigest: "f".repeat(64),
          }),
        ).toThrow();
        f.store.acknowledgeStopRestoreApplication(
          capture,
          step.predecessor,
          applicationAck(receipt, index + 1),
        );
        f.store.acknowledgeStopRestoreApplication(
          capture,
          step.predecessor,
          applicationAck(receipt, index + 1),
        );
      }
      const usage = f.journalRows().usage,
        completed = f.store.completeStopRestoreCut(capture);
      expect(completed).toMatchObject({ kind: "bootstrap", terminal: two, localYDocSequence: 2 });
      expect(f.store.completeStopRestoreCut(capture)).toEqual(completed);
      expect(f.store.openStopRestoreCut(f.lookup)).toEqual({
        kind: "complete",
        receipt: completed,
      });
      expect(() => f.store.nextStopRestoreCut(stale)).toThrow();
      expect(() =>
        f.store.acknowledgeStopRestoreApplication(capture, one, applicationAck(two, 2)),
      ).toThrow();
      expect(f.journalRows().usage).toBe(usage);
      expect(f.journalRows().journal).toEqual(original);
      expect(readStopRestore(f.context, f.lookup)?.phase).toBe("old-cut-applied");
    } finally {
      f.close();
    }
  },
);

it("uses existing owner progress and never bootstraps over its document", () => {
  const f = fixture("owner");
  try {
    f.adopt();
    const one = f.add("one"),
      two = f.add("two");
    const ordinary = f.store.openOwnerDelivery({
      host: f.coordinate,
      document: f.document,
      actor: f.actor,
    });
    f.store.acknowledgeOwnerDeliveryApplication(ordinary, applicationAck(one, 1));
    f.fence();
    expect(() => f.store.nextOwnerApplication(ordinary)).toThrow();
    const capture = f.open(),
      step = f.store.nextStopRestoreCut(capture);
    expect(step.kind).toBe("next");
    if (step.kind !== "next") throw Error();
    expect(step.predecessor).toEqual(one);
    expect(step.admitted.metadata.accepted.receipt).toEqual(two);
    f.store.acknowledgeStopRestoreApplication(capture, one, applicationAck(two, 2));
    expect(f.store.completeStopRestoreCut(capture)).toMatchObject({
      kind: "owner",
      sourceId: "adoption",
      terminal: two,
    });
    expect(
      f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_delivery_bootstraps").get()!.n,
    ).toBe(0);
  } finally {
    f.close();
  }
});

it.each([false, true])(
  "refuses a changed owner binding record before allocating the fence, changed=%s",
  (changed) => {
    const f = fixture("owner");
    try {
      f.adopt();
      beginStopRestore(f.context, f.intent, 40);
      if (changed) {
        const origin = JSON.parse(
          String(
            f.raw.prepare("SELECT origin_json FROM sync_relay_live_delivery_owners").get()!
              .origin_json,
          ),
        );
        const binding = parseLiveObjectBinding({
          ...origin.originalBinding,
          selectorPaths: ["docs"],
        });
        f.raw.prepare("UPDATE sync_relay_live_delivery_owners SET origin_json=?").run(
          JSON.stringify({
            ...origin,
            originalBinding: binding,
            bindingDigest: createHash("sha256").update(JSON.stringify(binding)).digest("hex"),
          }),
        );
        expect(() => advanceStopRestoreFence(f.context, f.lookup, 50)).toThrow();
      } else advanceStopRestoreFence(f.context, f.lookup, 50);
      expect(
        f.raw.prepare("SELECT restore_fence_generation FROM sync_relay_live_documents").get(),
      ).toEqual({ restore_fence_generation: changed ? 1 : 2 });
    } finally {
      f.close();
    }
  },
);

it.each(["owner", "host"])("refuses %s drift before allocating the fence", (damage) => {
  const f = fixture();
  try {
    beginStopRestore(f.context, f.intent, 40);
    const sql = {
      owner: "UPDATE sync_relay_workspaces SET owner_user_id='other'",
      baseline:
        "UPDATE sync_relay_live_documents SET baseline_projected_sha256='" + "f".repeat(64) + "'",
      registration: "UPDATE sync_relay_live_documents SET registered_at_ms=11",
      host: "UPDATE sync_relay_session_host_control SET configured_host_id='other'",
      path: "UPDATE sync_relay_live_documents SET current_path='docs/renamed.md'",
    }[damage]!;
    f.raw.exec(sql);
    expect(() => advanceStopRestoreFence(f.context, f.lookup, 50)).toThrow();
    expect(
      f.raw
        .prepare("SELECT admission_state,restore_fence_generation FROM sync_relay_live_documents")
        .get(),
    ).toMatchObject({ admission_state: "open", restore_fence_generation: 1 });
  } finally {
    f.close();
  }
});

it.each(["owner"] as const)(
  "resumes %s after relay ACK with lost reply and completion reopen",
  (kind) => {
    const f = fixture(kind);
    let reopened: ReturnType<typeof openSyncRelayStorage> | undefined;
    let closed = false;
    try {
      if (kind === "owner") f.adopt();
      const terminal = f.add("one");
      f.fence();
      const capture = f.open();
      const first = f.store.nextStopRestoreCut(capture);
      if (first.kind === "bootstrap")
        f.store.acknowledgeStopRestoreBootstrap(capture, bootstrapAck(first.baseline));
      f.store.acknowledgeStopRestoreApplication(capture, null, applicationAck(terminal, 1));
      f.close();
      closed = true;
      const connect = () => {
        reopened = openSyncRelayStorage(f.path);
        return reopened.createLiveCommittedDeliveryStore(
          createLiveJournalHistoryAuthority({ namespace: "restore-test", reconciled: true }),
        );
      };
      let store = connect(),
        opened = store.openStopRestoreCut(f.lookup);
      if (opened.kind !== "ready") throw Error(opened.kind);
      expect(store.nextStopRestoreCut(opened.capture)).toMatchObject({
        kind: "done",
        terminalReceipt: terminal,
      });
      const completed = store.completeStopRestoreCut(opened.capture);
      reopened!.close();
      reopened = undefined;
      store = connect();
      expect(store.openStopRestoreCut(f.lookup)).toEqual({ kind: "complete", receipt: completed });
      expect(() => store.openStopRestoreCut({ ...f.lookup, ownerUserId: "other" })).toThrow();
    } finally {
      if (!closed) f.close();
      reopened?.close();
    }
  },
);

type AcceptedNative = {
  bytes: Uint8Array;
  source: Omit<ReturnType<typeof pendingSource>, "acceptedReceipt"> & {
    acceptedReceipt: ReturnType<ReturnType<typeof fixture>["add"]>;
  };
};
function seedOwnerApplicationPrefix(
  f: ReturnType<typeof fixture>,
  terminal: ReturnType<ReturnType<typeof fixture>["add"]>,
  count: number,
) {
  const where =
    "workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND host_id=?";
  const params = [
    f.document.workspaceId,
    f.document.mainVersionId,
    f.document.objectId,
    f.document.lineageClaimId,
    f.coordinate.hostId,
  ];
  const owner = f.context.db
    .prepare(
      `SELECT * FROM sync_relay_live_delivery_owners WHERE relay_database_namespace=? AND ${where}`,
    )
    .get("restore-test", ...params)!;
  const tip = JSON.stringify(terminal),
    sequence = 9,
    applicationSequence = count === 1 ? 9 : 2;
  const charge = Buffer.byteLength(
    JSON.stringify([
      "restore-test",
      ...params,
      owner.origin_json,
      tip,
      terminal.journalCursor,
      sequence,
      applicationSequence,
    ]),
  );
  const reserved = f.context.db
    .prepare(`SELECT COUNT(*) AS count, SUM(reserved_bytes + accounted_bytes) AS bytes
    FROM sync_relay_live_delivery_reservations WHERE ${where} AND journal_cursor>0 AND journal_cursor<=?`)
    .get(...params, terminal.journalCursor)!;
  expect(reserved.count).toBe(count);
  const refund = Number(reserved.bytes) + Number(owner.accounted_bytes) - charge;
  expect(
    f.context.db
      .prepare(`UPDATE sync_relay_live_delivery_owners
    SET tip_receipt_json=?,tip_cursor=?,tip_sequence=?,tip_application_sequence=?,accounted_bytes=? WHERE relay_database_namespace=? AND ${where}`)
      .run(
        tip,
        terminal.journalCursor,
        sequence,
        applicationSequence,
        charge,
        "restore-test",
        ...params,
      ).changes,
  ).toBe(1);
  expect(
    f.context.db
      .prepare(
        `DELETE FROM sync_relay_live_delivery_reservations WHERE ${where} AND journal_cursor>0 AND journal_cursor<=?`,
      )
      .run(...params, terminal.journalCursor).changes,
  ).toBe(count);
  expect(
    f.context.db
      .prepare(
        "UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-? WHERE workspace_id=? AND usage_bytes>=?",
      )
      .run(refund, f.document.workspaceId, refund).changes,
  ).toBe(1);
}
function readyNativeFence(
  kind: "bootstrap" | "owner",
  mode: "service" | "device",
  events: boolean | "native" | number = false,
  selectedPoint = false,
  beforeFence?: (f: ReturnType<typeof fixture>) => void,
) {
  const f = fixture(kind, mode);
  if (kind === "owner") {
    beforeFence?.(f);
    f.adopt();
  }
  let acceptedNative: AcceptedNative | undefined;
  let seededPredecessor: ReturnType<typeof f.add> | null = null;
  const receipts: ReturnType<typeof f.add>[] = [];
  if (typeof events === "number") {
    const head = new Y.Doc();
    try {
      Y.applyUpdate(head, f.input.baselineBytes);
      const current = f.storage.resolveCurrentLiveDocumentBinding({
        document: f.document,
        actor: f.actor,
      });
      if (current.kind !== "current") throw Error(current.kind);
      let priorMetadata: Parameters<typeof appendValidatedLiveJournal>[1]["priorMetadata"] = null;
      // Seed the valid prefix once; the band-crossing frame uses ordinary admission.
      f.context.tx(() => {
        for (let index = 0; index < events - 1; index++) {
          head.clientID = index + 1;
          const vector = Y.encodeStateVector(head);
          head.getMap("frontmatter").set(`band-${index}`, "named edit");
          const updateBytes = Y.encodeStateAsUpdate(head, vector);
          const row = appendValidatedLiveJournal(f.context, {
            document: f.document,
            namespace: "restore-test",
            host: f.coordinate,
            current,
            metadata: { deliveryId: `band-${index}`, updateDigest: hash(updateBytes) },
            updateBytes,
            receivedAtMs: 30,
            firstSeen: [{ clientId: index + 1, startClock: 0, endClock: 1 }],
            firstSeenDeletes: [],
            authorSnapshot: [
              {
                kind: "automation",
                automationId: `a${index}`,
                attribution: { actorKind: "automation", depth: 0 },
              },
            ],
            checkpointBytes: null,
            checkpointDigest: null,
            priorMetadata,
          });
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
        const result = f.storage.commitLiveUpdateJournal({
          ...capture,
          validation: {
            ...capture.validation,
            evidence: { ...capture.validation.evidence, stateUpdate: Y.encodeStateAsUpdate(head) },
          },
          trustedAutomation: {
            automationId: `a${index}`,
            attribution: { actorKind: "automation", depth: 0 },
          },
        });
        if (result.result.kind !== "accepted") throw Error(JSON.stringify(result.result));
        receipts.push(result.result.receipt);
        if (index === 959) {
          expect(result.admitted!.metadata.checkpointCoverage).toHaveLength(960);
          expect(
            result.admitted!.metadata.checkpointCoverage!.some(
              (entry) => entry.author.kind === "unattributed",
            ),
          ).toBe(false);
        }
      }
    } catch (error) {
      f.close();
      throw error;
    } finally {
      head.destroy();
    }
  } else if (events === "native") {
    const current = f.storage.resolveCurrentLiveDocumentBinding({
      document: f.document,
      actor: f.actor,
    });
    if (current.kind !== "current") throw Error(current.kind);
    const bytes = f.update("first", "first"),
      source = pendingSource(current.binding, bytes, 1);
    // The owner's delivery of that update declares the agent its attribution names.
    const capture = f.journalCapture(bytes, source.deliveryId);
    const accountId = capture.expectedAuthority.principalId;
    const committed = f.storage.commitLiveUpdateJournal({
      ...capture,
      trustedAccount: { accountId, name: accountId },
      metadata: {
        ...capture.metadata,
        authorContext: {
          kind: "account",
          accountId,
          agent: {
            agentId: nativeAgent.agentId,
            ...(nativeAgent.onBehalfOf !== null ? { onBehalfOf: nativeAgent.onBehalfOf } : {}),
            depth: nativeAgent.depth,
          },
        },
      },
    }).result;
    if (committed.kind !== "accepted") throw Error(committed.kind);
    receipts.push(committed.receipt);
    acceptedNative = { bytes, source: { ...source, acceptedReceipt: committed.receipt } };
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
    f.store.acknowledgeStopRestoreApplication(
      capture,
      receipts[index - 1] ?? seededPredecessor,
      applicationAck(receipt, index === 0 && !seededPredecessor ? 9 : 2),
    );
  }
  f.store.completeStopRestoreCut(capture);
  const operation = f.store.pendingStopRestoreFence(f.lookup).operation;
  const receipt: NativeRestoreFenceReceipt = {
    operation,
    localHeadSequence: 11,
    recordedAtMs: 100,
  };
  return { ...f, capture, receipt, acceptedNative };
}

function ownerOriginProofFixture(mode: "service" | "device" = "device") {
  const f = fixture("owner", mode);
  const point = f.add("point"),
    adoptedTip = f.add("adopted-tip");
  const original = f.store.captureOwnerCut({
    host: f.coordinate,
    document: f.document,
    actor: f.actor,
    adoptionId: "adoption",
    expectedLocalSequence: 7,
    maxBytes: 1_000_000,
    maxEvents: 10,
  });
  f.store.acknowledgeOwnerAdoption(original, {
    adoptionId: "adoption",
    localYDocSequence: 7,
    terminalCursor: adoptedTip.journalCursor,
    adoptionReplayed: false,
  });
  const later = f.add("after-adoption");
  f.intent.restorePointCursor = point.journalCursor;
  f.intent.restorePointReceiptDigest = point.updateDigest;
  f.fence();
  const drain = f.open();
  f.store.acknowledgeStopRestoreApplication(drain, adoptedTip, applicationAck(later, 8));
  f.store.completeStopRestoreCut(drain);
  const nativeReceipt = {
    operation: f.store.pendingStopRestoreFence(f.lookup).operation,
    localHeadSequence: 11,
    recordedAtMs: 100,
  };
  const input = { ...f.lookup, maxBytes: 1_000_000, maxEvents: 10 };
  return {
    ...f,
    original: structuredClone({ binding: original.binding, cut: original.cut }),
    nativeReceipt,
    input,
  };
}

it.each(["device"] as readonly ("service" | "device")[])(
  "captures the frozen accepted %s cut separately from the chosen restore point",
  (mode) => {
    const f = ownerOriginProofFixture(mode);
    try {
      expect(() => f.store.captureStopRestoreAcceptedCut(f.input)).toThrow();
      f.store.acknowledgeStopRestoreFence(f.lookup, f.nativeReceipt);
      const before = f.journalRows();
      const selected = f.store.captureStopRestorePoint(f.input);
      const accepted = f.store.captureStopRestoreAcceptedCut(f.input);
      expect(selected.events).toHaveLength(1);
      expect(accepted.events).toHaveLength(3);
      expect(accepted.point).toEqual({
        journalCursor: f.nativeReceipt.operation.terminal!.journalCursor,
        receiptDigest: f.nativeReceipt.operation.terminal!.updateDigest,
      });
      expect(accepted.target).toBe("accepted");
      expect(selected.target).toBe("selected");
      expect(() => resolveLiveRestorePoint(accepted as never, policy)).toThrow("selected history");
      const scratch = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(scratch, accepted.checkpoint.bytes);
        for (const event of accepted.events) Y.applyUpdate(scratch, event.updateBytes);
        expect(yDocToMarkdown(scratch)).toBe(yDocToMarkdown(f.doc));
      } finally {
        scratch.destroy();
      }
      expect(f.journalRows()).toEqual(before);
      expect(() => f.store.captureStopRestoreAcceptedCut({ ...f.input, maxEvents: 2 })).toThrow(
        /bounds/,
      );
      accepted.events[0]!.updateBytes[0] ^= 1;
      expect(() => accepted.assertCurrent()).toThrow();
    } finally {
      f.close();
    }
  },
);

it("retires both captured proofs when relay durability becomes unavailable while SQLite stays open", () => {
  const f = ownerOriginProofFixture();
  try {
    f.store.acknowledgeStopRestoreFence(f.lookup, f.nativeReceipt);
    const proofs = [
      f.store.captureStopRestoreOwnerOrigin(f.input),
      f.store.captureStopRestorePoint(f.input),
    ];
    // Losing the transaction before COMMIT makes the real write owner invalidate its standing.
    expect(() => f.context.tx(() => f.context.db.exec("ROLLBACK"))).toThrow();
    expect(f.context.db.prepare("SELECT 1 AS alive").get()).toEqual({ alive: 1 });
    expect(() => f.context.captureStanding()).toThrow("Relay storage is unavailable");
    for (const proof of proofs)
      expect(() => proof.assertCurrent()).toThrow("Relay storage is unavailable");
  } finally {
    f.close();
  }
});

const corruptNativeReceipts: [string, (receipt: NativeRestoreFenceReceipt) => void][] = [
  [
    "selected cursor",
    (r) => {
      r.operation.point.journalCursor++;
    },
  ],
  [
    "selected receipt",
    (r) => {
      r.operation.point.receiptDigest = "f".repeat(64);
    },
  ],
  [
    "old receipt without selected point",
    (r) => {
      delete (r.operation as Partial<typeof r.operation>).point;
    },
  ],
  [
    "operation ID",
    (r) => {
      r.operation.operationId = "other";
    },
  ],
  [
    "namespace",
    (r) => {
      r.operation.relayDatabaseNamespace = "other";
    },
  ],
  [
    "workspace",
    (r) => {
      r.operation.oldBinding = { ...r.operation.oldBinding, workspaceId: "other" };
    },
  ],
  [
    "version",
    (r) => {
      r.operation.oldBinding = { ...r.operation.oldBinding, mainVersionId: "other" };
    },
  ],
  [
    "object",
    (r) => {
      r.operation.oldBinding = { ...r.operation.oldBinding, objectId: "other" };
    },
  ],
  [
    "lineage",
    (r) => {
      r.operation.oldBinding = { ...r.operation.oldBinding, lineageClaimId: "f".repeat(64) };
    },
  ],
  [
    "path",
    (r) => {
      r.operation.oldBinding = { ...r.operation.oldBinding, currentPath: "docs/other.md" };
    },
  ],
  [
    "selector",
    (r) => {
      r.operation.oldBinding = { ...r.operation.oldBinding, selectorPaths: ["docs/other.md"] };
    },
  ],
  [
    "host",
    (r) => {
      r.operation.hostId = "other";
    },
  ],
  [
    "fence",
    (r) => {
      r.operation.newFence++;
    },
  ],
  [
    "origin kind",
    (r) => {
      r.operation.origin.kind = "owner";
    },
  ],
  [
    "origin ID",
    (r) => {
      r.operation.origin.id = "other";
    },
  ],
  [
    "terminal",
    (r) => {
      r.operation.terminal = {
        deliveryId: "other",
        updateDigest: "f".repeat(64),
        journalCursor: 1,
        acceptingHostEpoch: parseHostEpoch(1),
      };
    },
  ],
  [
    "exact sequence",
    (r) => {
      r.operation.appliedSequence = 1;
    },
  ],
  [
    "head sequence",
    (r) => {
      r.localHeadSequence = -1;
    },
  ],
  [
    "recorded time",
    (r) => {
      r.recordedAtMs = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
];
it("refuses changed native receipts without phase, receipt, or quota mutation", () => {
  const f = readyNativeFence("bootstrap", "device");
  try {
    const before = f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(),
      usage = f.journalRows().usage;
    for (const [name, corrupt] of corruptNativeReceipts) {
      const changed = structuredClone(f.receipt);
      corrupt(changed);
      expect(() => f.store.acknowledgeStopRestoreFence(f.lookup, changed), name).toThrow();
      expect(f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(), name).toEqual(
        before,
      );
      expect(f.journalRows().usage, name).toBe(usage);
    }
  } finally {
    f.close();
  }
});

it.each([
  ["bootstrap", "service"],
  ["owner", "device"],
] as const)(
  "admits and resumes one durable restore replacement for %s on %s",
  async (kind, mode) => {
    const f = contentProposalFixture(kind, mode, kind === "owner");
    try {
      const proposed = await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200),
        before = f.journalRows();
      // Coverage window statements are cached per database, so the row bound lives in the cost test.
      const prepare = vi.spyOn(f.context.db, "prepare");
      const admitted = await f.store.admitStopRestoreProposal(
        f.input,
        proposed.proposalDigest,
        restore,
        201,
      );
      const provenanceReads = prepare.mock.calls
        .map(([sql]) => sql)
        .filter(
          (sql) =>
            sql.includes("sync_relay_live_update_struct_provenance") && /^\s*SELECT/i.test(sql),
        );
      expect(provenanceReads.length).toBeGreaterThan(0);
      expect(
        provenanceReads.every(
          (sql) =>
            /WHERE[\s\S]*journal_cursor\s*(?:[<>=]|IN\b)/i.test(sql) ||
            /WHERE[\s\S]*client_id=\?[\s\S]*start_clock<=\?[\s\S]*start_clock>=/i.test(sql),
        ),
      ).toBe(true);
      prepare.mockRestore();
      expect(admitted.phase).toBe("relay-admitted");
      expect(
        f.raw.prepare("SELECT admission_state FROM sync_relay_live_documents").get()!
          .admission_state,
      ).toBe("closed");
      const row = f.raw
        .prepare(
          "SELECT * FROM sync_relay_live_update_journal ORDER BY journal_cursor DESC LIMIT 1",
        )
        .get()!;
      expect(row.restore_operation_id).toBe(f.input.operationId);
      expect(row.validation_checkpoint_bytes).toBeInstanceOf(Uint8Array);
      expect(admitted.admitted.firstSeen).toEqual(f.receipt.replacementRanges);
      expect(admitted.admitted.authorSnapshot).toEqual([]);
      expect(
        admitted.admitted.checkpointCoverage?.filter(
          (entry) => entry.author.kind === "unattributed",
        ),
      ).toHaveLength(1);
      expect(
        await f.store.admitStopRestoreProposal(f.input, proposed.proposalDigest, restore, 205),
      ).toEqual(admitted);
      const application = {
        fence: admitted.preparation.fence,
        candidateDigest: admitted.candidateDigest,
        nativeSourceManifestDigest: admitted.nativeSourceManifestDigest,
        admitted: admitted.admitted,
        localHeadSequence: admitted.preparation.fence.localHeadSequence + 1,
        hostCoordinate: {
          hostId: f.input.host.hostId,
          hostEpoch: f.input.host.hostEpoch,
          instanceId: f.input.host.instanceId,
          connectionId: f.input.host.connectionId,
        },
        recordedAtMs: 202,
      };
      const applied = f.store.acknowledgeStopRestoreReplacement(f.input, application);
      expect(applied.phase).toBe("native-applied");
      const settlement = {
        settlementId: "restore-settlement",
        previousCursor: 0,
        terminalCursor: admitted.admitted.accepted.receipt.journalCursor,
        applicationCount: 3,
        localYDocSequence: application.localHeadSequence,
        momentId: "restore-moment",
        markdownDigest: admitted.preparation.point.markdownDigest,
        materialized: false,
        collectionReconcileRequired: false,
      };
      expect(f.store.acknowledgeStopRestoreSettlement(f.input, settlement).phase).toBe(
        "native-applied",
      );
      expect(
        f.raw.prepare("SELECT admission_state FROM sync_relay_live_documents").get()!
          .admission_state,
      ).toBe("closed");
      const settled = f.store.acknowledgeStopRestoreSettlement(f.input, {
        ...settlement,
        materialized: true,
      });
      expect(settled.phase).toBe("settled");
      const resume = {
        relayDatabaseNamespace: admitted.preparation.fence.operation.relayDatabaseNamespace,
        operationId: f.input.operationId,
        binding: admitted.admitted.accepted.binding,
        applicationReceipt: admitted.admitted.accepted.receipt,
        settlementId: settlement.settlementId,
        momentId: settlement.momentId,
        markdownDigest: settlement.markdownDigest,
        localHeadSequence: application.localHeadSequence,
        recordedAtMs: 204,
      };
      const resumed = f.store.acknowledgeStopRestoreResume(f.input, resume);
      expect(resumed.phase).toBe("resumed");
      expect(
        f.raw.prepare("SELECT admission_state FROM sync_relay_live_documents").get()!
          .admission_state,
      ).toBe("open");
      const after = f.journalRows();
      expect(f.store.acknowledgeStopRestoreResume(f.input, resume)).toEqual(resumed);
      expect(f.store.acknowledgeStopRestoreReplacement(f.input, application)).toEqual(resumed);
      expect(
        await f.store.admitStopRestoreProposal(f.input, proposed.proposalDigest, restore, 210),
      ).toEqual(resumed);
      expect(f.journalRows()).toEqual(after);
      const read = f.storage.readLiveUpdateJournalCut({ document: f.document });
      expect(read.kind).toBe("cut");
      if (kind === "owner") {
        const owner = f.store.openOwnerDelivery({
          host: f.input.host,
          document: f.document,
          actor: { kind: "owner", userId: "owner" },
        });
        expect(f.store.ownerDeliveryProgress(owner).terminal).toEqual(resume.applicationReceipt);
      } else {
        const drain = f.store.open({ host: f.input.host, document: f.document });
        expect(drain.baseline.binding).toEqual(resume.binding);
        f.store.close(drain);
      }
      expect(before).not.toEqual(after);
    } finally {
      f.close();
    }
  },
);

const hostedActivationId = `ordinary-activation-${"d".repeat(64)}`;
function hostRestoredDocument(f: ReturnType<typeof fixture>, shareId: string) {
  if (shareId !== f.intent.shareId)
    f.write((db) => {
      db.prepare(
        "INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner',?,0)",
      ).run(shareId, f.document.workspaceId, JSON.stringify({ paths: ["docs"], versionId: null }));
      db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES (?,?,'user','collaborator',NULL,'edit',1,'active',0,NULL,NULL)`).run(
        `${shareId}-grant`,
        shareId,
      );
    });
  f.storage.claimWorkspaceIdentity({
    workspaceId: f.document.workspaceId,
    replicationEpoch: "epoch",
    streamIdentity: "stream",
  });
  f.storage.ensureOwnedLiveDocument({
    intent: "share",
    workspaceId: f.document.workspaceId,
    path: "docs/a.md",
    shareId,
    ownerUserId: "owner",
    nowMs: 30,
    guard() {},
  });
  const state = Uint8Array.of(0, 0),
    { evidence } = f.input;
  const source = {
    version: 1,
    relayDatabaseNamespace: "restore-test",
    ...f.document,
    currentPath: "docs/a.md",
    replicationEpoch: "epoch",
    streamIdentity: "stream",
    committedCursor: 1,
    baseOriginId: "base",
    baseOriginSeq: 0,
    baseRelaySeq: 1,
    sourceMomentId: "moment-1",
    sourceDigest: evidence.projectedMarkdownSha256,
    sourceByteLength: evidence.projectedMarkdownByteLength,
    nativeHeadSequence: 0,
    fullStateDigest: hash(state),
    fullStateByteLength: state.byteLength,
  };
  const binding = {
    ...f.document,
    currentPath: "docs/a.md",
    selectorPaths: ["docs"],
    restoreFenceGeneration: 1,
  };
  f.write((db) =>
    db
      .prepare(`INSERT INTO sync_relay_service_activations(relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
      source_json,binding_json,state_digest,state_bytes,owner_user_id,completion_json,accounted_bytes) VALUES ('restore-test',?,?,'main',?,?,?,?,?,?,'owner','{}',1)`)
      .run(
        hostedActivationId,
        f.document.workspaceId,
        f.document.objectId,
        f.document.lineageClaimId,
        JSON.stringify(source),
        JSON.stringify(binding),
        source.fullStateDigest,
        state,
      ),
  );
}
const revokeOtherGrant = (f: Pick<ReturnType<typeof fixture>, "storage">, at: number) =>
  expect(
    f.storage.revokeShareGrant({ shareId: "other", grantId: "other-grant", revokedAtMs: at }).ok,
  ).toBe(true);
function revokeOtherGrantDuringRestore(f: ReturnType<typeof fixture>) {
  hostRestoredDocument(f, "other");
  f.fence = () => {
    beginStopRestore(f.context, f.intent, 40);
    revokeOtherGrant(f, 45);
    return advanceStopRestoreFence(f.context, f.lookup, 50);
  };
}

it("carries a revocation retirement recorded during a restore to the restored generation", async () => {
  const f = contentProposalFixture(
    "owner",
    "service",
    false,
    false,
    false,
    0,
    revokeOtherGrantDuringRestore,
  );
  try {
    const retirement = () => readServiceActivationRetirement(f.context, f.document);
    const recorded = {
      relayDatabaseNamespace: "restore-test",
      activationId: hostedActivationId,
      ...f.document,
      path: "docs/a.md",
      requestedAtMs: 45,
    };
    expect(retirement()).toEqual({ ...recorded, restoreFenceGeneration: 2, acceptedThrough: 2 });
    const proposed = await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
    const admitted = await f.store.admitStopRestoreProposal(
      f.input,
      proposed.proposalDigest,
      restore,
      201,
    );
    expect(retirement()).toEqual({
      ...recorded,
      restoreFenceGeneration: 2,
      acceptedThrough: admitted.admitted.accepted.receipt.journalCursor,
    });
    const application = {
      fence: admitted.preparation.fence,
      candidateDigest: admitted.candidateDigest,
      nativeSourceManifestDigest: admitted.nativeSourceManifestDigest,
      admitted: admitted.admitted,
      localHeadSequence: admitted.preparation.fence.localHeadSequence + 1,
      hostCoordinate: {
        hostId: f.input.host.hostId,
        hostEpoch: f.input.host.hostEpoch,
        instanceId: f.input.host.instanceId,
        connectionId: f.input.host.connectionId,
      },
      recordedAtMs: 202,
    };
    f.store.acknowledgeStopRestoreReplacement(f.input, application);
    const settlement = {
      settlementId: "restore-settlement",
      previousCursor: 0,
      terminalCursor: admitted.admitted.accepted.receipt.journalCursor,
      applicationCount: 3,
      localYDocSequence: application.localHeadSequence,
      momentId: "restore-moment",
      markdownDigest: admitted.preparation.point.markdownDigest,
      materialized: true,
      collectionReconcileRequired: false,
    };
    expect(f.store.acknowledgeStopRestoreSettlement(f.input, settlement).phase).toBe("settled");
    expect(
      f.store.acknowledgeStopRestoreResume(f.input, {
        relayDatabaseNamespace: admitted.preparation.fence.operation.relayDatabaseNamespace,
        operationId: f.input.operationId,
        binding: admitted.admitted.accepted.binding,
        applicationReceipt: admitted.admitted.accepted.receipt,
        settlementId: settlement.settlementId,
        momentId: settlement.momentId,
        markdownDigest: settlement.markdownDigest,
        localHeadSequence: application.localHeadSequence,
        recordedAtMs: 204,
      }).phase,
    ).toBe("resumed");
    const { key: carried, boundary } = carriedRetirement({ ...f, admitted });
    expect(retirement()).toEqual({
      ...recorded,
      restoreFenceGeneration: carried.restoreFenceGeneration,
      acceptedThrough: carried.acceptedThrough,
    });
    expect(f.storage.serviceHostDocumentEnabled(f.document)).toBe(false);
    f.write((db) =>
      db
        .prepare(
          "UPDATE sync_relay_share_grants SET status='active',generation=6,revoked_at_ms=NULL WHERE grant_id=?",
        )
        .run(f.intent.grantId),
    );
    expect(() =>
      f.storage.readStopRestorePlan({
        operationId: "after-retirement",
        ownerUserId: "owner",
        document: f.document,
        shareId: f.intent.shareId,
        grantId: f.intent.grantId,
        restorePointCursor: 0,
        restorePointReceiptDigest: f.intent.restorePointReceiptDigest,
        maxOutputBytes: 1_000_000,
      }),
    ).toThrow("Live editing is still stopping.");
    expect(() =>
      beginStopRestore(
        f.context,
        {
          ...f.intent,
          operationId: "after-retirement",
          expectedFence: 2,
          expectedGrantGeneration: 6,
        },
        300,
      ),
    ).toThrow("Live editing is still stopping.");
    expect(retirement()).toEqual({
      ...recorded,
      restoreFenceGeneration: carried.restoreFenceGeneration,
      acceptedThrough: carried.acceptedThrough,
    });
    const activations = f.storage.createServiceActivationStore(f.history);
    const complete = (key: typeof carried) =>
      activations.completeRetirement({
        workspaceId: f.document.workspaceId,
        key,
        boundary,
        host: f.input.host,
        registeredAtMs: 400,
        nowMs: 400,
        guard() {},
      });
    expect(() => complete({ ...carried, restoreFenceGeneration: 1, acceptedThrough: 2 })).toThrow(
      "Service activation retirement is unavailable.",
    );
    expect(complete(carried)).toEqual({ status: "pending", reason: "restore" });
    const bytes = f.raw
      .prepare(
        "SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?",
      )
      .get(carried.acceptedThrough)!.validation_checkpoint_bytes as Uint8Array;
    await pushRestoreSettlement(
      f.storage,
      restorePublication({ ...f, admitted }, bytes, carried.acceptedThrough, "carried-publication"),
    );
    expect(complete(carried)).toEqual({ status: "retired", replayed: false });
    expect(retirement()).toBeNull();
  } finally {
    f.close();
  }
});

type HostedStorage = Parameters<typeof createServiceHostFeed>[0];
async function pushRestoreSettlement(
  storage: HostedStorage,
  { payload, record }: Pick<ReturnType<typeof restorePublication>, "payload" | "record">,
  retiring = true,
) {
  const feed = createServiceHostFeed(storage, { wakeLog() {} }),
    originId = `${SERVICE_HOST_ORIGIN_PREFIX}native`;
  const call = (method: string, route: string[], body?: BodyInit) =>
    feed(
      new Request(`https://relay.test/sync/workspace/hosted/${route.join("/")}`, {
        method,
        ...(body === undefined ? {} : { body }),
      }),
      { workspaceId: "workspace", route, actor: { userId: "owner" }, guard() {} },
    );
  for (const sha256 of [
    payload.payloadBeforeBlobSha256,
    payload.payloadAfterBlobSha256,
    record.acceptedStateBlobSha256,
  ])
    expect(
      (await call("PUT", ["blobs", sha256], Buffer.from(storage.getBlob("workspace", sha256)!)))
        .status,
    ).toBe(200);
  const answer = await call(
    "POST",
    ["log"],
    JSON.stringify({
      replicationEpoch: "epoch",
      streamIdentity: "stream",
      originId,
      ops: [{ originSeq: 0, opKind: "moment.append", recordedAtMs: 1, payload }],
    }),
  );
  expect(answer.status).toBe(200);
  expect(
    storage.fetchLogCoordinate({ workspaceId: "workspace", originId, originSeq: 0 }),
  ).toMatchObject({
    ...(retiring ? { relayAdmission: "departed" } : {}),
    settlementAdmission: { status: "accepted" },
  });
}
function carriedRetirement(
  f: Pick<Awaited<ReturnType<typeof admittedRestoreFixture>>, "admitted" | "document" | "raw">,
) {
  const receipt = f.admitted.admitted.accepted.receipt;
  const endpoint = f.raw
    .prepare(
      "SELECT accepted_event_count,accepted_evidence_digest FROM sync_relay_live_update_journal WHERE journal_cursor=?",
    )
    .get(receipt.journalCursor)!;
  return {
    key: {
      objectId: f.document.objectId,
      lineageClaimId: f.document.lineageClaimId,
      activationId: hostedActivationId,
      restoreFenceGeneration: 2,
      acceptedThrough: receipt.journalCursor,
    },
    boundary: {
      terminalReceipt: receipt,
      eventCount: Number(endpoint.accepted_event_count),
      historyEvidenceDigest: String(endpoint.accepted_evidence_digest),
    },
  };
}
type Admitted = Awaited<ReturnType<typeof admittedRestoreFixture>>["admitted"];
async function publishRestore(
  f: Pick<
    Awaited<ReturnType<typeof admittedRestoreFixture>>,
    "document" | "raw" | "storage" | "context"
  >,
  admitted: Admitted,
  id: string,
  previous = 0,
  before?: string,
  originSeq = 0,
) {
  const cursor = admitted.admitted.accepted.receipt.journalCursor;
  const bytes = f.raw
    .prepare(
      "SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?",
    )
    .get(cursor)!.validation_checkpoint_bytes as Uint8Array;
  const published = restorePublication(
    { ...f, admitted },
    bytes,
    cursor,
    id,
    previous,
    before,
    originSeq,
  );
  await prepareHostedSettlements(f.context, {
    workspaceId: "workspace",
    originId: "proof",
    ops: [published.op],
  });
  expect(
    f.storage.appendLogBatch({ workspaceId: "workspace", originId: "proof", ops: [published.op] }),
  ).toMatchObject({ inserted: 1 });
  expect(published.op).toMatchObject({ settlementAdmission: { status: "accepted" } });
  return published;
}
const projectedMoment = (f: Pick<ReturnType<typeof fixture>, "raw">, momentId: string) => ({
  moment: f.raw
    .prepare("SELECT path,blob_sha256 FROM sync_relay_object_moments WHERE moment_id=?")
    .get(momentId),
  file: f.raw
    .prepare(
      "SELECT blob_sha256 FROM sync_relay_current_files WHERE workspace_id='workspace' AND version_id='main' AND path='docs/a.md'",
    )
    .get(),
});
const reshare = (f: Pick<ReturnType<typeof fixture>, "raw">, generation: number) =>
  f.raw
    .prepare(
      "UPDATE sync_relay_share_grants SET status='active',generation=?,revoked_at_ms=NULL WHERE grant_id='grant'",
    )
    .run(generation);
function restartRelay<F extends Pick<ReturnType<typeof fixture>, "storage" | "path" | "raw">>(
  f: F,
): F {
  f.storage.close();
  const storage = openSyncRelayStorage(f.path),
    history = createLiveJournalHistoryAuthority({ namespace: "restore-test", reconciled: true });
  return {
    ...f,
    storage,
    history,
    context: storage as StorageContext,
    store: storage.createLiveCommittedDeliveryStore(history),
    close: () => {
      f.raw.close();
      storage.close();
    },
  };
}
function declineAfterFence(
  f: Pick<ReturnType<typeof fixture>, "context" | "store" | "raw">,
  lookup: ReturnType<typeof fixture>["lookup"],
  at: number,
  answer: "cancelled" | "fenceCancelled",
) {
  advanceStopRestoreFence(f.context, lookup, at);
  const capture = f.store.openStopRestoreCut(lookup);
  if (capture.kind !== "ready") throw Error(capture.kind);
  f.store.completeStopRestoreCut(capture.capture);
  const operation = f.store.pendingStopRestoreFence(lookup).operation;
  const receipt: NativeRestoreFenceReceipt = {
    operation,
    localHeadSequence: operation.appliedSequence,
    recordedAtMs: at + 1,
  };
  const answers = cancellationAnswers({ context: f.context, lookup, raw: f.raw, receipt });
  declineStopRestore(f.context, lookup, at + 2);
  expect(f.store.acknowledgeStopRestoreCancellation(lookup, answers[answer], at + 3).phase).toBe(
    "declined",
  );
}
async function completeRestore<
  F extends Pick<
    ReturnType<typeof readyNativeFence>,
    "store" | "raw" | "context" | "document" | "close"
  >,
>(f: F, lookup: ReturnType<typeof fixture>["lookup"], at: number) {
  advanceStopRestoreFence(f.context, lookup, at);
  const capture = f.store.openStopRestoreCut(lookup);
  if (capture.kind !== "ready") throw Error(capture.kind);
  f.store.completeStopRestoreCut(capture.capture);
  const operation = f.store.pendingStopRestoreFence(lookup).operation;
  const fence: NativeRestoreFenceReceipt = {
    operation,
    localHeadSequence: operation.appliedSequence,
    recordedAtMs: at + 1,
  };
  const next = await admitRestore(
    buildContentProposal({ ...f, ...proposalSources(f, "owner", lookup, fence), receipt: fence }),
  );
  expect(next.complete().phase).toBe("resumed");
  return next;
}

it("retires an activation that carries a restore only once its settlement moment is in the log", async () => {
  const f = await admittedRestoreFixture("owner", false, "service", revokeOtherGrantDuringRestore);
  const opened: ReturnType<typeof openSyncRelayStorage>[] = [];
  let closed = false;
  try {
    expect(f.complete().phase).toBe("resumed");
    const { key, boundary } = carriedRetirement(f);
    const bytes = f.raw
      .prepare(
        "SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?",
      )
      .get(key.acceptedThrough)!.validation_checkpoint_bytes as Uint8Array;
    const publication = restorePublication(
      f,
      bytes,
      key.acceptedThrough,
      "carried-restore-publication",
    );
    const complete = (storage: ReturnType<typeof openSyncRelayStorage>) =>
      storage.createServiceActivationStore(f.history).completeRetirement({
        workspaceId: f.document.workspaceId,
        key,
        boundary,
        host: f.lookup.host,
        registeredAtMs: 400,
        nowMs: 400,
        guard() {},
      });
    const state = (storage: ReturnType<typeof openSyncRelayStorage>) => ({
      activations: (storage as StorageContext).db
        .prepare("SELECT * FROM sync_relay_service_activations")
        .all(),
      owners: (storage as StorageContext).db
        .prepare("SELECT * FROM sync_relay_live_delivery_owners")
        .all(),
    });
    const restart = () => {
      if (!closed) {
        f.close();
        closed = true;
      } else opened.at(-1)!.close();
      const storage = openSyncRelayStorage(f.path);
      opened.push(storage);
      return storage;
    };
    const before = state(f.storage);
    expect(complete(f.storage)).toEqual({ status: "pending", reason: "restore" });
    expect(state(f.storage)).toEqual(before);
    let storage = restart();
    expect(complete(storage)).toEqual({ status: "pending", reason: "restore" });
    expect(state(storage)).toEqual(before);
    await pushRestoreSettlement(storage, publication);
    await pushRestoreSettlement(storage, publication);
    storage = restart();
    expect(complete(storage)).toEqual({ status: "retired", replayed: false });
    storage = restart();
    expect(complete(storage)).toEqual({ status: "retired", replayed: true });
    expect(readServiceActivationRetirement(storage as StorageContext, f.document)).toBeNull();
  } finally {
    if (!closed) f.close();
    opened.at(-1)?.close();
  }
});

const publicationPending =
  "The last restore of this file has not reached the server yet. Try again in a moment.";
it("waits for a resumed restore's settlement before the next restore begins", async () => {
  const first = await admittedRestoreFixture("owner", false);
  let f = first;
  try {
    expect(first.complete().phase).toBe("resumed");
    reshare(f, 6);
    const b = {
      ...f.intent,
      operationId: "restore-b",
      expectedFence: 2,
      expectedGrantGeneration: 6,
    };
    const operations = () =>
        f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(),
      before = operations();
    expect(() => beginStopRestore(f.context, b, 300)).toThrow(publicationPending);
    expect(operations()).toEqual(before);
    expect(f.storage.getShareGrant("grant")).toMatchObject({ status: "active", generation: 6 });
    f = restartRelay(first);
    expect(() => beginStopRestore(f.context, b, 300)).toThrow(publicationPending);
    expect(operations()).toEqual(before);
    const a = await publishRestore(f, first.admitted, "restore-a-publication");
    expect(beginStopRestore(f.context, b, 300).previousOperationId).toBe("restore");
    declineAfterFence(f, { ...f.lookup, operationId: "restore-b" }, 301, "fenceCancelled");
    reshare(f, 8);
    expect(
      beginStopRestore(
        f.context,
        { ...f.intent, operationId: "restore-c", expectedFence: 3, expectedGrantGeneration: 8 },
        310,
      ).previousOperationId,
    ).toBe("restore-b");
    const c = await completeRestore(f, { ...f.lookup, operationId: "restore-c" }, 311);
    const published = await publishRestore(
      f,
      c.admitted,
      "restore-c-publication",
      first.admitted.admitted.accepted.receipt.journalCursor,
      a.markdownDigest,
      1,
    );
    expect(projectedMoment(f, "restore-c-publication")).toEqual({
      moment: { path: "docs/a.md", blob_sha256: published.markdownDigest },
      file: { blob_sha256: published.markdownDigest },
    });
  } finally {
    f.close();
  }
});

const restoredState = (f: Pick<ReturnType<typeof fixture>, "raw">, admitted: Admitted) =>
  f.raw
    .prepare(
      "SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?",
    )
    .get(admitted.admitted.accepted.receipt.journalCursor)!
    .validation_checkpoint_bytes as Uint8Array;
const publicationRepair =
  "The server could not confirm the latest changes to this file. Ask the server's operator to repair it before restoring again.";

it("reports a refused restore publication as needing repair", async () => {
  const f = await admittedRestoreFixture("owner", false);
  try {
    f.complete();
    const restored = f.admitted.admitted.accepted.receipt.journalCursor;
    const publication = restorePublication(
      f,
      restoredState(f, f.admitted),
      restored,
      "refused-restore-publication",
      0,
      hash(Buffer.from("not the baseline")),
    );
    await prepareHostedSettlements(f.context, {
      workspaceId: "workspace",
      originId: "proof",
      ops: [publication.op],
    });
    expect(publication.op).toMatchObject({ settlementAdmission: { status: "refused" } });
    expect(
      f.storage.appendLogBatch({
        workspaceId: "workspace",
        originId: "proof",
        ops: [publication.op],
      }),
    ).toMatchObject({ inserted: 1 });
    expect(
      f.raw.prepare("SELECT refused_terminal_cursor FROM sync_relay_live_restore_lifecycles").get(),
    ).toEqual({ refused_terminal_cursor: restored });
    reshare(f, 6);
    expect(() =>
      beginStopRestore(
        f.context,
        { ...f.intent, operationId: "restore-b", expectedFence: 2, expectedGrantGeneration: 6 },
        300,
      ),
    ).toThrow(publicationRepair);
  } finally {
    f.close();
  }
});

it("funds a restore's publication at admission and releases it once with its binding", async () => {
  const f = await admittedRestoreFixture("owner", false);
  try {
    const binding = f.admitted.admitted.accepted.binding,
      cursor = f.admitted.admitted.accepted.receipt.journalCursor;
    const reservation = restorePublicationReservation("restore-test", binding);
    // Every field at its limit, escaped as stored: a backslash costs two JSON bytes and a lone surrogate six.
    expect(maximumBindingBytes("restore-test", binding)).toBe(
      2 +
        15 +
        [
          binding.workspaceId,
          binding.mainVersionId,
          binding.objectId,
          binding.lineageClaimId,
          "restore-test",
          binding.restoreFenceGeneration,
          stableJsonStringify(binding),
        ].reduce<number>((n, value) => n + Buffer.byteLength(JSON.stringify(value)), 0) +
        2 * 16 +
        (2 + 80) +
        (2 + 2 * 512) +
        3 * (2 + 64) +
        (2 + 6 * 256) +
        16,
    );
    expect(reservation).toBe(
      262_144 + 131_072 + 119 + maximumBindingBytes("restore-test", binding),
    );
    const held = () =>
      f.raw
        .prepare(
          "SELECT publication_reservation_bytes AS bytes,accounted_bytes FROM sync_relay_live_restore_lifecycles",
        )
        .get()!;
    const usage = () =>
      Number(
        f.raw
          .prepare(
            "SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'",
          )
          .get()!.usage_bytes,
      );
    expect(Number(held().bytes)).toBe(reservation);
    f.complete();
    expect(Number(held().bytes)).toBe(reservation);
    const funded = held();
    const publication = restorePublication(
      f,
      restoredState(f, f.admitted),
      cursor,
      "funded-publication",
    );
    await prepareHostedSettlements(f.context, {
      workspaceId: "workspace",
      originId: "proof",
      ops: [publication.op],
    });
    const second = restorePublication(
      f,
      restoredState(f, f.admitted),
      cursor,
      "second-publication",
    );
    await prepareHostedSettlements(f.context, {
      workspaceId: "workspace",
      originId: "second",
      ops: [second.op],
    });
    expect(second.op).toMatchObject({ settlementAdmission: { status: "accepted" } });
    const before = { held: funded, usage: usage() };
    expect(held()).toEqual(funded);
    f.raw.exec(
      "CREATE TRIGGER refuse_binding BEFORE INSERT ON sync_relay_live_settlement_bindings BEGIN SELECT RAISE(ABORT,'binding refused'); END",
    );
    expect(() =>
      f.storage.appendLogBatch({
        workspaceId: "workspace",
        originId: "proof",
        ops: [publication.op],
      }),
    ).toThrow("binding refused");
    expect({ held: held(), usage: usage() }).toEqual(before);
    f.raw.exec("DROP TRIGGER refuse_binding");
    expect(
      f.storage.appendLogBatch({
        workspaceId: "workspace",
        originId: "proof",
        ops: [publication.op],
      }),
    ).toMatchObject({ inserted: 1 });
    const stored = Number(
      f.raw.prepare("SELECT storage_bytes FROM sync_relay_live_settlement_bindings").get()!
        .storage_bytes,
    );
    const log = f.storage.fetchLogCoordinate({
      workspaceId: "workspace",
      originId: "proof",
      originSeq: 0,
    })!;
    const logged =
      Buffer.byteLength(log.payloadJson) +
      Buffer.byteLength(JSON.stringify(log.admittedAuthorSnapshot)) +
      Buffer.byteLength(JSON.stringify(log.settlementAdmission));
    expect(stored).toBeLessThanOrEqual(maximumBindingBytes("restore-test", binding));
    expect(held()).toEqual({
      bytes: 0,
      accounted_bytes: Number(before.held.accounted_bytes) - reservation,
    });
    expect(usage()).toBe(before.usage - reservation + stored + logged);
    const after = usage();
    expect(
      f.storage.appendLogBatch({
        workspaceId: "workspace",
        originId: "proof",
        ops: [publication.op],
      }),
    ).toMatchObject({ inserted: 0 });
    expect(
      f.storage.appendLogBatch({ workspaceId: "workspace", originId: "second", ops: [second.op] }),
    ).toMatchObject({ inserted: 1 });
    expect(second.op).toMatchObject({ settlementAdmission: { status: "refused" } });
    const refused = f.storage.fetchLogCoordinate({
      workspaceId: "workspace",
      originId: "second",
      originSeq: 0,
    })!;
    expect(held()).toEqual({
      bytes: 0,
      accounted_bytes: Number(before.held.accounted_bytes) - reservation,
    });
    expect(
      f.raw.prepare("SELECT refused_terminal_cursor FROM sync_relay_live_restore_lifecycles").get(),
    ).toEqual({ refused_terminal_cursor: cursor });
    expect(usage()).toBe(
      after +
        Buffer.byteLength(refused.payloadJson) +
        Buffer.byteLength(JSON.stringify(refused.settlementAdmission)),
    );
    expect(f.store.readStopRestoreLifecycle(f.input)!.phase).toBe("resumed");
  } finally {
    f.close();
  }
});

function cancellationAnswers(
  f: Pick<ReturnType<typeof readyNativeFence>, "context" | "lookup" | "raw" | "receipt">,
) {
  const cutover = readStopRestore(f.context, f.lookup)!.cutoverCursor!;
  const fence = f.receipt.operation,
    binding = { ...fence.oldBinding, restoreFenceGeneration: fence.newFence };
  const row = f.raw
    .prepare(
      "SELECT accepted_event_count,accepted_evidence_digest FROM sync_relay_live_update_journal WHERE journal_cursor=?",
    )
    .get(cutover)!;
  const cancelled: NativeRestoreCancellationAnswer = {
    status: "cancelled",
    hostId: fence.hostId,
    generation: fence.newFence - 1,
    binding: fence.oldBinding,
  };
  const fenceCancelled: NativeRestoreCancellationAnswer & { status: "fenceCancelled" } = {
    status: "fenceCancelled",
    hostId: fence.hostId,
    generation: fence.newFence,
    binding,
    receipt: {
      fence: f.receipt,
      binding,
      endpoint: {
        terminalReceipt: fence.terminal,
        eventCount: Number(row.accepted_event_count),
        historyEvidenceDigest: String(row.accepted_evidence_digest),
      },
      recordedAtMs: 160,
    },
  };
  return { cutover, cancelled, fenceCancelled };
}
function serviceFence(native: boolean, revoked = false) {
  const f = readyNativeFence(
    "owner",
    "service",
    true,
    false,
    revoked
      ? revokeOtherGrantDuringRestore
      : (hosted) => hostRestoredDocument(hosted, hosted.intent.shareId),
  );
  try {
    if (native) f.store.acknowledgeStopRestoreFence(f.lookup, f.receipt);
    const answers = cancellationAnswers(f);
    const key = (restoreFenceGeneration: number) => ({
      objectId: f.document.objectId,
      lineageClaimId: f.document.lineageClaimId,
      activationId: hostedActivationId,
      restoreFenceGeneration,
      acceptedThrough: answers.cutover,
    });
    return { ...f, ...answers, key };
  } catch (error) {
    f.close();
    throw error;
  }
}
function declinedFence(native: boolean, revoked = false) {
  const f = serviceFence(native, revoked);
  try {
    expect(declineStopRestore(f.context, f.lookup, 150).phase).toBe(
      native ? "native-fenced" : "old-cut-applied",
    );
    return f;
  } catch (error) {
    f.close();
    throw error;
  }
}
type DeclinedFence = ReturnType<typeof declinedFence>;
const completeRetirementAt = (
  f: Pick<DeclinedFence, "storage" | "history" | "document" | "lookup">,
  key: ReturnType<DeclinedFence["key"]>,
) => {
  const db = (f.storage as StorageContext).db,
    owner = db.prepare("SELECT tip_receipt_json FROM sync_relay_live_delivery_owners").get()!;
  const endpoint = db
    .prepare(
      "SELECT accepted_event_count,accepted_evidence_digest FROM sync_relay_live_update_journal WHERE journal_cursor=?",
    )
    .get(key.acceptedThrough)!;
  return f.storage.createServiceActivationStore(f.history).completeRetirement({
    workspaceId: f.document.workspaceId,
    key,
    boundary: {
      terminalReceipt: JSON.parse(String(owner.tip_receipt_json)),
      eventCount: Number(endpoint.accepted_event_count),
      historyEvidenceDigest: String(endpoint.accepted_evidence_digest),
    },
    host: f.lookup.host,
    registeredAtMs: 400,
    nowMs: 400,
    guard() {},
  });
};
const documentState = (f: Pick<DeclinedFence, "raw">) =>
  f.raw
    .prepare("SELECT restore_fence_generation,admission_state FROM sync_relay_live_documents")
    .get();

it.each([["revoked during the restore", true]] as const)(
  "ends a declined restore at the old generation when its host never fenced it: %s",
  (_cause, revoked) => {
    const f = declinedFence(false, revoked);
    try {
      expect(f.store.pendingStopRestoreCancellation(f.lookup)).toEqual({
        operationId: "restore",
        objectId: f.document.objectId,
        lineageClaimId: f.document.lineageClaimId,
        hostId: f.receipt.operation.hostId,
        newFence: 2,
      });
      const declined = f.store.acknowledgeStopRestoreCancellation(f.lookup, f.cancelled, 170);
      expect(declined).toMatchObject({
        phase: "declined",
        newFence: null,
        cutoverCursor: null,
        applied: null,
        nativeReceipt: null,
        declinedAtMs: 170,
      });
      expect(documentState(f)).toEqual({ restore_fence_generation: 1, admission_state: "closed" });
      expect(readServiceActivationRetirement(f.context, f.document)).toMatchObject({
        restoreFenceGeneration: 1,
        acceptedThrough: f.cutover,
        requestedAtMs: revoked ? 45 : 170,
      });
      expect(
        f.raw
          .prepare("SELECT outcome,journal_cursor FROM sync_relay_live_restore_cancellations")
          .all(),
      ).toEqual([{ outcome: "cancelled", journal_cursor: null }]);
      expect(f.store.pendingStopRestoreCancellation(f.lookup)).toBeNull();
      const after = f.rows();
      expect(f.store.acknowledgeStopRestoreCancellation(f.lookup, f.cancelled, 180)).toEqual(
        declined,
      );
      expect(() =>
        f.store.acknowledgeStopRestoreCancellation(f.lookup, f.fenceCancelled, 180),
      ).toThrow();
      expect(f.rows()).toEqual(after);
      expect(f.storage.getShareGrant("grant")).toMatchObject({ status: "revoked" });
      expect(() => completeRetirementAt(f, f.key(2))).toThrow(
        "Service activation retirement is unavailable.",
      );
      expect(completeRetirementAt(f, f.key(1))).toEqual({ status: "retired", replayed: false });
    } finally {
      f.close();
    }
  },
);

it.each([[true, false]])(
  "ends a declined restore at the fenced generation with its host's receipt, native fence saved=%s, revoked during the restore=%s",
  async (native, revoked) => {
    const f = declinedFence(native, revoked);
    let reopened: ReturnType<typeof openSyncRelayStorage> | undefined,
      closed = false;
    try {
      const sequence = () =>
        Number(
          f.raw
            .prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_relay_live_update_journal'")
            .get()!.seq,
        );
      const control = sequence() + 1,
        operation = readStopRestore(f.context, f.lookup)!;
      const declined = f.store.acknowledgeStopRestoreCancellation(f.lookup, f.fenceCancelled, 170);
      expect(declined).toEqual({
        ...operation,
        phase: "declined",
        declinedAtMs: 170,
        nativeReceipt: f.receipt,
      });
      expect(documentState(f)).toEqual({ restore_fence_generation: 2, admission_state: "closed" });
      expect(readServiceActivationRetirement(f.context, f.document)).toMatchObject({
        restoreFenceGeneration: 2,
        acceptedThrough: f.cutover,
        requestedAtMs: revoked ? 45 : 170,
      });
      expect(
        f.raw
          .prepare("SELECT outcome,journal_cursor FROM sync_relay_live_restore_cancellations")
          .all(),
      ).toEqual([{ outcome: "fence-cancelled", journal_cursor: control }]);
      expect(sequence()).toBe(control);
      const baseline = Number(
        f.raw
          .prepare(
            "SELECT baseline_moment_relay_seq FROM sync_relay_live_documents WHERE lineage_state='current'",
          )
          .get()!.baseline_moment_relay_seq,
      );
      const authority = {
        lineageClaimId: f.fenceCancelled.receipt.binding.lineageClaimId,
        baselineSequence: baseline,
        restoreFenceGeneration: 2,
      };
      expect(
        await readReplicaLiveJournal(f.context, {
          workspaceId: "workspace",
          after: f.cutover,
          limit: 10,
        }),
      ).toEqual({
        rows: [
          {
            relayDatabaseNamespace: "restore-test",
            journalCursor: control,
            cancellation: f.fenceCancelled.receipt,
            authority,
          },
        ],
        nextCursor: control,
        hasMore: false,
      });
      const operations = () =>
          f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(),
        after = operations();
      f.close();
      closed = true;
      reopened = openSyncRelayStorage(f.path);
      const history = createLiveJournalHistoryAuthority({
        namespace: "restore-test",
        reconciled: true,
      });
      const store = reopened.createLiveCommittedDeliveryStore(history);
      expect(store.pendingStopRestoreCancellation(f.lookup)).toBeNull();
      expect(store.acknowledgeStopRestoreCancellation(f.lookup, f.fenceCancelled, 180)).toEqual(
        declined,
      );
      expect(() => store.acknowledgeStopRestoreCancellation(f.lookup, f.cancelled, 180)).toThrow();
      expect(() => store.acknowledgeStopRestoreFence(f.lookup, f.receipt)).toThrow();
      expect(
        (reopened as StorageContext).db
          .prepare("SELECT * FROM sync_relay_live_restore_operations")
          .all(),
      ).toEqual(after);
      const reopenedFixture = {
        storage: reopened,
        history,
        document: f.document,
        lookup: f.lookup,
      };
      expect(() => completeRetirementAt(reopenedFixture, f.key(1))).toThrow(
        "Service activation retirement is unavailable.",
      );
      expect(completeRetirementAt(reopenedFixture, f.key(2))).toEqual({
        status: "retired",
        replayed: false,
      });
    } finally {
      if (!closed) f.close();
      reopened?.close();
    }
  },
);

it.each([true])(
  "refuses a missing or altered cancellation proof, native fence saved=%s",
  (native) => {
    const f = declinedFence(native);
    try {
      const before = f.rows(),
        cancellations = () =>
          f.raw.prepare("SELECT * FROM sync_relay_live_restore_cancellations").all(),
        requested = cancellations();
      const receipt = f.fenceCancelled.receipt;
      const altered: NativeRestoreCancellationAnswer[] = [
        ...(native
          ? [
              f.cancelled,
              {
                ...f.fenceCancelled,
                receipt: { ...receipt, fence: { ...receipt.fence, recordedAtMs: 101 } },
              },
            ]
          : []),
        { ...f.cancelled, hostId: "other-host" },
        { ...f.cancelled, generation: 2 },
        {
          ...f.cancelled,
          binding: { ...f.receipt.operation.oldBinding, currentPath: "docs/other.md" },
        },
        { ...f.fenceCancelled, hostId: "other-host" },
        {
          ...f.fenceCancelled,
          receipt: {
            ...receipt,
            fence: {
              ...receipt.fence,
              operation: { ...receipt.fence.operation, appliedSequence: 1 },
            },
          },
        },
        {
          ...f.fenceCancelled,
          receipt: {
            ...receipt,
            endpoint: { ...receipt.endpoint, eventCount: receipt.endpoint.eventCount + 1 },
          },
        },
        {
          ...f.fenceCancelled,
          receipt: {
            ...receipt,
            endpoint: { ...receipt.endpoint, historyEvidenceDigest: "f".repeat(64) },
          },
        },
      ];
      for (const answer of altered)
        expect(() => f.store.acknowledgeStopRestoreCancellation(f.lookup, answer, 170)).toThrow();
      expect(() =>
        f.store.acknowledgeStopRestoreCancellation(
          f.lookup,
          { ...f.cancelled, binding: null },
          170,
        ),
      ).toThrow();
      expect(f.rows()).toEqual(before);
      expect(cancellations()).toEqual(requested);
      expect(f.store.pendingStopRestoreCancellation(f.lookup)).not.toBeNull();
    } finally {
      f.close();
    }
  },
);

function declinedAtFence(
  restart: boolean,
  answer: "cancelled" | "fenceCancelled" = "fenceCancelled",
) {
  const f = readyNativeFence("owner", "device", true);
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined;
  const generation = answer === "cancelled" ? 1 : 2;
  try {
    if (answer === "fenceCancelled") f.store.acknowledgeStopRestoreFence(f.lookup, f.receipt);
    const answers = cancellationAnswers(f);
    declineStopRestore(f.context, f.lookup, 150);
    expect(f.store.acknowledgeStopRestoreCancellation(f.lookup, answers[answer], 170).phase).toBe(
      "declined",
    );
    expect(documentState(f)).toEqual({
      restore_fence_generation: generation,
      admission_state: "closed",
    });
    f.write((db) =>
      db
        .prepare(
          "UPDATE sync_relay_share_grants SET status='active',generation=6,revoked_at_ms=NULL WHERE grant_id='grant'",
        )
        .run(),
    );
    let storage = f.storage,
      history = f.history;
    if (restart) {
      f.storage.close();
      storage = reopened = openSyncRelayStorage(f.path);
      history = createLiveJournalHistoryAuthority({ namespace: "restore-test", reconciled: true });
    }
    const context = storage as StorageContext;
    const g = {
      ...f,
      storage,
      history,
      context,
      store: storage.createLiveCommittedDeliveryStore(history),
      write: (sql: string, ...values: string[]) =>
        context.tx(() => context.db.prepare(sql).run(...values)),
      close: () => {
        if (reopened) {
          f.raw.close();
          reopened.close();
        } else f.close();
      },
    };
    const next = {
      ...f.intent,
      operationId: "restore-b",
      expectedFence: generation,
      expectedGrantGeneration: 6,
    };
    const plan = () =>
      storage.readStopRestorePlan({
        operationId: next.operationId,
        ownerUserId: "owner",
        document: f.document,
        shareId: next.shareId,
        grantId: next.grantId,
        restorePointCursor: 0,
        restorePointReceiptDigest: next.restorePointReceiptDigest,
        maxOutputBytes: 1_000_000,
      });
    return { ...g, next, nextLookup: { ...f.lookup, operationId: next.operationId }, plan };
  } catch (error) {
    if (reopened) {
      f.raw.close();
      reopened.close();
    } else f.close();
    throw error;
  }
}

// Proves: the next restore follows a declined one only from the generation
// and lineage its host's recorded answer ended at. A document moved to
// another generation, or an answer naming another lineage, refuses both the
// offer and the start, with nothing changed. Undoing the damage lets it begin.
it.each([false, true])(
  "refuses a restore after a Decline at another fence or lineage, restart=%s",
  (restart) => {
    const f = declinedAtFence(restart);
    try {
      const lineage = f.document.lineageClaimId,
        other = "e".repeat(64);
      const operations = () =>
          f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(),
        before = operations();
      const damage: [() => void, () => void, number][] = [
        [
          () => f.write("UPDATE sync_relay_live_documents SET restore_fence_generation=3"),
          () => f.write("UPDATE sync_relay_live_documents SET restore_fence_generation=2"),
          3,
        ],
        [
          () =>
            f.write(
              "UPDATE sync_relay_live_restore_cancellations SET acknowledgment_json=replace(acknowledgment_json,?,?)",
              lineage,
              other,
            ),
          () =>
            f.write(
              "UPDATE sync_relay_live_restore_cancellations SET acknowledgment_json=replace(acknowledgment_json,?,?)",
              other,
              lineage,
            ),
          2,
        ],
      ];
      for (const [apply, undo, expectedFence] of damage) {
        apply();
        expect(() => f.plan()).toThrow("Live restore operation conflicts with current authority.");
        expect(() => beginStopRestore(f.context, { ...f.next, expectedFence }, 180)).toThrow(
          "Live restore operation conflicts with current authority.",
        );
        expect(operations()).toEqual(before);
        expect(f.storage.getShareGrant("grant")).toMatchObject({ status: "active", generation: 6 });
        undo();
      }
      expect(beginStopRestore(f.context, f.next, 180).previousOperationId).toBe("restore");
    } finally {
      f.close();
    }
  },
);

const departFrozenPath = (f: Pick<ReturnType<typeof fixture>, "write" | "document">) =>
  f.write((db) => {
    const copy =
      db.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
    SELECT workspace_id,?,?,?,version_id,?,blob_sha256,content_kind,byte_length,? FROM sync_relay_object_moments WHERE object_id=? ORDER BY relay_seq DESC LIMIT 1`);
    copy.run(f.document.objectId, 10, "renamed", "docs/renamed.md", 10, f.document.objectId);
    copy.run("reusing", 11, "reusing", "docs/a.md", 11, f.document.objectId);
  });
const cancellingConnection = (
  f: Pick<ReturnType<typeof fixture>, "coordinate">,
  reply: () => Promise<unknown>,
) => {
  const sendRequest = vi.fn(async (request: { method: string }) => {
    expect(request.method).toBe("liveApplication.cancelRestoreFence");
    return { result: await reply() };
  });
  return {
    sendRequest,
    connection: {
      client: { sendRequest, sendLiveRestore: vi.fn() } as never,
      workspace: "native-workspace",
      host: f.coordinate,
      deadlineMs: 1000,
      nextRequestId: () => 1,
    },
  };
};
it("declines a restore whose file is renamed while its host prepares, with its host's answer", async () => {
  const f = contentProposalFixture("bootstrap", "service"),
    fence = f.receipt.fence;
  try {
    const { fenceCancelled } = cancellationAnswers({ ...f, receipt: fence });
    const { sendRequest, connection } = cancellingConnection(f, async () => fenceCancelled);
    const sendLiveRestore = vi.fn(async () => {
      departFrozenPath(f);
      return { response: { result: { status: "prepared" } }, bytes: Buffer.from(f.encoded) };
    });
    const options = {
      store: f.store,
      lookup: f.lookup,
      deliveryKind: "bootstrap" as const,
      connection: { ...connection, client: { sendRequest, sendLiveRestore } as never },
    };
    await expect(
      new LiveRestorePreparation(preparationConfig(), restore).prepare(options),
    ).resolves.toEqual({ kind: "pending", reason: "The restore was declined." });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(f.raw.prepare(`SELECT COUNT(*) AS count FROM ${proposalTable}`).get()!.count).toBe(0);
    expect(readStopRestore(f.context, f.lookup)).toMatchObject({
      phase: "declined",
      nativeReceipt: fence,
    });
    expect(
      f.raw.prepare("SELECT outcome FROM sync_relay_live_restore_cancellations").all(),
    ).toEqual([{ outcome: "fence-cancelled" }]);
    expect(documentState(f)).toEqual({ restore_fence_generation: 2, admission_state: "closed" });
  } finally {
    f.close();
  }
});

it("finishes an admitted restore at its frozen path after its file is renamed", async () => {
  const f = await admittedRestoreFixture("owner", false, "service", (hosted) =>
    hostRestoredDocument(hosted, hosted.intent.shareId),
  );
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined,
    closed = false;
  try {
    const frozen = f.admitted.admitted.accepted.binding,
      receipt = f.admitted.admitted.accepted.receipt;
    expect(frozen).toMatchObject({ currentPath: "docs/a.md", restoreFenceGeneration: 2 });
    departFrozenPath(f);
    const moments = f.raw
      .prepare("SELECT * FROM sync_relay_object_moments ORDER BY relay_seq")
      .all();
    expect(f.store.acknowledgeStopRestoreReplacement(f.input, f.application).phase).toBe(
      "native-applied",
    );
    const { key, boundary } = carriedRetirement(f);
    const bytes = f.raw
      .prepare(
        "SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?",
      )
      .get(receipt.journalCursor)!.validation_checkpoint_bytes as Uint8Array;
    const publication = restorePublication(
      f,
      bytes,
      receipt.journalCursor,
      "renamed-restore-publication",
    );
    f.close();
    closed = true;
    reopened = openSyncRelayStorage(f.path);
    const history = createLiveJournalHistoryAuthority({
      namespace: "restore-test",
      reconciled: true,
    });
    const store = reopened.createLiveCommittedDeliveryStore(history),
      db = (reopened as StorageContext).db;
    expect(store.acknowledgeStopRestoreSettlement(f.input, f.settlement).phase).toBe("settled");
    const resumed = store.acknowledgeStopRestoreResume(f.input, f.resume);
    expect(resumed).toMatchObject({ phase: "resumed", resume: { binding: frozen } });
    expect(store.readStopRestoreLifecycle(f.input)).toEqual(resumed);
    expect(store.stopRestoreFinishedAtMovedPath(f.input)).toBe(true);
    expect(db.prepare("SELECT * FROM sync_relay_object_moments ORDER BY relay_seq").all()).toEqual(
      moments,
    );
    expect(
      reopened.objectIdAtPathInVersion({
        workspaceId: "workspace",
        versionId: "main",
        path: "docs/renamed.md",
      }),
    ).toBe(f.document.objectId);
    expect(
      reopened.objectIdAtPathInVersion({
        workspaceId: "workspace",
        versionId: "main",
        path: "docs/a.md",
      }),
    ).toBe("reusing");
    expect(
      db
        .prepare(
          "SELECT current_path,restore_fence_generation,admission_state FROM sync_relay_live_documents",
        )
        .get(),
    ).toEqual({ current_path: "docs/a.md", restore_fence_generation: 2, admission_state: "open" });
    expect(
      reopened.readServiceHostFeedScope("workspace")?.settling.get(f.document.objectId),
    ).toMatchObject({
      path: "docs/a.md",
      restoreFenceGeneration: 2,
      acceptedThrough: receipt.journalCursor,
    });
    const owner = db.prepare("SELECT tip_receipt_json FROM sync_relay_live_delivery_owners").get()!;
    expect(JSON.parse(String(owner.tip_receipt_json))).toEqual(receipt);
    const complete = () =>
      reopened!.createServiceActivationStore(history).completeRetirement({
        workspaceId: f.document.workspaceId,
        key,
        boundary,
        host: f.lookup.host,
        registeredAtMs: 400,
        nowMs: 400,
        guard() {},
      });
    expect(complete()).toEqual({ status: "pending", reason: "restore" });
    await pushRestoreSettlement(reopened, publication);
    expect(db.prepare("SELECT * FROM sync_relay_object_moments ORDER BY relay_seq").all()).toEqual(
      moments,
    );
    expect(complete()).toEqual({ status: "retired", replayed: false });
    db.prepare(
      "UPDATE sync_relay_share_grants SET status='active',generation=6,revoked_at_ms=NULL WHERE grant_id=?",
    ).run(f.intent.grantId);
    expect(
      reopened.resolveCurrentLiveDocumentBinding({ document: f.document, actor: f.actor }),
    ).toEqual({ kind: "refused", reason: "stale-document" });
  } finally {
    if (!closed) f.close();
    reopened?.close();
  }
});

const rotateIdentity = (f: Pick<ReturnType<typeof fixture>, "write" | "storage">) => {
  f.write((db) =>
    db
      .prepare(
        "INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','rotation-test',0,'test.rotation','{}',300)",
      )
      .run(),
  );
  expect(
    f.storage.rotateWorkspaceIdentity({
      workspaceId: "workspace",
      ownerUserId: "owner",
      replicationEpoch: "next-epoch",
      streamIdentity: "next-stream",
      rotatedAtMs: 300,
    }),
  ).toBe("rotated");
};
const admittedRows = (
  f: Pick<ReturnType<typeof contentProposalFixture>, "raw" | "journalRows">,
) => ({
  ...lifecycleRows(f),
  documents: f.raw
    .prepare("SELECT restore_fence_generation,admission_state FROM sync_relay_live_documents")
    .all(),
});

it("refuses a native resume reply that arrives after a workspace identity rotation", async () => {
  const stage = "resume";
  const f = await admittedRestoreFixture("owner", false, "service");
  try {
    f.store.acknowledgeStopRestoreReplacement(f.input, f.application);
    f.store.acknowledgeStopRestoreSettlement(f.input, f.settlement);
    const phase = f.store.readStopRestoreLifecycle(f.input)!.phase,
      reply = { apply: f.application, settle: f.settlement, resume: f.resume }[stage];
    let before: ReturnType<typeof admittedRows> | undefined;
    const sendLiveRestore = vi.fn(async (_request: unknown, operation: string) => {
      expect(operation).toBe(stage);
      rotateIdentity(f);
      before = admittedRows(f);
      return {
        response: { result: { status: operation } },
        bytes: Buffer.from(JSON.stringify(reply)),
      };
    });
    const options = {
      store: f.store,
      lookup: f.lookup,
      deliveryKind: "owner" as const,
      connection: {
        client: { sendLiveRestore } as never,
        workspace: "native-workspace",
        host: f.lookup.host,
        deadlineMs: 1000,
        nextRequestId: () => 1,
      },
    };
    await expect(
      new LiveRestorePreparation(preparationConfig(), restore).complete(
        options,
        f.proposal.proposalDigest,
      ),
    ).rejects.toThrow();
    expect(sendLiveRestore).toHaveBeenCalledTimes(1);
    expect(admittedRows(f)).toEqual(before);
    expect(f.store.readStopRestoreLifecycle(f.input)!.phase).toBe(phase);
    expect(documentState(f)).toEqual({ restore_fence_generation: 2, admission_state: "closed" });
  } finally {
    f.close();
  }
});

it.each(["decline", "admission"] as const)(
  "lets exactly one of Decline and admission take a fenced restore: %s first",
  async (first) => {
    const f = contentProposalFixture("bootstrap", "service");
    try {
      const proposed = await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
      const admit = () =>
        f.store.admitStopRestoreProposal(f.input, proposed.proposalDigest, restore, 201);
      if (first === "admission") {
        expect((await admit()).phase).toBe("relay-admitted");
        const after = f.rows();
        expect(() => declineStopRestore(f.context, f.lookup, 202)).toThrow(
          "The restore is already being applied, so it can no longer be declined.",
        );
        expect(f.rows()).toEqual(after);
        expect(
          f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_restore_cancellations").get()!.n,
        ).toBe(0);
        return;
      }
      expect(declineStopRestore(f.context, f.lookup, 202).phase).toBe("native-fenced");
      const after = f.journalRows();
      await expect(admit()).rejects.toThrow();
      await expect(
        f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 203),
      ).rejects.toThrow();
      expect(() => f.store.captureStopRestorePoint(f.input)).toThrow();
      expect(() => f.store.acknowledgeStopRestoreFence(f.lookup, f.receipt.fence)).toThrow();
      expect(() => f.store.pendingStopRestoreFence(f.lookup)).toThrow();
      expect(f.journalRows()).toEqual(after);
      expect(readStopRestore(f.context, f.lookup)?.phase).toBe("native-fenced");
    } finally {
      f.close();
    }
  },
);

it("migrates a store from before the declined phase without changing its restore rows", async () => {
  const f = await admittedRestoreFixture("owner", true);
  try {
    f.complete();
    // One connection throughout, as the relay has: another one may read a table through its old layout.
    const db = f.context.db;
    const rows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all();
    const snapshot = () => ({
      operations: rows("sync_relay_live_restore_operations"),
      proposals: rows(proposalTable),
      lifecycles: rows("sync_relay_live_restore_lifecycles"),
      sources: rows("sync_relay_live_restore_source_ranges"),
      journal: db
        .prepare(
          "SELECT journal_cursor,restore_operation_id FROM sync_relay_live_update_journal ORDER BY journal_cursor",
        )
        .all(),
    });
    // The earlier build held no publication reservation.
    db.exec(
      "UPDATE sync_relay_live_restore_lifecycles SET accounted_bytes=accounted_bytes-publication_reservation_bytes,publication_reservation_bytes=0",
    );
    const before = snapshot();
    expect(before.lifecycles).toHaveLength(1);
    expect(before.sources.length).toBeGreaterThan(0);
    expect(before.journal.some((row) => row.restore_operation_id === "restore")).toBe(true);
    layOutEarlierRestoreStore(
      db,
      [
        ["sync_relay_live_restore_operations", LIVE_RESTORE_OPERATIONS_V1_SQL, ["declined_at_ms"]],
        [
          "sync_relay_live_restore_lifecycles",
          LIVE_RESTORE_LIFECYCLES_V1_SQL,
          ["publication_reservation_bytes", "refused_terminal_cursor"],
        ],
      ],
      [LIVE_RESTORE_ACTIVE_V1_SQL],
      ["live-restore-declined-v1", "live-restore-publication-v1"],
    );
    db.exec("BEGIN IMMEDIATE");
    initializeLiveRestoreOperationSchema(db);
    db.exec("COMMIT");
    expect(snapshot()).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sync_relay_migrations WHERE migration_id IN ('live-restore-declined-v1','live-restore-publication-v1')",
        )
        .get(),
    ).toEqual({ n: 2 });
    expect(() => initializeLiveRestoreOperationSchema(db)).not.toThrow();
  } finally {
    f.close();
  }
});

function layOutEarlierRestoreStore(
  db: StorageContext["db"],
  tables: [table: string, sql: string, later: string[]][],
  indexes: string[],
  migrations: string[],
) {
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("PRAGMA legacy_alter_table=ON");
  db.exec("BEGIN");
  for (const [table, sql, later] of tables) {
    const columns = db
      .prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`)
      .all()
      .map((row) => String(row.name))
      .filter((name) => !later.includes(name))
      .join(",");
    db.exec(
      `ALTER TABLE ${table} RENAME TO ${table}_later; ${sql}; INSERT INTO ${table}(${columns}) SELECT ${columns} FROM ${table}_later; DROP TABLE ${table}_later`,
    );
  }
  for (const sql of indexes) db.exec(sql);
  for (const migration of migrations)
    db.prepare("DELETE FROM sync_relay_migrations WHERE migration_id=?").run(migration);
  db.exec("COMMIT");
  db.exec("PRAGMA legacy_alter_table=OFF");
  db.exec("PRAGMA foreign_keys=ON");
}

it("starts a fresh restore author window at the 960-identity checkpoint band", async () => {
  const f = contentProposalFixture("owner", "device", false, false, false, 960);
  try {
    const accepted = f.store.captureStopRestoreAcceptedCut(f.input);
    expect(accepted.checkpoint.cursor).toBe(960);
    expect(accepted.events).toEqual([]);
    const proposed = await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
    const admitted = await f.store.admitStopRestoreProposal(
      f.input,
      proposed.proposalDigest,
      restore,
      201,
    );
    expect(admitted.admitted.authorSnapshot).toEqual([]);
    expect(admitted.admitted.checkpointCoverage?.map((entry) => entry.author)).toEqual([
      { kind: "unattributed" },
    ]);
  } finally {
    f.close();
  }
});

async function admittedRestoreFixture(
  kind: "owner" | "bootstrap" = "owner",
  pending: boolean | "deleted" = true,
  mode: "service" | "device" = "device",
  beforeFence?: Parameters<typeof readyNativeFence>[4],
) {
  return admitRestore(contentProposalFixture(kind, mode, pending, false, false, 0, beforeFence));
}
async function admitRestore<
  F extends Pick<ReturnType<typeof contentProposalFixture>, "store" | "input" | "encoded">,
>(f: F) {
  const proposal = await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200);
  const admitted = await f.store.admitStopRestoreProposal(
    f.input,
    proposal.proposalDigest,
    restore,
    201,
  );
  const application = {
    fence: admitted.preparation.fence,
    candidateDigest: admitted.candidateDigest,
    nativeSourceManifestDigest: admitted.nativeSourceManifestDigest,
    admitted: admitted.admitted,
    localHeadSequence: admitted.preparation.fence.localHeadSequence + 1,
    hostCoordinate: {
      hostId: f.input.host.hostId,
      hostEpoch: f.input.host.hostEpoch,
      instanceId: f.input.host.instanceId,
      connectionId: f.input.host.connectionId,
    },
    recordedAtMs: 202,
  };
  const settlement = {
    settlementId: "restore-settlement",
    previousCursor: 0,
    terminalCursor: admitted.admitted.accepted.receipt.journalCursor,
    applicationCount: 3,
    localYDocSequence: application.localHeadSequence,
    momentId: "restore-moment",
    markdownDigest: admitted.preparation.point.markdownDigest,
    materialized: true,
    collectionReconcileRequired: false,
  };
  const resume = {
    relayDatabaseNamespace: admitted.preparation.fence.operation.relayDatabaseNamespace,
    operationId: f.input.operationId,
    binding: admitted.admitted.accepted.binding,
    applicationReceipt: admitted.admitted.accepted.receipt,
    settlementId: settlement.settlementId,
    momentId: settlement.momentId,
    markdownDigest: settlement.markdownDigest,
    localHeadSequence: application.localHeadSequence,
    recordedAtMs: 204,
  };
  const complete = (store = f.store) => {
    store.acknowledgeStopRestoreReplacement(f.input, application);
    store.acknowledgeStopRestoreSettlement(f.input, settlement);
    return store.acknowledgeStopRestoreResume(f.input, resume);
  };
  return { ...f, proposal, admitted, application, settlement, resume, complete };
}
const lifecycleRows = (
  f: Pick<ReturnType<typeof contentProposalFixture>, "raw" | "journalRows">,
) => ({
  ...proposalRows(f),
  lifecycle: f.raw.prepare("SELECT * FROM sync_relay_live_restore_lifecycles").all(),
  sources: f.raw.prepare("SELECT * FROM sync_relay_live_restore_source_ranges").all(),
  operations: f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(),
  owners: f.raw.prepare("SELECT * FROM sync_relay_live_delivery_owners").all(),
  edges: f.raw.prepare("SELECT * FROM sync_relay_live_delivery_edges").all(),
});

async function repeatedReviewFixture(rounds = 1) {
  const f = await admittedRestoreFixture("owner", "deleted");
  try {
    f.complete();
    let published = await publishRestore(f, f.admitted, "review-publication-0"),
      previous = f.admitted.admitted.accepted.receipt.journalCursor;
    for (let round = 1; ; round++) {
      const at = 200 + 100 * round,
        grantGeneration = 4 + 2 * round;
      f.raw
        .prepare(
          "UPDATE sync_relay_share_grants SET status='active',generation=?,revoked_at_ms=NULL WHERE grant_id='grant'",
        )
        .run(grantGeneration);
      const intent = {
        ...f.intent,
        operationId: round === 1 ? "review-second" : `review-${round + 1}`,
        expectedFence: 1 + round,
        expectedGrantGeneration: grantGeneration,
      };
      beginStopRestore(f.context, intent, at);
      const lookup = { ...f.lookup, operationId: intent.operationId };
      advanceStopRestoreFence(f.context, lookup, at + 1);
      const opened = f.store.openStopRestoreCut(lookup);
      if (opened.kind !== "ready") throw Error(opened.kind);
      expect(f.store.nextStopRestoreCut(opened.capture).kind).toBe("done");
      f.store.completeStopRestoreCut(opened.capture);
      const receipt = {
        operation: f.store.pendingStopRestoreFence(lookup).operation,
        localHeadSequence: 2 + 10 * round,
        recordedAtMs: at + 2,
      };
      f.store.acknowledgeStopRestoreFence(lookup, receipt);
      const input = { ...lookup, maxBytes: 1_000_000, maxEvents: 40 };
      const proposal = {
        ...f.receipt,
        fence: receipt,
        point: resolveLiveRestorePoint(f.store.captureStopRestorePoint(input), policy),
        selectedHistory: f.store.captureStopRestorePoint(input).proof,
        acceptedHistory: f.store.captureStopRestoreAcceptedCut(input).proof,
        originEvidenceDigest: f.store.captureStopRestoreOwnerOrigin(input).evidenceDigest,
        nativeSources: [],
        nativeSourceManifestDigest: jsonHash([receipt, []]),
      };
      const second = buildContentProposal({ ...f, input, lookup, receipt, proposal });
      const saved = await f.store.recordStopRestoreProposal(input, second.encoded, restore, at + 3);
      if (round === rounds)
        return { ...second, first: f, saved, reviewInput: { ...input, maxOutputBytes: 1_000_000 } };
      const admitted = await f.store.admitStopRestoreProposal(
        input,
        saved.proposalDigest,
        restore,
        at + 4,
      );
      const application = {
        ...f.application,
        fence: admitted.preparation.fence,
        candidateDigest: admitted.candidateDigest,
        nativeSourceManifestDigest: admitted.nativeSourceManifestDigest,
        admitted: admitted.admitted,
        localHeadSequence: receipt.localHeadSequence + 1,
        recordedAtMs: at + 5,
      };
      f.store.acknowledgeStopRestoreReplacement(input, application);
      const settlement = {
        ...f.settlement,
        settlementId: `settlement-${round}`,
        momentId: `moment-${round}`,
        terminalCursor: admitted.admitted.accepted.receipt.journalCursor,
        localYDocSequence: application.localHeadSequence,
        markdownDigest: admitted.preparation.point.markdownDigest,
      };
      f.store.acknowledgeStopRestoreSettlement(input, settlement);
      f.store.acknowledgeStopRestoreResume(input, {
        ...f.resume,
        operationId: input.operationId,
        binding: admitted.admitted.accepted.binding,
        applicationReceipt: admitted.admitted.accepted.receipt,
        settlementId: settlement.settlementId,
        momentId: settlement.momentId,
        markdownDigest: settlement.markdownDigest,
        localHeadSequence: application.localHeadSequence,
        recordedAtMs: at + 7,
      });
      published = await publishRestore(
        f,
        admitted,
        `review-publication-${round}`,
        previous,
        published.markdownDigest,
        round,
      );
      previous = admitted.admitted.accepted.receipt.journalCursor;
    }
  } catch (error) {
    f.close();
    throw error;
  }
}

it("returns a complete private review across a restore checkpoint, including already-deleted native work", async () => {
  const f = await repeatedReviewFixture();
  try {
    expect(f.receipt.acceptedHistory.suffix).toHaveLength(0);
    expect(f.receipt.acceptedHistory.checkpoint.eventCount).toBe(3);
    expect(Y.decodeUpdate(f.first.bytes.nativeSourceBytes[1]!).structs).toHaveLength(0);
    expect(
      f.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM sync_relay_live_restore_source_ranges WHERE source_ordinal=1",
        )
        .get()!.n,
    ).toBe(0);
    const before = lifecycleRows(f),
      review = (await f.store.readStopRestoreReview(f.reviewInput, restore))!;
    expect(review.proposalDigest).toBe(f.saved.proposalDigest);
    expect(
      review.acceptedEvents.map((event) => event.metadata.accepted.receipt.journalCursor),
    ).toEqual([1, 2, 3]);
    expect(review.priorRestoreCuts).toEqual([
      {
        operationId: "restore",
        proposalDigest: f.first.proposal.proposalDigest,
        restoreJournalCursor: 3,
        selectedEventCount: f.first.receipt.selectedHistory.eventCount,
        acceptedEventCount: f.first.receipt.acceptedHistory.eventCount,
        selectedTerminal: f.first.receipt.selectedHistory.terminal,
        frozenTerminal: f.first.receipt.acceptedHistory.terminal,
      },
    ]);
    expect(review.nativeSources).toHaveLength(2);
    expect(review.nativeSources.map((source) => source.acceptedRelation)).toEqual([
      "not-relay-accepted",
      "not-relay-accepted",
    ]);
    expect(review.nativeSources[1]!.source.deliveryId).toBe(
      f.first.receipt.nativeSources[1]!.deliveryId,
    );
    for (const source of review.nativeSources)
      expect(source.occurrences).toEqual([
        {
          operationId: "restore",
          proposalDigest: f.first.proposal.proposalDigest,
          context: "prior-restore",
          acceptedReceipt: null,
        },
      ]);
    expect(review.content.frozenMarkdownDigest).toBe(
      hash(Buffer.from(review.content.frozenMarkdown)),
    );
    expect(review.content.restoredMarkdownDigest).toBe(f.receipt.point.markdownDigest);
    expect(lifecycleRows(f)).toEqual(before);
  } finally {
    f.close();
  }
});

it.each(["workspace", "output", "historical-proposal"])(
  "refuses the complete restore review for %s without admitting a replacement",
  async (damage) => {
    const f = await repeatedReviewFixture();
    try {
      const input = structuredClone(f.reviewInput);
      if (damage === "owner") input.ownerUserId = "foreign";
      if (damage === "workspace") input.workspaceId = "foreign";
      if (damage === "host") Object.assign(input.host, { connectionId: "foreign" });
      if (damage === "events") input.maxEvents = 3;
      if (damage === "bytes") input.maxBytes = 1;
      if (damage === "output") input.maxOutputBytes = 1;
      if (damage === "metadata")
        f.raw.exec(
          "UPDATE sync_relay_live_update_journal SET received_at_ms=received_at_ms+1 WHERE journal_cursor=1",
        );
      if (damage === "missing-event")
        f.raw.exec("DELETE FROM sync_relay_live_update_journal WHERE journal_cursor=1");
      if (damage === "historical-proposal")
        f.raw.exec(
          "UPDATE sync_relay_live_restore_proposals SET proposal_bytes=zeroblob(length(proposal_bytes)) WHERE operation_id='restore'",
        );
      if (damage === "restore-marker")
        f.raw.exec(
          "UPDATE sync_relay_live_update_journal SET restore_operation_id=NULL WHERE journal_cursor=3",
        );
      const before = lifecycleRows(f);
      await expect(f.store.readStopRestoreReview(input, restore)).rejects.toThrow();
      expect(lifecycleRows(f)).toEqual(before);
    } finally {
      f.close();
    }
  },
);

it.each(["none", "one deleted"])(
  "keeps pending source attribution complete after restore: %s",
  async (damage) => {
    const f = await admittedRestoreFixture(),
      doc = new Y.Doc({ gc: false });
    try {
      f.complete();
      const checkpoint = f.raw
        .prepare(
          "SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE restore_operation_id=?",
        )
        .get(f.input.operationId)!;
      Y.applyUpdate(doc, checkpoint.validation_checkpoint_bytes as Uint8Array);
      doc.getMap("frontmatter").set("later", "ordinary work");
      const candidate = Y.encodeStateAsUpdate(doc),
        capture = f.journalCapture(candidate, "after-restore");
      expect(
        f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_restore_source_ranges").get()!
          .count,
      ).toBe(2);
      if (damage === "all deleted") f.raw.exec("DELETE FROM sync_relay_live_restore_source_ranges");
      if (damage === "one deleted")
        f.raw.exec("DELETE FROM sync_relay_live_restore_source_ranges WHERE source_ordinal=0");
      if (damage === "manifest changed")
        f.raw.exec(
          "UPDATE sync_relay_live_restore_source_ranges SET source_sha256='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'",
        );
      const before = lifecycleRows(f);
      if (damage !== "none") {
        expect(() => f.storage.commitLiveUpdateJournal(capture)).toThrow();
        expect(lifecycleRows(f)).toEqual(before);
      } else {
        const result = f.storage.commitLiveUpdateJournal(capture);
        expect(result.result.kind).toBe("accepted");
        const firstSeen = result.admitted!.metadata.firstSeen;
        expect(firstSeen.length).toBe(1);
        expect(firstSeen[0]!.clientId).toBe(doc.clientID);
        expect(firstSeen[0]!.endClock - firstSeen[0]!.startClock).toBe(1);
      }
    } finally {
      doc.destroy();
      f.close();
    }
  },
);
it("funds all restore receipts before admission and keeps the journal unchanged on quota refusal", async () => {
  const f = contentProposalFixture();
  try {
    const proposal = await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200),
      before = lifecycleRows(f),
      original = f.context.options.workspaceQuotaBytes;
    f.context.options.workspaceQuotaBytes = Number(before.usage) + 1;
    await expect(
      f.store.admitStopRestoreProposal(f.input, proposal.proposalDigest, restore, 201),
    ).rejects.toThrow(/quota/);
    expect(lifecycleRows(f)).toEqual(before);
    f.context.options.workspaceQuotaBytes = original;
    const admitted = await f.store.admitStopRestoreProposal(
      f.input,
      proposal.proposalDigest,
      restore,
      201,
    );
    expect(admitted.phase).toBe("relay-admitted");
    expect(
      Number(
        f.raw
          .prepare("SELECT receipt_reservation_bytes FROM sync_relay_live_restore_lifecycles")
          .get()!.receipt_reservation_bytes,
      ),
    ).toBeGreaterThan(0);
  } finally {
    f.close();
  }
});
it.each(["application"])(
  "recovers the exact restore after relay restart before %s acknowledgement",
  async (stage) => {
    const f = await admittedRestoreFixture();
    let reopened: ReturnType<typeof openSyncRelayStorage> | undefined,
      closed = false;
    try {
      if (stage !== "application")
        f.store.acknowledgeStopRestoreReplacement(f.input, f.application);
      if (stage === "resume") f.store.acknowledgeStopRestoreSettlement(f.input, f.settlement);
      f.close();
      closed = true;
      reopened = openSyncRelayStorage(f.path);
      const store = reopened.createLiveCommittedDeliveryStore(
        createLiveJournalHistoryAuthority({ namespace: "restore-test", reconciled: true }),
      );
      expect(f.complete(store).phase).toBe("resumed");
      expect(store.readStopRestoreLifecycle(f.input)!.resume).toEqual(f.resume);
    } finally {
      if (!closed) f.close();
      reopened?.close();
    }
  },
);

function retainedLifecyclePayloadBytes(db: StorageContext["db"], operationId: string): number {
  const op = db
    .prepare("SELECT * FROM sync_relay_live_restore_operations WHERE operation_id=?")
    .get(operationId)!;
  const lifecycle = db
    .prepare("SELECT * FROM sync_relay_live_restore_lifecycles WHERE operation_id=?")
    .get(operationId)!;
  const journal = db
    .prepare("SELECT * FROM sync_relay_live_update_journal WHERE restore_operation_id=?")
    .get(operationId)!;
  return (
    [
      op.intent_json,
      op.basis_json,
      op.terminal_json,
      op.applied_json,
      op.native_receipt_json,
      lifecycle.admission_json,
      lifecycle.application_json,
      lifecycle.pending_settlement_json,
      lifecycle.settlement_json,
      lifecycle.resume_json,
    ].reduce<number>(
      (sum, value) => sum + (value === null ? 0 : Buffer.byteLength(String(value))),
      0,
    ) +
    (journal.update_bytes as Uint8Array).byteLength +
    (journal.validation_checkpoint_bytes as Uint8Array).byteLength +
    Number(journal.accepted_metadata_bytes) +
    Number(lifecycle.receipt_reservation_bytes)
  );
}
it("rolls back admission one byte below its funded read budget and can retry to completion", async () => {
  const f = contentProposalFixture("owner", "device", true),
    tx = f.context.tx.bind(f.context);
  try {
    const proposal = await f.store.recordStopRestoreProposal(f.input, f.encoded, restore, 200),
      before = lifecycleRows(f);
    let required = 0;
    const dryRun = vi.spyOn(f.context, "tx").mockImplementation((run) =>
      tx(() => {
        run();
        required = retainedLifecyclePayloadBytes(f.context.db, f.input.operationId);
        throw Error("measured rollback");
      }),
    );
    try {
      await expect(
        f.store.admitStopRestoreProposal(f.input, proposal.proposalDigest, restore, 201),
      ).rejects.toThrow("measured rollback");
    } finally {
      dryRun.mockRestore();
    }
    expect(lifecycleRows(f)).toEqual(before);
    expect(required).toBeGreaterThan(f.encoded.length);
    let reachedAdmission = false;
    const observe = vi.spyOn(f.context, "tx").mockImplementation((run) =>
      tx(() => {
        try {
          return run();
        } catch (error) {
          reachedAdmission =
            f.context.db
              .prepare("SELECT 1 FROM sync_relay_live_restore_lifecycles WHERE operation_id=?")
              .get(f.input.operationId) !== undefined;
          throw error;
        }
      }),
    );
    try {
      await expect(
        f.store.admitStopRestoreProposal(
          { ...f.input, maxBytes: required - 1 },
          proposal.proposalDigest,
          restore,
          201,
        ),
      ).rejects.toThrow();
    } finally {
      observe.mockRestore();
    }
    expect(reachedAdmission).toBe(true);
    expect(lifecycleRows(f)).toEqual(before);
    const admitted = await f.store.admitStopRestoreProposal(
      { ...f.input, maxBytes: required },
      proposal.proposalDigest,
      restore,
      201,
    );
    expect(admitted.phase).toBe("relay-admitted");
    const application = {
      fence: admitted.preparation.fence,
      candidateDigest: admitted.candidateDigest,
      nativeSourceManifestDigest: admitted.nativeSourceManifestDigest,
      admitted: admitted.admitted,
      localHeadSequence: admitted.preparation.fence.localHeadSequence + 1,
      hostCoordinate: {
        hostId: f.input.host.hostId,
        hostEpoch: f.input.host.hostEpoch,
        instanceId: f.input.host.instanceId,
        connectionId: f.input.host.connectionId,
      },
      recordedAtMs: 202,
    };
    const settlement = {
      settlementId: "budget-settlement",
      previousCursor: 0,
      terminalCursor: admitted.admitted.accepted.receipt.journalCursor,
      applicationCount: 3,
      localYDocSequence: application.localHeadSequence,
      momentId: "budget-moment",
      markdownDigest: admitted.preparation.point.markdownDigest,
      materialized: true,
      collectionReconcileRequired: false,
    };
    const resume = {
      relayDatabaseNamespace: admitted.preparation.fence.operation.relayDatabaseNamespace,
      operationId: f.input.operationId,
      binding: admitted.admitted.accepted.binding,
      applicationReceipt: admitted.admitted.accepted.receipt,
      settlementId: settlement.settlementId,
      momentId: settlement.momentId,
      markdownDigest: settlement.markdownDigest,
      localHeadSequence: application.localHeadSequence,
      recordedAtMs: 204,
    };
    const budget = { ...f.input, maxBytes: required };
    f.store.acknowledgeStopRestoreReplacement(budget, application);
    f.store.acknowledgeStopRestoreSettlement(budget, settlement);
    expect(f.store.acknowledgeStopRestoreResume(budget, resume).phase).toBe("resumed");
  } finally {
    f.close();
  }
});

function restorePublication(
  f: Pick<
    Awaited<ReturnType<typeof admittedRestoreFixture>>,
    "document" | "raw" | "admitted" | "storage"
  >,
  bytes: Uint8Array,
  terminal: number,
  id: string,
  previous = 0,
  before = String(
    f.raw.prepare("SELECT baseline_projected_sha256 FROM sync_relay_live_documents").get()!
      .baseline_projected_sha256,
  ),
  originSeq = 0,
) {
  const document = f.document,
    row = f.raw
      .prepare("SELECT * FROM sync_relay_live_update_journal WHERE journal_cursor=?")
      .get(terminal)!;
  const binding = { ...f.admitted.admitted.accepted.binding };
  const normalized = createLiveMarkdownRegistrationValidator(policy)({
    document,
    currentPath: binding.currentPath,
    checkpoint: bytes,
  });
  if (normalized.kind !== "accepted") throw Error(normalized.reason);
  const markdown = Buffer.from(normalized.evidence.projectedMarkdown),
    markdownDigest = hash(markdown),
    stateDigest = hash(bytes);
  for (const [sha256, content] of [
    [stateDigest, bytes],
    [markdownDigest, markdown],
  ] as const)
    f.storage.putBlob({ workspaceId: document.workspaceId, sha256, content, createdAtMs: 1 });
  const prior =
    previous === 0
      ? null
      : f.raw
          .prepare("SELECT * FROM sync_relay_live_update_journal WHERE journal_cursor=?")
          .get(previous)!;
  const namespace = String(row.relay_database_namespace),
    key = [
      namespace,
      document.workspaceId,
      document.mainVersionId,
      document.objectId,
      document.lineageClaimId,
    ];
  const acceptedEventCount =
    Number(row.accepted_event_count) - Number(prior?.accepted_event_count ?? 0);
  const record = {
    settlementId: "",
    relayDatabaseNamespace: namespace,
    binding,
    hostCoordinate: {
      hostId: "host",
      hostEpoch: 1,
      instanceId: "instance",
      connectionId: "connection",
    },
    previousCursor: previous,
    terminalCursor: terminal,
    previousYdocSequence: 0,
    localYdocSequence: 1,
    applicationCount: acceptedEventCount,
    nativeIntervalDigest: hash(Buffer.from(`native-interval-${id}`)),
    acceptedEventCount,
    acceptedIntervalDigest: jsonHash([
      "live-settlement-accepted-interval-v1",
      key,
      [
        Number(prior?.accepted_event_count ?? 0),
        previous,
        prior?.accepted_evidence_digest ?? initialAcceptedHistoryDigest(namespace, document),
      ],
      [Number(row.accepted_event_count), terminal, row.accepted_evidence_digest],
    ]),
    momentId: id,
    markdownDigest,
    sourceStateVectorDigest: hash(Buffer.from(`state-vector-${id}`)),
    acceptedStateBlobSha256: stateDigest,
    recordedAtMs: 1,
    restoreOperationId: null,
  };
  record.settlementId = nativeSettlementId(record);
  const payload = {
    momentId: id,
    objectId: document.objectId,
    versionId: "main",
    path: binding.currentPath,
    operation: "write",
    payloadBeforePath: binding.currentPath,
    payloadAfterPath: binding.currentPath,
    payloadBeforeContentKind: "text",
    payloadAfterContentKind: "text",
    payloadBeforeBlobSha256: before,
    payloadAfterBlobSha256: markdownDigest,
    payloadAfterByteLength: markdown.byteLength,
    recordedAtMs: 1,
    settlementReference: { formatVersion: 1, recordDigest: settlementRecordDigest(record), record },
  };
  return {
    record,
    payload,
    markdownDigest,
    op: {
      originSeq,
      opKind: "moment.append",
      payloadJson: stableJsonStringify(payload),
      recordedAtMs: 1,
    },
  };
}

it("publishes hosted settlement at a verified closed restore fence and chains the next ordinary settlement", async () => {
  const f = await admittedRestoreFixture(),
    doc = new Y.Doc({ gc: false });
  try {
    const restoreCursor = f.admitted.admitted.accepted.receipt.journalCursor;
    const bytes = f.raw
      .prepare(
        "SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?",
      )
      .get(restoreCursor)!.validation_checkpoint_bytes as Uint8Array;
    const first = restorePublication(f, bytes, restoreCursor, "published-restore");
    await prepareHostedSettlements(f.context, {
      workspaceId: "workspace",
      originId: "proof",
      ops: [first.op],
    });
    expect(first.op).toMatchObject({ settlementAdmission: { status: "accepted" } });
    expect(
      f.storage.appendLogBatch({ workspaceId: "workspace", originId: "proof", ops: [first.op] }),
    ).toMatchObject({ inserted: 1 });
    expect(first.op).toMatchObject({ settlementAdmission: { status: "accepted" } });
    expect(
      f.raw.prepare("SELECT admission_state FROM sync_relay_live_documents").get()!.admission_state,
    ).toBe("closed");
    expect(
      f.storage.fetchLogCoordinate({ workspaceId: "workspace", originId: "proof", originSeq: 0 })!
        .admittedAuthorSnapshot,
    ).toEqual([{ kind: "unattributed" }]);
    f.complete();
    Y.applyUpdate(doc, bytes);
    doc.getMap("frontmatter").set("after", "continued work");
    const captured = f.journalCapture(Y.encodeStateAsUpdate(doc), "post-restore");
    const accepted = f.storage.commitLiveUpdateJournal({
      ...captured,
      trustedAccount: { accountId: "owner", name: "Owner" },
      metadata: { ...captured.metadata, authorContext: { kind: "account", accountId: "owner" } },
    });
    expect(accepted.result.kind).toBe("accepted");
    const second = restorePublication(
      f,
      Y.encodeStateAsUpdate(doc),
      accepted.admitted!.metadata.accepted.receipt.journalCursor,
      "published-next",
      restoreCursor,
      first.markdownDigest,
      1,
    );
    await prepareHostedSettlements(f.context, {
      workspaceId: "workspace",
      originId: "proof",
      ops: [second.op],
    });
    expect(
      f.storage.appendLogBatch({ workspaceId: "workspace", originId: "proof", ops: [second.op] })
        .settlementRefusals,
    ).toBeUndefined();
    expect(
      f.storage.fetchLogCoordinate({ workspaceId: "workspace", originId: "proof", originSeq: 1 })!
        .admittedAuthorSnapshot,
    ).toEqual([{ kind: "human", humanId: "owner", humanName: "Owner" }]);
  } finally {
    doc.destroy();
    f.close();
  }
});

it.each(["old-fence"])("consumes invalid hosted restore proof: %s", async (damage) => {
  const f = await admittedRestoreFixture();
  try {
    const terminal = f.admitted.admitted.accepted.receipt.journalCursor;
    const bytes = f.raw
      .prepare(
        "SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?",
      )
      .get(terminal)!.validation_checkpoint_bytes as Uint8Array;
    const publication = restorePublication(f, bytes, terminal, "bad-restore");
    if (damage !== "changed-admission") {
      publication.record.binding.restoreFenceGeneration =
        damage === "old-fence"
          ? publication.record.binding.restoreFenceGeneration - 1
          : publication.record.binding.restoreFenceGeneration + 1;
      publication.payload.settlementReference.recordDigest = hash(
        Buffer.from(stableJsonStringify(publication.record)),
      );
      publication.op.payloadJson = stableJsonStringify(publication.payload);
    }
    await prepareHostedSettlements(f.context, {
      workspaceId: "workspace",
      originId: "proof",
      ops: [publication.op],
    });
    if (damage === "changed-admission")
      f.raw
        .prepare("UPDATE sync_relay_live_restore_lifecycles SET admission_sha256=?")
        .run("a".repeat(64));
    expect(
      f.storage.appendLogBatch({
        workspaceId: "workspace",
        originId: "proof",
        ops: [publication.op],
      }).settlementRefusals,
    ).toHaveLength(1);
    expect(
      f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_settlement_bindings").get()!.n,
    ).toBe(0);
  } finally {
    f.close();
  }
});
afterAll(async () => {
  await liveValidation.close();
});
