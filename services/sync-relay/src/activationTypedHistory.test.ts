// Typing any amount must never stop a note from going live. Activation takes the captured baseline and full state as
// given and reads none of the note's history, so it costs what the note's size costs, not what its edit count costs.
// These tests drive the activation itself (`prepare`) with production settings.
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { createLiveValidationExecutor } from "./liveValidation.js";
import type { StorageContext } from "./storage/context.js";
import {
  ServiceActivationLineageEnding,
  ServiceActivationStaleCut,
} from "./storage/ordinaryActivationSource.js";
import { SERVICE_ACTIVATIONS } from "./storage/serviceActivationSchema.js";
import { ServiceActivationRefused } from "./storage/serviceActivation.js";
import { pauseLiveRoom } from "./storage/liveRoomPauses.js";
import { releaseRetiredLiveDelivery } from "./storage/liveDeliveryReservations.js";
import { serverLogLine } from "./serverLogWords.js";
import { createLiveMarkdownRegistrationValidator } from "../../../packages/ydoc-projection/src/liveDocumentValidation.js";
import {
  markdownToYDoc,
  yDocToMarkdown,
} from "../../../packages/ydoc-projection/src/import-export.js";
import {
  ACTIVATION,
  typedRelayNote as seedTypedRelayNote,
  type TypedRelayNote,
} from "./testing/typedNotes.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const typedRelayNote = (keystrokes: number) =>
  seedTypedRelayNote(keystrokes, (close) => {
    cleanup.push(close);
  });
/** The relay's validation as it runs in production: in its own child process, with the profile's policy. */
function validation() {
  const pool = createLiveValidationExecutor();
  cleanup.push(() => pool.close());
  return pool.ordinaryActivation(ACTIVATION.validation);
}

type Hold = { start: number; end: number };
/**
 * The longest time the event loop went without running a timer while `run` worked, counting a hold still going when
 * `run` settles, and the five longest holds. A timer is due every `everyMs`, so a loop that is never held reads about
 * `everyMs`. Promise callbacks run before any timer, so work made only of them holds the loop for its whole length.
 * `monitorEventLoopDelay` records a delay only from its second timer on, so it reads 0 for such a hold.
 */
async function longestHold<T>(run: () => Promise<T>, everyMs = 5) {
  let last = performance.now();
  const all: Hold[] = [];
  const timer = setInterval(() => {
    const now = performance.now();
    all.push({ start: last, end: now });
    last = now;
  }, everyMs);
  try {
    const value = await run();
    all.push({ start: last, end: performance.now() });
    const holds = [...all].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 5);
    return { value, longestMs: holds[0]!.end - holds[0]!.start, holds, all };
  } finally {
    clearInterval(timer);
  }
}

type Validate = ReturnType<typeof validation>;

/** One activation with the self-hosted profile's settings, timed, with the event loop watched. */
async function activate(note: TypedRelayNote, validate = validation(), capture = note.capture) {
  const store = note.deployment.storage.createServiceActivationStore(note.deployment.history);
  const start = performance.now();
  const { value: outcome, longestMs } = await longestHold(() =>
    store
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
      ),
  );
  return { outcome, elapsedMs: performance.now() - start, holdMs: longestMs };
}

it("the hold probe sees work that holds the event loop, including work made only of promise callbacks", async () => {
  const busy = (ms: number) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      /* hold */
    }
  };
  // 30 holds of 10 ms joined by promise callbacks: no timer can run between them, so the loop is held for 300 ms.
  const { longestMs } = await longestHold(async () => {
    for (let hold = 0; hold < 30; hold++) {
      busy(10);
      await Promise.resolve();
    }
  });
  expect(longestMs).toBeGreaterThanOrEqual(300);
});

const activated = (note: TypedRelayNote) => ({
  document: note.document,
  replayed: false,
  completed: false,
});

it("a typed note activates", async () => {
  const note = await typedRelayNote(100);
  expect((await activate(note)).outcome).toEqual(activated(note));
});

// The owner's engine writes the source file, and its Markdown may differ from the relay's for the same state.
it("a typed note whose owner wrote its source in its own Markdown activates", async () => {
  const note = await typedRelayNote(100);
  const spelled = Buffer.from("# Owner's own spelling\n");
  const capture = {
    ...note.capture,
    source: {
      ...note.capture.source,
      sourceDigest: createHash("sha256").update(spelled).digest("hex"),
      sourceByteLength: spelled.length,
    },
  };
  expect((await activate(note, validation(), capture)).outcome).toEqual(activated(note));
});

