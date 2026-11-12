// #3763: typing any amount must never stop a note from going live, and activation must cost what the note's size costs,
// not what its edit count costs. These tests drive the activation itself (`prepare`) with production settings and
// assert its outcome: accepted, how long it took, and that it never held the event loop long enough to stall typing.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, expect, it } from "vitest";
import { validateOrdinaryActivation, type OrdinaryActivationValidator } from "./storage/ordinaryActivationValidation.js";
import { checkpointPolicySha256 } from "./storage/ordinaryActivationCheckpoint.js";
import { ACTIVATION, typedRelayNote as seedTypedRelayNote, type TypedRelayNote } from "./testing/typedNotes.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
// The bars from the agreed #3763 plan.
const ACTIVATION_MS = 1_000, EVENT_LOOP_STALL_MS = 100;
const typedRelayNote = (keystrokes: number) => seedTypedRelayNote(keystrokes, close => {cleanup.push(close);});
/** The relay's validation in this process, naming its policy as the relay's validation pool does. */
const validate: OrdinaryActivationValidator = Object.assign(
  async (work: Parameters<OrdinaryActivationValidator>[0]) => validateOrdinaryActivation(work, ACTIVATION.validation),
  {policySha256: checkpointPolicySha256(ACTIVATION.validation)});

/** The relay's work for this note that runs off the request path, before anyone shares it. Main has none. */
async function foldAhead(_note: TypedRelayNote) {}

/** One activation with the self-hosted profile's settings, timed, with the event loop watched. */
async function activate(note: TypedRelayNote) {
  const store = note.deployment.storage.createServiceActivationStore(note.deployment.history);
  const stalls = monitorEventLoopDelay({resolution: 10}); stalls.enable();
  const start = performance.now();
  try {
    const outcome = await store.prepare({capture: note.capture, host: note.host, registeredAtMs: 3, guard() {},
      validate, bounds: {maxCaptureBytes: ACTIVATION.maxCaptureBytes, maxHistoryEntries: ACTIVATION.maxActivationHistoryEntries,
        maxBytesPerDrain: ACTIVATION.maxBytesPerDrain}}).then(value => value, (error: unknown) => error);
    return {outcome, elapsedMs: performance.now() - start, stallMs: stalls.max / 1e6};
  } finally {stalls.disable();}
}

it("a note typed within today's entry limit activates", async () => {
  const note = await typedRelayNote(100);
  expect((await activate(note)).outcome).toEqual({document: note.document, replayed: false, completed: false});
});

// Fails on main: 200 keystrokes after the base is more history than the activation reads, and it refuses the note.
it("a note typed past today's entry limit activates", async () => {
  const note = await typedRelayNote(200);
  expect((await activate(note)).outcome).toEqual({document: note.document, replayed: false, completed: false});
});

it("a long typed note activates in under a second without stalling the relay, however many keystrokes it took", {timeout: 600_000}, async () => {
  for (const keystrokes of [10_000, 100_000]) {
    const note = await typedRelayNote(keystrokes);
    await foldAhead(note);
    const {outcome, elapsedMs, stallMs} = await activate(note);
    // Every size reports all three, so one missed bar still shows the figures for the rest.
    console.log(`[typed-activation] ${keystrokes} keystrokes: ${outcome instanceof Error ? `refused (${outcome.message})` : "activated"}, ` +
      `${Math.round(elapsedMs)} ms, longest event-loop stall ${Math.round(stallMs)} ms`);
    expect.soft(outcome, `${keystrokes} keystrokes`).toEqual({document: note.document, replayed: false, completed: false});
    expect.soft(elapsedMs, `${keystrokes} keystrokes: activation time`).toBeLessThan(ACTIVATION_MS);
    expect.soft(stallMs, `${keystrokes} keystrokes: longest event-loop stall`).toBeLessThanOrEqual(EVENT_LOOP_STALL_MS);
  }
});
