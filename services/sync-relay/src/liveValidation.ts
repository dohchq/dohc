import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OrderedLiveUpdateCutPolicy } from "@dohc/ydoc-projection/live-journal-validation";
import type { FirstOpenBaseInput, FirstOpenBaseResult } from "./firstOpenBase.js";
import type { OwnerOutboxAdmission, CapacityLiveAdmissionValidator } from "./ownerOutboxDelivery.js";
import type { OrdinaryActivationValidation, OrdinaryActivationValidator, OrdinaryActivationWork } from "./storage/ordinaryActivationSource.js";
import type { LiveJournalValidation } from "./storage/types.js";
import type { FirstOpenHistory, FirstOpenHistoryRead } from "./storage/firstOpenHistory.js";
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
export type LiveValidationWork = ({ policy: OrderedLiveUpdateCutPolicy } & (
  | { kind: "journal"; input: Parameters<OwnerOutboxAdmission["validate"]>[0] }
  | { kind: "settlement"; input: SettlementNormalizationInput }
  | { kind: "activation"; input: OrdinaryActivationWork }
  | { kind: "restore"; input: LiveRestoreWork }
  | { kind: "first-open"; input: FirstOpenBaseInput }
)) | { kind: "first-open-history"; input: FirstOpenHistoryRead };
export type FirstOpenHistoryFailure = {
  kind: "history-error";
  message: string;
  code?: string;
  errcode?: number;
};

type CapacityRetry = {
  kind: "retry";
  reason: "admission-unavailable";
  waitForCapacity(signal?: AbortSignal): Promise<void>;
};
/** How long a first-open build may run. */
export const FIRST_OPEN_BUILD_MS = 60_000;
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
 * Activation, restore and first-open work together hold at most one slot, so live edits always keep the other.
 */
export function createLiveValidationExecutor(heapLimitMb = 512, logValidatorFailure = createValidatorFailureLog(), { firstOpenBuildMs = FIRST_OPEN_BUILD_MS } = {}) {
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
    claim?: (slot: Slot) => void,
  ): Promise<Result | CapacityRetry> {
    signal?.throwIfAborted();
    if (closed) throw new Error("Live validation closed.");
    const auxiliary = work.kind === "activation" || work.kind === "restore" || work.kind === "first-open" || work.kind === "first-open-history";
    const slot = auxiliary && [...slots].some((slot) => slot.auxiliary) ? undefined :
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
        const failed = value as {kind?: unknown; errorClass?: unknown};
        if (work.kind === "first-open" && failed.kind === "failed") {
          fail(new LiveValidatorFailure(typeof failed.errorClass === "string" ? failed.errorClass : "unknown"));
          return;
        }
        if (!settle()) return;
        slot.busy = false;
        slot.auxiliary = false;
        // A result that arrives after `close` began must not release its hold.
        if (!closed) hold(slot, false);
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
  /** Restore does not wait for a slot either: a busy pool refuses it as busy. */
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
  /**
   * Runs at most one first-open job at a time and never waits for a slot, so
   * live admission keeps the other. A busy caller retries on its next pass.
   */
  async function firstOpen<Result extends { kind: string }>(
    work: LiveValidationWork,
    heapExhausted: Result,
    signal?: AbortSignal,
    waitForExitSignal?: AbortSignal,
  ): Promise<Result | { kind: "busy" }> {
    let claimed: Slot | undefined;
    try {
      const result = await submit<Result>(work, heapExhausted, signal, slot => { claimed = slot; });
      return result.kind === "retry" ? { kind: "busy" } : result as Result;
    } catch (error) {
      // A deadline answers only after the child releases its slot.
      if (claimed && waitForExitSignal?.aborted && error === waitForExitSignal.reason) await claimed.exited;
      throw error;
    }
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
    /**
     * A build that runs its worker out of memory does so on every try, so it
     * is refused for good. A build that passes its deadline says only that
     * this host was slow this time. Both answer after the child has closed.
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
          { kind: "refused", reason: "seed-worker-capacity" },
          signal ? AbortSignal.any([signal, deadline]) : deadline,
          deadline,
        );
      } catch (error) {
        if (!deadline.aborted || error !== deadline.reason) throw error;
        return { kind: "deadline" };
      }
    },
    /** Reads first-open history on the worker's own read-only connection, in the first-open slot. */
    readFirstOpenHistory(read: FirstOpenHistoryRead, signal?: AbortSignal) {
      return firstOpen<FirstOpenHistory | FirstOpenHistoryFailure | { kind: "internal_error" }>({ kind: "first-open-history", input: read }, { kind: "internal_error" }, signal).then(result => {
        if (result.kind === "history-error") throw Object.assign(new Error(result.message), {code: result.code, errcode: result.errcode});
        if (result.kind === "internal_error") throw new Error("First-open history child exceeded its heap limit.");
        return result;
      });
    },
    close,
  };
}

export const liveValidation = createLiveValidationExecutor();