it("a typed note whose typed rows the relay can no longer read activates from its baseline and full state", async () => {
  const note = await typedRelayNote(2_000);
  const forgotten = note.raw
    .prepare("DELETE FROM sync_relay_blobs WHERE sha256<>?")
    .run(note.document.lineageClaimId).changes;
  expect(forgotten).toBe(2_000);
  expect((await activate(note)).outcome).toEqual(activated(note));
});

it("a capture whose full state does not contain its baseline is refused", async () => {
  const note = await typedRelayNote(100);
  const other = markdownToYDoc("Notes\n", { clientID: 9 }),
    unrelated = Y.encodeStateAsUpdate(other);
  other.destroy();
  const { outcome } = await activate(note, validation(), note.captureAt(unrelated));
  expect(outcome).toBeInstanceOf(ServiceActivationRefused);
  expect(outcome).toMatchObject({ message: "Native activation does not contain its baseline." });
});

it("a capture whose relay advanced between its read and its transaction is refused as stale, and the next one activates", async () => {
  const note = await typedRelayNote(100),
    validate = validation();
  const advancing: Validate = Object.assign(async (...[work, signal]: Parameters<Validate>) => {
    const result = await validate(work, signal);
    note.appendWrite("saved", note.end, true);
    return result;
  }, validate);
  expect((await activate(note, advancing)).outcome).toBeInstanceOf(ServiceActivationStaleCut);
  expect((await activate(note, validate, note.captureAt(note.note.fullState))).outcome).toEqual(
    activated(note),
  );
});

// The server log shows only fixed words, so the refusal must carry its reason as one.
it("an activation refused for its baseline names why in the server log", async () => {
  const note = await typedRelayNote(100);
  const validate = validation();
  expect((await activate(note, validate)).outcome).toMatchObject({ replayed: false });
  // The relay keeps the registered baseline but forgets the activation that registered it.
  note.raw.prepare(`DELETE FROM ${SERVICE_ACTIVATIONS}`).run();
  expect(serverLogLine((await activate(note, validate)).outcome)).toBe(
    "ServerLogError: Service activation requires a new live baseline: already-registered.",
  );
});

function replacedLineage(note: TypedRelayNote) {
  const seed = markdownToYDoc("Accepted change\n", { clientID: 3 }),
    baseline = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  const document = {
    ...note.document,
    lineageClaimId: createHash("sha256").update(baseline).digest("hex"),
  };
  const projected = createLiveMarkdownRegistrationValidator(ACTIVATION.validation)({
    document,
    currentPath: note.path,
    checkpoint: baseline,
  });
  if (projected.kind !== "accepted") throw new Error("Invalid replaced note fixture.");
  note.appendWrite("accepted-change", projected.evidence, true);
  const baseRelaySeq = note.appendUpdate(baseline, {
    isBaseState: true,
    lineageClaimId: document.lineageClaimId,
  });
  const captured = note.captureAt(baseline);
  const baseOriginSeq = Number(
    note.raw.prepare("SELECT origin_seq FROM sync_relay_log WHERE relay_seq=?").get(baseRelaySeq)!
      .origin_seq,
  );
  return {
    document,
    capture: {
      ...captured,
      activationId: `ordinary-activation-${"b".repeat(64)}`,
      baselineBytes: Buffer.from(baseline),
      source: { ...captured.source, ...document, baseOriginSeq, baseRelaySeq },
    },
  };
}
const liveDocumentRows = (note: TypedRelayNote) =>
  note.raw
    .prepare(
      "SELECT lineage_claim_id,lineage_state,admission_state,replaces_lineage_claim_id FROM sync_relay_live_documents ORDER BY lineage_state DESC",
    )
    .all();

function retire(note: Awaited<ReturnType<typeof typedRelayNote>>) {
  note.raw
    .prepare(
      `UPDATE ${SERVICE_ACTIVATIONS} SET retire_requested_at_ms=3,retire_restore_generation=1,retire_accepted_cursor=0,
        retired_at_ms=3,retired_boundary_json='null',state_bytes=NULL`,
    )
    .run();
  releaseRetiredLiveDelivery(
    note.deployment.storage as unknown as StorageContext,
    note.document,
    note.host.hostId,
  );
}

