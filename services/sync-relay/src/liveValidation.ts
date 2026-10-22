import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { OrderedLiveUpdateCutPolicy } from "@dohc/ydoc-projection/live-journal-validation";
import type { FirstOpenBaseInput, FirstOpenBaseResult } from "./firstOpenBase.js";
import type { OwnerOutboxAdmission, CapacityLiveAdmissionValidator } from "./ownerOutboxDelivery.js";
import type { LiveJournalValidation } from "./storage/types.js";
import type { FirstOpenHistory, FirstOpenHistoryRead } from "./storage/firstOpenHistory.js";

export type SettlementNormalizationInput = {
  document: import("@dohc/live-session-contract").LiveDocumentKey;
  currentPath: string;
  checkpoint: Uint8Array;
};
export type SettlementNormalizationResult =
  | {
      kind: "accepted";
      evidence: {
        stateUpdateSha256: string;
        projectedMarkdownSha256: string;
        projectedMarkdownByteLength: number;
      };
    }
  | {
      kind: "refused";
      reason:
        | "invalid-input"
        | "invalid-update"
        | "invalid-schema"
        | "projection-mutated"
        | "capacity-refused";
      source: "call" | "registration-input";
    };
export type LiveValidationWork =
  | ({ policy: OrderedLiveUpdateCutPolicy } & (
      | { kind: "journal"; input: Parameters<OwnerOutboxAdmission["validate"]>[0] }
      | { kind: "settlement"; input: SettlementNormalizationInput }
      | { kind: "first-open"; input: FirstOpenBaseInput }
    ))
  | { kind: "first-open-history"; input: FirstOpenHistoryRead };
