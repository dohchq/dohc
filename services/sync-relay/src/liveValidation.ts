import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OrderedLiveUpdateCutPolicy } from "@dohc/ydoc-projection/live-journal-validation";
import type { OwnerOutboxAdmission, CapacityLiveAdmissionValidator } from "./ownerOutboxDelivery.js";
import type { LiveJournalValidation } from "./storage/types.js";

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
);
type CapacityRetry = {
  kind: "retry";
  reason: "admission-unavailable";
  waitForCapacity(signal?: AbortSignal): Promise<void>;
};
type Slot = { child: ChildProcess; busy: boolean; heapExhausted: boolean; exited: Promise<void> };
/**
 * Two process-wide validation slots, with no retained waiting inputs. Each job
 * runs in a child process: a V8 heap-limit abort ends that child, not the relay.
 */
export function createLiveValidationExecutor(heapLimitMb = 512) {
  const slots = new Set<Slot>();
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
  // An idle child must not keep the relay's event loop alive.
  const hold = (slot: Slot, held: boolean) => {
    for (const handle of [slot.child, slot.child.channel, slot.child.stderr as Socket | null])
      if (held) handle?.ref();
      else handle?.unref();
  };
  function spawn() {
    const source = import.meta.url.endsWith(".ts");
    const child = fork(
      fileURLToPath(
        new URL(
          source ? "./liveValidationWorker.ts" : "./liveValidationWorker.js",
          import.meta.url,
        ),
      ),
      [],
      {
        execArgv: [
          ...(source
            ? [
                "--import",
                pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
              ]
            : []),
          `--max-old-space-size=${heapLimitMb}`,
          // A worker thread's default 4 MiB stack, less Node's 192 KiB guard.
          "--stack-size=3904",
        ],
        serialization: "advanced",
        stdio: ["ignore", "inherit", "pipe", "ipc"],
      },
    );
    let exit: () => void = () => {};
    const exited = new Promise<void>((resolve) => (exit = resolve));
    const slot: Slot = { child, busy: false, heapExhausted: false, exited };
    slots.add(slot);
    let carry = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (text: string) => {
      process.stderr.write(text);
      const seen = carry + text;
      if (/Reached heap limit|JavaScript heap out of memory/.test(seen))
        slot.heapExhausted = true;
      carry = seen.slice(-32);
    });
    child.on("error", () => {}); // A failed idle child must not crash the relay.
    // `close` follows the exit and the end of stderr, so its verdict is complete.
    child.once("close", () => {
      slots.delete(slot);
      exit();
      notify();
    });
    hold(slot, false);
    return slot;
  }
  async function submit<Result>(
    work: LiveValidationWork,
    heapExhausted: Result,
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
    hold(slot, true);
    return new Promise<Result>((resolve, reject) => {
      let done = false;
      const settle = () => {
        if (done) return false;
        done = true;
        signal?.removeEventListener("abort", abort);
        slot.child.off("message", complete);
        slot.child.off("error", fail);
        slot.child.off("close", ended);
        return true;
      };
      const fail = (error: unknown) => {
        if (!settle()) return;
        // The slot stays busy until the child has exited.
        slot.child.kill("SIGKILL");
        reject(error);
      };
      const abort = () => fail(signal!.reason);
      const ended = (code: number | null, exitSignal: NodeJS.Signals | null) => {
        if (!settle()) return;
        // Node exits 134 on Windows where POSIX reports SIGABRT.
        if ((code === 134 || exitSignal === "SIGABRT") && slot.heapExhausted)
          resolve(heapExhausted);
        else reject(new Error("Live validation worker exited."));
      };
      const complete = (value: unknown) => {
        if (!settle()) return;
        slot.busy = false;
        hold(slot, false);
        resolve(value as Result);
        notify();
      };
      slot.child.once("message", complete);
      slot.child.once("error", fail);
      slot.child.once("close", ended);
      signal?.addEventListener("abort", abort, { once: true });
      // Advanced serialization copies typed arrays; never detach storage or caller buffers.
      try {
        slot.child.send(work, (error) => {
          if (error) fail(error);
        });
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
        { kind: "refused", reason: "capacity-refused", source: "final" },
        signal,
      );
    return Object.assign(validate, { waitForCapacity, hasCapacity });
  }
  async function close() {
    closed = true;
    notify();
    await Promise.all(
      [...slots].map((slot) => {
        slot.child.kill("SIGKILL");
        return slot.exited;
      }),
    );
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
        { kind: "refused", reason: "capacity-refused", source: "registration-input" },
        signal,
      );
    },
    close,
  };
}

export const liveValidation = createLiveValidationExecutor();
