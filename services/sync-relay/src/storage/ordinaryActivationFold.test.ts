import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import type { StorageContext } from "./context";
import { CHECKPOINT_MOMENTS, checkpointPolicySha256, readOrdinaryCheckpoint, type OrdinaryCheckpointScope } from "./ordinaryActivationCheckpoint";
import { foldOrdinaryCheckpointPages, type OrdinaryFoldBounds, type OrdinaryFoldValidator } from "./ordinaryActivationFold";
import { validateOrdinaryActivation } from "./ordinaryActivationValidation";
import { ACTIVATION, typedNote, typedRelayNote, type TypedRelayNote } from "../testing/typedNotes";
import { createLiveMarkdownRegistrationValidator } from "../../../../packages/ydoc-projection/src/liveDocumentValidation";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
const seed = (keystrokes: number) => typedRelayNote(keystrokes, close => {cleanup.push(close);});
const validate: OrdinaryFoldValidator = async work => validateOrdinaryActivation(work, ACTIVATION.validation);
const project = createLiveMarkdownRegistrationValidator(ACTIVATION.validation);
function folding(note: TypedRelayNote, bounds: OrdinaryFoldBounds, check: OrdinaryFoldValidator = validate) {
  const storage = note.deployment.storage as unknown as StorageContext;
  const scope: OrdinaryCheckpointScope = {namespace: note.deployment.history.namespace, document: note.document, replicationEpoch: "epoch",
    streamIdentity: "stream", base: {relaySeq: note.capture.source.baseRelaySeq, originId: "typist", originSeq: 1},
    policySha256: checkpointPolicySha256(ACTIVATION.validation)};
  /** Folds a run of up to `pages` pages; one page by default. */
  const fold = (pages = 1) => foldOrdinaryCheckpointPages(storage, {scope, bounds, pages, validate: check, nowMs: () => 7});
  /** Folds runs until the checkpoint is current or the fold stops, and returns the last outcome. */
  const all = async (pages = 1) => {
    for (let runs = 0; runs < 1_000; runs++) {const outcome = await fold(pages); if (outcome.kind !== "folded") return outcome;}
    throw new Error("The fold did not finish.");
  };
  return {storage, scope, fold, all, read: () => readOrdinaryCheckpoint(storage, scope)};
}
/** The projection and full state of the note's base and its first `typed` keystrokes, replayed in one document. */
function replayed(note: TypedRelayNote, typed: number) {
  const doc = new Y.Doc({gc: false});
  for (const update of [note.note.baseline, ...note.note.updates.slice(0, typed)]) Y.applyUpdate(doc, update);
  const result = project({document: note.document, currentPath: note.path, checkpoint: Y.encodeStateAsUpdate(doc)});
  doc.destroy();
  if (result.kind !== "accepted") throw new Error("Invalid replay.");
  return {projectedMarkdownSha256: result.evidence.projectedMarkdownSha256, projectedMarkdownByteLength: result.evidence.projectedMarkdownByteLength,
    stateUpdateSha256: result.evidence.stateUpdateSha256};
}
const projection = ({projectedMarkdownSha256, projectedMarkdownByteLength}: {projectedMarkdownSha256: string; projectedMarkdownByteLength: number}) =>
  ({projectedMarkdownSha256, projectedMarkdownByteLength});

it("a typed note folds page by page to the state and projection one replay of it has", async () => {
  const note = await seed(600), f = folding(note, {pageRows: 128, pageBytes: ACTIVATION.maxBytesPerDrain});
  expect(await f.all()).toEqual({kind: "current"});
  const checkpoint = f.read()!, end = replayed(note, 600);
  expect(checkpoint.throughRelaySeq).toBe(note.capture.source.committedCursor);
  expect(checkpoint.foldedEntries).toBe(601);
  expect(checkpoint.stateSha256).toBe(end.stateUpdateSha256);
  expect(checkpoint.projection).toEqual(projection(end));
  expect(checkpoint.currentPath).toBe(note.path);
  // The last page reached the cursor, so the rows a source may name keep the projection of the history through them.
  expect(checkpoint.tail).toHaveLength(32);
  expect(checkpoint.tail.at(-1)).toMatchObject({relaySeq: note.capture.source.committedCursor, originSeq: 601, ordinary: true, projection: projection(end)});
  expect(checkpoint.tail.at(-2)!.projection).toEqual(projection(replayed(note, 599)));
  expect(checkpoint.tail.every(row => row.projection !== null)).toBe(true);
});

