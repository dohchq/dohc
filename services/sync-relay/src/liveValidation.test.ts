import { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import {
  createLiveValidationExecutor,
  createValidatorFailureLog,
  LiveValidatorFailure,
} from "./liveValidation.js";
import { LiveRestoreTooLarge } from "./liveRestoreValidation.js";
import { nestedEmphasis } from "./liveValidation.fixture.js";

import {
  registered,
  cleanupLiveDeliveryFixtures,
} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
const { encodeStateAsUpdate } = createRequire(
  new URL("../../../packages/ydoc-projection/package.json", import.meta.url),
)("yjs") as {
  encodeStateAsUpdate(doc: ReturnType<typeof markdownToYDoc>): Uint8Array;
};
const policy = {
  maxStructVisits: 1_000_000,
  maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000,
  maxDeleteIntervalVisits: 1_000_000,
  maxIndexOperations: 10_000_000,
};
const pools: ReturnType<typeof createLiveValidationExecutor>[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  cleanupLiveDeliveryFixtures();
});
function fixture() {
  const pool = createLiveValidationExecutor();
  pools.push(pool);
  const doc = markdownToYDoc("A **shared** document");
  const checkpoint = encodeStateAsUpdate(doc);
  doc.destroy();
  const input = {
    document: {
      workspaceId: "workspace",
      mainVersionId: "main",
      objectId: "object",
      lineageClaimId: "lineage",
    },
    currentPath: "note.md",
    checkpoint,
    suffix: [],
    candidate: Uint8Array.of(0, 0),
  };
  return { pool, input, validate: pool.validator(policy) };
}
it("runs the same validator without detaching input", async () => {
  const { input, validate } = fixture(),
    expected = createLiveMarkdownJournalValidator(policy)(input);
  expect(expected.kind).toBe("accepted");
  const original = input.checkpoint.slice();
  const pending = validate(input);
  if (expected.kind !== "accepted") throw Error("Expected accepted validation");
  const { stateUpdate: _stateUpdate, ...evidence } = expected.evidence;
  expect(await pending).toEqual({ kind: "accepted", evidence });
  expect(input.checkpoint).toEqual(original);
  expect(await validate({ ...input, candidate: Uint8Array.of(255) })).toEqual(
    createLiveMarkdownJournalValidator(policy)({ ...input, candidate: Uint8Array.of(255) }),
  );
});
it.each([4093, 4094])(
  "returns state bytes only when %s retained updates reach the checkpoint count",
  async (suffixCount) => {
    const { input, validate } = fixture();
    const call = {
      ...input,
      suffix: Array.from({ length: suffixCount }, () => Uint8Array.of(0, 0)),
    };
    const expected = createLiveMarkdownJournalValidator(policy)(call);
    const result = await validate(call);
    expect(expected.kind).toBe("accepted");
    if (expected.kind !== "accepted") throw Error("Expected accepted validation");
    if (suffixCount === 4094) {
      expect(result).toEqual(expected);
      if (result.kind === "accepted")
        expect(Object.getPrototypeOf(result.evidence.stateUpdate)).toBe(Uint8Array.prototype);
    } else {
      const { stateUpdate: _stateUpdate, ...evidence } = expected.evidence;
      expect(result).toEqual({ kind: "accepted", evidence });
    }
  },
  30_000,
);

it("bounds concurrent work, cancels active jobs, and closes without dangling requests", async () => {
  const { pool, input, validate } = fixture(),
    abort = new AbortController();
  const first = Promise.resolve(validate(input, abort.signal));
  const rejected = expect(first).rejects.toThrow("cancelled");
  const second = Promise.resolve(validate(input));
  expect(validate.hasCapacity?.()).toBe(false);
  const busy = await validate(input);
  expect(busy).toMatchObject({ kind: "retry", reason: "admission-unavailable" });
  if (busy.kind !== "retry") throw Error("Expected busy pool");
  let ready = false;
  const available = busy.waitForCapacity().then(() => {
    ready = true;
  });
  const cancelled = new AbortController();
  const cancelWait = expect(busy.waitForCapacity(cancelled.signal)).rejects.toThrow("stop waiting");
  cancelled.abort(new Error("stop waiting"));
  await cancelWait;
  expect(ready).toBe(false);
  abort.abort(new Error("cancelled"));
  await rejected;
  expect(validate.hasCapacity?.()).toBe(false);
  await available;
  expect(validate.hasCapacity?.()).toBe(true);
  expect((await second).kind).toBe("accepted");
  const active = Promise.resolve(validate(input));
  const closing = expect(active).rejects.toThrow("exited");
  await pool.close();
  await closing;
  await expect(validate(input)).rejects.toThrow("closed");
});