it("a note whose text was replaced while it was off goes live on its new lineage", async () => {
  const note = await typedRelayNote(100);
  const validate = validation();
  expect((await activate(note, validate)).outcome).toMatchObject({ replayed: false });
  retire(note);
  const replaced = replacedLineage(note);
  expect((await activate(note, validate, replaced.capture)).outcome).toEqual({
    document: replaced.document,
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
      lineage_claim_id: replaced.document.lineageClaimId,
      lineage_state: "current",
      admission_state: "open",
      replaces_lineage_claim_id: note.document.lineageClaimId,
    },
  ]);
});

it("a note on a new lineage waits while its last live session is still open", async () => {
  const note = await typedRelayNote(100);
  const validate = validation();
  expect((await activate(note, validate)).outcome).toMatchObject({ replayed: false });
  const before = liveDocumentRows(note);
  const replaced = replacedLineage(note);
  expect((await activate(note, validate, replaced.capture)).outcome).toBeInstanceOf(
    ServiceActivationLineageEnding,
  );
  expect(liveDocumentRows(note)).toEqual(before);
});

it("a paused note on a new lineage waits until its owner resumes the pause", async () => {
  const note = await typedRelayNote(100);
  const validate = validation();
  expect((await activate(note, validate)).outcome).toMatchObject({ replayed: false });
  retire(note);
  pauseLiveRoom(note.deployment.storage as unknown as StorageContext, {
    document: note.document,
    cause: "failing",
    refusal: null,
    named: [],
    copy: new Uint8Array([1]),
    pausedAtMs: 4,
  });
  const before = liveDocumentRows(note);
  expect((await activate(note, validate, replacedLineage(note).capture)).outcome).toBeInstanceOf(
    ServiceActivationLineageEnding,
  );
  expect(liveDocumentRows(note)).toEqual(before);
});

it("a deleted note restored under a new lineage activates", async () => {
  const note = await typedRelayNote(100);
  const deleted = note.appendMoment({
    momentId: "deleted",
    path: note.path,
    operation: "delete",
    payloadBeforePath: note.path,
    payloadBeforeContentKind: "text",
    payloadBeforeBlobSha256: note.end.projectedMarkdownSha256,
    payloadAfterPath: null,
    payloadAfterBlobSha256: null,
  });
  note.raw
    .prepare(
      "INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms) VALUES ('workspace',?,?,'deleted','main',NULL,NULL,NULL,NULL,0)",
    )
    .run(note.document.objectId, deleted);
  const restored = new Y.Doc();
  Y.applyUpdate(restored, note.note.fullState);
  const seeded = markdownToYDoc(yDocToMarkdown(restored), { clientID: 3 }),
    baseline = Y.encodeStateAsUpdate(seeded);
  restored.destroy();
  seeded.destroy();
  const lineageClaimId = createHash("sha256").update(baseline).digest("hex"),
    document = { ...note.document, lineageClaimId },
    text = createLiveMarkdownRegistrationValidator(ACTIVATION.validation)({
      document,
      currentPath: note.path,
      checkpoint: baseline,
    });
  if (text.kind !== "accepted") throw new Error("Invalid restored note.");
  note.appendWrite("restored", text.evidence, true);
  const base = note.appendUpdate(baseline, { lineageClaimId, isBaseState: true }),
    captured = note.captureAt(baseline);
  const capture = {
    ...captured,
    baselineBytes: Buffer.from(baseline),
    source: {
      ...captured.source,
      lineageClaimId,
      baseRelaySeq: base,
      baseOriginSeq: captured.source.nativeHeadSequence,
    },
  };
  expect((await activate(note, validation(), capture)).outcome).toEqual({
    document,
    replayed: false,
    completed: false,
  });
});

// The plan's bars, 1 s to activate and 100 ms of held event loop, are reported here rather than asserted: a shared
// runner's timing would fail a hard bar without a regression.
it(
  "a long typed note activates however many keystrokes it took, and reports its time and longest hold",
  { timeout: 600_000 },
  async () => {
    const validate = validation();
    // The child process starts on its first job; this one keeps that start out of the figures.
    await activate(await typedRelayNote(100), validate);
    for (const keystrokes of [10_000, 100_000]) {
      const note = await typedRelayNote(keystrokes);
      const { outcome, elapsedMs, holdMs } = await activate(note, validate);
      console.log(
        `[typed-activation] ${keystrokes} keystrokes: ` +
          `${outcome instanceof Error ? `refused (${outcome.message})` : "activated"}, ${Math.round(elapsedMs)} ms (bar 1000), ` +
          `longest event-loop hold ${Math.round(holdMs)} ms (bar 100)`,
      );
      expect.soft(outcome, `${keystrokes} keystrokes`).toEqual(activated(note));
    }
  },
);