it("a file moment ends a page, and the checkpoint keeps the projection the moment followed", async () => {
  const longer = typedNote(100), note = await seed(50), f = folding(note, {pageRows: 128, pageBytes: ACTIVATION.maxBytesPerDrain});
  const before = replayed(note, 50);
  const moment = note.appendMoment({momentId: "saved", path: note.path, operation: "write", payloadAfterPath: note.path, payloadAfterContentKind: "text",
    payloadAfterBlobSha256: before.projectedMarkdownSha256, payloadAfterByteLength: before.projectedMarkdownByteLength});
  for (const update of longer.updates.slice(50)) note.appendUpdate(update);
  expect(await f.fold()).toMatchObject({kind: "folded", throughRelaySeq: moment - 1});
  expect(f.read()!.moments).toEqual([]);
  expect(await f.all()).toEqual({kind: "current"});
  const checkpoint = f.read()!;
  expect(checkpoint.moments).toEqual([{relaySeq: moment, operation: "write", ...projection(before),
    write: {blobSha256: before.projectedMarkdownSha256, byteLength: before.projectedMarkdownByteLength, objectMoment: false}}]);
  expect(checkpoint.stateSha256).toBe(replayed({...note, note: longer}, 100).stateUpdateSha256);
});

it("the fold stops at a rename to an empty path, as activation's reader refuses the move back from it", async () => {
  const note = await seed(20), f = folding(note, {pageRows: 128, pageBytes: ACTIVATION.maxBytesPerDrain});
  const renamed = note.appendRename(note.path, "", replayed(note, 20));
  expect(await f.all()).toEqual({kind: "blocked", relaySeq: renamed});
  expect(f.read()!.throughRelaySeq).toBe(renamed - 1);
});

it("the checkpoint keeps its latest rename and object write after it drops the moments before them", async () => {
  const note = await seed(20), f = folding(note, {pageRows: 1_024, pageBytes: ACTIVATION.maxBytesPerDrain}), text = replayed(note, 20);
  note.appendRename(note.path, "notes/elsewhere.md", text);
  const back = note.appendRename("notes/elsewhere.md", note.path, text), saved = note.appendWrite("saved", text, true);
  for (let later = 0; later < CHECKPOINT_MOMENTS; later++) note.appendWrite(`later-${later}`, text);
  expect(await f.all()).toEqual({kind: "current"});
  const checkpoint = f.read()!;
  expect(checkpoint.moments).toHaveLength(CHECKPOINT_MOMENTS);
  expect(checkpoint.momentsFromSeq).toBe(saved + 1);
  expect(checkpoint).toMatchObject({latestRename: back,
    latestWrite: {relaySeq: saved, blobSha256: text.projectedMarkdownSha256, byteLength: text.projectedMarkdownByteLength}});
});

it("the fold stops before a row activation would refuse, and never folds past it", async () => {
  const longer = typedNote(320), note = await seed(300), f = folding(note, {pageRows: 128, pageBytes: ACTIVATION.maxBytesPerDrain});
  const moved = note.appendUpdate(longer.updates[300]!, {path: "notes/elsewhere.md"});
  for (const update of longer.updates.slice(301)) note.appendUpdate(update);
  expect(await f.all()).toEqual({kind: "blocked", relaySeq: moved});
  expect(f.read()!.throughRelaySeq).toBe(moved - 1);
  expect(await f.fold()).toEqual({kind: "blocked", relaySeq: moved});
  expect(f.read()!.throughRelaySeq).toBe(moved - 1);
});

it("a page validation refuses saves nothing, and the next fold refuses it again", async () => {
  const note = await seed(200), f = folding(note, {pageRows: 128, pageBytes: ACTIVATION.maxBytesPerDrain});
  expect(await f.fold()).toMatchObject({kind: "folded"});
  const saved = f.read()!;
  note.appendUpdate(new Uint8Array([1, 2, 3]));
  expect(await f.all()).toEqual({kind: "refused", message: "Ordinary activation history is not a valid live document."});
  // The page holding the refused row is the one that refuses, so the checkpoint stays where the last accepted page left it.
  expect(f.read()).toEqual(saved);
  expect(saved.foldedEntries).toBe(129);
  expect(await f.fold()).toMatchObject({kind: "refused"});
});

