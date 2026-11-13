// #3763: typing any amount must never stop a note from going live, and activation must cost what the note's size costs,
// not what its edit count costs. These tests drive the activation itself (`prepare`) with production settings, assert
// that it accepts the note, and report how long it took, the longest time it held the relay's event loop, and the work
// on the main thread inside its longest holds.
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { createLiveValidationExecutor } from "./liveValidation.js";
import type { StorageContext } from "./storage/context.js";
import { CHECKPOINT_MOMENTS, readOrdinaryCheckpoint, type OrdinaryCheckpointScope } from "./storage/ordinaryActivationCheckpoint.js";
import { foldOrdinaryCheckpointPages, ORDINARY_FOLD_PAGE_ROWS, ORDINARY_FOLD_RUN_PAGES, type OrdinaryFoldValidator } from "./storage/ordinaryActivationFold.js";
import { ServiceActivationStaleCut } from "./storage/ordinaryActivationSource.js";
import { ACTIVATION, typedNote, typedRelayNote as seedTypedRelayNote, type TypedRelayNote } from "./testing/typedNotes.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
const typedRelayNote = (keystrokes: number) => seedTypedRelayNote(keystrokes, close => {cleanup.push(close);});
/** The relay's validation as it runs in production: in its own child process, with the profile's policy. */
function validation() {
  const pool = createLiveValidationExecutor(); cleanup.push(() => pool.close());
  return pool.ordinaryActivation(ACTIVATION.validation);
}

/** The lineage the note's checkpoint belongs to under `validate`'s policy. */
function lineageOf(note: TypedRelayNote, validate: Validate): OrdinaryCheckpointScope {
  const {source} = note.capture;
  return {namespace: note.deployment.history.namespace, document: note.document, replicationEpoch: source.replicationEpoch,
    streamIdentity: source.streamIdentity, base: {relaySeq: source.baseRelaySeq, originId: source.baseOriginId, originSeq: source.baseOriginSeq},
    policySha256: validate.policySha256!};
}
/** The note's rows after its lineage's checkpoint, or after its base without one: the rows an activation's last read walks. */
function rowsAfterCheckpoint(note: TypedRelayNote, validate: Validate) {
  const {source} = note.capture;
  const checkpoint = readOrdinaryCheckpoint(note.deployment.storage as unknown as StorageContext, lineageOf(note, validate));
  return Number(note.raw.prepare("SELECT count(*) AS rows FROM sync_relay_log WHERE relay_seq>? AND relay_seq<=?")
    .get(checkpoint ? checkpoint.throughRelaySeq : source.baseRelaySeq, source.committedCursor)!.rows);
}
/** Folds the note's next page into its lineage's checkpoint, as an activation's fold does. */
function foldOnePage(note: TypedRelayNote, validate: Validate) {
  const foldPage: OrdinaryFoldValidator = async (work, signal) => {
    const result = await validate(work, signal);
    if (result.kind === "accepted") throw new Error("A fold page was answered as an activation.");
    return result;
  };
  return foldOrdinaryCheckpointPages(note.deployment.storage as unknown as StorageContext, {scope: lineageOf(note, validate), pages: 1, validate: foldPage,
    nowMs: () => 3, bounds: {pageRows: ORDINARY_FOLD_PAGE_ROWS, pageBytes: ACTIVATION.maxBytesPerDrain}});
}
/** Keystrokes past the base that one fold run takes. */
const RUN_ROWS = ORDINARY_FOLD_RUN_PAGES * ORDINARY_FOLD_PAGE_ROWS;
/** A note near 100,000 keystrokes that leaves one whole page after its last fold run, the most an activation's last read walks. */
const WORST_REMAINDER = 6 * RUN_ROWS + ORDINARY_FOLD_PAGE_ROWS;

type Hold = {start: number; end: number};
/**
 * The longest time the event loop went without running a timer while `run` worked, counting a hold still going when
 * `run` settles, and the five longest holds. A timer is due every `everyMs`, so a loop that is never held reads about
 * `everyMs`. Promise callbacks run before any timer, so work made only of them holds the loop for its whole length.
 * `monitorEventLoopDelay` records a delay only from its second timer on, so it reads 0 for such a hold.
 */
