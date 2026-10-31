import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OrderedLiveUpdateCutPolicy } from "@dohc/ydoc-projection/live-journal-validation";
import type { OwnerOutboxAdmission, CapacityLiveAdmissionValidator } from "./ownerOutboxDelivery.js";
import type { OrdinaryActivationValidation, OrdinaryActivationValidator, OrdinaryActivationWork } from "./storage/ordinaryActivationValidation.js";
import type { LiveJournalValidation } from "./storage/types.js";
import {WORKER_LIVE_VALIDATION_POLICY} from "@dohc/ydoc-projection/live-journal-validation";
import { liveRestoreValidator, type LiveRestoreReply, type LiveRestoreValidator, type LiveRestoreWork } from "./liveRestoreValidation.js";

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
  | { kind: "activation"; input: OrdinaryActivationWork }
  | { kind: "restore"; input: LiveRestoreWork }
);
type CapacityRetry = {
  kind: "retry";
  reason: "admission-unavailable";
  waitForCapacity(signal?: AbortSignal): Promise<void>;
};
type Slot = { child: ChildProcess; busy: boolean; auxiliary: boolean; heapExhausted: boolean; exited: Promise<void> };
/** The validator threw instead of judging the edit, so the edit is tried again. */
export class LiveValidatorFailure extends Error {
  constructor(readonly errorClass: string) {
    super(`Live validation failed with ${errorClass}.`);
    this.name = "LiveValidatorFailure";
  }
}
const MAX_LOGGED_VALIDATOR_FAILURES = 1024;
/** Names each validator failure once per document, candidate edit and error class. */
export function createValidatorFailureLog(log: (message: string) => void = message => console.error(message)) {
  const logged = new Set<string>();
  return (document: import("@dohc/live-session-contract").LiveDocumentKey, candidate: Uint8Array, errorClass: string) => {
    const key = JSON.stringify([document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId,
      createHash("sha256").update(candidate).digest("hex"), errorClass]);
    if (logged.has(key)) return;
    if (logged.size >= MAX_LOGGED_VALIDATOR_FAILURES) logged.delete(logged.values().next().value!);
    logged.add(key);
    log(`[sync-relay] live validation failed with ${errorClass} for document ${document.objectId}; the edit waits and is tried again.`);
  };
}
/**
 * Two process-wide validation slots, with no retained waiting inputs. Each job
 * runs in a child process: a V8 heap-limit abort ends that child, not the relay.
 * Activation and restore together hold at most one slot, so live edits always keep the other.
 */
export function createLiveValidationExecutor(heapLimitMb = 512, logValidatorFailure = createValidatorFailureLog()) {
  const slots = new Set<Slot>();
  const waiters = new Set<() => void>();
  let closed = false;
  const hasCapacity = (auxiliary = false) => !closed && (!auxiliary || ![...slots].some(slot => slot.auxiliary)) && (slots.size < 2 || [...slots].some((slot) => !slot.busy));
  const notify = () => {
    for (const wake of [...waiters]) wake();
  };
  function waitForCapacity(signal?: AbortSignal, auxiliary = false): Promise<void> {
    signal?.throwIfAborted();
    if (closed) return Promise.reject(new Error("Live validation closed."));
    if (hasCapacity(auxiliary))
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
  // A fork refused before it started has no process to signal.
  const kill = (slot: Slot) => {
    if (slot.child.pid !== undefined) slot.child.kill("SIGKILL");
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
    const slot: Slot = { child, busy: false, auxiliary: false, heapExhausted: false, exited };
    slots.add(slot);
    const release = () => {
      slots.delete(slot);
      exit();
      notify();
    };
    // Listen before touching stdio: a fork refused with EMFILE has none, then errors and closes.
    // A failed child must not crash the relay. A fork refused with EAGAIN has unopened pipes and may never close.
    child.on("error", () => {
      if (child.pid !== undefined) return;
      if (child.connected) child.disconnect();
      release();
    });
    // `close` follows the exit and the end of stderr, so its verdict is complete.
    child.once("close", release);
    let carry = "";
    // Reading a refused fork's unopened stderr fails; that must not crash the relay.
    child.stderr?.on("error", () => {});
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      process.stderr.write(text);
      const seen = carry + text;
      if (/Reached heap limit|JavaScript heap out of memory/.test(seen))
        slot.heapExhausted = true;
      carry = seen.slice(-32);
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
    const auxiliary = work.kind === "activation" || work.kind === "restore";
    const slot = auxiliary && [...slots].some((slot) => slot.auxiliary) ? undefined :
      [...slots].find((slot) => !slot.busy) ??
      (slots.size < 2 ? spawn() : undefined);
    if (!slot)
      return {
        kind: "retry",
        reason: "admission-unavailable",
        waitForCapacity: (signal?: AbortSignal) => waitForCapacity(signal, auxiliary),
      };
    slot.busy = true;
    slot.auxiliary = auxiliary;
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
        kill(slot);
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
        slot.auxiliary = false;
        // A result that arrives after `close` began must not release its hold.
        if (!closed) hold(slot, false);
        const failed = value as {kind?: unknown; errorClass?: unknown};
        if (failed.kind === "failed") reject(new LiveValidatorFailure(typeof failed.errorClass === "string" ? failed.errorClass : "unknown"));
        else resolve(value as Result);
        notify();
      };
      slot.child.once("message", complete);
      slot.child.once("error", fail);
      slot.child.once("close", ended);
      signal?.addEventListener("abort", abort, { once: true });
      // A refused fork has no channel; its `error` event fails the job.
      if (slot.child.pid === undefined) return;
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
      ).catch((error: unknown) => {
        if (error instanceof LiveValidatorFailure) logValidatorFailure(input.document, input.candidate, error.errorClass);
        throw error;
      });
    return Object.assign(validate, { waitForCapacity, hasCapacity });
  }
  /** Activation does not wait for a slot: a busy pool answers `retry`, and a later pass captures again. */
  function ordinaryActivation(policy: OrderedLiveUpdateCutPolicy): OrdinaryActivationValidator {
    const ownedPolicy = Object.freeze({ ...policy });
    return (input, signal) =>
      submit<OrdinaryActivationValidation>(
        { kind: "activation", policy: ownedPolicy, input },
        { kind: "capacity-refused" },
        signal,
      );
  }
  /** Preparation refuses a busy pool; admission waits with its captured reads and cancellation signal. */
  function restore(policy: OrderedLiveUpdateCutPolicy): LiveRestoreValidator {
    const ownedPolicy = Object.freeze({ ...policy });
    return liveRestoreValidator((input, signal) =>
      submit<LiveRestoreReply | { kind: "capacity-refused" }>(
        { kind: "restore", policy: ownedPolicy, input },
        { kind: "capacity-refused" },
        signal,
      ),
    );
  }
  async function close() {
    closed = true;
    notify();
    await Promise.all(
      [...slots].map((slot) => {
        // Keep the relay alive until each child has closed.
        hold(slot, true);
        kill(slot);
        return slot.exited;
      }),
    );
  }
  return {
    validator,
    ordinaryActivation,
    restore,
    async normalizeSettlement(
      input: SettlementNormalizationInput,
      signal?: AbortSignal,
    ) {
      return submit<SettlementNormalizationResult>(
        { kind: "settlement", policy: WORKER_LIVE_VALIDATION_POLICY, input },
        { kind: "refused", reason: "capacity-refused", source: "registration-input" },
        signal,
      );
    },
    close,
  };
}
export const liveValidation = createLiveValidationExecutor();
