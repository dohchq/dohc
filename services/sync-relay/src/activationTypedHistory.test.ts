// #3763: typing any amount must never stop a note from going live, and activation must cost what the note's size costs,
// not what its edit count costs. These tests drive the activation itself (`prepare`) with production settings, assert
// that it accepts the note, and report how long it took and the longest time it held the relay's event loop.
import { afterEach, expect, it } from "vitest";
import { createLiveValidationExecutor } from "./liveValidation.js";
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

/**
 * The longest time the event loop went without running a timer while `run` worked, counting a hold still going when
 * `run` settles. A timer is due every `everyMs`, so a loop that is never held reads about `everyMs`. Promise callbacks
 * run before any timer, so work made only of them holds the loop for its whole length. `monitorEventLoopDelay` records
 * a delay only from its second timer on, so it reads 0 for such a hold.
 */
async function longestHold<T>(run: () => Promise<T>, everyMs = 5) {
  let last = performance.now(), longestMs = 0;
  const timer = setInterval(() => {const now = performance.now(); longestMs = Math.max(longestMs, now - last); last = now;}, everyMs);
  try {
    const value = await run();
    return {value, longestMs: Math.max(longestMs, performance.now() - last)};
  } finally {clearInterval(timer);}
}

/** One activation with the self-hosted profile's settings, timed, with the event loop watched. */
async function activate(note: TypedRelayNote, validate = validation()) {
  const store = note.deployment.storage.createServiceActivationStore(note.deployment.history);
  const start = performance.now();
  const {value: outcome, longestMs} = await longestHold(() => store.prepare({capture: note.capture, host: note.host, registeredAtMs: 3,
    guard() {}, validate, bounds: {maxCaptureBytes: ACTIVATION.maxCaptureBytes, maxHistoryEntries: ACTIVATION.maxActivationHistoryEntries,
      maxBytesPerDrain: ACTIVATION.maxBytesPerDrain}}).then(value => value, (error: unknown) => error));
  return {outcome, elapsedMs: performance.now() - start, holdMs: longestMs};
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

// The plan's bars, 1 s to activate and 100 ms of held event loop, are reported here rather than asserted: a shared
// runner's timing would fail a hard bar without a regression.
it("a long typed note activates however many keystrokes it took, and reports its time and longest hold", {timeout: 600_000}, async () => {
  const validate = validation();
  // The child process starts on its first job; this one keeps that start out of the figures.
  await activate(await typedRelayNote(100), validate);
  for (const keystrokes of [10_000, 100_000]) {
    const note = await typedRelayNote(keystrokes);
    await foldAhead(note);
    const {outcome, elapsedMs, holdMs} = await activate(note, validate);
    console.log(`[typed-activation] ${keystrokes} keystrokes: ${outcome instanceof Error ? `refused (${outcome.message})` : "activated"}, ` +
      `${Math.round(elapsedMs)} ms (bar 1000), longest event-loop hold ${Math.round(holdMs)} ms (bar 100)`);
    expect.soft(outcome, `${keystrokes} keystrokes`).toEqual({document: note.document, replayed: false, completed: false});
  }
});
