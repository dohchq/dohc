import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createLiveValidationExecutor } from "./liveValidation.js";
import type { StorageContext } from "./storage/context.js";
import type { LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import { SERVICE_ACTIVATIONS } from "./storage/serviceActivationSchema.js";
import { pauseLiveRoom } from "./storage/liveRoomPauses.js";
import {
  readServiceActivationRetirement,
  type RetirementKey,
} from "./storage/serviceActivationRetirement.js";
import { liveJournalCut } from "./storage/liveUpdateJournal.js";
import { createLiveMarkdownRegistrationValidator } from "../../../packages/ydoc-projection/src/liveDocumentValidation.js";
import {
  markdownToYDoc,
  yDocToMarkdown,
} from "../../../packages/ydoc-projection/src/import-export.js";
import {
  cleanupLiveDeliveryFixtures,
  registered,
} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
import { noteResolve, RESOLVE_BLOBS } from "./singleNoteResolve.test-helper.js";
import { ACTIVATION, typedRelayNote as seedTypedRelayNote } from "./testing/typedNotes.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  cleanupLiveDeliveryFixtures();
});
const typedRelayNote = () =>
  seedTypedRelayNote(20, (close) => {
    cleanup.push(close);
  });
type Note = Awaited<ReturnType<typeof typedRelayNote>>;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function validation() {
  const pool = createLiveValidationExecutor();
  cleanup.push(() => pool.close());
  return pool.ordinaryActivation(ACTIVATION.validation);
}

async function activate(
  note: Note,
  validate: ReturnType<typeof validation>,
  capture = note.capture,
) {
  return note.deployment.storage
    .createServiceActivationStore(note.deployment.history)
    .prepare({
      capture,
      host: note.host,
      registeredAtMs: 3,
      guard() {},
      validate,
      bounds: {
        maxCaptureBytes: ACTIVATION.maxCaptureBytes,
        maxBytesPerDrain: ACTIVATION.maxBytesPerDrain,
      },
    })
    .then(
      (value) => value,
      (error: unknown) => error,
    );
}

function markdownOf(state: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const text = Buffer.from(yDocToMarkdown(doc));
  doc.destroy();
  return text;
}

type Successor = ReturnType<typeof successor>;
function successor(
  predecessor: LiveDocumentKey,
  path: string,
  text: string,
  clientID: number,
  resolved = true,
) {
  const epochTag = sha256(`epoch-${text}`);
  const seed = markdownToYDoc(text, { clientID });
  if (resolved) seed.getMap("meta").set("dohcLineageEpoch", epochTag);
  const baseline = Y.encodeStateAsUpdate(seed),
    stateVector = Y.encodeStateVector(seed);
  seed.destroy();
  const document = {
    ...predecessor,
    mainVersionId: "main" as const,
    lineageClaimId: sha256(baseline),
  };
  const projected = createLiveMarkdownRegistrationValidator(ACTIVATION.validation)({
    document,
    currentPath: path,
    checkpoint: baseline,
  });
  const markdown = markdownOf(baseline);
  if (
    projected.kind !== "accepted" ||
    projected.evidence.projectedMarkdownSha256 !== sha256(markdown) ||
    projected.evidence.projectedMarkdownByteLength !== markdown.length
  )
    throw new Error("Invalid successor fixture.");
  return { document, baseline, stateVector, epochTag, markdown };
}

function pushResolve(
  storage: Pick<Note["deployment"]["storage"], "appendLogBatch">,
  putBlob: (bytes: Uint8Array) => void,
  input: {
    predecessor: LiveDocumentKey;
    path: string;
    current: Buffer;
    next: Successor;
    originSeq?: number;
  },
) {
  const { predecessor, path, current, next, originSeq = 0 } = input;
  for (const bytes of [
    current,
    next.markdown,
    next.baseline,
    next.stateVector,
    RESOLVE_BLOBS.incoming.content,
  ])
    putBlob(bytes);
  const payload = noteResolve(
    { workspaceId: "workspace", objectId: predecessor.objectId, path, recordedAtMs: 20 },
    ({ transition, lineageTransition }) => {
      transition.current = {
        ...transition.current,
        blobSha256: sha256(current),
        byteLength: current.length,
      };
      transition.result = {
        ...transition.result,
        blobSha256: sha256(next.markdown),
        byteLength: next.markdown.length,
      };
      lineageTransition.predecessorClaimId = predecessor.lineageClaimId;
      lineageTransition.artifactPreimageSha256 = sha256(current);
      lineageTransition.successor = {
        lineageClaimId: next.document.lineageClaimId,
        epochTag: next.epochTag,
        contentKind: "richdoc",
        resultSha256: sha256(next.markdown),
        updateBlobSha256: next.document.lineageClaimId,
        stateVectorBlobSha256: sha256(next.stateVector),
      };
    },
  );
  return storage.appendLogBatch({
    workspaceId: "workspace",
    originId: "owner-desktop",
    ops: [
      {
        originSeq,
        opKind: "conflict.resolve",
        payloadJson: JSON.stringify(payload),
        recordedAtMs: 20,
      },
    ],
  });
}

