import { ChildProcess, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import { createLiveValidationExecutor, createValidatorFailureLog, LiveValidatorFailure } from "./liveValidation.js";
import { LiveRestoreBusy, LiveRestoreTooLarge } from "./liveRestoreValidation.js";

import {registered, cleanupLiveDeliveryFixtures} from '../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js';
const {encodeStateAsUpdate} = createRequire(new URL("../../../packages/ydoc-projection/package.json", import.meta.url))("yjs") as {
  encodeStateAsUpdate(doc: ReturnType<typeof markdownToYDoc>): Uint8Array;
};
const policy = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000};
const pools: ReturnType<typeof createLiveValidationExecutor>[] = [];
afterEach(async () => {await Promise.all(pools.splice(0).map(pool => pool.close())); cleanupLiveDeliveryFixtures();});
function fixture() {
  const pool = createLiveValidationExecutor(); pools.push(pool);
  const doc = markdownToYDoc("A **shared** document");
  const checkpoint = encodeStateAsUpdate(doc); doc.destroy();
  const input = {document: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "lineage"},
    currentPath: "note.md", checkpoint, suffix: [], candidate: Uint8Array.of(0, 0)};
  return {pool, input, validate: pool.validator(policy)};
}
it("runs the same validator without detaching input", async () => {
  const {input, validate} = fixture(), expected = createLiveMarkdownJournalValidator(policy)(input);
  expect(expected.kind).toBe("accepted");
  const original = input.checkpoint.slice();
  const pending = validate(input);
  if (expected.kind !== "accepted") throw Error("Expected accepted validation");
  const {stateUpdate: _stateUpdate, ...evidence} = expected.evidence;
  expect(await pending).toEqual({kind: "accepted", evidence}); expect(input.checkpoint).toEqual(original);
  expect(await validate({...input, candidate: Uint8Array.of(255)})).toEqual(createLiveMarkdownJournalValidator(policy)({...input, candidate: Uint8Array.of(255)}));
});
it.each([4093, 4094])("returns state bytes only when %s retained updates reach the checkpoint count", async suffixCount => {
  const {input, validate} = fixture();
  const call = {...input, suffix: Array.from({length: suffixCount}, () => Uint8Array.of(0, 0))};
  const expected = createLiveMarkdownJournalValidator(policy)(call);
  const result = await validate(call);
  expect(expected.kind).toBe("accepted");
  if (expected.kind !== "accepted") throw Error("Expected accepted validation");
  if (suffixCount === 4094) {
    expect(result).toEqual(expected);
    if (result.kind === "accepted") expect(Object.getPrototypeOf(result.evidence.stateUpdate)).toBe(Uint8Array.prototype);
  } else {
    const {stateUpdate: _stateUpdate, ...evidence} = expected.evidence;
    expect(result).toEqual({kind: "accepted", evidence});
  }
}, 30_000);