let heapCheckpoint: Uint8Array | undefined;
function heapExhaustionCheckpoint() {
  if (!heapCheckpoint) {
    const doc = markdownToYDoc("a\n\n".repeat(80_000));
    try {
      heapCheckpoint = encodeStateAsUpdate(doc);
    } finally {
      doc.destroy();
    }
  }
  return heapCheckpoint;
}

// A busy activation's wait for capacity must not end on any slot's release, or a host waking on it would
// capture again each time a live edit finished while the auxiliary slot stayed taken.
// Proves: the wait outlasts a live edit's completion and ends only once the auxiliary child has exited, when an activation runs.
it("keeps a busy activation waiting through live edits until the auxiliary slot frees", async () => {
  const { pool, input, validate } = fixture(),
    { checkpoint } = nestedEmphasis(3000),
    activate = pool.ordinaryActivation(policy);
  const work = {
    document: input.document,
    currentPath: input.currentPath,
    baselineBytes: checkpoint,
  };
  // The held job runs far longer than the test.
  const held = new AbortController(),
    running = Promise.resolve(activate(work, held.signal)).catch((error: unknown) => error);
  expect((await activate(work)).kind).toBe("retry");
  let woke = false;
  const waiting = activate.waitForCapacity!().then(() => {
    woke = true;
  });
  expect((await validate(input)).kind).toBe("accepted");
  // Everything the edit's completion set off has run.
  await new Promise(setImmediate);
  expect(woke).toBe(false);
  held.abort(new Error("released"));
  expect(await running).toMatchObject({ message: "released" });
  await waiting;
  expect(await activate({ ...work, baselineBytes: input.checkpoint })).toMatchObject({
    kind: "accepted",
  });
}, 60_000);

function restorePoint(input: ReturnType<typeof fixture>["input"], checkpoint: Uint8Array) {
  return {
    binding: { ...input.document, currentPath: input.currentPath },
    checkpoint: { bytes: checkpoint },
    events: [],
    point: { journalCursor: 0, receiptDigest: "a".repeat(64) },
    artifact: () => undefined,
    assertCurrent() {},
  };
}

it("refuses restore work whose child runs out of heap, and validates the next restore", async () => {
  const { input } = fixture(),
    pool = createLiveValidationExecutor(128);
  pools.push(pool);
  const restore = pool.restore(policy),
    validate = pool.validator(policy);
  const checkpoint = heapExhaustionCheckpoint();
  await expect(restore.point(restorePoint(input, checkpoint))).rejects.toBeInstanceOf(
    LiveRestoreTooLarge,
  );
  expect(validate.hasCapacity?.()).toBe(true);
  expect(await restore.point(restorePoint(input, input.checkpoint))).toMatchObject({
    journalCursor: 0,
    receiptDigest: "a".repeat(64),
  });
}, 60_000);

it("fails a job whose child exits abnormally, and replaces the child", async () => {
  const { input, validate } = fixture();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const written = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  // The child cannot read a missing input and exits with an uncaught error.
  try {
    await expect(validate(null as never)).rejects.toThrow("exited");
    // Its stack can name files, so the log counts its lines and shows none of them.
    await vi.waitFor(() =>
      expect(
        log.mock.calls.some(([line]) =>
          /^\[live-validation\] withheld \d+ stderr lines? that can name files\.$/.test(
            String(line),
          ),
        ),
      ).toBe(true),
    );
    expect(JSON.stringify([log.mock.calls, written.mock.calls])).not.toMatch(
      /TypeError|liveValidationWorker/,
    );
  } finally {
    log.mockRestore();
    written.mockRestore();
  }
  expect(validate.hasCapacity?.()).toBe(true);
  expect((await validate(input)).kind).toBe("accepted");
});