type CapacityRetry = {
  kind: "retry";
  reason: "admission-unavailable";
  waitForCapacity(signal?: AbortSignal): Promise<void>;
};
type Slot = { worker: Worker; busy: boolean };
/** How long a first-open build may run: about ten times the slowest real note measured. */
export const FIRST_OPEN_BUILD_MS = 60_000;
/** Two process-wide validation slots, with no retained waiting inputs. */
export function createLiveValidationExecutor({ firstOpenBuildMs = FIRST_OPEN_BUILD_MS } = {}) {
  const slots = new Set<Slot>();
  const waiters = new Set<() => void>();
  let closed = false;
  // A failed job's slot stays busy until its worker exits.
  let firstOpenSlot: Slot | undefined;
  const hasCapacity = () => !closed && (slots.size < 2 || [...slots].some((slot) => !slot.busy));
  const notify = () => {
    for (const wake of [...waiters]) wake();
  };
  function waitForCapacity(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (closed) return Promise.reject(new Error("Live validation closed."));
    if (hasCapacity())
      return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const dispose = () => {
        waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
      };
      const wake = () => {
        dispose();
        if (closed) reject(new Error("Live validation closed."));
        else resolve();
      };
      const abort = () => {
        dispose();
        reject(signal!.reason);
      };
      waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  function spawn() {
    const source = import.meta.url.endsWith(".ts");
    const worker = new Worker(
      new URL(
        source ? "./liveValidationWorker.ts" : "./liveValidationWorker.js",
        import.meta.url,
      ),
      {
        execArgv: source
          ? [
              "--import",
              pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
            ]
          : [],
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      },
    );
    const slot = { worker, busy: false };
    slots.add(slot);
    worker.on("error", () => {}); // A failed idle worker must not crash the relay.
    worker.once("exit", () => {
      slots.delete(slot);
      notify();
    });
    worker.unref();
    return slot;
  }
  async function submit<Result>(
    work: LiveValidationWork,
    signal?: AbortSignal,
    claim?: (slot: Slot) => void,
  ): Promise<Result | CapacityRetry> {
    signal?.throwIfAborted();
    if (closed) throw new Error("Live validation closed.");
    const slot =
      [...slots].find((slot) => !slot.busy) ??
      (slots.size < 2 ? spawn() : undefined);
    if (!slot)
      return {
        kind: "retry",
        reason: "admission-unavailable",
        waitForCapacity,
      };
    slot.busy = true;
    claim?.(slot);
    slot.worker.ref();
    return new Promise<Result>((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        slot.worker.off("message", complete);
        slot.worker.off("error", fail);
        slot.worker.off("exit", exited);
      };
      const fail = (error: unknown) => {
        if (done) return;
        done = true;
        cleanup();
        // Keep the slot reserved until termination completes.
        void slot.worker.terminate();
        reject(error);
      };
      const abort = () => fail(signal!.reason);
      const exited = () => fail(new Error("Live validation worker exited."));
      const complete = (value: Result) => {
        if (done) return;
        done = true;
        cleanup();
        slot.busy = false;
        slot.worker.unref();
        resolve(value);
        notify();
      };
      slot.worker.once("message", complete);
      slot.worker.once("error", fail);
      slot.worker.once("exit", exited);
      signal?.addEventListener("abort", abort, { once: true });
      // Structured clone owns the worker input; never detach storage or caller buffers.
      try {
        slot.worker.postMessage(work);
      } catch (error) {
        fail(error);
      }
    });
  }
  function validator(
    policy: OrderedLiveUpdateCutPolicy,
  ): CapacityLiveAdmissionValidator {
    const ownedPolicy = Object.freeze({ ...policy });
    const validate: OwnerOutboxAdmission["validate"] = (input, signal) =>
      submit<LiveJournalValidation>(
        { kind: "journal", policy: ownedPolicy, input },
        signal,
      );
    return Object.assign(validate, { waitForCapacity, hasCapacity });
  }
  /**
   * Runs at most one first-open job at a time and never waits for a slot, so
   * live admission keeps the other. A busy caller retries on its next pass.
   */
  async function firstOpen<Result extends { kind: string }>(
    work: LiveValidationWork,
    signal?: AbortSignal,
  ): Promise<Result | { kind: "busy" }> {
    if (firstOpenSlot?.busy && slots.has(firstOpenSlot)) return { kind: "busy" };
    const result = await submit<Result>(work, signal, (slot) => {
      firstOpenSlot = slot;
    });
    if (result.kind === "retry") return { kind: "busy" };
    firstOpenSlot = undefined;
    return result as Result;
  }
  async function close() {
    closed = true;
    notify();
    await Promise.all([...slots].map((slot) => slot.worker.terminate()));
  }
  return {
    validator,
    async normalizeSettlement(
      input: SettlementNormalizationInput,
      signal?: AbortSignal,
    ) {
      const policy = {
        maxStructVisits: 1_000_000,
        maxValueNodeVisits: 5_000_000,
        maxDecodedPayloadByteVisits: 100_000_000,
        maxStructClientGroupVisits: 1_000_000,
        maxDeleteClientGroupVisits: 1_000_000,
        maxDeleteIntervalVisits: 1_000_000,
        maxIndexOperations: 10_000_000,
      };
      return submit<SettlementNormalizationResult>(
        { kind: "settlement", policy, input },
        signal,
      );
    },
    /**
     * A build that runs its worker out of memory does so on every try, so it
     * is refused for good. Node emits that worker's exit right after its
     * error, so its slot is free before the refusal answers. A build that
     * passes its deadline says only that this host was slow this time: its
     * worker is ended, and it answers once the slot is free.
     */
    async buildFirstOpenBase(
      policy: OrderedLiveUpdateCutPolicy,
      input: FirstOpenBaseInput,
      signal?: AbortSignal,
    ): Promise<FirstOpenBaseResult | { kind: "busy" } | { kind: "deadline" }> {
      const deadline = AbortSignal.timeout(firstOpenBuildMs);
      try {
        return await firstOpen<FirstOpenBaseResult>(
          { kind: "first-open", policy, input },
          signal ? AbortSignal.any([signal, deadline]) : deadline,
        );
      } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY") {
          return { kind: "refused", reason: "seed-worker-capacity" };
        }
        if (!deadline.aborted || error !== deadline.reason) throw error;
        const slot = firstOpenSlot;
        if (slot && slots.has(slot)) await new Promise((exited) => slot.worker.once("exit", exited));
        return { kind: "deadline" };
      }
    },
    /** Reads first-open history on the worker's own read-only connection, in the first-open slot. */
    readFirstOpenHistory(read: FirstOpenHistoryRead, signal?: AbortSignal) {
      return firstOpen<FirstOpenHistory>({ kind: "first-open-history", input: read }, signal);
    },
    close,
  };
}

export const liveValidation = createLiveValidationExecutor();