/** Records the largest string or byte value any statement returns from now on. */
function largestRead(storage: StorageContext) {
  let largest = 0;
  const note = (value: unknown) => {
    for (const field of Object.values(value && typeof value === "object" ? value : {}))
      largest = Math.max(largest, typeof field === "string" || field instanceof Uint8Array ? field.length : 0);
    return value;
  };
  const prepare = storage.db.prepare.bind(storage.db);
  storage.db.prepare = (sql: string) => {
    const statement = prepare(sql);
    return new Proxy(statement, {get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "get") return (...args: never[]) => note(target.get(...args));
      if (key === "all") return (...args: never[]) => target.all(...args).map(note);
      if (key === "iterate") return function* (...args: never[]) {for (const row of target.iterate(...args)) yield note(row);};
      return typeof value === "function" ? value.bind(target) : value;
    }});
  };
  return () => largest;
}

it("pages end at the byte bound, and the fold still reaches one replay's state", async () => {
  const note = await seed(200), f = folding(note, {pageRows: 1_024, pageBytes: 8 * 1024});
  expect(await f.fold()).toMatchObject({kind: "folded", reachedCursor: false});
  expect(f.read()!.foldedEntries).toBeLessThan(100);
  expect(await f.all()).toEqual({kind: "current"});
  expect(f.read()!.stateSha256).toBe(replayed(note, 200).stateUpdateSha256);
});

it("rows of oversized payloads are refused at the byte bound without reading past it", async () => {
  const bound = 32 * 1024, longer = typedNote(60), note = await seed(40), f = folding(note, {pageRows: 1_024, pageBytes: bound});
  const oversized = note.appendMoment({momentId: "large", path: note.path, operation: "write", payloadAfterPath: note.path,
    payloadAfterContentKind: "text", payloadAfterBlobSha256: "0".repeat(64), payloadAfterByteLength: 1, padding: "x".repeat(bound)});
  for (const update of longer.updates.slice(40)) note.appendUpdate(update);
  const largest = largestRead(f.storage);
  expect(await f.all()).toEqual({kind: "blocked", relaySeq: oversized});
  expect(f.read()!.throughRelaySeq).toBe(oversized - 1);
  expect(await f.fold()).toEqual({kind: "blocked", relaySeq: oversized});
  expect(largest()).toBeLessThan(bound);
});

it("a fold another fold overtook saves nothing", async () => {
  const note = await seed(150);
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const f = folding(note, {pageRows: 64, pageBytes: ACTIVATION.maxBytesPerDrain}, async work => {await gate; return validateOrdinaryActivation(work, ACTIVATION.validation);});
  const first = f.fold(), second = f.fold();
  release();
  expect(await first).toMatchObject({kind: "folded"});
  expect(await second).toEqual({kind: "lost"});
  expect(f.read()!.foldedEntries).toBe(65);
});

/** Counts the relay transactions the storage runs from now on. */
function countSaves(storage: StorageContext) {
  let saves = 0;
  const tx = storage.tx.bind(storage);
  storage.tx = run => {saves++; return tx(run);};
  return () => saves;
}

it("a run of pages saves its checkpoint once, at the state one replay of the note has", async () => {
  const note = await seed(600), f = folding(note, {pageRows: 128, pageBytes: ACTIVATION.maxBytesPerDrain});
  const saves = countSaves(f.storage);
  expect(await f.fold(16)).toEqual({kind: "folded", throughRelaySeq: note.capture.source.committedCursor, reachedCursor: true});
  expect(saves()).toBe(1);
  const checkpoint = f.read()!, end = replayed(note, 600);
  expect(checkpoint.foldedEntries).toBe(601);
  expect(checkpoint.stateSha256).toBe(end.stateUpdateSha256);
  expect(checkpoint.tail.at(-1)).toMatchObject({relaySeq: note.capture.source.committedCursor, projection: projection(end)});
  expect(await f.fold(16)).toEqual({kind: "current"});
});

it("a run ends after its pages, and the next run continues from the checkpoint it saved", async () => {
  const note = await seed(600), f = folding(note, {pageRows: 128, pageBytes: ACTIVATION.maxBytesPerDrain});
  const saves = countSaves(f.storage);
  expect(await f.fold(2)).toMatchObject({kind: "folded", reachedCursor: false});
  expect(f.read()!.foldedEntries).toBe(257);
  expect(await f.all(2)).toEqual({kind: "current"});
  expect(saves()).toBe(3);
  expect(f.read()!.stateSha256).toBe(replayed(note, 600).stateUpdateSha256);
});

