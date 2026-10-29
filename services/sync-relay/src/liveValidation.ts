import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { OrderedLiveUpdateCutPolicy } from "@dohc/ydoc-projection/live-journal-validation";
import type {validateLiveRestoreProposal} from "@dohc/ydoc-projection/restore-proof";
import type { OwnerOutboxAdmission, CapacityLiveAdmissionValidator } from "./ownerOutboxDelivery.js";
import type { LiveJournalValidation } from "./storage/types.js";
import {WORKER_LIVE_VALIDATION_POLICY} from "./liveValidationPolicy.js";

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
export type LiveValidationWork = { policy: OrderedLiveUpdateCutPolicy } & (
  | { kind: "journal"; input: Parameters<OwnerOutboxAdmission["validate"]>[0] }
  | { kind: "settlement"; input: SettlementNormalizationInput }
  | { kind: "restore"; input: RestoreValidationInput; settlementPolicy: OrderedLiveUpdateCutPolicy }
);
type ProposalCapture = Parameters<typeof validateLiveRestoreProposal>[0];
type ProposalValidation = ReturnType<typeof validateLiveRestoreProposal>;
export type RestoreValidationInput = {
  capture: {
    receipt: ProposalCapture["receipt"];
    selected: Omit<ProposalCapture["selected"], "assertCurrent" | "artifact">;
    accepted: Omit<ProposalCapture["accepted"], "assertCurrent" | "artifact">;
  };
  bytes: Parameters<typeof validateLiveRestoreProposal>[1];
  budget: Parameters<typeof validateLiveRestoreProposal>[3];
  artifacts: [string, Uint8Array | undefined][];
  maxOutputBytes?: number;
};
export type RestoreValidationResult =
  | {kind: "accepted"; validated: Pick<ProposalValidation, "content" | "candidateBytes" | "nativeSourceRanges">;
      reviewContent?: ReturnType<ProposalValidation["projectReview"]>}
  | {kind: "artifact-required"; digest: string}
  | {kind: "capacity-refused"}
  | {kind: "invalid"; message: string};
type CapacityRetry = {
  kind: "retry";
  reason: "admission-unavailable";
  waitForCapacity(signal?: AbortSignal): Promise<void>;
};
/** Two process-wide validation slots, with no retained waiting inputs. */
export function createLiveValidationExecutor() {
  const slots = new Set<{ worker: Worker; busy: boolean }>();
  const waiters = new Set<() => void>();
  let closed = false;
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
      return submit<SettlementNormalizationResult>(
        { kind: "settlement", policy: WORKER_LIVE_VALIDATION_POLICY, input },
        signal,
      );
    },
    async validateRestore(input: RestoreValidationInput, policy: OrderedLiveUpdateCutPolicy, signal?: AbortSignal) {
      return submit<RestoreValidationResult>(
        {kind: "restore", policy, input, settlementPolicy: WORKER_LIVE_VALIDATION_POLICY}, signal,
      );
    },
    close,
  };
}
export const liveValidation = createLiveValidationExecutor();