it.each([18, 19])("returns checkpoint state only when %s large suffix updates and the candidate reach the byte limit", async suffixCount => {
  const {pool, input} = fixture();
  const doc = markdownToYDoc("Byte checkpoint");
  try {
    doc.getMap("frontmatter").set("payload", "x".repeat(1_048_576));
    const bytes = encodeStateAsUpdate(doc);
    const call = {...input, checkpoint: bytes, suffix: Array.from({length: suffixCount}, () => bytes), candidate: bytes};
    expect(bytes.byteLength * 19).toBeLessThan(20_971_520);
    expect(bytes.byteLength * 20).toBeGreaterThanOrEqual(20_971_520);
    const bytePolicy = {...policy, maxDecodedPayloadByteVisits: 1_000_000_000};
    const expected = createLiveMarkdownJournalValidator(bytePolicy)(call);
    expect(expected.kind).toBe("accepted");
    const result = await pool.validator(bytePolicy)(call);
    if (expected.kind !== "accepted") throw Error("Expected accepted validation");
    if (suffixCount === 19) expect(result).toEqual(expected);
    else {
      const {stateUpdate: _stateUpdate, ...evidence} = expected.evidence;
      expect(result).toEqual({kind: "accepted", evidence});
    }
  } finally {doc.destroy();}
}, 30_000);
it("bounds concurrent work, cancels active jobs, and closes without dangling requests", async () => {
  const {pool, input, validate} = fixture(), abort = new AbortController();
  const first = Promise.resolve(validate(input, abort.signal));
  const rejected = expect(first).rejects.toThrow("cancelled");
  const second = Promise.resolve(validate(input));
  expect(validate.hasCapacity?.()).toBe(false);
  const busy = await validate(input);
  expect(busy).toMatchObject({kind: "retry", reason: "admission-unavailable"});
  if (busy.kind !== "retry") throw Error("Expected busy pool");
  let ready = false;
  const available = busy.waitForCapacity().then(() => {ready = true;});
  const cancelled = new AbortController();
  const cancelWait = expect(busy.waitForCapacity(cancelled.signal)).rejects.toThrow("stop waiting");
  cancelled.abort(new Error("stop waiting")); await cancelWait;
  expect(ready).toBe(false);
  abort.abort(new Error("cancelled")); await rejected;
  // The cancelled child holds its slot until it has exited.
  expect(validate.hasCapacity?.()).toBe(false);
  await available;
  expect(validate.hasCapacity?.()).toBe(true);
  expect((await second).kind).toBe("accepted");
  const active = Promise.resolve(validate(input)); const closing = expect(active).rejects.toThrow("exited");
  await pool.close(); await closing;
  await expect(validate(input)).rejects.toThrow("closed");
});

it.each([
  ["its idle child", ""],
  // Shutdown starts just before the job's result handler runs.
  ["a child whose result arrives after close begins", `const {ChildProcess} = await import("node:child_process"), emit = ChildProcess.prototype.emit;
    ChildProcess.prototype.emit = function (event, ...args) {
      if (event === "message") closing ??= pool.close();
      return emit.call(this, event, ...args);
    };`],
])("keeps the process alive until close has ended %s", async (_case, setup) => {
  const {input} = fixture();
  // Nothing else holds this process open once the job completes and its child goes idle.
  const script = `const {createLiveValidationExecutor} = await import(process.argv[1]);
    const pool = createLiveValidationExecutor();
    let closing;
    ${setup}
    const result = await pool.validator(${JSON.stringify(policy)})({document: ${JSON.stringify(input.document)}, currentPath: "note.md",
      checkpoint: new Uint8Array(Buffer.from(process.argv[2], "base64")), suffix: [], candidate: Uint8Array.of(0, 0)});
    if (result.kind !== "accepted") throw new Error("Expected accepted validation");
    await (closing ?? pool.close());
    console.log("closed");`;
  const {stdout} = await promisify(execFile)(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
    "--input-type=module", "-e", script, new URL("./liveValidation.ts", import.meta.url).href, Buffer.from(input.checkpoint).toString("base64")]);
  expect(stdout.trim()).toBe("closed");
});

// Node returns before creating stdio for EMFILE, then emits `error` and `close`.
// For EAGAIN it wraps the unopened pipes, emits `error`, and may never emit `close`.
it.each(["EMFILE", "EAGAIN"] as const)("fails a job whose fork is refused with %s, frees its slot, and keeps the relay up", async code => {
  const {pool, input, validate} = fixture(), {checkpoint} = nestedEmphasis(3000);
  // The held job runs far longer than the test, so only the failed fork's slot can free capacity.
  const held = new AbortController();
  const other = Promise.resolve(pool.normalizeSettlement({document: input.document, currentPath: input.currentPath, checkpoint}, held.signal))
    .catch((error: unknown) => error);
  const binding = (process as unknown as {binding(name: string): unknown}).binding;
  const {Process} = binding("process_wrap") as {Process: {prototype: {spawn(options: unknown): number}}};
  const errno = (binding("uv") as Record<`UV_${typeof code}`, number>)[`UV_${code}`];
  const spawn = Process.prototype.spawn;
  Process.prototype.spawn = () => {Process.prototype.spawn = spawn; return errno;};
  try {
    await expect(validate(input)).rejects.toThrow(code);
  } finally {Process.prototype.spawn = spawn;}
  await validate.waitForCapacity!();
  expect((await validate(input)).kind).toBe("accepted");
  held.abort(new Error("released")); expect(await other).toMatchObject({message: "released"});
  await pool.close();
}, 30_000);