it("a run whose page validation refuses saves the pages before it, reports the refusal, and the next run starts from them", async () => {
  let pages = 0;
  const note = await seed(300), f = folding(note, {pageRows: 128, pageBytes: ACTIVATION.maxBytesPerDrain}, async work => {pages++; return validate(work);});
  note.appendUpdate(new Uint8Array([1, 2, 3]));
  const refused = {kind: "refused", message: "Ordinary activation history is not a valid live document."};
  expect(await f.fold(16)).toEqual(refused);
  expect(pages).toBe(3);
  expect(f.read()!.foldedEntries).toBe(257);
  // The next run validates only the page after the saved checkpoint.
  expect(await f.fold(16)).toEqual(refused);
  expect(pages).toBe(4);
  expect(f.read()!.foldedEntries).toBe(257);
});

it("a run stopped at a row the fold cannot take saves the pages before it, and the next run reports the row", async () => {
  const longer = typedNote(320), note = await seed(300), f = folding(note, {pageRows: 128, pageBytes: ACTIVATION.maxBytesPerDrain});
  const moved = note.appendUpdate(longer.updates[300]!, {path: "notes/elsewhere.md"});
  expect(await f.fold(16)).toMatchObject({kind: "folded", throughRelaySeq: moved - 1, reachedCursor: false});
  expect(f.read()!.throughRelaySeq).toBe(moved - 1);
  expect(await f.fold(16)).toEqual({kind: "blocked", relaySeq: moved});
});

it("a fold run lets the event loop turn before each page read and before its save", async () => {
  const note = await seed(600), events: string[] = [];
  const f = folding(note, {pageRows: 128, pageBytes: ACTIVATION.maxBytesPerDrain}, async work => {events.push("page"); return validate(work);});
  const tx = f.storage.tx.bind(f.storage);
  f.storage.tx = run => {events.push("save"); return tx(run);};
  // One immediate per event-loop turn, for as long as the run lasts.
  let running = true;
  const turn = () => {events.push("turn"); if (running) setImmediate(turn);};
  setImmediate(turn);
  try {expect(await f.fold(16)).toMatchObject({kind: "folded", reachedCursor: true});} finally {running = false;}
  const work = events.filter(event => event !== "turn");
  expect(work).toEqual(["page", "page", "page", "page", "page", "save"]);
  // Every page and the save start in a turn of their own.
  const order = events.join(" ");
  expect(order).not.toMatch(/(page|save) (page|save)/);
});

// The plan's targets, 250 ms to validate a page and 10 ms of lock to save it, are reported rather than asserted. The
// ceilings, four and five times looser, catch a gross regression without failing on a shared runner's noise.
const PAGE_CEILING_MS = 1_000, LOCK_CEILING_MS = 50;
it("a long note folds page by page to its replayed state within loose time ceilings, and reports its slowest page and longest save", {timeout: 600_000}, async () => {
  const note = await seed(10_000), timed: number[] = [], locks: number[] = [];
  const f = folding(note, {pageRows: 1_024, pageBytes: ACTIVATION.maxBytesPerDrain}, async work => {
    const start = performance.now();
    try {return validateOrdinaryActivation(work, ACTIVATION.validation);} finally {timed.push(performance.now() - start);}
  });
  const tx = f.storage.tx.bind(f.storage);
  f.storage.tx = run => {const start = performance.now(); try {return tx(run);} finally {locks.push(performance.now() - start);}};
  expect(await f.all()).toEqual({kind: "current"});
  expect(f.read()!.stateSha256).toBe(replayed(note, 10_000).stateUpdateSha256);
  console.log(`[fold] 10000 keystrokes: ${timed.length} pages, slowest page ${Math.round(Math.max(...timed))} ms (target 250), ` +
    `longest save ${Math.max(...locks).toFixed(1)} ms of lock (target 10)`);
  expect(Math.max(...timed), "slowest page").toBeLessThanOrEqual(PAGE_CEILING_MS);
  expect(Math.max(...locks), "longest save").toBeLessThanOrEqual(LOCK_CEILING_MS);
});