async function longestHold<T>(run: () => Promise<T>, everyMs = 5) {
  let last = performance.now();
  const all: Hold[] = [];
  const timer = setInterval(() => {const now = performance.now(); all.push({start: last, end: now}); last = now;}, everyMs);
  try {
    const value = await run();
    all.push({start: last, end: performance.now()});
    const holds = [...all].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 5);
    return {value, longestMs: holds[0]!.end - holds[0]!.start, holds, all};
  } finally {clearInterval(timer);}
}

type Validate = ReturnType<typeof validation>;
type Span = {stage: string; start: number; end: number};
/**
 * Times the activation's work on the main thread: each history read, each write's body, the relay database's commit, the
 * continuity sidecar's commit that follows it, and each validation's send to the child. The rest of the main thread's
 * time is the fold's page reads and checkpoint builds.
 */
function staged(note: TypedRelayNote, validate: Validate) {
  const storage = note.deployment.storage as unknown as StorageContext, spans: Span[] = [];
  const span = <T>(stage: string, run: () => T) => {const start = performance.now(); try {return run();} finally {spans.push({stage, start, end: performance.now()});}};
  const tx = storage.tx.bind(storage), readTx = storage.readTx.bind(storage), exec = storage.db.exec.bind(storage.db);
  let writing = false, committed = 0;
  storage.readTx = run => span("history read", () => readTx(run));
  storage.db.exec = (sql: string) => {
    if (!writing || sql !== "COMMIT") return exec(sql);
    try {return span("relay database commit", () => exec(sql));} finally {committed = performance.now();}
  };
  const writes: Span[] = [];
  storage.tx = run => {
    writing = true; committed = 0;
    const start = performance.now();
    try {
      const value = tx(() => span("write body", run));
      spans.push({stage: "continuity sidecar commit", start: committed, end: performance.now()});
      return value;
    } finally {writing = false; writes.push({stage: "write", start, end: performance.now()});}
  };
  const sent: Validate = Object.assign((...args: Parameters<Validate>) => span("validation send", () => validate(...args)), validate);
  return {validate: sent, spans, writes};
}

/** One activation with the self-hosted profile's settings, timed, with the event loop watched and its work staged. */
async function activate(note: TypedRelayNote, validate = validation(), capture = note.capture) {
  const store = note.deployment.storage.createServiceActivationStore(note.deployment.history);
  const stages = staged(note, validate);
  const start = performance.now();
  const {value: outcome, longestMs, holds, all} = await longestHold(() => store.prepare({capture, host: note.host, registeredAtMs: 3,
    guard() {}, validate: stages.validate, bounds: {maxCaptureBytes: ACTIVATION.maxCaptureBytes, maxHistoryEntries: ACTIVATION.maxActivationHistoryEntries,
      maxBytesPerDrain: ACTIVATION.maxBytesPerDrain}}).then(value => value, (error: unknown) => error));
  return {outcome, elapsedMs: performance.now() - start, holdMs: longestMs, holds, all, spans: stages.spans, writes: stages.writes};
}

/**
 * Each hold by the work in it, with the longest of each kind against the 100 ms bar: a checkpoint write (every write
 * but the activation's last), the activation's write, the last history read, an earlier history read, and fold pages,
 * which is every other hold: a page's read, its send to validation, and the checkpoint it builds from the answer.
 */
function holdKinds(label: string, run: {all: Hold[]; spans: Span[]; writes: Span[]}) {
  const overlaps = (hold: Hold, span: Span) => span.start < hold.end && span.end > hold.start;
  const reads = run.spans.filter(span => span.stage === "history read");
  const kindOf = (hold: Hold) => {
    const write = run.writes.findIndex(span => overlaps(hold, span));
    if (write >= 0) return write === run.writes.length - 1 ? "activation write" : "checkpoint write";
    const read = reads.findIndex(span => overlaps(hold, span));
    if (read >= 0) return read === reads.length - 1 ? "last history read" : "earlier history read";
    return "fold page";
  };
  const kinds = new Map<string, number[]>();
  for (const hold of run.all) {const kind = kindOf(hold); kinds.set(kind, [...kinds.get(kind) ?? [], hold.end - hold.start]);}
  return ["fold page", "checkpoint write", "earlier history read", "last history read", "activation write"].map(kind => {
    const lengths = kinds.get(kind) ?? [], longest = Math.max(0, ...lengths);
    return `[typed-activation] ${label} ${kind.padEnd(20)} holds ${String(lengths.length).padStart(5)}  longest ${longest.toFixed(1).padStart(7)} ms ` +
      `(bar 100: ${longest < 100 ? "under" : "OVER"})`;
  }).join("\n");
}

