import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OrderedLiveUpdateCutPolicy } from "@dohc/ydoc-projection/live-journal-validation";
import type {
  OwnerOutboxAdmission,
  CapacityLiveAdmissionValidator,
} from "./ownerOutboxDelivery.js";
import type {
  OrdinaryActivationValidation,
  OrdinaryActivationValidator,
  OrdinaryActivationWork,
  OrdinaryFoldResult,
  OrdinaryFoldWork,
} from "./storage/ordinaryActivationValidation.js";
import { checkpointPolicySha256 } from "./storage/ordinaryActivationCheckpoint.js";
import type { LiveJournalValidation } from "./storage/types.js";
import { WORKER_LIVE_VALIDATION_POLICY } from "@dohc/ydoc-projection/live-journal-validation";
import {
  liveRestoreValidator,
  type LiveRestoreReply,
  type LiveRestoreValidator,
  type LiveRestoreWork,
} from "./liveRestoreValidation.js";
import { childStderrLog, serverLogClass } from "./serverLogWords.js";

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
  | { kind: "activation"; input: OrdinaryActivationWork | OrdinaryFoldWork }
  | { kind: "restore"; input: LiveRestoreWork }
);
/** What the worker adds to a journal verdict about its own time. */
type WorkerTiming = { replayMs?: number; projectionMs?: number; workerMs: number };
type CapacityRetry = {
  kind: "retry";
  reason: "admission-unavailable";
  waitForCapacity(signal?: AbortSignal): Promise<void>;
};
type Slot = {
  child: ChildProcess;
  busy: boolean;
  auxiliary: boolean;
  heapExhausted: boolean;
  exited: Promise<void>;
  /** Settles once the child has started and can read work. */
  ready: Promise<void>;
};
/** The validator threw instead of judging the edit, so the edit is tried again. */
export class LiveValidatorFailure extends Error {
  constructor(readonly errorClass: string) {
    super(`Live validation failed with ${errorClass}.`);
    this.name = "LiveValidatorFailure";
  }
}
const MAX_LOGGED_VALIDATOR_FAILURES = 1024;
/**
 * How long one edit or settlement check may run once its child can read it, several times the
 * slowest ordinary note. A busy host can slow an ordinary check, so an edit's or settlement's
 * first overrun is tried again, and only a second one started within the retry window refuses
 * it as too large. Activation and restore read a note's history, which ordinary use can make
 * long, so they have no limit.
 */
export const LIVE_CHECK_TIME_LIMIT_MS = 10_000;
const LIVE_CHECK_RETRY_WINDOW_MS = 5 * 60_000;
/**
 * One edit or settlement: its note, and the edit's own bytes or the settled state. Other edits
 * accepted between two tries change the journal before an edit, not the edit.
 */
function checkedInput(work: Extract<LiveValidationWork, { kind: "journal" | "settlement" }>) {
  const { document } = work.input;
  return JSON.stringify([
    work.kind,
    document.workspaceId,
    document.mainVersionId,
    document.objectId,
    document.lineageClaimId,
    createHash("sha256")
      .update(work.kind === "journal" ? work.input.candidate : work.input.checkpoint)
      .digest("hex"),
  ]);
}
/** Names each validator failure once per document, candidate edit and error class. */
export function createValidatorFailureLog(
  log: (message: string) => void = (message) => console.error(message),
) {
  const logged = new Set<string>();
  return (
    document: import("@dohc/live-session-contract").LiveDocumentKey,
    candidate: Uint8Array,
    errorClass: string,
  ) => {
    const key = JSON.stringify([
      document.workspaceId,
      document.mainVersionId,
      document.objectId,
      document.lineageClaimId,
      createHash("sha256").update(candidate).digest("hex"),
      errorClass,
    ]);
    if (logged.has(key)) return;
    if (logged.size >= MAX_LOGGED_VALIDATOR_FAILURES) logged.delete(logged.values().next().value!);
    logged.add(key);
    log(
      `[sync-relay] live validation failed with ${errorClass} for document ${document.objectId}; the edit waits and is tried again.`,
    );
  };
}
/**
 * Two process-wide validation slots, with no retained waiting inputs. Each job
 * runs in a child process: a V8 heap-limit abort or a check past its time limit ends that child, not the relay.
 * Activation and restore together hold at most one slot, so live edits always keep the other.
 */
