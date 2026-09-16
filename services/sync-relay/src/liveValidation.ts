import { Worker } from "node:worker_threads";
import type { OrderedLiveUpdateCutPolicy } from "@dohc/ydoc-projection/live-journal-validation";
import type { OwnerOutboxAdmission } from "./ownerOutboxDelivery.js";
import type { LiveJournalValidation } from "./storage/types.js";

const capacity: LiveJournalValidation = { kind: "refused", reason: "capacity-refused", source: "call" };

/** Two process-wide validation slots, with no retained waiting inputs. */
export function createLiveValidationExecutor() {
  const slots = new Set<{ worker: Worker; busy: boolean }>();
  let closed = false;
  function spawn() {
    const source = import.meta.url.endsWith(".ts");
    const worker = new Worker(new URL(source ? "./liveValidationWorker.ts" : "./liveValidationWorker.js", import.meta.url), {
      execArgv: source ? ["--import", "tsx"] : [],
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    const slot = { worker, busy: false };
    slots.add(slot);
    worker.on("error", () => {}); // A failed idle worker must not crash the relay.
    worker.once("exit", () => { slots.delete(slot); });
    worker.unref();
    return slot;
  }
  return {
    validator(policy: OrderedLiveUpdateCutPolicy): OwnerOutboxAdmission["validate"] {
      const ownedPolicy = Object.freeze({ ...policy });
      return async (input, signal) => {
        signal?.throwIfAborted();
        if (closed) throw new Error("Live validation closed.");
        const slot = [...slots].find(slot => !slot.busy) ?? (slots.size < 2 ? spawn() : undefined);
        if (!slot) return capacity;
        slot.busy = true;
        slot.worker.ref();
        return new Promise<LiveJournalValidation>((resolve, reject) => {
          let done = false;
          const cleanup = () => {
            signal?.removeEventListener("abort", abort);
            slot.worker.off("message", complete); slot.worker.off("error", fail); slot.worker.off("exit", exited);
          };
          const fail = (error: unknown) => {
            if (done) return;
            done = true; cleanup();
            // Keep the slot reserved until termination completes.
            void slot.worker.terminate();
            reject(error);
          };
          const abort = () => fail(signal!.reason);
          const exited = () => fail(new Error("Live validation worker exited."));
          const complete = (value: LiveJournalValidation) => {
            if (done) return;
            done = true; cleanup(); slot.busy = false; slot.worker.unref(); resolve(value);
          };
          slot.worker.once("message", complete); slot.worker.once("error", fail); slot.worker.once("exit", exited);
          signal?.addEventListener("abort", abort, { once: true });
          // Structured clone owns the worker input; never detach storage or caller buffers.
          try { slot.worker.postMessage({ policy: ownedPolicy, input }); } catch (error) { fail(error); }
        });
      };
    },
    async close() {
      closed = true;
      await Promise.all([...slots].map(slot => slot.worker.terminate()));
    },
  };
}

export const liveValidation = createLiveValidationExecutor();