const STAGES = ["history read", "write body", "relay database commit", "continuity sidecar commit", "validation send"];
/** Each stage's count, longest span and total, then the five longest holds split by the stages inside them. */
function stageReport(label: string, run: {holds: Hold[]; spans: Span[]}) {
  const lines = STAGES.map(stage => {
    const lengths = run.spans.filter(span => span.stage === stage).map(span => span.end - span.start);
    return `[typed-activation] ${label} ${stage.padEnd(26)} x${String(lengths.length).padStart(4)}  longest ${Math.max(0, ...lengths).toFixed(1).padStart(7)} ms` +
      `  total ${lengths.reduce((sum, ms) => sum + ms, 0).toFixed(0).padStart(6)} ms`;
  });
  for (const hold of run.holds) {
    const parts = STAGES.map(stage => [stage, run.spans.filter(span => span.stage === stage)
      .reduce((sum, span) => sum + Math.max(0, Math.min(span.end, hold.end) - Math.max(span.start, hold.start)), 0)] as const);
    const other = hold.end - hold.start - parts.reduce((sum, [, ms]) => sum + ms, 0);
    lines.push(`[typed-activation] ${label} hold ${(hold.end - hold.start).toFixed(0).padStart(5)} ms: ` +
      [...parts, ["page reads and other work", Math.max(0, other)] as const].filter(([, ms]) => ms >= 0.5)
        .sort((a, b) => b[1] - a[1]).map(([stage, ms]) => `${stage} ${ms.toFixed(0)}`).join(", "));
  }
  return lines.join("\n");
}

it("the hold probe sees work that holds the event loop, including work made only of promise callbacks", async () => {
  const busy = (ms: number) => {const end = performance.now() + ms; while (performance.now() < end) { /* hold */ }};
  // 30 holds of 10 ms joined by promise callbacks: no timer can run between them, so the loop is held for 300 ms.
  const {longestMs} = await longestHold(async () => {for (let hold = 0; hold < 30; hold++) {busy(10); await Promise.resolve();}});
  expect(longestMs).toBeGreaterThanOrEqual(300);
});

it("a note typed within today's entry limit activates", async () => {
  const note = await typedRelayNote(100);
  expect((await activate(note)).outcome).toEqual({document: note.document, replayed: false, completed: false});
});

// One keystroke past today's entry limit: the activation folds its rows into a checkpoint before its last read.
it("a note typed past today's entry limit activates", async () => {
  const note = await typedRelayNote(ACTIVATION.maxActivationHistoryEntries + 1);
  expect((await activate(note)).outcome).toEqual({document: note.document, replayed: false, completed: false});
});

it("a typed note's final read walks at most one page of rows after its checkpoint", {timeout: 300_000}, async () => {
  const validate = validation();
  // One run and one page more leaves exactly one page. One run and 2,000 rows more leaves more than a page after the run.
  for (const [keystrokes, worst] of [[RUN_ROWS + ORDINARY_FOLD_PAGE_ROWS, true], [RUN_ROWS + 2_000, false]] as const) {
    const note = await typedRelayNote(keystrokes);
    expect((await activate(note, validate)).outcome, `${keystrokes} keystrokes`).toEqual({document: note.document, replayed: false, completed: false});
    const left = rowsAfterCheckpoint(note, validate);
    expect(left, `${keystrokes} keystrokes`).toBeLessThanOrEqual(ORDINARY_FOLD_PAGE_ROWS);
    if (worst) expect(left, `${keystrokes} keystrokes`).toBe(ORDINARY_FOLD_PAGE_ROWS);
  }
});