it("retains no pipe of a fork refused with EAGAIN", async () => {
  const script = `const {createHook} = await import("node:async_hooks");
    const {createLiveValidationExecutor} = await import(process.argv[1]);
    const pool = createLiveValidationExecutor(), validate = pool.validator(${JSON.stringify(policy)});
    const {Process} = process.binding("process_wrap"), spawn = Process.prototype.spawn, errno = process.binding("uv").UV_EAGAIN;
    const pipes = new Set();
    const hook = createHook({init(id, type) {if (type === "PIPEWRAP") pipes.add(id);}, destroy(id) {pipes.delete(id);}}).enable();
    Process.prototype.spawn = () => errno;
    // A refused fork never receives its job.
    for (let i = 0; i < 20; i++) await validate({}).catch(() => {});
    Process.prototype.spawn = spawn;
    await pool.close();
    // Closed pipes become collectable on the next turn; their destroy hooks run on the turn after collection.
    await new Promise(setImmediate); globalThis.gc(); await new Promise(setImmediate);
    hook.disable();
    console.log(pipes.size);`;
  const {stdout} = await promisify(execFile)(process.execPath, ["--expose-gc", "--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
    "--input-type=module", "-e", script, new URL("./liveValidation.ts", import.meta.url).href]);
  expect(stdout.trim()).toBe("0");
}, 30_000);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** A note whose source witness nests emphasis `depth` levels; it reads as one flat emphasis run. */
function nestedEmphasis(depth: number) {
  const source = "*".repeat(depth) + "b" + " a*".repeat(depth);
  const doc = markdownToYDoc(`*b${" a".repeat(depth)}*`), meta = doc.getMap("meta");
  meta.set("dohcMarkdownSource", source);
  meta.set("dohcMarkdownSourceSha256", sha256(source));
  meta.set("dohcMarkdownSourceProjectionSha256", sha256(yDocToMarkdown(doc)));
  const checkpoint = encodeStateAsUpdate(doc); doc.destroy();
  return {source, checkpoint};
}
it("keeps a worker thread's stack for deeply nested emphasis", async () => {
  const {pool, input} = fixture(), {source, checkpoint} = nestedEmphasis(2400);
  // A child's default stack refuses this witness as unreadable instead of verifying it.
  expect(await pool.normalizeSettlement({document: input.document, currentPath: input.currentPath, checkpoint}))
    .toMatchObject({kind: "accepted", evidence: {projectedMarkdownSha256: sha256(source)}});
}, 120_000);

it.each(["journal", "settlement"] as const)("refuses %s work whose child runs out of heap, and replaces the child", async kind => {
  const {input} = fixture(), pool = createLiveValidationExecutor(128); pools.push(pool);
  const validate = pool.validator(policy);
  const doc = markdownToYDoc("a\n\n".repeat(80_000)), checkpoint = encodeStateAsUpdate(doc); doc.destroy();
  const result = kind === "journal" ? await validate({...input, checkpoint})
    : await pool.normalizeSettlement({document: input.document, currentPath: input.currentPath, checkpoint});
  expect(result).toEqual({kind: "refused", reason: "capacity-refused", source: kind === "journal" ? "final" : "registration-input"});
  expect(validate.hasCapacity?.()).toBe(true);
  expect((await validate(input)).kind).toBe("accepted");
}, 60_000);

it("keeps a slot for live edits while an activation validates", async () => {
  const {pool, input, validate} = fixture(), {checkpoint} = nestedEmphasis(3000), activate = pool.ordinaryActivation(policy);
  const work = {document: input.document, currentPath: input.currentPath, baselineBytes: checkpoint};
  // The held job runs far longer than the test.
  const held = new AbortController(), running = Promise.resolve(activate(work, held.signal)).catch((error: unknown) => error);
  expect(await activate(work)).toMatchObject({kind: "retry", reason: "admission-unavailable"});
  expect(validate.hasCapacity?.()).toBe(true);
  expect((await validate(input)).kind).toBe("accepted");
  held.abort(new Error("released")); expect(await running).toMatchObject({message: "released"});
}, 60_000);

