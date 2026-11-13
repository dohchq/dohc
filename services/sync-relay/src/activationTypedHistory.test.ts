// #3763: typing any amount must never stop a note from going live, and activation must cost what the note's size costs,
// not what its edit count costs. These tests drive the activation itself (`prepare`) with production settings, assert
// that it accepts the note, and report how long it took, the longest time it held the relay's event loop, and the work
// on the main thread inside its longest holds.
import { afterEach, expect, it } from "vitest";
import { createLiveValidationExecutor } from "./liveValidation.js";
import type { StorageContext } from "./storage/context.js";
import type { OrdinaryCheckpointScope } from "./storage/ordinaryActivationCheckpoint.js";
import { foldOrdinaryCheckpointPages, ORDINARY_FOLD_PAGE_ROWS, type OrdinaryFoldValidator } from "./storage/ordinaryActivationFold.js";
import { ServiceActivationStaleCut } from "./storage/ordinaryActivationSource.js";
import { ACTIVATION, typedRelayNote as seedTypedRelayNote, type TypedRelayNote } from "./testing/typedNotes.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
const typedRelayNote = (keystrokes: number) => seedTypedRelayNote(keystrokes, close => {cleanup.push(close);});
/** The relay's validation as it runs in production: in its own child process, with the profile's policy. */
function validation() {
  const pool = createLiveValidationExecutor(); cleanup.push(() => pool.close());
  return pool.ordinaryActivation(ACTIVATION.validation);
}

/** The relay's work for this note that runs off the request path, before anyone shares it. Main has none. */
async function foldAhead(_note: TypedRelayNote) {}

type Hold = {start: number; end: number};
/**
 * The longest time the event loop went without running a timer while `run` worked, counting a hold still going when
 * `run` settles, and the five longest holds. A timer is due every `everyMs`, so a loop that is never held reads about
 * `everyMs`. Promise callbacks run before any timer, so work made only of them holds the loop for its whole length.
 * `monitorEventLoopDelay` records a delay only from its second timer on, so it reads 0 for such a hold.
 */
async function longestHold<T>(run: () => Promise<T>, everyMs = 5) {
  let last = performance.now();
  const holds: Hold[] = [];
  const keep = (hold: Hold) => {holds.push(hold); holds.sort((a, b) => (b.end - b.start) - (a.end - a.start)); holds.splice(5);};
  const timer = setInterval(() => {const now = performance.now(); keep({start: last, end: now}); last = now;}, everyMs);
  try {
    const value = await run();
    keep({start: last, end: performance.now()});
    return {value, longestMs: holds[0]!.end - holds[0]!.start, holds};
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
  storage.tx = run => {
    writing = true; committed = 0;
    try {
      const value = tx(() => span("write body", run));
      spans.push({stage: "continuity sidecar commit", start: committed, end: performance.now()});
      return value;
    } finally {writing = false;}
  };
  const sent: Validate = Object.assign((...args: Parameters<Validate>) => span("validation send", () => validate(...args)), validate);
  return {validate: sent, spans};
}

/** One activation with the self-hosted profile's settings, timed, with the event loop watched and its work staged. */
async function activate(note: TypedRelayNote, validate = validation()) {
  const store = note.deployment.storage.createServiceActivationStore(note.deployment.history);
  const stages = staged(note, validate);
  const start = performance.now();
  const {value: outcome, longestMs, holds} = await longestHold(() => store.prepare({capture: note.capture, host: note.host, registeredAtMs: 3,
    guard() {}, validate: stages.validate, bounds: {maxCaptureBytes: ACTIVATION.maxCaptureBytes, maxHistoryEntries: ACTIVATION.maxActivationHistoryEntries,
      maxBytesPerDrain: ACTIVATION.maxBytesPerDrain}}).then(value => value, (error: unknown) => error));
  return {outcome, elapsedMs: performance.now() - start, holdMs: longestMs, holds, spans: stages.spans};
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

// One keystroke past the most history one read takes: the activation folds the rest.
it("a note typed past today's entry limit activates", async () => {
  const note = await typedRelayNote(ACTIVATION.maxActivationHistoryEntries + 1);
  expect((await activate(note)).outcome).toEqual({document: note.document, replayed: false, completed: false});
});

it("an activation whose lineage folds further between its read and its transaction is refused as stale, and the next one activates", {timeout: 120_000}, async () => {
  const note = await typedRelayNote(2_400), validate = validation(), {source} = note.capture;
  const storage = note.deployment.storage as unknown as StorageContext;
  const scope: OrdinaryCheckpointScope = {namespace: note.deployment.history.namespace, document: note.document, replicationEpoch: source.replicationEpoch,
    streamIdentity: source.streamIdentity, base: {relaySeq: source.baseRelaySeq, originId: source.baseOriginId, originSeq: source.baseOriginSeq},
    policySha256: validate.policySha256!};
  const foldPage: OrdinaryFoldValidator = async (work, signal) => {
    const result = await validate(work, signal);
    if (result.kind === "accepted") throw new Error("A fold page was answered as an activation.");
    return result;
  };
  const foldOnce = () => foldOrdinaryCheckpointPages(storage, {scope, pages: 1, validate: foldPage, nowMs: () => 3,
    bounds: {pageRows: ORDINARY_FOLD_PAGE_ROWS, pageBytes: ACTIVATION.maxBytesPerDrain}});
  // After one page, fewer rows follow the checkpoint than one read takes, so the activation reads from it without folding.
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

// The plan's bars, 1 s to activate and 100 ms of held event loop, are reported here rather than asserted: a shared
// runner's timing would fail a hard bar without a regression.
it("a long typed note activates however many keystrokes it took, and reports its time and longest hold", {timeout: 600_000}, async () => {
  const validate = validation();
  // The child process starts on its first job; this one keeps that start out of the figures.
  await activate(await typedRelayNote(100), validate);
  for (const keystrokes of [10_000, 100_000]) {
    const note = await typedRelayNote(keystrokes);
    await foldAhead(note);
    const run = await activate(note, validate), {outcome, elapsedMs, holdMs} = run;
    console.log(`[typed-activation] ${keystrokes} keystrokes: ${outcome instanceof Error ? `refused (${outcome.message})` : "activated"}, ` +
      `${Math.round(elapsedMs)} ms (bar 1000), longest event-loop hold ${Math.round(holdMs)} ms (bar 100)\n${stageReport(String(keystrokes), run)}`);
    expect.soft(outcome, `${keystrokes} keystrokes`).toEqual({document: note.document, replayed: false, completed: false});
  }
});