it("an activation whose lineage folds further between its read and its transaction is refused as stale, and the next one activates", {timeout: 120_000}, async () => {
  const note = await typedRelayNote(2_000), validate = validation(), foldOnce = () => foldOnePage(note, validate);
  // After one page, less than a page follows the checkpoint, so the activation reads from it without folding.
  expect(await foldOnce()).toMatchObject({kind: "folded", reachedCursor: false});
  let folded = false;
  const folding: Validate = Object.assign(async (...[work, signal]: Parameters<Validate>) => {
    const result = await validate(work, signal);
    if ("cut" in work && !folded) {folded = true; expect(await foldOnce()).toMatchObject({kind: "folded"});}
    return result;
  }, validate);
  expect((await activate(note, folding)).outcome).toBeInstanceOf(ServiceActivationStaleCut);
  expect(folded).toBe(true);
  expect((await activate(note, validate)).outcome).toEqual({document: note.document, replayed: false, completed: false});
});

const activated = (note: TypedRelayNote) => ({document: note.document, replayed: false, completed: false});
const storageOf = (note: TypedRelayNote) => note.deployment.storage as unknown as StorageContext;
/**
 * A note typed past today's entry limit, so only a read that continues from a checkpoint can activate it, whose file was
 * saved after its first 100 keystrokes more often than a checkpoint keeps file moments. `before` runs first, on the
 * seeded note. Returns the note and its complete typing, which a capture names once any more rows are appended.
 */
async function savedOften(before?: (note: TypedRelayNote) => void) {
  const longer = typedNote(ACTIVATION.maxActivationHistoryEntries + 100), note = await typedRelayNote(100);
  before?.(note);
  for (let save = 0; save <= CHECKPOINT_MOMENTS; save++) note.appendWrite(`saved-${save}`, note.end, true);
  for (const update of longer.updates.slice(100)) note.appendUpdate(update);
  return {note, longer};
}

it("a note saved more often than its checkpoint keeps file moments activates past today's entry limit", {timeout: 120_000}, async () => {
  const validate = validation(), {note, longer} = await savedOften(), capture = note.captureAt(longer.fullState);
  expect((await activate(note, validate, capture)).outcome).toEqual(activated(note));
  const checkpoint = readOrdinaryCheckpoint(storageOf(note), lineageOf(note, validate))!;
  expect(checkpoint.momentsFromSeq).toBeGreaterThan(capture.source.baseRelaySeq);
  expect(checkpoint).toMatchObject({latestRename: null, latestWrite: {blobSha256: note.end.projectedMarkdownSha256}});
});

// The move back is older than every moment the checkpoint keeps, so the read takes it from the checkpoint and still
// checks the saved file against the note's latest moment.
it.each([
  {file: "keeps the note's text", text: undefined},
  {file: "holds other text", text: "Other text\n"},
])("a note moved away and back before the moments its checkpoint keeps activates only while its saved file $file", {timeout: 120_000}, async ({text}) => {
  const validate = validation(), {note, longer} = await savedOften(seeded => {
    seeded.appendRename(seeded.path, "notes/elsewhere.md", seeded.end);
    seeded.appendRename("notes/elsewhere.md", seeded.path, seeded.end);
  });
  const capture = note.captureAt(longer.fullState);
  note.raw.prepare("INSERT INTO sync_relay_current_files(workspace_id,version_id,path,blob_sha256,content_kind,state_relay_seq) VALUES ('workspace','main',?,?,'text',?)")
    .run(note.path, text === undefined ? note.end.projectedMarkdownSha256 : createHash("sha256").update(text).digest("hex"), capture.source.committedCursor);
  const {outcome} = await activate(note, validate, capture);
  if (text === undefined) expect(outcome).toEqual(activated(note));
  else expect(outcome).toMatchObject({message: "Ordinary activation found a later ordinary file moment with a divergent projection."});
});

// A device's late write of text it settled earlier lands after the note's last keystroke. Its proof compares only the
// writes after that device's last keystroke, which the checkpoint still keeps.
it("a note saved more often than its checkpoint keeps activates past a stale write that follows its last keystroke", {timeout: 120_000}, async () => {
  const validate = validation(), {note, longer} = await savedOften();
  note.appendWrite(`moment-ydoc-${"5".repeat(64)}`, note.end, true);
  const capture = note.captureAt(longer.fullState);
  expect((await activate(note, validate, capture)).outcome).toEqual(activated(note));
});

/**
 * A note typed until the row before `at`, whose typing then sets a metadata key no live document has, at row `at`, and
 * removes it in the next row, with the owner's capture of the result.
 */