/** A restore point at `checkpoint`, with no stored artifacts. */
function restorePoint(input: ReturnType<typeof fixture>["input"], checkpoint: Uint8Array) {
  return {binding: {...input.document, currentPath: input.currentPath}, checkpoint: {bytes: checkpoint}, events: [],
    point: {journalCursor: 0, receiptDigest: "a".repeat(64)}, artifact: () => undefined, assertCurrent() {}};
}

it("refuses restore work whose child runs out of heap, and validates the next restore", async () => {
  const {input} = fixture(), pool = createLiveValidationExecutor(128); pools.push(pool);
  const restore = pool.restore(policy), validate = pool.validator(policy);
  const doc = markdownToYDoc("a\n\n".repeat(80_000)), checkpoint = encodeStateAsUpdate(doc); doc.destroy();
  await expect(restore.point(restorePoint(input, checkpoint))).rejects.toBeInstanceOf(LiveRestoreTooLarge);
  expect(validate.hasCapacity?.()).toBe(true);
  expect(await restore.point(restorePoint(input, input.checkpoint))).toMatchObject({journalCursor: 0, receiptDigest: "a".repeat(64)});
}, 60_000);

it.each(["activation", "restore"] as const)("lets activation and restore share one slot while %s validates", async held => {
  const {pool, input, validate} = fixture(), {checkpoint} = nestedEmphasis(3000);
  const activate = pool.ordinaryActivation(policy), restore = pool.restore(policy);
  const activation = {document: input.document, currentPath: input.currentPath, baselineBytes: checkpoint};
  // The held job runs far longer than the test.
  const release = new AbortController();
  const running = (held === "activation" ? Promise.resolve(activate(activation, release.signal)) : restore.point(restorePoint(input, checkpoint), release.signal))
    .catch((error: unknown) => error);
  // A job given the second slot would run past this deadline instead of refusing.
  if (held === "activation") await expect(restore.point(restorePoint(input, checkpoint), AbortSignal.timeout(10_000))).rejects.toBeInstanceOf(LiveRestoreBusy);
  else expect(await activate(activation, AbortSignal.timeout(10_000))).toMatchObject({kind: "retry", reason: "admission-unavailable"});
  expect(validate.hasCapacity?.()).toBe(true);
  expect((await validate(input)).kind).toBe("accepted");
  release.abort(new Error("released")); expect(await running).toMatchObject({message: "released"});
}, 60_000);

it("fails a job whose child exits abnormally, and replaces the child", async () => {
  const {input, validate} = fixture();
  // The child cannot read a missing input and exits with an uncaught error.
  await expect(validate(null as never)).rejects.toThrow("exited");
  expect(validate.hasCapacity?.()).toBe(true);
  expect((await validate(input)).kind).toBe("accepted");
});

it("names a validator failure once per document and edit, retries it, and keeps the child", async () => {
  const messages: string[] = [];
  const pool = createLiveValidationExecutor(512, createValidatorFailureLog(message => messages.push(message))); pools.push(pool);
  const {input} = fixture(), validate = pool.validator(policy);
  // Stands in for a validator that throws: the child answers with the failure it caught.
  const emit = ChildProcess.prototype.emit;
  ChildProcess.prototype.emit = function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    return Reflect.apply(emit, this, [event, ...(event === "message" ? [{kind: "failed", errorClass: "RangeError"}] : args)]) as boolean;
  } as typeof emit;
  try {
    for (let attempt = 0; attempt < 3; attempt++) await expect(validate(input)).rejects.toThrow(LiveValidatorFailure);
    await expect(validate({...input, candidate: Uint8Array.of(0, 1)})).rejects.toThrow("RangeError");
  } finally {ChildProcess.prototype.emit = emit;}
  expect(messages).toEqual([
    "[sync-relay] live validation failed with RangeError for document object; the edit waits and is tried again.",
    "[sync-relay] live validation failed with RangeError for document object; the edit waits and is tried again.",
  ]);
  expect(validate.hasCapacity?.()).toBe(true);
  expect((await validate(input)).kind).toBe("accepted");
});