function resolveTypedNote(
  note: Note,
  next: Successor,
  chain?: { originSeq: number; predecessor: LiveDocumentKey; current: Buffer },
) {
  const blob = note.raw.prepare(
    "INSERT OR IGNORE INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)",
  );
  const pushed = pushResolve(
    note.deployment.storage,
    (bytes) => blob.run(sha256(bytes), bytes.length, bytes),
    {
      predecessor: chain?.predecessor ?? note.document,
      path: note.path,
      current: chain?.current ?? markdownOf(note.note.fullState),
      next,
      originSeq: chain?.originSeq,
    },
  );
  const baseRelaySeq = Number(
    note.raw
      .prepare(
        "SELECT relay_seq FROM sync_relay_log WHERE origin_id='owner-desktop' AND origin_seq=?",
      )
      .get(chain?.originSeq ?? 0)!.relay_seq,
  );
  note.appendWrite(
    "moment-resolved",
    {
      projectedMarkdownSha256: sha256(next.markdown),
      projectedMarkdownByteLength: next.markdown.length,
    },
    true,
  );
  return { pushed, baseRelaySeq };
}

function captureOf(
  note: Note,
  next: Successor,
  base: { baseOriginId: string; baseOriginSeq: number; baseRelaySeq: number },
) {
  const captured = note.captureAt(next.baseline);
  return {
    ...captured,
    activationId: `ordinary-activation-${"b".repeat(64)}`,
    baselineBytes: Buffer.from(next.baseline),
    source: { ...captured.source, ...next.document, ...base },
  };
}

const liveDocumentRows = (note: Note) =>
  note.raw
    .prepare(
      "SELECT lineage_claim_id,lineage_state,admission_state,replaces_lineage_claim_id FROM sync_relay_live_documents ORDER BY lineage_state DESC",
    )
    .all();

async function sharedNote() {
  const note = await typedRelayNote();
  note.raw
    .prepare(
      "INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('share','workspace','owner',?,0)",
    )
    .run(JSON.stringify({ paths: ["notes"], versionId: null }));
  note.raw.exec(
    "INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES ('grant','share','user','reader',NULL,'edit',4,'active',0,NULL,NULL)",
  );
  note.deployment.storage.ensureOwnedLiveDocument({
    intent: "share",
    workspaceId: "workspace",
    path: note.path,
    shareId: "share",
    ownerUserId: "owner",
    nowMs: 2,
    guard() {},
  });
  return note;
}

const enrolment = (note: Note) =>
  note.raw.prepare("SELECT state,retired FROM sync_relay_service_host_enrollments").all();

function hostRetires(note: Note) {
  const open = readServiceActivationRetirement(
    note.deployment.storage as unknown as StorageContext,
    note.document,
  )!;
  expect(
    note.deployment.storage
      .createServiceActivationStore(note.deployment.history)
      .completeRetirement({
        workspaceId: "workspace",
        key: {
          objectId: open.objectId,
          lineageClaimId: open.lineageClaimId,
          activationId: open.activationId,
          restoreFenceGeneration: open.restoreFenceGeneration,
          acceptedThrough: open.acceptedThrough,
        },
        boundary: null,
        host: note.host,
        registeredAtMs: 30,
        nowMs: 30,
        guard() {},
      }),
  ).toEqual({ status: "retired", replayed: false });
  note.deployment.storage.releaseServiceHostEnrollment({
    workspaceId: "workspace",
    objectId: note.document.objectId,
    nowMs: 31,
  });
}

it("accepting a replacement closes an open session's claim, so the next save on it is refused as stale", () => {
  const f = registered();
  cleanup.push(() => f.close());
  const document = f.input.evidence.document;
  const current = () =>
    f.storage.resolveCurrentLiveDocumentBinding({ document, actor: f.actor }).kind;
  expect(current()).toBe("current");
  const path = f.input.evidence.currentPath;

  const pushed = pushResolve(
    f.storage,
    (bytes) =>
      f.write((db) =>
        db
          .prepare(
            "INSERT OR IGNORE INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)",
          )
          .run(sha256(bytes), bytes.length, bytes),
      ),
    {
      predecessor: document,
      path,
      current: markdownOf(f.input.baselineBytes),
      next: successor(document, path, "Merged on the owner's desktop\n", 3),
    },
  );
  expect(pushed).toMatchObject({ inserted: 1 });
  expect(f.storage.resolveCurrentLiveDocumentBinding({ document, actor: f.actor })).toEqual({
    kind: "refused",
    reason: "stale-document",
  });
  expect(
    f.raw.prepare("SELECT lineage_state,admission_state FROM sync_relay_live_documents").all(),
  ).toEqual([{ lineage_state: "current", admission_state: "closed" }]);
});