async function strayKey(at: number) {
  // The relay keeps deleted content, so the capture does too.
  const note = await typedRelayNote(at - 2), doc = new Y.Doc({gc: false});
  doc.clientID = 3; Y.applyUpdate(doc, note.note.fullState);
  doc.on("update", (update: Uint8Array) => {note.appendUpdate(update);});
  doc.getMap("meta").set("stray", 1);
  doc.getMap("meta").delete("stray");
  const capture = note.captureAt(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return {note, capture};
}

// A read from the base projects only the prefixes its source's proof needs, so a history may pass through a state no
// live document has. A fold page that ends at that state cannot refuse what the read from the base accepts.
it("a note whose typing passes through a state no live document has, at the end of a fold page, activates as a read from the base does", {timeout: 120_000}, async () => {
  const validate = validation(), probe = await typedRelayNote(2_000);
  expect(await foldOnePage(probe, validate)).toMatchObject({kind: "folded", reachedCursor: false});
  const end = readOrdinaryCheckpoint(storageOf(probe), lineageOf(probe, validate))!.throughRelaySeq;
  const at = Number(probe.raw.prepare("SELECT origin_seq FROM sync_relay_log WHERE relay_seq=?").get(end)!.origin_seq);
  // Without a validation policy to fold under, activation reads from the base.
  const fromBase = await strayKey(at), unfolded = ((...args: Parameters<Validate>) => validate(...args)) as Validate;
  expect((await activate(fromBase.note, unfolded, fromBase.capture)).outcome).toEqual(activated(fromBase.note));
  const folding = await strayKey(at);
  expect((await activate(folding.note, validate, folding.capture)).outcome).toEqual(activated(folding.note));
});

// The relay saves a fold's checkpoint before the activation registers. A relay that stops between the two, and starts
// again, continues from that checkpoint and validates no fold page twice.
it.each([false, true])("an activation that stopped after its fold saved continues from the saved checkpoint, restarted: %s", {timeout: 120_000}, async restarted => {
  const validate = validation(), {note, longer} = await savedOften(), capture = note.captureAt(longer.fullState), scope = lineageOf(note, validate);
  let pages = 0;
  const counted = (stop: boolean): Validate => Object.assign(async (...[work, signal]: Parameters<Validate>) => {
    if (stop && "cut" in work) throw new Error("The relay stopped before it registered the activation.");
    if ("page" in work) pages++;
    return validate(work, signal);
  }, validate);
  expect((await activate(note, counted(true), capture)).outcome).toMatchObject({message: "The relay stopped before it registered the activation."});
  expect(pages).toBeGreaterThan(0);
  const saved = readOrdinaryCheckpoint(storageOf(note), scope)!;
  expect(saved).toMatchObject({throughRelaySeq: capture.source.committedCursor, latestWrite: {blobSha256: note.end.projectedMarkdownSha256}});
  if (restarted) note.reopen();
  expect(readOrdinaryCheckpoint(storageOf(note), scope)).toEqual(saved);
  pages = 0;
  expect((await activate(note, counted(false), capture)).outcome).toEqual(activated(note));
  expect(pages).toBe(0);
});

// The plan's bars, 1 s to activate and 100 ms of held event loop, are reported here rather than asserted: a shared
// runner's timing would fail a hard bar without a regression.
it("a long typed note activates however many keystrokes it took, and reports its time and longest hold", {timeout: 600_000}, async () => {
  const validate = validation();
  // The child process starts on its first job; this one keeps that start out of the figures.
  await activate(await typedRelayNote(100), validate);
  for (const keystrokes of [10_000, 100_000, WORST_REMAINDER]) {
    const note = await typedRelayNote(keystrokes);
    const run = await activate(note, validate), {outcome, elapsedMs, holdMs} = run;
    console.log(`[typed-activation] ${keystrokes} keystrokes${keystrokes === WORST_REMAINDER ? " (worst remainder)" : ""}: ` +
      `${outcome instanceof Error ? `refused (${outcome.message})` : "activated"}, ${Math.round(elapsedMs)} ms (bar 1000), ` +
      `longest event-loop hold ${Math.round(holdMs)} ms (bar 100), ${rowsAfterCheckpoint(note, validate)} rows after the checkpoint\n` +
      `${stageReport(String(keystrokes), run)}\n${holdKinds(String(keystrokes), run)}`);
    expect.soft(outcome, `${keystrokes} keystrokes`).toEqual({document: note.document, replayed: false, completed: false});
  }
});