it("kills a child at its deadline and keeps its slot until the child exits", async () => {
  const { pool, input, validate } = fixture(),
    { checkpoint } = nestedEmphasis(3000);
  const work = { document: input.document, currentPath: input.currentPath, checkpoint };
  const held = new AbortController(),
    other = Promise.resolve(pool.normalizeSettlement(work, held.signal)).catch(
      (error: unknown) => error,
    );
  await expect(pool.normalizeSettlement(work, AbortSignal.timeout(2_000))).rejects.toThrow(
    "timeout",
  );
  expect(validate.hasCapacity?.()).toBe(false);
  // The other job runs far longer than the test, so only the killed child's exit frees a slot.
  await validate.waitForCapacity!();
  expect((await validate(input)).kind).toBe("accepted");
  held.abort(new Error("released"));
  expect(await other).toMatchObject({ message: "released" });
}, 60_000);

it("commits and recovers worker evidence without changing an exact replay", async () => {
  const f = registered({ deployment: true }),
    pool = createLiveValidationExecutor();
  try {
    const template = f.capture(f.update("payload", "small"));
    const read = f.storage.readLiveUpdateJournalCut({ document: template.cutToken.document });
    if (read.kind !== "cut") throw Error("Expected journal cut");
    const input = {
      ...template,
      metadata: { ...template.metadata, deliveryId: "worker" },
      cutToken: read.cut,
    };
    const validation = await pool.validator(policy)({
      document: read.cut.document,
      currentPath: read.cut.currentPath,
      checkpoint: read.cut.checkpoint.bytes,
      suffix: read.cut.suffix.map((row) => row.bytes),
      candidate: input.updateBytes,
    });
    if (validation.kind !== "accepted") throw Error("Expected accepted worker evidence");
    expect(Object.hasOwn(validation.evidence, "stateUpdate")).toBe(false);
    const accepted = f.storage.commitLiveUpdateJournal({ ...input, validation });
    expect(accepted.result).toMatchObject({ kind: "accepted", replayed: false });
    const before = f.raw
      .prepare(
        "SELECT update_digest,validation_checkpoint_sha256,validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=1",
      )
      .get()!;
    expect(before.validation_checkpoint_bytes).toBeNull();
    expect(before.validation_checkpoint_sha256).toBeNull();
    expect(f.storage.commitLiveUpdateJournal({ ...input, validation }).result).toMatchObject({
      kind: "accepted",
      replayed: true,
    });
    expect(
      f.raw
        .prepare(
          "SELECT update_digest,validation_checkpoint_sha256,validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=1",
        )
        .get(),
    ).toEqual(before);
    expect(
      f.storage.readCommittedLiveUpdate({
        host: input.host,
        document: input.cutToken.document,
        journalCursor: 1,
      }),
    ).toEqual({ kind: "committed", admitted: accepted.admitted });
  } finally {
    await pool.close();
    f.close();
  }
}, 30_000);

it("names a validator failure whose class it does not know as Error", async () => {
  const messages: string[] = [];
  const pool = createLiveValidationExecutor(
    512,
    createValidatorFailureLog((message) => messages.push(message)),
  );
  pools.push(pool);
  const { input } = fixture(),
    validate = pool.validator(policy);
  const emit = ChildProcess.prototype.emit;
  ChildProcess.prototype.emit = function (
    this: ChildProcess,
    event: string | symbol,
    ...args: unknown[]
  ) {
    return Reflect.apply(emit, this, [
      event,
      ...(event === "message" ? [{ kind: "failed", errorClass: "notes/secret plan.md" }] : args),
    ]) as boolean;
  } as typeof emit;
  try {
    await expect(validate(input)).rejects.toThrow(LiveValidatorFailure);
  } finally {
    ChildProcess.prototype.emit = emit;
  }
  expect(messages).toEqual([
    "[sync-relay] live validation failed with Error for document object; the edit waits and is tried again.",
  ]);
});