it("a successor registers after its predecessor's resolve, while a pause is left on the old claim", async () => {
  const note = await sharedNote();
  const validate = validation();
  expect(await activate(note, validate)).toMatchObject({ replayed: false });
  pauseLiveRoom(note.deployment.storage as unknown as StorageContext, {
    document: note.document,
    cause: "refused",
    refusal: "stale-binding",
    named: [],
    copy: new Uint8Array([1]),
    pausedAtMs: 4,
  });
  const next = successor(note.document, note.path, "Merged on the owner's desktop\n", 3);
  const { pushed, baseRelaySeq } = resolveTypedNote(note, next);
  expect(pushed).toMatchObject({ inserted: 1 });
  expect(
    note.raw
      .prepare(
        `SELECT lineage_claim_id,retire_requested_at_ms IS NOT NULL AS retiring FROM ${SERVICE_ACTIVATIONS}`,
      )
      .all(),
  ).toEqual([{ lineage_claim_id: note.document.lineageClaimId, retiring: 1 }]);
  hostRetires(note);

  const capture = captureOf(note, next, {
    baseOriginId: "owner-desktop",
    baseOriginSeq: 0,
    baseRelaySeq,
  });
  expect(await activate(note, validate, capture)).toEqual({
    document: next.document,
    replayed: false,
    completed: false,
  });
  expect(liveDocumentRows(note)).toEqual([
    {
      lineage_claim_id: note.document.lineageClaimId,
      lineage_state: "retired",
      admission_state: "closed",
      replaces_lineage_claim_id: null,
    },
    {
      lineage_claim_id: next.document.lineageClaimId,
      lineage_state: "current",
      admission_state: "open",
      replaces_lineage_claim_id: note.document.lineageClaimId,
    },
  ]);
});

it("a successor takes over a note an Edit share keeps live, once its predecessor retired", async () => {
  const note = await sharedNote();
  const validate = validation();
  expect(await activate(note, validate)).toMatchObject({ replayed: false });
  expect(
    note.deployment.storage.moveLiveNote({
      workspaceId: "workspace",
      objectId: note.document.objectId,
      move: "started",
      generation: 1,
      nowMs: 4,
    }),
  ).toMatchObject({ moved: true });
  const next = successor(note.document, note.path, "Merged on the owner's desktop\n", 3);
  const { baseRelaySeq } = resolveTypedNote(note, next);
  hostRetires(note);
  expect(enrolment(note)).toEqual([{ state: "live", retired: 0 }]);

  const capture = captureOf(note, next, {
    baseOriginId: "owner-desktop",
    baseOriginSeq: 0,
    baseRelaySeq,
  });
  expect(await activate(note, validate, capture)).toEqual({
    document: next.document,
    replayed: false,
    completed: false,
  });
  expect(liveDocumentRows(note).map((row) => row.lineage_state)).toEqual(["retired", "current"]);
  expect(enrolment(note)).toEqual([{ state: "live", retired: 0 }]);
});

it("a successor registers after a second resolve replaced the first successor before it registered", async () => {
  const note = await sharedNote();
  const validate = validation();
  expect(await activate(note, validate)).toMatchObject({ replayed: false });
  const first = successor(note.document, note.path, "Merged on the owner's desktop\n", 3);
  resolveTypedNote(note, first);
  const next = successor(first.document, note.path, "Merged again on the owner's desktop\n", 4);
  const { baseRelaySeq } = resolveTypedNote(note, next, {
    originSeq: 1,
    predecessor: first.document,
    current: first.markdown,
  });
  hostRetires(note);

  const capture = captureOf(note, next, {
    baseOriginId: "owner-desktop",
    baseOriginSeq: 1,
    baseRelaySeq,
  });
  expect(await activate(note, validate, capture)).toEqual({
    document: next.document,
    replayed: false,
    completed: false,
  });
  expect(liveDocumentRows(note)).toEqual([
    {
      lineage_claim_id: note.document.lineageClaimId,
      lineage_state: "retired",
      admission_state: "closed",
      replaces_lineage_claim_id: null,
    },
    {
      lineage_claim_id: next.document.lineageClaimId,
      lineage_state: "current",
      admission_state: "open",
      replaces_lineage_claim_id: note.document.lineageClaimId,
    },
  ]);
});