export function createLiveValidationExecutor(
  heapLimitMb = 512,
  logValidatorFailure = createValidatorFailureLog(),
  checkTimeLimitMs = LIVE_CHECK_TIME_LIMIT_MS,
) {
  const slots = new Set<Slot>();
  const waiters = new Set<() => void>();
  // When each checked input last ran out of time.
  const overran = new Map<string, number>();
  let closed = false;
  const hasCapacity = (auxiliary = false) =>
    !closed &&
    (!auxiliary || ![...slots].some((slot) => slot.auxiliary)) &&
    (slots.size < 2 || [...slots].some((slot) => !slot.busy));
  const notify = () => {
    for (const wake of [...waiters]) wake();
  };
  function waitForCapacity(signal?: AbortSignal, auxiliary = false): Promise<void> {
    signal?.throwIfAborted();
    if (closed) return Promise.reject(new Error("Live validation closed."));
    if (hasCapacity(auxiliary)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const dispose = () => {
        waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
      };
      // A slot another kind of work may not take leaves this waiter waiting.
      const wake = () => {
        if (!closed && !hasCapacity(auxiliary)) return;
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
            ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href]
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
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => (started = resolve));
    const slot: Slot = {
      child,
      busy: false,
      auxiliary: false,
      heapExhausted: false,
      exited,
      ready,
    };
    // The child's first message says it is ready.
    child.once("message", () => started());
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
    const forward = childStderrLog("[live-validation]");
    // Reading a refused fork's unopened stderr fails; that must not crash the relay.
    child.stderr?.on("error", () => {});
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      forward(text);
      const seen = carry + text;
      if (/Reached heap limit|JavaScript heap out of memory/.test(seen)) slot.heapExhausted = true;
      carry = seen.slice(-32);
    });
    hold(slot, false);
    return slot;
  }
  async function submit<Result>(
    work: LiveValidationWork,
    tooLarge: Result,
    signal?: AbortSignal,
  ): Promise<Result | CapacityRetry> {
    signal?.throwIfAborted();
    if (closed) throw new Error("Live validation closed.");
    const auxiliary = work.kind === "activation" || work.kind === "restore";
    const slot =
      auxiliary && [...slots].some((slot) => slot.auxiliary)
        ? undefined
        : ([...slots].find((slot) => !slot.busy) ?? (slots.size < 2 ? spawn() : undefined));
    if (!slot)
      return {
        kind: "retry",
        reason: "admission-unavailable",
        waitForCapacity: (signal?: AbortSignal) => waitForCapacity(signal, auxiliary),
      };
    slot.busy = true;
    slot.auxiliary = auxiliary;
    hold(slot, true);
    const startedAt = performance.now();
    const timed = work.kind === "journal" || work.kind === "settlement" ? work : undefined;
    return new Promise<Result>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        if (done) return false;
        done = true;
        clearTimeout(timer);
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
      // A retried input that overruns again is refused as too large, as a heap-limit abort is.
      const overrun = (input: string) => {
        if (!settle()) return;
        kill(slot);
        const last = overran.get(input);
        // A check that started before the last overrun ran beside it, so it leaves that mark in place.
        if (last !== undefined && startedAt < last)
          return reject(new LiveValidatorFailure("LiveCheckOverrun"));
        overran.delete(input);
        if (last !== undefined && startedAt - last < LIVE_CHECK_RETRY_WINDOW_MS)
          return resolve(tooLarge);
        if (overran.size >= MAX_LOGGED_VALIDATOR_FAILURES)
          overran.delete(overran.keys().next().value!);
        overran.set(input, performance.now());
        reject(new LiveValidatorFailure("LiveCheckOverrun"));
      };
      const ended = (code: number | null, exitSignal: NodeJS.Signals | null) => {
        if (!settle()) return;
        // Node exits 134 on Windows where POSIX reports SIGABRT.
        if ((code === 134 || exitSignal === "SIGABRT") && slot.heapExhausted) resolve(tooLarge);
        else reject(new Error("Live validation worker exited."));
      };
      const complete = (value: unknown) => {
        if ((value as { kind?: unknown }).kind === "ready") return;
        if (!settle()) return;
        slot.busy = false;
        slot.auxiliary = false;
        // A result that arrives after `close` began must not release its hold.
        if (!closed) hold(slot, false);
        const failed = value as { kind?: unknown; errorClass?: unknown };
        if (failed.kind === "failed")
          reject(new LiveValidatorFailure(serverLogClass(failed.errorClass)));
        else resolve(value as Result);
        notify();
      };
      slot.child.on("message", complete);
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
      // A malformed input still reaches the child, which fails it.
      if (timed?.input?.document)
        void slot.ready.then(() => {
          if (done) return;
          timer = setTimeout(() => overrun(checkedInput(timed)), checkTimeLimitMs);
          // The busy child keeps the relay alive; the timer need not.
          timer.unref();
        });
    });
  }
  function validator(policy: OrderedLiveUpdateCutPolicy): CapacityLiveAdmissionValidator {
    const ownedPolicy = Object.freeze({ ...policy });
    const validate: OwnerOutboxAdmission["validate"] = (input, signal, timing) => {
      const sentAt = performance.now();
      return submit<LiveJournalValidation & { timing?: WorkerTiming }>(
        { kind: "journal", policy: ownedPolicy, input },
        { kind: "refused", reason: "capacity-refused", source: "final" },
        signal,
      ).then(
        (answer) => {
          if (answer.kind === "retry" || !("timing" in answer)) return answer;
          const { timing: steps, ...verdict } = answer;
          if (timing && steps) {
            const replayMs = steps.replayMs ?? 0,
              projectionMs = steps.projectionMs ?? 0;
            timing.hopMs += performance.now() - sentAt - steps.workerMs;
            timing.replayMs += replayMs;
            timing.projectionMs += projectionMs;
            timing.workerOtherMs += steps.workerMs - replayMs - projectionMs;
          }
          return verdict as LiveJournalValidation;
        },
        (error: unknown) => {
          if (error instanceof LiveValidatorFailure)
            logValidatorFailure(input.document, input.candidate, error.errorClass);
          throw error;
        },
      );
    };
    return Object.assign(validate, { waitForCapacity, hasCapacity });
  }
  /**
   * Activation does not wait for a slot. A pass checks `hasCapacity` before it captures; a slot taken since answers `retry`.
   * `waitForCapacity` settles once a slot may be free, so the host can run the pass that captures again.
   */
  function ordinaryActivation(policy: OrderedLiveUpdateCutPolicy): OrdinaryActivationValidator {
    const ownedPolicy = Object.freeze({ ...policy });
    return Object.assign(
      (input: OrdinaryActivationWork | OrdinaryFoldWork, signal?: AbortSignal) =>
        submit<OrdinaryActivationValidation | OrdinaryFoldResult>(
          { kind: "activation", policy: ownedPolicy, input },
          { kind: "capacity-refused" },
          signal,
        ),
      {
        hasCapacity: () => hasCapacity(true),
        waitForCapacity: (signal?: AbortSignal) => waitForCapacity(signal, true),
        policySha256: checkpointPolicySha256(ownedPolicy),
      },
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
    async normalizeSettlement(input: SettlementNormalizationInput, signal?: AbortSignal) {
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