it("forgets the oldest named failure once the log is full", () => {
  const messages: string[] = [], log = createValidatorFailureLog(message => messages.push(message));
  const document = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "lineage"};
  for (let index = 0; index <= 1024; index++) log(document, Uint8Array.of(index & 255, index >> 8), "TypeError");
  log(document, Uint8Array.of(0, 0), "TypeError");
  expect(messages).toHaveLength(1026);
  log(document, Uint8Array.of(0, 4), "TypeError");
  expect(messages).toHaveLength(1026);
});

it("kills a child at its deadline and keeps its slot until the child exits", async () => {
  const {pool, input, validate} = fixture(), {checkpoint} = nestedEmphasis(3000);
  const work = {document: input.document, currentPath: input.currentPath, checkpoint};
  const held = new AbortController(), other = Promise.resolve(pool.normalizeSettlement(work, held.signal)).catch((error: unknown) => error);
  await expect(pool.normalizeSettlement(work, AbortSignal.timeout(2_000))).rejects.toThrow("timeout");
  expect(validate.hasCapacity?.()).toBe(false);
  // The other job runs far longer than the test, so only the killed child's exit frees a slot.
  await validate.waitForCapacity!();
  expect((await validate(input)).kind).toBe("accepted");
  held.abort(new Error("released")); expect(await other).toMatchObject({message: "released"});
}, 60_000);

it.each([false, true])('commits and recovers worker evidence with checkpoint due=%s', async checkpointDue => {
  const f = registered({deployment: true}), pool = createLiveValidationExecutor();
  try {
    const template = f.capture(f.update('payload', checkpointDue ? 'x'.repeat(1_048_576) : 'small'));
    const validate = pool.validator({...policy, maxDecodedPayloadByteVisits: 1_000_000_000});
    for (let index = 0; index < (checkpointDue ? 20 : 1); index++) {
      const read = f.storage.readLiveUpdateJournalCut({document: template.cutToken.document});
      if (read.kind !== 'cut') throw Error('Expected journal cut');
      const input = {...template, metadata: {...template.metadata, deliveryId: 'worker-' + index}, cutToken: read.cut};
      const validation = await validate({document: read.cut.document, currentPath: read.cut.currentPath,
        checkpoint: read.cut.checkpoint.bytes, suffix: read.cut.suffix.map(row => row.bytes), candidate: input.updateBytes});
      if (validation.kind !== 'accepted') throw Error('Expected accepted worker evidence');
      const due = checkpointDue && index === 19;
      expect(Object.hasOwn(validation.evidence, 'stateUpdate')).toBe(due);
      const accepted = f.storage.commitLiveUpdateJournal({...input, validation});
      expect(accepted.result).toMatchObject({kind: 'accepted', replayed: false});
      if (index !== (checkpointDue ? 19 : 0)) continue;
      const before = f.raw.prepare('SELECT update_digest,validation_checkpoint_sha256,validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?').get(index + 1)!;
      expect(before.validation_checkpoint_bytes).toEqual(due ? validation.evidence.stateUpdate : null);
      expect(before.validation_checkpoint_sha256).toBe(due ? validation.evidence.stateUpdateSha256 : null);
      expect(f.storage.commitLiveUpdateJournal({...input, validation}).result).toMatchObject({kind: 'accepted', replayed: true});
      expect(f.raw.prepare('SELECT update_digest,validation_checkpoint_sha256,validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?').get(index + 1)).toEqual(before);
      expect(f.storage.readCommittedLiveUpdate({host: input.host, document: input.cutToken.document, journalCursor: index + 1}))
        .toEqual({kind: 'committed', admitted: accepted.admitted});
    }
  } finally {await pool.close(); f.close();}
}, 30_000);