it("a second resolve that does not continue the first can't replace the retired row", async () => {
  const note = await sharedNote();
  const validate = validation();
  expect(await activate(note, validate)).toMatchObject({ replayed: false });
  const first = successor(note.document, note.path, "Merged on the owner's desktop\n", 3);
  resolveTypedNote(note, first);
  const stranger = successor(note.document, note.path, "Typed somewhere else\n", 5);
  const next = successor(stranger.document, note.path, "Merged again on the owner's desktop\n", 4);
  const { baseRelaySeq } = resolveTypedNote(note, next, {
    originSeq: 1,
    predecessor: stranger.document,
    current: first.markdown,
  });
  hostRetires(note);
  const before = liveDocumentRows(note);

  const outcome = await activate(
    note,
    validate,
    captureOf(note, next, { baseOriginId: "owner-desktop", baseOriginSeq: 1, baseRelaySeq }),
  );
  expect(String((outcome as Error).message)).toMatch(/lineage-conflict/u);
  expect(liveDocumentRows(note)).toEqual(before);
});

it("a claim the resolve did not name can't register against the retired row", async () => {
  const note = await sharedNote();
  const validate = validation();
  expect(await activate(note, validate)).toMatchObject({ replayed: false });
  resolveTypedNote(note, successor(note.document, note.path, "Merged on the owner's desktop\n", 3));
  hostRetires(note);
  const before = liveDocumentRows(note);

  const other = successor(note.document, note.path, "Typed somewhere else\n", 4, false);
  note.appendWrite(
    "other-write",
    {
      projectedMarkdownSha256: sha256(other.markdown),
      projectedMarkdownByteLength: other.markdown.length,
    },
    true,
  );
  const baseRelaySeq = note.appendUpdate(other.baseline, {
    isBaseState: true,
    lineageClaimId: other.document.lineageClaimId,
  });
  const baseOriginSeq = Number(
    note.raw.prepare("SELECT origin_seq FROM sync_relay_log WHERE relay_seq=?").get(baseRelaySeq)!
      .origin_seq,
  );
  const outcome = await activate(
    note,
    validate,
    captureOf(note, other, { baseOriginId: "typist", baseOriginSeq, baseRelaySeq }),
  );
  expect(String((outcome as Error).message)).toMatch(/lineage-conflict/u);
  expect(liveDocumentRows(note)).toEqual(before);
});

describe("a retirement reading the journal of the note its resolve closed", () => {
  async function retiring() {
    const note = await sharedNote();
    expect(await activate(note, validation())).toMatchObject({ replayed: false });
    resolveTypedNote(
      note,
      successor(note.document, note.path, "Merged on the owner's desktop\n", 3),
    );
    const storage = note.deployment.storage as unknown as StorageContext;
    const open = readServiceActivationRetirement(storage, note.document)!;
    const key: RetirementKey = {
      objectId: open.objectId,
      lineageClaimId: open.lineageClaimId,
      activationId: open.activationId,
      restoreFenceGeneration: open.restoreFenceGeneration,
      acceptedThrough: open.acceptedThrough,
    };
    const read = (change: Partial<RetirementKey> = {}) =>
      liveJournalCut(storage, note.document, { ...key, ...change }).kind;
    return { note, key, read };
  }

  it("reads it for the open retirement it names", async () => {
    const { read } = await retiring();
    expect(read()).toBe("cut");
  });

  it.each<[string, (key: RetirementKey) => Partial<RetirementKey>]>([
    ["activation", () => ({ activationId: `ordinary-activation-${"c".repeat(64)}` })],
    ["claim", () => ({ lineageClaimId: "c".repeat(64) })],
    ["restore generation", (key) => ({ restoreFenceGeneration: key.restoreFenceGeneration + 1 })],
    ["accepted cursor", (key) => ({ acceptedThrough: key.acceptedThrough + 1 })],
  ])("refuses a retirement with another %s", async (_, change) => {
    const { key, read } = await retiring();
    expect(read(change(key))).toBe("refused");
  });

  it("refuses once the retirement completed", async () => {
    const { note, read } = await retiring();
    hostRetires(note);
    expect(read()).toBe("refused");
  });

  it("refuses an activation from another replication stream", async () => {
    const { note, read } = await retiring();
    note.raw
      .prepare(
        `UPDATE ${SERVICE_ACTIVATIONS} SET source_json=json_set(source_json,'$.streamIdentity','another-stream')`,
      )
      .run();
    expect(read()).toBe("refused");
  });
});
